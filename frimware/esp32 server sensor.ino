/*
  ESP32 PLTS Monitor
  - Tegangan baterai Li-ion/LiPo 3S lewat pembagi tegangan (ADC1)
  - Arus AC lewat ACS712-20A (true RMS + filter)
  - Relay 4 channel (relay 1 & 2 digabung di GPIO 26)
  - Keluaran pendamping Relay 1 & 2: GPIO 23 (ON) dan GPIO 22 (OFF), aktif HIGH
  - Suhu & kelembapan DHT11 (GPIO 4), bit-bang tanpa library tambahan
  - Server (Termux) mengambil data lewat IP: GET /api/data, POST /api/relay
  - OTA sejak v1.2 (POST /api/ota)
  - Semua pengaturan jaringan dari WEB sejak v1.3
  - v1.4.0 = UI baru seragam dengan ESP8266 + fix netmask + portal auth bypass

  Board   : "ESP32 Dev Module"
  Partisi : WAJIB punya OTA (mis. "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)")

  Endpoint:
    GET  /                halaman pengaturan
    GET  /api/info        status singkat + pengaturan sekarang
    GET  /api/scan        daftar WiFi
    POST /api/config      simpan pengaturan baru
    POST /api/portal      masuk mode setup sekarang
    GET  /api/data        data sensor untuk dashboard
    POST /api/relay?ch=1..3|all&state=0|1
    POST /api/ota         update firmware (.bin)
*/
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <Preferences.h>

// ===================== PROTOTIPE =====================
struct AcData  { float irms, ipk, mean; bool clip; uint16_t n; };
struct DhtData { float t, h; bool have; uint32_t okMs; uint32_t err; };

AcData sampleCurrent();
bool   dhtRead(float& t, float& h);
bool   dhtDecode(const uint16_t* lo, const uint16_t* hi, float& t, float& h);
// =====================================================

// ===================== KONFIGURASI =====================
#define FW_VER       "1.4.0"
#define AP_PREFIX    "Nodelix-ESP32"
#define PIN_BTN      0            // tombol BOOT: tahan 3 detik -> mode setup

struct Cfg {
  String ssid, pass, apiKey;
  bool dhcp = true;
  IPAddress ip{192, 168, 1, 50}, gw{192, 168, 1, 1}, mask{255, 255, 255, 0}, dns{192, 168, 1, 1};
  bool valid = false;
} cfg;

Preferences prefs;
String apName;
bool portalMode = false;
uint32_t btnHeld = 0, lastStaTry = 0, wifiOkAt = 0;

// ---------- Baca / tulis pengaturan di NVS ----------
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

// NVS otomatis commit saat prefs.end() — tidak butuh flush manual seperti LittleFS.
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
  Serial.println("[CFG] Pengaturan tersimpan di NVS");
  cfg.valid = cfg.ssid.length() > 0 && cfg.apiKey.length() > 0;
}

// ---------- Pembaca JSON mini ----------
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

// >>> PERBAIKAN: netmask 255.255.255.0 (dan IP berakhiran .0 lain) sekarang valid.
bool isIp(const String& s) {
  int dots = 0, part = 0;
  bool hasDigit = false;
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '.') {
      if (!hasDigit || part > 255) return false;
      dots++; part = 0; hasDigit = false;
    } else if (c >= '0' && c <= '9') {
      part = part * 10 + (c - '0');
      if (part > 255) return false;
      hasDigit = true;
    } else {
      return false;
    }
  }
  return dots == 3 && hasDigit;
}

// --- Baterai
struct Tap { const char* id; uint8_t pin; bool en; float ratio; float mv; float v; };
Tap taps[] = {
  {"s1", 35, false, (4700.0f  + 10000.0f) / 10000.0f, 0, 0},
  {"s2", 36, false, (22000.0f + 10000.0f) / 10000.0f, 0, 0},
  {"s3", 39, true,  (33000.0f + 10000.0f) / 10000.0f, 0, 0},
};

// --- ACS712-20A
#define PIN_ACS        34
#define ACS_MV_PER_A   100.0f
#define ACS_DIV        1.0f
#define MAINS_HZ       50
#define I_CYCLES       10
#define SAMPLE_US      250
#define ADC_CLIP_HI_MV 3100
#define ADC_CLIP_LO_MV 120

// --- Relay
#define RELAY_ACTIVE_LOW 1
struct Relay { const char* name; uint8_t pin; bool on; };
Relay relays[] = { {"Relay 1 & 2", 26, false}, {"Relay 3", 27, false}, {"Relay 4", 32, false} };
const uint8_t RELAY_IDS[] = {1, 3, 4};
const int NR = sizeof(relays) / sizeof(relays[0]);

// --- Keluaran pendamping Relay 1 & 2 (aktif HIGH, selalu berlawanan):
//     Relay 1 & 2 ON  -> GPIO 23 ON (HIGH), GPIO 22 OFF (LOW)
//     Relay 1 & 2 OFF -> GPIO 22 ON (HIGH), GPIO 23 OFF (LOW)
#define PIN_AUX_ON      23
#define PIN_AUX_OFF     22
#define AUX_ACTIVE_LOW  0
#define AUX_RELAY_IDX   0

// --- DHT11
#define PIN_DHT         4
#define DHT_PERIOD_MS   2000
#define DHT_STALE_MS    10000
// =======================================================

WebServer server(80);
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE dhtMux = portMUX_INITIALIZER_UNLOCKED;
AcData ac = {0, 0, 0, false, 0};
DhtData dht = {0, 0, false, 0, 0};

void setAux(bool relayOn) {
  pinMode(PIN_AUX_ON, OUTPUT);
  pinMode(PIN_AUX_OFF, OUTPUT);
  digitalWrite(PIN_AUX_ON,  (relayOn  == !AUX_ACTIVE_LOW) ? HIGH : LOW);
  digitalWrite(PIN_AUX_OFF, (!relayOn == !AUX_ACTIVE_LOW) ? HIGH : LOW);
}

void setRelay(int i, bool on) {
  if (i < 0 || i >= NR) return;
  relays[i].on = on;
  pinMode(relays[i].pin, OUTPUT);
  digitalWrite(relays[i].pin, (on == !RELAY_ACTIVE_LOW) ? HIGH : LOW);
  if (i == AUX_RELAY_IDX) setAux(on);
}

// ---------- Baterai: rata-rata terpangkas 32 sampel ----------
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

// ---------- DHT11 (bit-bang) ----------
static uint16_t dhtPulse(int level) {
  uint32_t t0 = micros();
  while (digitalRead(PIN_DHT) == level) {
    if ((uint32_t)(micros() - t0) > 150) return 0;
  }
  return (uint16_t)(micros() - t0);
}

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
  vTaskDelay(pdMS_TO_TICKS(20));
  bool ok;
  portENTER_CRITICAL(&dhtMux);
  pinMode(PIN_DHT, INPUT_PULLUP);
  delayMicroseconds(55);
  ok = dhtPulse(LOW) && dhtPulse(HIGH);
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
      t.v = (t.v == 0) ? v : t.v + 0.3f * (v - t.v);
    }
    AcData r = sampleCurrent();
    if (first) { for (int i = 0; i < 5; i++) hist[i] = r.irms; ema = r.irms; first = false; }
    hist[hi] = r.irms; hi = (hi + 1) % 5;
    float t5[5]; memcpy(t5, hist, sizeof(t5));
    for (int i = 1; i < 5; i++) for (int j = i; j > 0 && t5[j] < t5[j - 1]; j--) { float x = t5[j]; t5[j] = t5[j - 1]; t5[j - 1] = x; }
    ema += (t5[2] - ema) * (fabsf(t5[2] - ema) > 0.5f ? 0.6f : 0.25f);
    r.irms = ema;
    portENTER_CRITICAL(&mux); ac = r; portEXIT_CRITICAL(&mux);
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

// ---------- HTTP API ----------
bool authOk() {
  if (server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey) return true;
  server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
  return false;
}

int relaysJson(char* b, int sz) {
  int n = snprintf(b, sz, "[");
  for (int i = 0; i < NR; i++)
    n += snprintf(b + n, sz - n, "%s{\"id\":%d,\"ch\":%d,\"name\":\"%s\",\"pin\":%d,\"on\":%d}", i ? "," : "", RELAY_IDS[i], i + 1, relays[i].name, relays[i].pin, relays[i].on ? 1 : 0);
  return n + snprintf(b + n, sz - n, "]");
}

int auxJson(char* b, int sz) {
  bool ax = relays[AUX_RELAY_IDX].on;
  return snprintf(b, sz, "{\"relay\":%d,\"on_pin\":%d,\"off_pin\":%d,\"on\":%d,\"off\":%d}",
                  AUX_RELAY_IDX + 1, PIN_AUX_ON, PIN_AUX_OFF, ax ? 1 : 0, ax ? 0 : 1);
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
  char tb[12] = "null", hb[12] = "null";
  if (dOk) { snprintf(tb, sizeof(tb), "%.1f", d.t); snprintf(hb, sizeof(hb), "%.1f", d.h); }
  n += snprintf(b + n, sizeof(b) - n, ",\"dht\":{\"pin\":%d,\"ok\":%d,\"t\":%s,\"h\":%s,\"age\":%lu,\"err\":%lu}",
                PIN_DHT, dOk, tb, hb, d.have ? (unsigned long)((millis() - d.okMs) / 1000) : 0UL, (unsigned long)d.err);

  n += snprintf(b + n, sizeof(b) - n, ",\"aux\":");
  n += auxJson(b + n, sizeof(b) - n);
  snprintf(b + n, sizeof(b) - n, "}");
  server.send(200, "application/json", b);
}

void hRelay() {
  if (!authOk()) return;
  String ch = server.arg("ch"); ch.trim(); ch.toLowerCase();
  String idArg = server.arg("id"); idArg.trim(); idArg.toLowerCase();
  String pinArg = server.arg("pin"); pinArg.trim();
  String s = server.arg("state"); s.trim(); s.toLowerCase();
  if (!s.length() || !(s == "1" || s == "0" || s == "true" || s == "false" || s == "on" || s == "off")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"state\"}");
    return;
  }
  bool st = (s == "1" || s == "true" || s == "on");
  if (ch == "all" || ch == "semua" || idArg == "all" || idArg == "semua") {
    for (int i = 0; i < NR; i++) setRelay(i, st);
  } else {
    int i = -1;
    if (pinArg.length()) {
      int p = pinArg.toInt();
      for (int k = 0; k < NR; k++) if (relays[k].pin == p) { i = k; break; }
    } else if (idArg.length()) {
      if (idArg == "1" || idArg == "1&2" || idArg == "1-2" || idArg == "1,2") i = 0;
      else if (idArg == "2" || idArg == "3" || idArg == "r3" || idArg == "relay 3") i = 1;
      else if (idArg == "4" || idArg == "r4" || idArg == "relay 4") i = 2;
    } else {
      if (ch == "1" || ch == "1&2" || ch == "1-2" || ch == "1,2" || ch == "r1" || ch == "gpio26") i = 0;
      else if (ch == "2" || ch == "r2" || ch == "r3" || ch == "relay3" || ch == "relay 3" || ch == "gpio27") i = 1;
      else if (ch == "3" || (ch == "4" && NR == 3) || ch == "r4" || ch == "relay4" || ch == "relay 4" || ch == "gpio32") i = 2;
      else if (ch.length() && ch[0] >= '1' && ch[0] <= '9') i = ch.toInt() - 1;
    }
    if (i < 0 || i >= NR) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"ch\"}"); return; }
    setRelay(i, st);
  }
  char b[520];
  int n = snprintf(b, sizeof(b), "{\"ok\":true,\"relays\":");
  n += relaysJson(b + n, sizeof(b) - n);
  n += snprintf(b + n, sizeof(b) - n, ",\"aux\":");
  n += auxJson(b + n, sizeof(b) - n);
  snprintf(b + n, sizeof(b) - n, "}");
  server.send(200, "application/json", b);
}

// ---------- OTA ----------
bool otaOk = false, otaDenied = false;
String otaErr;
uint32_t otaWritten = 0, otaRestartAt = 0;

void hOtaUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    otaOk = false; otaDenied = false; otaErr = ""; otaWritten = 0;
    if (!cfg.apiKey.length() || server.header("X-API-Key") != cfg.apiKey) { otaDenied = true; otaErr = "unauthorized"; return; }
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) otaErr = Update.errorString();
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (otaDenied || otaErr.length()) return;
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
    otaRestartAt = millis() + 1200;
    char b[160];
    snprintf(b, sizeof(b), "{\"ok\":true,\"device\":\"esp32-plts\",\"bytes\":%lu}", (unsigned long)otaWritten);
    server.send(200, "application/json", b);
    return;
  }
  String e = otaErr.length() ? otaErr : (otaWritten ? "gagal menulis flash" : "tidak ada file");
  e.replace("\"", "'");
  server.send(500, "application/json", "{\"ok\":false,\"error\":\"" + e + "\"}");
}

// ===================== HALAMAN PENGATURAN (UI SAMA DENGAN ESP8266) =====================
const char PAGE[] PROGMEM = R"HTML(
<!DOCTYPE html><html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pengaturan %BOARD%</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#eef2f8;color:#0b1a30;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5}
.w{max-width:520px;margin:0 auto;padding:20px 16px 40px}
.h{display:flex;align-items:center;gap:12px;padding:4px 0 18px}
.lg{width:44px;height:44px;border-radius:13px;background:#0b1a30;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;flex-shrink:0}
.h b{font-size:18px;display:block}
.h span{display:block;font-size:12px;color:#6b7a94;margin-top:2px}
.st{background:#fff;border:1px solid #dbe2ee;border-radius:14px;padding:14px 16px;font-size:13px;line-height:1.6;margin-bottom:16px;color:#3d4b62}
.st b{font-weight:600;color:#0b1a30}
.ap{color:#b45309;font-weight:700}
.card{background:#fff;border:1px solid #dbe2ee;border-radius:18px;padding:20px 18px}
label.f{display:block;margin:16px 0 0;font-size:12.5px;font-weight:600;color:#3d4b62;letter-spacing:.2px}
label.f:first-child{margin-top:0}
input[type=text]{width:100%;margin-top:6px;padding:12px 14px;border:1.5px solid #dbe2ee;border-radius:12px;font:inherit;font-size:15px;background:#fbfcfe;outline:none;transition:border-color .15s,background .15s;color:#0b1a30}
input[type=text]:focus{border-color:#f5a524;background:#fff}
input[type=text]::placeholder{color:#9aa7bd}
.sw{display:flex;align-items:center;gap:10px;margin:18px 0 0;font-size:13.5px;font-weight:600;color:#3d4b62;cursor:pointer;user-select:none}
.sw input{width:18px;height:18px;accent-color:#f5a524;cursor:pointer}
.grid{margin-top:4px}
.grid.hide{display:none}
.hint{font-size:12px;color:#6b7a94;line-height:1.6;margin:14px 0 0}
.msg{margin-top:16px;font-size:13.5px;font-weight:600;border-radius:12px;padding:12px 14px;display:none;line-height:1.4}
.msg.ok{display:block;background:#e6f7ec;color:#166534}
.msg.err{display:block;background:#fdeaea;color:#991b1b}
.msg.work{display:block;background:#eef4fb;color:#2f5f92}
.sv{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;font:inherit;font-size:15px;font-weight:700;background:#f5a524;color:#3a2500;cursor:pointer;transition:opacity .15s}
.sv:hover{opacity:.92}
.sv:disabled{opacity:.5;cursor:not-allowed}
</style></head><body><div class="w">
<div class="h"><div class="lg">N</div><div><b>NodelixcoreOS</b><span>%BOARD% &middot; firmware %FW%</span></div></div>
<div class="st" id="st">Memuat status&hellip;</div>
<div class="card">
  <label class="f">Nama WiFi (SSID)</label>
  <input id="ssid" type="text" placeholder="WiFi rumah" autocomplete="off">
  <label class="f">Password WiFi</label>
  <input id="pass" type="text" placeholder="kosongkan bila WiFi terbuka" autocomplete="off">
  <label class="f">Kunci API</label>
  <input id="key" type="text" placeholder="nlx-..." autocomplete="off">
  <label class="sw"><input id="dhcp" type="checkbox" checked onchange="mode()">IP otomatis (DHCP)</label>
  <div class="grid" id="static">
    <label class="f">IP perangkat</label>
    <input id="ip" type="text" placeholder="192.168.1.50" autocomplete="off">
    <label class="f">Gateway</label>
    <input id="gw" type="text" placeholder="192.168.1.1" autocomplete="off">
    <label class="f">Netmask</label>
    <input id="mask" type="text" placeholder="255.255.255.0" autocomplete="off">
    <label class="f">DNS</label>
    <input id="dns" type="text" placeholder="192.168.1.1" autocomplete="off">
  </div>
  %OPENFIELD%
  <button class="sv" id="sv" type="button" onclick="save()">Simpan &amp; restart</button>
  <div class="msg" id="msg"></div>
  <p class="hint">Setelah disimpan perangkat restart lalu tersambung ke WiFi. Untuk mengubah lagi: tahan tombol BOOT/FLASH 3 detik, atau pakai Pengaturan di web Termux.</p>
</div>
<p class="hint" style="text-align:center;margin-top:16px">%AP% &middot; http://192.168.4.1</p>
</div>
<script>
var $=function(i){return document.getElementById(i)};
function say(t,k){var m=$('msg');m.className='msg '+k;m.textContent=t}
function mode(){$('static').className=$('dhcp').checked?'grid hide':'grid'}
async function info(){try{var j=await(await fetch('/api/info',{headers:{'X-API-Key':$('key').value.trim()}})).json();
 var s='Mode: <b>'+(j.mode==='ap'?'setup (WiFi sendiri)':'tersambung')+'</b>';
 if(j.ap)s+=' &middot; WiFi <span class="ap">'+j.ap+'</span>';
 if(j.ssid)s+=' &middot; WiFi: <b>'+j.ssid+'</b>';
 if(j.ip)s+=' &middot; IP <b>'+j.ip+'</b>';
 $('st').innerHTML=s;
 if(j.ssid&&!$('ssid').value)$('ssid').value=j.ssid;
 if(j.ip_cfg&&!$('ip').value)$('ip').value=j.ip_cfg;
 if(j.gw&&!$('gw').value)$('gw').value=j.gw;
 if(j.mask&&!$('mask').value)$('mask').value=j.mask;
 if(j.dns&&!$('dns').value)$('dns').value=j.dns;
 $('dhcp').checked=j.dhcp!==false;mode();
}catch(e){$('st').textContent='Perangkat belum menjawab'}}
async function save(){var b={ssid:$('ssid').value.trim(),pass:$('pass').value,dhcp:$('dhcp').checked,ip:$('ip').value.trim(),gw:$('gw').value.trim(),mask:$('mask').value.trim(),dns:$('dns').value.trim(),api_key:$('key').value.trim()};
 var x=$('sec');if(x)b.open_sec=+x.value;
 $('sv').disabled=true;say('Menyimpan...','work');
 try{var r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':$('key').value.trim()},body:JSON.stringify(b)});
  var j=await r.json();
  if(j.ok){say('Tersimpan. Perangkat restart dan tersambung ke WiFi...','ok');setTimeout(function(){location.reload()},10000)}
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
  pg.replace("%OPENFIELD%", "");          // ESP32 tidak punya pengaturan pintu
  return pg;
}

// >>> Dalam mode setup, akses fisik dianggap otorisasi (bisa simpan tanpa kunci lama).
bool cfgAuth() {
  if (portalMode) return true;
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
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str());
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

// ---------- Route ----------
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

// >>> PERBAIKAN: beri jeda sebelum restart supaya respons HTTP terkirim tuntas
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
  if (jsonHas(body, "pass")) cfg.pass = pass;
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

  delay(400);                       // beri waktu TCP stack mengirim respons
  otaRestartAt = millis() + 2500;   // restart total ~2.9 detik setelah respons
}

void hPortalNow() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  server.send(200, "application/json", String("{\"ok\":true,\"ap\":\"") + apName + "\",\"url\":\"http://192.168.4.1\"}");
  startPortal();
}

void setup() {
  setAux(false);
  pinMode(PIN_AUX_ON, OUTPUT);
  pinMode(PIN_AUX_OFF, OUTPUT);
  setAux(false);
  pinMode(PIN_DHT, INPUT_PULLUP);
  for (int i = 0; i < NR; i++) {
    setRelay(i, false);
    pinMode(relays[i].pin, OUTPUT);
    setRelay(i, false);
  }
  Serial.begin(115200);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

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
  server.on("/", HTTP_GET, hPage);
  server.on("/api/info", HTTP_GET, hInfo);
  server.on("/api/scan", HTTP_GET, hScan);
  server.on("/api/config", HTTP_POST, hConfig);
  server.on("/api/portal", HTTP_POST, hPortalNow);
  server.on("/api/data", HTTP_GET, hData);
  server.on("/api/relay", HTTP_POST, hRelay);
  server.on("/api/ota", HTTP_POST, hOta, hOtaUpload);
  server.begin();

  xTaskCreatePinnedToCore(sensorTask, "sensor", 6144, NULL, 1, NULL, 1);
}

void loop() {
  server.handleClient();
  const uint32_t now = millis();
  if (otaRestartAt && (int32_t)(now - otaRestartAt) >= 0) ESP.restart();

  if (digitalRead(PIN_BTN) == LOW) {
    if (!btnHeld) btnHeld = now;
    else if (now - btnHeld > 3000) { btnHeld = 0; startPortal(); }
  } else btnHeld = 0;

  if (WiFi.status() == WL_CONNECTED) wifiOkAt = now;

  if (portalMode) {
    if (cfg.ssid.length() && now - lastStaTry > 20000) { lastStaTry = now; WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str()); }
    if (WiFi.status() == WL_CONNECTED) stopPortal();
  } else {
    static uint32_t lastCheck = 0;
    if (now - lastCheck > 15000) {
      lastCheck = now;
      if (WiFi.status() != WL_CONNECTED) WiFi.reconnect();
    }
    if (WiFi.status() != WL_CONNECTED && cfg.ssid.length() && wifiOkAt && now - wifiOkAt > 120000UL) startPortal();
    if (now - wifiOkAt > 600000UL) ESP.restart();
  }
  delay(2);
}
