/*
  ESP32 PLTS Monitor
  - Tegangan baterai Li-ion/LiPo 3S lewat pembagi tegangan (ADC1)
  - Arus AC lewat ACS712-20A (true RMS + filter)
  - Relay 4 channel (relay 1 & 2 digabung di GPIO 26)
  - Keluaran pendamping Relay 1 & 2: GPIO 12 (ON) dan GPIO 13 (OFF), saling berlawanan
  - Suhu & kelembapan DHT11 (GPIO 4), dibaca tanpa library tambahan
  - Server (Termux) mengambil data lewat IP: GET /api/data, POST /api/relay

  Hanya memakai library bawaan board ESP32 (WiFi, WebServer, ESPmDNS).
  Board: "ESP32 Dev Module".
*/
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>

// ===================== KONFIGURASI =====================
const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-wifi-password";
const char* API_KEY   = "replace-this-API";   // harus sama dengan ESP32_API_KEY di .env

#define USE_STATIC_IP 1                              // 1 = IP tetap (samakan dengan ESP32_IP di .env)
IPAddress IP_ADDR(192, 168, 11, 50), IP_GW(192, 168, 11, 1), IP_MASK(255, 255, 255, 0), IP_DNS(192, 168, 11, 1);

// --- Baterai: R1 ke baterai+, R2 ke GND. en=false -> pin tidak dibaca (jangan diaktifkan jika belum dipasang)
struct Tap { const char* id; uint8_t pin; bool en; float ratio; float mv; float v; };
Tap taps[] = {
  {"s1", 35, false, (4700.0f  + 10000.0f) / 10000.0f, 0, 0},   // tap 1S : 4.7k / 10k
  {"s2", 36, false, (22000.0f + 10000.0f) / 10000.0f, 0, 0},   // tap 2S : 22k / 10k
  {"s3", 39, true,  (33000.0f + 10000.0f) / 10000.0f, 0, 0},   // pack 3S: 33k / 10k  (GPIO 39 = VN)
};

// --- ACS712-20A
#define PIN_ACS        34        // ADC1, input-only (GPIO 34 bebas, tidak bentrok dengan relay)
#define ACS_MV_PER_A   100.0f    // 20A = 100 mV/A
#define ACS_DIV        1.0f      // 1.0 = output sensor langsung ke ADC. Jika pakai pembagi 10k (atas) + 20k (bawah) isi 0.6667
#define MAINS_HZ       50
#define I_CYCLES       10        // jendela ukur = 10 siklus = 200 ms
#define SAMPLE_US      250       // ~4 kHz (80 sampel per siklus)
#define ADC_CLIP_HI_MV 3100      // di atas ini ADC ESP32 jenuh / tidak linear
#define ADC_CLIP_LO_MV 120

// --- Relay (modul 4 channel). Relay 1 & 2 dipasang paralel di GPIO 26 -> satu tombol, dua relay
#define RELAY_ACTIVE_LOW 1       // kebanyakan modul: IN=LOW -> relay ON
struct Relay { const char* name; uint8_t pin; bool on; };
Relay relays[] = { {"Relay 1 & 2", 26, false}, {"Relay 3", 27, false}, {"Relay 4", 32, false} };
const int NR = sizeof(relays) / sizeof(relays[0]);

// --- Keluaran pendamping Relay 1 & 2 (selalu berlawanan):
//     Relay 1 & 2 ON  -> GPIO 12 ON,  GPIO 13 OFF
//     Relay 1 & 2 OFF -> GPIO 13 ON,  GPIO 12 OFF
//     GPIO 12 = pin strapping (MTDI): saat boot harus LOW. Pakai untuk LED/transistor ke GND,
//     jangan ditarik HIGH oleh rangkaian luar (ESP32 bisa gagal boot).
#define PIN_AUX_ON      12
#define PIN_AUX_OFF     13
#define AUX_ACTIVE_LOW  0        // 0 = "ON" berarti pin HIGH, 1 = "ON" berarti pin LOW
#define AUX_RELAY_IDX   0        // index di relays[] yang diikuti (0 = "Relay 1 & 2")

// --- DHT11 (suhu & kelembapan). Kaki DATA ke GPIO 4 + pull-up 10k ke 3V3 (modul 3 pin biasanya sudah ada)
#define PIN_DHT         4
#define DHT_PERIOD_MS   2000     // DHT11 maks. 1 pembacaan/detik; 2 detik lebih aman
#define DHT_STALE_MS    10000    // tanpa pembacaan valid selama ini -> dianggap tidak terbaca
// =======================================================

struct AcData { float irms, ipk, mean; bool clip; uint16_t n; };
struct DhtData { float t, h; bool have; uint32_t okMs; uint32_t err; };

WebServer server(80);
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE dhtMux = portMUX_INITIALIZER_UNLOCKED;
AcData ac = {0, 0, 0, false, 0};
DhtData dht = {0, 0, false, 0, 0};

void setAux(bool relayOn) {
  digitalWrite(PIN_AUX_ON,  (relayOn  == !AUX_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(PIN_AUX_OFF, (!relayOn == !AUX_ACTIVE_LOW) ? HIGH : LOW);
}

void setRelay(int i, bool on) {
  relays[i].on = on;
  digitalWrite(relays[i].pin, (on == !RELAY_ACTIVE_LOW) ? HIGH : LOW);
  if (i == AUX_RELAY_IDX) setAux(on);     // semua jalur (satu relay / "all" / boot) lewat sini
}

// ---------- Baterai: rata-rata terpangkas 32 sampel (buang min & max) ----------
float readTapMv(uint8_t pin) {
  uint32_t s = 0, mn = 99999, mx = 0;
  for (int i = 0; i < 32; i++) {
    uint32_t v = analogReadMilliVolts(pin);
    s += v; if (v < mn) mn = v; if (v > mx) mx = v;
    delayMicroseconds(200);
  }
  return (s - mn - mx) / 30.0f;
}

// ---------- ACS712 AC ----------
// Filter berlapis:
//  1) oversampling 2x per sampel
//  2) median-of-3 untuk membuang spike (noise WiFi / ADC)
//  3) offset DC (titik tengah ~2.5 V) dibuang dengan rata-rata jendela = N siklus utuh (otomatis ikut drift)
//  4) true RMS (Welford) -> akurat untuk sinus murni maupun gelombang non-sinus
//  5) median-of-5 + EMA antar-jendela (di sensorTask) agar angka stabil
//  6) deteksi clipping bila sinyal menyentuh batas ADC
float acsMv() { return (analogReadMilliVolts(PIN_ACS) + analogReadMilliVolts(PIN_ACS)) * 0.5f; }
float med3(float a, float b, float c) { return fmaxf(fminf(a, b), fminf(fmaxf(a, b), c)); }

AcData sampleCurrent() {
  float mean = 0, m2 = 0, vmax = 0, vmin = 1e9f;
  uint32_t n = 0;
  float a = acsMv(), b = acsMv();
  const uint32_t win = (1000000UL / MAINS_HZ) * I_CYCLES;
  uint32_t t0 = micros(), tn = t0;
  while ((uint32_t)(micros() - t0) < win) {
    float c = acsMv(), x = med3(a, b, c);
    a = b; b = c;
    n++;
    float d = x - mean; mean += d / n; m2 += d * (x - mean);
    if (x > vmax) vmax = x;
    if (x < vmin) vmin = x;
    tn += SAMPLE_US;
    while ((int32_t)(micros() - tn) < 0) {}
  }
  float k = 1.0f / (ACS_DIV * ACS_MV_PER_A);
  AcData r;
  r.irms = sqrtf(m2 / n) * k;
  r.ipk  = fmaxf(vmax - mean, mean - vmin) * k;
  r.mean = mean / ACS_DIV;
  r.clip = (vmax > ADC_CLIP_HI_MV) || (vmin < ADC_CLIP_LO_MV);
  r.n    = n;
  return r;
}

// ---------- DHT11 (bit-bang, tanpa library) ----------
// Protokol 1-wire: host menarik LOW >= 18 ms lalu melepas; sensor membalas LOW ~80 us + HIGH ~80 us,
// lalu 40 bit, tiap bit = LOW ~50 us + HIGH (~27 us = 0, ~70 us = 1).
// Nilai bit ditentukan dengan membandingkan lama HIGH terhadap lama LOW bit yang sama,
// jadi tidak bergantung pada kecepatan CPU.
static uint16_t dhtPulse(int level) {          // lama (us) pin bertahan di `level`; 0 = timeout
  uint32_t t0 = micros();
  while (digitalRead(PIN_DHT) == level) {
    if ((uint32_t)(micros() - t0) > 150) return 0;
  }
  return (uint16_t)(micros() - t0);
}

// 40 pasang (lo, hi) -> 5 byte -> cek checksum -> suhu & kelembapan. false = data rusak.
bool dhtDecode(const uint16_t* lo, const uint16_t* hi, float& t, float& h) {
  uint8_t d[5] = {0, 0, 0, 0, 0};
  for (int i = 0; i < 40; i++) {
    if (lo[i] == 0 || hi[i] == 0) return false;
    d[i / 8] <<= 1;
    if (hi[i] > lo[i]) d[i / 8] |= 1;
  }
  if (((d[0] + d[1] + d[2] + d[3]) & 0xFF) != d[4]) return false;
  h = d[0] + d[1] * 0.1f;
  t = d[2] + (d[3] & 0x7F) * 0.1f;
  if (d[3] & 0x80) t = -t;
  return h <= 100.0f && t > -40.0f && t < 80.0f;
}

bool dhtRead(float& t, float& h) {
  uint16_t lo[40] = {0}, hi[40] = {0};
  pinMode(PIN_DHT, OUTPUT);
  digitalWrite(PIN_DHT, LOW);
  vTaskDelay(pdMS_TO_TICKS(20));               // sinyal start >= 18 ms
  bool ok;
  portENTER_CRITICAL(&dhtMux);                 // jendela baca ~5 ms: jangan terganggu interrupt
  pinMode(PIN_DHT, INPUT_PULLUP);
  delayMicroseconds(55);
  ok = dhtPulse(LOW) && dhtPulse(HIGH);        // balasan sensor
  for (int i = 0; ok && i < 40; i++) {
    lo[i] = dhtPulse(LOW);
    hi[i] = dhtPulse(HIGH);
    ok = lo[i] && hi[i];
  }
  portEXIT_CRITICAL(&dhtMux);
  pinMode(PIN_DHT, INPUT_PULLUP);
  return ok && dhtDecode(lo, hi, t, h);
}

void pollDht() {
  float t = 0, h = 0;
  bool ok = dhtRead(t, h);
  portENTER_CRITICAL(&mux);
  if (ok) { dht.t = t; dht.h = h; dht.have = true; dht.okMs = millis(); }
  else dht.err++;
  portEXIT_CRITICAL(&mux);
}

void sensorTask(void*) {
  float hist[5] = {0}, ema = 0; uint8_t hi = 0; bool first = true;
  uint32_t lastDht = 0;
  for (;;) {
    if (millis() - lastDht >= DHT_PERIOD_MS) { lastDht = millis(); pollDht(); }
    for (auto& t : taps) if (t.en) {
      float mv = readTapMv(t.pin), v = mv / 1000.0f * t.ratio;
      t.mv = mv;
      t.v = (t.v == 0) ? v : t.v + 0.3f * (v - t.v);          // EMA tegangan
    }
    AcData r = sampleCurrent();
    if (first) { for (int i = 0; i < 5; i++) hist[i] = r.irms; ema = r.irms; first = false; }
    hist[hi] = r.irms; hi = (hi + 1) % 5;
    float t5[5]; memcpy(t5, hist, sizeof(t5));
    for (int i = 1; i < 5; i++) for (int j = i; j > 0 && t5[j] < t5[j - 1]; j--) { float x = t5[j]; t5[j] = t5[j - 1]; t5[j - 1] = x; }
    ema += (t5[2] - ema) * (fabsf(t5[2] - ema) > 0.5f ? 0.6f : 0.25f);   // cepat bila beban berubah besar
    r.irms = ema;
    portENTER_CRITICAL(&mux); ac = r; portEXIT_CRITICAL(&mux);
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// ---------- HTTP ----------
bool authOk() {
  if (server.header("X-API-Key") == API_KEY || server.arg("key") == API_KEY) return true;
  server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
  return false;
}

int relaysJson(char* b, int sz) {
  int n = snprintf(b, sz, "[");
  for (int i = 0; i < NR; i++)
    n += snprintf(b + n, sz - n, "%s{\"id\":%d,\"name\":\"%s\",\"pin\":%d,\"on\":%d}", i ? "," : "", i + 1, relays[i].name, relays[i].pin, relays[i].on);
  return n + snprintf(b + n, sz - n, "]");
}

void hData() {
  if (!authOk()) return;
  char b[1600];
  int n = snprintf(b, sizeof(b), "{\"ok\":true,\"device\":\"esp32-plts\",\"fw\":\"1.1\",\"ip\":\"%s\",\"rssi\":%d,\"uptime\":%lu,\"heap\":%u,\"battery\":[",
                   WiFi.localIP().toString().c_str(), WiFi.RSSI(), millis() / 1000, (unsigned)ESP.getFreeHeap());
  for (int i = 0; i < 3; i++)
    n += snprintf(b + n, sizeof(b) - n, "%s{\"id\":\"%s\",\"pin\":%d,\"en\":%d,\"ratio\":%.4f,\"mv\":%.0f,\"v\":%.3f}",
                  i ? "," : "", taps[i].id, taps[i].pin, taps[i].en, taps[i].ratio, taps[i].mv, taps[i].v);
  portENTER_CRITICAL(&mux); AcData a = ac; portEXIT_CRITICAL(&mux);
  n += snprintf(b + n, sizeof(b) - n, "],\"current\":{\"pin\":%d,\"irms\":%.4f,\"ipk\":%.3f,\"mean_mv\":%.1f,\"clip\":%d,\"n\":%u},\"relays\":",
                PIN_ACS, a.irms, a.ipk, a.mean, a.clip, (unsigned)a.n);
  n += relaysJson(b + n, sizeof(b) - n);
  portENTER_CRITICAL(&mux); DhtData d = dht; portEXIT_CRITICAL(&mux);
  bool dOk = d.have && (millis() - d.okMs) < DHT_STALE_MS;
  char tb[12] = "null", hb[12] = "null";          // JSON tidak boleh berisi NaN -> null bila tidak terbaca
  if (dOk) { snprintf(tb, sizeof(tb), "%.1f", d.t); snprintf(hb, sizeof(hb), "%.1f", d.h); }
  n += snprintf(b + n, sizeof(b) - n, ",\"dht\":{\"pin\":%d,\"ok\":%d,\"t\":%s,\"h\":%s,\"age\":%lu,\"err\":%lu}",
                PIN_DHT, dOk, tb, hb, d.have ? (unsigned long)((millis() - d.okMs) / 1000) : 0UL, (unsigned long)d.err);

  bool ax = relays[AUX_RELAY_IDX].on;
  snprintf(b + n, sizeof(b) - n, ",\"aux\":{\"relay\":%d,\"on_pin\":%d,\"off_pin\":%d,\"on\":%d,\"off\":%d}}",
           AUX_RELAY_IDX + 1, PIN_AUX_ON, PIN_AUX_OFF, ax, !ax);
  server.send(200, "application/json", b);
}

void hRelay() {
  if (!authOk()) return;
  String ch = server.arg("ch");
  String s = server.arg("state");
  bool st = (s == "1" || s == "true" || s == "on");
  if (ch == "all") {
    for (int i = 0; i < NR; i++) setRelay(i, st);
  } else {
    int i = ch.toInt() - 1;
    if (i < 0 || i >= NR) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"ch\"}"); return; }
    setRelay(i, st);
  }
  char b[420];
  int n = snprintf(b, sizeof(b), "{\"ok\":true,\"relays\":");
  n += relaysJson(b + n, sizeof(b) - n);
  snprintf(b + n, sizeof(b) - n, "}");
  server.send(200, "application/json", b);
}

void setup() {
  // Keluaran pendamping dulu (supaya setRelay(0,false) langsung menyalakan GPIO 13 & mematikan GPIO 12)
  pinMode(PIN_AUX_ON, OUTPUT);
  pinMode(PIN_AUX_OFF, OUTPUT);
  pinMode(PIN_DHT, INPUT_PULLUP);
  // Relay: pastikan OFF sedini mungkin saat boot
  for (int i = 0; i < NR; i++) { pinMode(relays[i].pin, OUTPUT); setRelay(i, false); }
  Serial.begin(115200);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);          // rentang ~0.15 - 3.1 V

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
#if USE_STATIC_IP
  WiFi.config(IP_ADDR, IP_GW, IP_MASK, IP_DNS);
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.printf("\nWiFi: %s  IP: %s\n", WiFi.status() == WL_CONNECTED ? "terhubung" : "GAGAL (akan dicoba lagi)", WiFi.localIP().toString().c_str());
  MDNS.begin("esp32-plts");

  const char* hdr[] = {"X-API-Key"};
  server.collectHeaders(hdr, 1);
  server.on("/", HTTP_GET, [] { server.send(200, "text/plain", "ESP32 PLTS monitor\nGET /api/data | POST /api/relay?ch=1..3|all&state=0|1\nHeader: X-API-Key"); });
  server.on("/api/data", HTTP_GET, hData);
  server.on("/api/relay", HTTP_POST, hRelay);
  server.begin();

  xTaskCreatePinnedToCore(sensorTask, "sensor", 6144, NULL, 1, NULL, 1);
}

void loop() {
  server.handleClient();
  static uint32_t lastCheck = 0, lastOk = 0;
  if (WiFi.status() == WL_CONNECTED) lastOk = millis();
  if (millis() - lastCheck > 15000) {
    lastCheck = millis();
    if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
  }
  if (millis() - lastOk > 600000UL) ESP.restart();   // WiFi putus > 10 menit -> restart
  delay(2);
}
