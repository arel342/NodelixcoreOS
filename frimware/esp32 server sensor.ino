/*
  ESP32 PLTS Monitor
  - Tegangan baterai Li-ion/LiPo 3S lewat pembagi tegangan (ADC1)
  - Arus AC lewat ACS712-20A (true RMS + filter)
  - Relay 4 channel (relay 1 & 2 digabung di GPIO 26)
  - Keluaran pendamping Relay 1 & 2: GPIO 12 (ON) dan GPIO 13 (OFF), saling berlawanan
  - Suhu & kelembapan DHT11 (GPIO 4), dibaca tanpa library tambahan
  - Server (Termux) mengambil data lewat IP: GET /api/data, POST /api/relay

  - Update firmware (OTA) sejak versi 1.2: server Termux mengirim file .bin ke POST /api/ota

  - Sejak versi 1.3 semua pengaturan jaringan diisi dari WEB, tidak lagi di file ini:
      * Pertama kali dinyalakan (atau tombol BOOT ditahan 3 detik), ESP32 menyalakan WiFi
        sendiri "Nodelix-ESP32-xxxx". Sambungkan HP ke WiFi itu lalu buka http://192.168.4.1
        untuk mengisi: nama WiFi, password WiFi, IP (DHCP/statis), dan kunci API.
      * Nilai disimpan di flash (NVS/Preferences), jadi tetap ada setelah listrik mati.
      * Bisa juga dikirim dari web Termux: Pengaturan > ESP32 (Mode setup / Kirim pengaturan).
      * WiFi rumah hilang lebih dari 2 menit -> ESP32 menyalakan mode setup lagi otomatis.
        Begitu WiFi rumah tersambung, mode setup tertutup sendiri.

  Hanya memakai library bawaan board ESP32 (WiFi, WebServer, ESPmDNS, Update, Preferences).
  Board      : "ESP32 Dev Module".
  Partisi    : WAJIB memakai skema dengan OTA agar update lewat jaringan bisa dipakai,
               mis. "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)". Skema bawaan
               "Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)" tidak punya partisi OTA,
               jadi /api/ota akan menjawab error "no OTA partition".

  Update firmware (OTA):
    Gambar baru ditulis ke partisi OTA lewat library Update; kalau verifikasi berhasil ESP restart
    sendiri dan memakai firmware baru, kalau gagal gambar lama tetap jalan. Dipakai oleh tab
    "Update Firmware" di web dan menu Termux (node update-fw.js).

  Endpoint (header X-API-Key harus sama dengan ESP32_API_KEY di .env):
    GET  /                halaman pengaturan (nama WiFi, password, IP, kunci API)
    GET  /api/info        status singkat + pengaturan sekarang
    GET  /api/scan        daftar WiFi yang terdeteksi
    POST /api/config      simpan pengaturan baru (dipakai halaman ini & web Termux)
    POST /api/portal      masuk mode setup sekarang (WiFi sendiri + halaman pengaturan)
    GET  /api/data        data sensor untuk dashboard Termux
    POST /api/relay?ch=1..3|all&state=0|1
    POST /api/ota         update firmware (.bin) dari server Termux
*/
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Update.h>          // OTA: menulis firmware baru ke partisi OTA
#include <Preferences.h>     // penyimpanan pengaturan (nama WiFi, password, IP, kunci API)

// ===================== KONFIGURASI =====================
// Tidak ada lagi WIFI_SSID / WIFI_PASS / kunci API di baris kode: semuanya diisi dari halaman
// web mode setup (192.168.4.1) atau dari web Termux, lalu disimpan permanen di flash (NVS).
#define FW_VER       "1.3"        // 1.2 = OTA, 1.3 = mode setup AP + semua pengaturan lewat web
#define AP_PREFIX    "Nodelix-ESP32"
#define PIN_BTN      0            // tombol BOOT pada board: tahan 3 detik -> masuk mode setup

struct Cfg {
  String ssid, pass, apiKey;
  bool dhcp = true;
  IPAddress ip{192, 168, 1, 50}, gw{192, 168, 1, 1}, mask{255, 255, 255, 0}, dns{192, 168, 1, 1};
  bool valid = false;             // sudah pernah diisi (ada nama WiFi + kunci API)?
} cfg;

Preferences prefs;
String apName;                    // nama WiFi mode setup, mis. Nodelix-ESP32-1A2B
bool portalMode = false;
uint32_t btnHeld = 0, lastStaTry = 0, wifiOkAt = 0;

// ---------- Baca / tulis pengaturan di flash ----------
void cfgLoad() {
  prefs.begin("nodelix", true);
  cfg.ssid   = prefs.getString("ssid", "");
  cfg.pass   = prefs.getString("pass", "");
  cfg.apiKey = prefs.getString("apikey", "");
  cfg.dhcp   = prefs.getBool("dhcp", true);
  cfg.ip.fromString(prefs.getString("ip", "192.168.1.50"));
  cfg.gw.fromString(prefs.getString("gw", "192.168.1.1"));
  cfg.mask.fromString(prefs.getString("mask", "255.255.255.0"));
  cfg.dns.fromString(prefs.getString("dns", "192.168.1.1"));
  prefs.end();
  cfg.valid = cfg.ssid.length() > 0 && cfg.apiKey.length() > 0;
}
void cfgSave() {
  prefs.begin("nodelix", false);
  prefs.putString("ssid", cfg.ssid);
  prefs.putString("pass", cfg.pass);
  prefs.putString("apikey", cfg.apiKey);
  prefs.putBool("dhcp", cfg.dhcp);
  prefs.putString("ip", cfg.ip.toString());
  prefs.putString("gw", cfg.gw.toString());
  prefs.putString("mask", cfg.mask.toString());
  prefs.putString("dns", cfg.dns.toString());
  prefs.end();
  cfg.valid = cfg.ssid.length() > 0 && cfg.apiKey.length() > 0;
}

// ---------- Pembaca JSON mini (tanpa library tambahan) ----------
String jsonStr(const String& body, const char* key) {
  String pat = String("\"") + key + "\":";
  int i = body.indexOf(pat);
  if (i < 0) return "";
  i += pat.length();
  while (i < (int)body.length() && (body[i] == ' ' || body[i] == '\t')) i++;
  if (i >= (int)body.length()) return "";
  if (body[i] == '"') {
    String out; int j = i + 1;
    while (j < (int)body.length() && body[j] != '"') {
      if (body[j] == '\\' && j + 1 < (int)body.length()) j++;
      out += body[j++];
    }
    return out;
  }
  int j = i;
  while (j < (int)body.length() && body[j] != ',' && body[j] != '}') j++;
  String out = body.substring(i, j); out.trim();
  return out;
}
bool jsonBool(const String& body, const char* key, bool def) {
  String v = jsonStr(body, key);
  if (!v.length()) return def;
  return v == "1" || v == "true" || v == "on";
}
bool isIp(const String& s) {
  int dots = 0, part = 0;
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '.') { if (i == 0 || s[i - 1] == '.' || part > 255) return false; dots++; part = 0; }
    else if (c >= '0' && c <= '9') { part = part * 10 + (c - '0'); if (part > 255) return false; }
    else return false;
  }
  return dots == 3 && part > 0;
}

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
  if (server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey) return true;
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
  int n = snprintf(b, sizeof(b), "{\"ok\":true,\"device\":\"esp32-plts\",\"fw\":\"" FW_VER "\",\"ip\":\"%s\",\"rssi\":%d,\"uptime\":%lu,\"heap\":%u,\"battery\":[",
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

// ---------- Update firmware (OTA): POST /api/ota, body multipart berisi file .bin ----------
// Dipakai tab "Update Firmware" di web dan menu Termux (node update-fw.js).
bool otaOk = false, otaDenied = false;
String otaErr;
uint32_t otaWritten = 0, otaRestartAt = 0;

void hOtaUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    otaOk = false; otaDenied = false; otaErr = ""; otaWritten = 0;
    // Kunci API diperiksa sebelum satu byte pun ditulis ke flash
    if (!cfg.apiKey.length() || server.header("X-API-Key") != cfg.apiKey) { otaDenied = true; otaErr = "unauthorized"; return; }
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) otaErr = Update.errorString();   // gambar ESP32 memakai partisi OTA
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (otaDenied || otaErr.length()) return;
    // Gambar firmware ESP selalu diawali byte 0xE9: tolak file lain sebelum ditulis
    if (otaWritten == 0 && (up.currentSize < 1 || up.buf[0] != 0xE9)) { otaErr = "bukan gambar firmware"; return; }
    if (Update.write(up.buf, up.currentSize) != up.currentSize) { otaErr = Update.errorString(); return; }
    otaWritten += up.currentSize;
  } else if (up.status == UPLOAD_FILE_END) {
    if (otaDenied || otaErr.length()) return;
    if (Update.end(true) && !Update.hasError()) otaOk = true; else otaErr = Update.errorString();
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    if (!otaErr.length()) otaErr = "upload dibatalkan";
  }
}

void hOta() {
  server.sendHeader("Connection", "close");
  if (otaDenied) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  if (otaOk) {
    otaRestartAt = millis() + 1200;                     // jawab dulu ke server, baru restart (lihat loop)
    char b[160];
    snprintf(b, sizeof(b), "{\"ok\":true,\"device\":\"esp32-plts\",\"bytes\":%lu}", (unsigned long)otaWritten);
    server.send(200, "application/json", b);
    return;
  }
  String e = otaErr.length() ? otaErr : (otaWritten ? "gagal menulis flash" : "tidak ada file");
  e.replace("\"", "'");
  server.send(500, "application/json", "{\"ok\":false,\"error\":\"" + e + "\"}");
}

// ===================== MODE SETUP: WiFi sendiri + halaman pengaturan =====================
// Halaman ini bisa dibuka dua cara:
//   * mode setup  -> http://192.168.4.1  (perangkat menyalakan WiFi "%AP_PREFIX%-xxxx")
//   * sudah tersambung -> http://IP-perangkat (butuh kunci API sekarang kalau sudah diisi)
// Halaman ini jugalah yang membuat WiFi/IP/kunci API bisa diubah tanpa mengedit file .ino.
const char PAGE[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pengaturan %BOARD%</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eef2f8;color:#0b1a30;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px}
.w{max-width:520px;margin:0 auto;padding:16px 14px 34px}
.h{display:flex;align-items:center;gap:11px;padding:4px 2px 14px}
.lg{width:40px;height:40px;border-radius:12px;background:#0b1a30;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700}
.h b{font-size:18px}.h span{display:block;font-size:12px;color:#6b7a94}
.st{background:#fff;border:1px solid #dbe2ee;border-radius:14px;padding:12px 14px;font-size:13px;line-height:1.5;margin-bottom:14px}
.st b{font-weight:600}.ap{color:#b45309;font-weight:700}
.c{background:#fff;border:1px solid #dbe2ee;border-radius:16px;padding:16px}
label.f{display:block;margin:12px 0 0;font-size:12.5px;font-weight:600;color:#3d4b62}
input[type=text]{width:100%;margin-top:5px;padding:11px 12px;border:1.5px solid #dbe2ee;border-radius:11px;font:inherit;font-size:14.5px;background:#fbfcfe;outline:none}
input:focus{border-color:#8ab4e8;background:#fff}
.rw{display:flex;gap:8px;align-items:flex-end}.rw>div{flex:1}
button{border:0;border-radius:11px;padding:11px 15px;font:inherit;font-size:14px;font-weight:600;background:#0b1a30;color:#fff;cursor:pointer}
button.gh{background:#fff;color:#0b1a30;border:1.5px solid #dbe2ee}
.sv{width:100%;margin-top:18px;background:#f5a524;color:#3a2500}
.sv[disabled]{opacity:.5}
.sw{display:flex;align-items:center;gap:10px;margin:14px 0 0;font-size:13.5px;font-weight:600;color:#3d4b62}
.sw input{width:19px;height:19px;accent-color:#f5a524}
.hint{font-size:12px;color:#6b7a94;line-height:1.55;margin:12px 0 0}
.msg{margin-top:14px;font-size:13px;font-weight:600;border-radius:11px;padding:11px 12px;display:none}
.msg.ok{display:block;background:#e6f7ec;color:#166534}.msg.err{display:block;background:#fdeaea;color:#991b1b}
.msg.work{display:block;background:#eef4fb;color:#2f5f92}
#static{display:none}
</style></head><body><div class="w">
<div class="h"><div class="lg">N</div><div><b>NodelixcoreOS</b><span>%BOARD% &middot; firmware %FW%</span></div></div>
<div class="st" id="st">Memuat status&hellip;</div>
<div class="c">
  <label class="f">Nama WiFi (SSID)</label>
  <div class="rw"><div><input id="ssid" list="wl" placeholder="WiFi rumah"></div><button type="button" class="gh" onclick="scan()">Cari WiFi</button></div>
  <datalist id="wl"></datalist>
  <label class="f">Password WiFi</label><input id="pass" type="text" placeholder="kosongkan bila WiFi terbuka">
  <label class="sw"><input id="dhcp" type="checkbox" checked onchange="mode()">IP otomatis (DHCP)</label>
  <div id="static">
    <label class="f">IP perangkat</label><input id="ip" placeholder="192.168.1.50">
    <label class="f">Gateway</label><input id="gw" placeholder="192.168.1.1">
    <label class="f">Netmask</label><input id="mask" placeholder="255.255.255.0">
    <label class="f">DNS</label><input id="dns" placeholder="192.168.1.1">
  </div>
  <label class="f">Kunci API (samakan dengan ESP32_API_KEY di web Termux)</label><input id="key" placeholder="nlx-...">
  <label class="f">Kunci API sekarang (wajib bila perangkat sudah pernah diisi)</label><input id="cur" placeholder="kunci lama / kosongkan bila belum pernah">
  %OPENFIELD%
  <button class="sv" id="sv" type="button" onclick="save()">Simpan &amp; restart</button>
  <div class="msg" id="msg"></div>
  <p class="hint">Setelah disimpan perangkat restart lalu tersambung ke WiFi rumah. Untuk mengubah lagi: tahan tombol BOOT/FLASH 3 detik, atau pakai Pengaturan di web Termux.</p>
</div>
<p class="hint" style="text-align:center">%AP% &middot; http://192.168.4.1</p>
</div>
<script>
var $=function(i){return document.getElementById(i)};
function say(t,k){var m=$('msg');m.className='msg '+k;m.textContent=t}
function mode(){$('static').style.display=$('dhcp').checked?'none':'block'}
async function info(){try{var j=await(await fetch('/api/info',{headers:{'X-API-Key':$('cur').value.trim()}})).json();
 $('st').innerHTML='Mode: <b>'+(j.mode==='ap'?'setup (WiFi sendiri)':'tersambung')+'</b>'+(j.ap?' &middot; WiFi <span class="ap">'+j.ap+'</span>':'')+(j.ssid?' &middot; WiFi rumah: <b>'+j.ssid+'</b>':'')+(j.ip?' &middot; IP <b>'+j.ip+'</b>':'');
 if(j.ssid&&!$('ssid').value)$('ssid').value=j.ssid;
 if(j.ip_cfg&&!$('ip').value)$('ip').value=j.ip_cfg;
 if(j.gw&&!$('gw').value)$('gw').value=j.gw;
 if(j.mask&&!$('mask').value)$('mask').value=j.mask;
 if(j.dns&&!$('dns').value)$('dns').value=j.dns;
 $('dhcp').checked=j.dhcp!==false; mode();
 if(j.configured&&!j.ssid)$('cur').placeholder='isi kunci API untuk melihat setelan lama';
}catch(e){$('st').textContent='Perangkat belum menjawab'}}
async function scan(){say('Mencari WiFi...','work');try{var a=await(await fetch('/api/scan',{headers:{'X-API-Key':$('cur').value.trim()}})).json();
 $('wl').innerHTML=a.map(function(s){return '<option value="'+s+'">'}).join('');
 var i=0;a.forEach(function(s){if(i<1&&s)$('ssid').value=s});
 say(a.length?('Ditemukan '+a.length+' WiFi, pilih di daftar.':'Tidak ada WiFi ditemukan, tulis manual.'),'ok');
}catch(e){say('Gagal mencari WiFi','err')}}
async function save(){var b={ssid:$('ssid').value.trim(),pass:$('pass').value,dhcp:$('dhcp').checked,ip:$('ip').value.trim(),gw:$('gw').value.trim(),mask:$('mask').value.trim(),dns:$('dns').value.trim(),api_key:$('key').value.trim()};
 var x=$('sec');if(x)b.open_sec=+x.value;
 $('sv').disabled=true;say('Menyimpan...','work');
 try{var r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':$('cur').value.trim()},body:JSON.stringify(b)});
  var j=await r.json();
  if(j.ok){say('Tersimpan. Perangkat restart dan tersambung ke WiFi rumah...','ok');setTimeout(function(){location.reload()},8000)}
  else{say('Gagal: '+(j.error||r.status),'err');$('sv').disabled=false}
 }catch(e){say('Gagal mengirim: '+(e.message||e),'err');$('sv').disabled=false}}
mode();info();
</script></body></html>
)HTML";

String pageHtml() {
  String pg = FPSTR(PAGE);
  pg.replace("%FW%", FW_VER);
  pg.replace("%BOARD%", "ESP32 PLTS");
  pg.replace("%AP%", apName);
  pg.replace("%OPENFIELD%", "");                 // ESP32 tidak punya pengaturan pintu
  pg.replace("%OPEN%", "");
  return pg;
}

// Kunci API: perangkat baru (belum ada kunci) boleh diatur siapa saja; setelah ada kunci,
// permintaan harus memakai kunci itu (header X-API-Key atau parameter key).
bool cfgAuth() {
  if (!cfg.apiKey.length()) return true;
  return server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey;
}
bool jsonHas(const String& body, const char* key) { return body.indexOf(String("\"") + key + "\":") >= 0; }

// ---------- WiFi ----------
bool connectWifi() {
  if (!cfg.ssid.length()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  if (!cfg.dhcp) WiFi.config(cfg.ip, cfg.gw, cfg.mask, cfg.dns);
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  return WiFi.status() == WL_CONNECTED;
}
void startPortal() {
  if (portalMode) return;
  portalMode = true; lastStaTry = millis();
  WiFi.mode(WIFI_AP_STA);                        // AP untuk pengaturan, STA untuk mencoba WiFi rumah terus
  WiFi.softAP(apName.c_str());                   // tanpa password: dipakai sebentar saat mengisi pengaturan
  IPAddress a = WiFi.softAPIP();
  Serial.printf("\n[%s] Mode setup aktif: sambungkan HP ke WiFi \"%s\", buka http://%s\n", FW_VER, apName.c_str(), a.toString().c_str());
}
void stopPortal() {
  if (!portalMode) return;
  portalMode = false;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  Serial.printf("[%s] Terhubung ke WiFi \"%s\", mode setup dimatikan. IP: %s\n", FW_VER, cfg.ssid.c_str(), WiFi.localIP().toString().c_str());
}

// ---------- Route halaman pengaturan ----------
void hPage() { server.send(200, "text/html; charset=utf-8", pageHtml()); }

void hInfo() {
  bool ok = cfgAuth();
  char b[420];
  IPAddress ipNow = portalMode ? WiFi.softAPIP() : WiFi.localIP();
  snprintf(b, sizeof(b),
    "{\"ok\":true,\"fw\":\"" FW_VER "\",\"mode\":\"%s\",\"ap\":\"%s\",\"configured\":%d,"
    "\"ssid\":\"%s\",\"ip\":\"%s\",\"dhcp\":%d,\"ip_cfg\":\"%s\",\"gw\":\"%s\",\"mask\":\"%s\",\"dns\":\"%s\"}",
    portalMode ? "ap" : "sta", apName.c_str(), cfg.valid ? 1 : 0,
    ok ? cfg.ssid.c_str() : "", ipNow.toString().c_str(), cfg.dhcp ? 1 : 0,
    ok ? cfg.ip.toString().c_str() : "", ok ? cfg.gw.toString().c_str() : "", ok ? cfg.mask.toString().c_str() : "", ok ? cfg.dns.toString().c_str() : "");
  server.send(200, "application/json", b);
}

void hScan() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  int n = WiFi.scanNetworks();
  String j = "[";
  for (int i = 0; i < n; i++) {
    if (i) j += ",";
    String ss = WiFi.SSID(i); ss.replace("\"", "'"); ss.replace("\\", "/");
    j += "\"" + ss + "\"";
  }
  j += "]";
  WiFi.scanDelete();
  server.send(200, "application/json", j);
}

void hConfig() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  String body = server.arg("plain");
  String ssid = jsonStr(body, "ssid");
  String pass = jsonStr(body, "pass");
  String key = jsonStr(body, "api_key");
  String ip = jsonStr(body, "ip"), gw = jsonStr(body, "gw"), mask = jsonStr(body, "mask"), dns = jsonStr(body, "dns");
  bool dhcp = jsonBool(body, "dhcp", cfg.dhcp);

  String err;
  if (ssid.length() > 32) err = "nama WiFi maksimal 32 karakter";
  else if (pass.length() > 63) err = "password WiFi maksimal 63 karakter";
  else if (ip.length() && !isIp(ip)) err = "IP tidak valid";
  else if (gw.length() && !isIp(gw)) err = "gateway tidak valid";
  else if (mask.length() && !isIp(mask)) err = "netmask tidak valid";
  else if (dns.length() && !isIp(dns)) err = "DNS tidak valid";
  else if (key.length() && (key.length() < 8 || key.length() > 64 || key.indexOf(' ') >= 0)) err = "kunci API 8-64 karakter tanpa spasi";
  if (err.length()) {
    err.replace("\"", "'");
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"" + err + "\"}");
    return;
  }

  if (ssid.length()) cfg.ssid = ssid;
  if (jsonHas(body, "pass")) cfg.pass = pass;              // password hanya diganti kalau memang dikirim
  if (key.length()) cfg.apiKey = key;
  cfg.dhcp = dhcp;
  if (ip.length()) cfg.ip.fromString(ip);
  if (gw.length()) cfg.gw.fromString(gw);
  if (mask.length()) cfg.mask.fromString(mask);
  if (dns.length()) cfg.dns.fromString(dns);
  if (!cfg.ssid.length() || !cfg.apiKey.length()) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"nama WiFi dan kunci API wajib diisi\"}");
    return;
  }
  cfgSave();
  Serial.printf("[%s] Pengaturan disimpan: WiFi \"%s\", IP %s, kunci API %s\n",
                FW_VER, cfg.ssid.c_str(), cfg.dhcp ? "DHCP" : cfg.ip.toString().c_str(), cfg.apiKey.c_str());
  server.send(200, "application/json", String("{\"ok\":true,\"saved\":\"") + cfg.ssid + "\"}");
  otaRestartAt = millis() + 1500;                          // jawab dulu, baru restart dengan pengaturan baru
}

// Dipakai tombol "Mode setup" di web Termux: perangkat menyalakan WiFi sendiri sekarang
void hPortalNow() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  server.send(200, "application/json", String("{\"ok\":true,\"ap\":\"") + apName + "\",\"url\":\"http://192.168.4.1\"}");
  startPortal();
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

  // Pengaturan jaringan dibaca dari flash. Belum pernah diisi, atau tombol BOOT ditahan saat
  // menyala -> masuk mode setup: WiFi sendiri + halaman pengaturan di http://192.168.4.1
  pinMode(PIN_BTN, INPUT_PULLUP);
  cfgLoad();
  {
    String suf = String((uint16_t)(ESP.getEfuseMac() & 0xFFFF), HEX);
    suf.toUpperCase();
    apName = String(AP_PREFIX) + "-" + suf;
  }
  const bool forceSetup = digitalRead(PIN_BTN) == LOW;
  if (cfg.valid && !forceSetup && connectWifi()) {
    Serial.printf("\nWiFi: \"%s\" terhubung  IP: %s  kunci API: %s\n", cfg.ssid.c_str(), WiFi.localIP().toString().c_str(), cfg.apiKey.c_str());
  } else {
    startPortal();
  }
  wifiOkAt = millis();
  MDNS.begin("esp32-plts");

  const char* hdr[] = {"X-API-Key"};
  server.collectHeaders(hdr, 1);
  server.on("/", HTTP_GET, hPage);                          // halaman pengaturan (nama WiFi, IP, kunci API)
  server.on("/api/info", HTTP_GET, hInfo);
  server.on("/api/scan", HTTP_GET, hScan);
  server.on("/api/config", HTTP_POST, hConfig);             // dipakai halaman ini & web Termux
  server.on("/api/portal", HTTP_POST, hPortalNow);          // masuk mode setup dari web Termux
  server.on("/api/data", HTTP_GET, hData);
  server.on("/api/relay", HTTP_POST, hRelay);
  server.on("/api/ota", HTTP_POST, hOta, hOtaUpload);   // update firmware dari server (OTA)
  server.begin();

  xTaskCreatePinnedToCore(sensorTask, "sensor", 6144, NULL, 1, NULL, 1);
}

void loop() {
  server.handleClient();
  const uint32_t now = millis();
  // OTA selesai atau pengaturan baru disimpan -> restart supaya setelan baru dipakai
  if (otaRestartAt && (int32_t)(now - otaRestartAt) >= 0) ESP.restart();

  // Tombol BOOT ditahan 3 detik -> mode setup (untuk mengganti WiFi tanpa cabut alat)
  if (digitalRead(PIN_BTN) == LOW) {
    if (!btnHeld) btnHeld = now;
    else if (now - btnHeld > 3000) { btnHeld = 0; startPortal(); }
  } else btnHeld = 0;

  if (WiFi.status() == WL_CONNECTED) wifiOkAt = now;

  if (portalMode) {
    // WiFi rumah tetap dicoba tiap 20 detik; portal menutup sendiri begitu tersambung
    if (cfg.ssid.length() && now - lastStaTry > 20000) { lastStaTry = now; WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str()); }
    if (WiFi.status() == WL_CONNECTED) stopPortal();
  } else {
    static uint32_t lastCheck = 0;
    if (now - lastCheck > 15000) {
      lastCheck = now;
      if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    }
    // WiFi rumah hilang lebih dari 2 menit -> nyalakan mode setup supaya masih bisa diatur
    if (WiFi.status() != WL_CONNECTED && cfg.ssid.length() && wifiOkAt && now - wifiOkAt > 120000UL) startPortal();
    if (now - wifiOkAt > 600000UL) ESP.restart();   // WiFi putus > 10 menit -> restart
  }
  delay(2);
}
