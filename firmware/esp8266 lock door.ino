/*
  ESP8266 Door Lock - RFID RC522 + LCD 1602 (I2C) + Relay, terintegrasi dengan server Termux

  Board   : NodeMCU 1.0 (ESP-12E)  atau  LOLIN(WEMOS) D1 mini  (core ESP8266 versi 3.x)
  Flash   : pilih ukuran yang punya FS, mis. "4MB (FS:2MB OTA:~1019KB)"
  Library : MFRC522 (by GithubCommunity). Driver LCD I2C sudah ada di file ini.

  Wiring:
    RC522   3.3V->3V3 | GND->G | RST->D0 | SDA(SS)->D8 | SCK->D5 | MOSI->D7 | MISO->D6
    LCD I2C VCC->VIN | GND->G | SDA->D2 | SCL->D1
    Relay   VCC->VIN | GND->G | IN->D4
*/
#include <ESP8266WiFi.h>
#include <SPI.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <Updater.h>
#include <LittleFS.h>
#include <Wire.h>
#include <MFRC522.h>

// ===================== KONFIGURASI =====================
#define AP_PREFIX    "Nodelix-DOOR"
#define PIN_BTN      0            // tombol FLASH/BOOT (D3/GPIO0): tahan 3 detik -> mode setup

struct Cfg {
  String ssid, pass, apiKey;
  bool dhcp = true;
  IPAddress ip{192, 168, 1, 60}, gw{192, 168, 1, 1}, mask{255, 255, 255, 0}, dns{192, 168, 1, 1};
  bool valid = false;
} cfg;

String apName;
bool portalMode = false;
uint32_t btnHeld = 0, lastStaTry = 0, wifiOkAt = 0;

// ---------- Baca / tulis pengaturan di LittleFS (/net.txt) ----------
String fileVal(const String& t, const char* key) {
  int i = t.indexOf(String(key) + "=");
  if (i < 0) return "";
  int j = t.indexOf('\n', i);
  String v = t.substring(i + String(key).length() + 1, j < 0 ? t.length() : j);
  v.trim();
  return v;
}

void cfgLoad() {
  File f = LittleFS.open("/net.txt", "r");
  if (!f) return;
  String t = f.readString(); f.close();
  cfg.ssid   = fileVal(t, "SSID");
  cfg.pass   = fileVal(t, "PASS");
  cfg.apiKey = fileVal(t, "KEY");
  cfg.dhcp   = fileVal(t, "DHCP") != "0";
  String ip = fileVal(t, "IP"), gw = fileVal(t, "GW"), mk = fileVal(t, "MASK"), dn = fileVal(t, "DNS");
  if (ip.length()) cfg.ip.fromString(ip);
  if (gw.length()) cfg.gw.fromString(gw);
  if (mk.length()) cfg.mask.fromString(mk);
  if (dn.length()) cfg.dns.fromString(dn);
  cfg.valid = cfg.ssid.length() > 0 && cfg.apiKey.length() > 0;
}

// >>> PERBAIKAN: flush() + close() + log
void cfgSave() {
  File f = LittleFS.open("/net.txt", "w");
  if (!f) {
    Serial.println("[CFG] Gagal membuka /net.txt untuk ditulis");
    return;
  }
  f.print("SSID="); f.print(cfg.ssid); f.print("\n");
  f.print("PASS="); f.print(cfg.pass); f.print("\n");
  f.print("KEY=");  f.print(cfg.apiKey); f.print("\n");
  f.print("DHCP="); f.print(cfg.dhcp ? 1 : 0); f.print("\n");
  f.print("IP=");   f.print(cfg.ip.toString()); f.print("\n");
  f.print("GW=");   f.print(cfg.gw.toString()); f.print("\n");
  f.print("MASK="); f.print(cfg.mask.toString()); f.print("\n");
  f.print("DNS=");  f.print(cfg.dns.toString()); f.print("\n");
  f.flush();
  f.close();
  Serial.println("[CFG] /net.txt tersimpan");
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

// >>> PERBAIKAN: netmask 255.255.255.0 (dan IP .0 lain) sekarang valid.
// Bug lama: "part > 0" di akhir menolak octet terakhir = 0.
bool isIp(const String& s) {
  int dots = 0, part = 0;
  bool hasDigit = false;
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '.') {
      if (!hasDigit || part > 255) return false;   // octet kosong atau > 255
      dots++; part = 0; hasDigit = false;
    } else if (c >= '0' && c <= '9') {
      part = part * 10 + (c - '0');
      if (part > 255) return false;
      hasDigit = true;
    } else {
      return false;                                // karakter bukan angka/titik
    }
  }
  return dots == 3 && hasDigit;                    // 4 octet, octet terakhir ada isinya
}

#define PIN_RC_SS     15
#define PIN_RC_RST    16
#define PIN_SDA        4
#define PIN_SCL        5
#define PIN_RELAY      2
#define RELAY_ACTIVE_LOW 1
#define LCD_ADDR    0x27

#define MAX_CARDS    150
#define FW_VER       "1.4.1"    // 1.4.1 = fix netmask + flush save + UI baru + portal auth bypass
// =======================================================

// ---------- LCD 1602 lewat PCF8574 (mode 4-bit) ----------
struct Lcd {
  uint8_t addr = LCD_ADDR, bl = 0x08;
  void w(uint8_t v) { Wire.beginTransmission(addr); Wire.write((uint8_t)(v | bl)); Wire.endTransmission(); }
  void pulse(uint8_t v) { w(v | 0x04); delayMicroseconds(2); w(v & ~0x04); delayMicroseconds(60); }
  void nib(uint8_t n, uint8_t rs) { pulse((uint8_t)((n << 4) | rs)); }
  void cmd(uint8_t c) { nib(c >> 4, 0); nib(c & 0x0F, 0); if (c <= 3) delay(3); }
  void chr(uint8_t c) { nib(c >> 4, 1); nib(c & 0x0F, 1); }
  void begin() {
    Wire.beginTransmission(0x27);
    if (Wire.endTransmission() == 0) addr = 0x27;
    else { Wire.beginTransmission(0x3F); if (Wire.endTransmission() == 0) addr = 0x3F; }
    delay(60); w(0);
    nib(0x03, 0); delay(5); nib(0x03, 0); delay(1); nib(0x03, 0); delay(1); nib(0x02, 0);
    cmd(0x28); cmd(0x0C); cmd(0x06); cmd(0x01);
  }
  void text16(uint8_t row, const char* s) { cmd(0x80 | (row ? 0x40 : 0x00)); for (uint8_t i = 0; i < 16; i++) chr((uint8_t)s[i]); }
} lcd;

String shownA = "", shownB = "";
void lcdLine(uint8_t row, const String& s) {
  char b[17]; memset(b, ' ', 16); b[16] = 0;
  int n = s.length(); if (n > 16) n = 16;
  memcpy(b + (16 - n) / 2, s.c_str(), n);
  lcd.text16(row, b);
}
void lcdShow(const String& a, const String& b) {
  if (a != shownA) { lcdLine(0, a); shownA = a; }
  if (b != shownB) { lcdLine(1, b); shownB = b; }
}

// ---------- State ----------
MFRC522 rfid(PIN_RC_SS, PIN_RC_RST);
ESP8266WebServer server(80);

String cards[MAX_CARDS]; bool adminCards[MAX_CARDS] = {}; int nCards = 0;
long cfgVer = 0; int openSec = 5; bool enabled = true;
bool relayOn = false; uint32_t relayOffAt = 0;
bool enrolling = false; uint32_t enrollUntil = 0;
uint32_t lastPoll = 0, bootId = 0, msgUntil = 0;
String m1, m2;

struct Ev { uint32_t id; uint32_t at; char type[16]; char uid[24]; };
Ev evs[8]; uint32_t evSeq = 0;

void pushEv(const char* type, const String& uid) {
  uint32_t id = ++evSeq; Ev& e = evs[id % 8];
  e.id = id; e.at = millis();
  strncpy(e.type, type, 15); e.type[15] = 0;
  strncpy(e.uid, uid.c_str(), 23); e.uid[23] = 0;
}
void showMsg(const String& a, const String& b, uint32_t ms) { m1 = a; m2 = b; msgUntil = millis() + ms; }
bool serverOk() { return lastPoll != 0 && (millis() - lastPoll) < 8000; }
bool hasCard(const String& u) { for (int i = 0; i < nCards; i++) if (cards[i] == u) return true; return false; }
bool isAdminCard(const String& u) { for (int i = 0; i < nCards; i++) if (cards[i] == u) return adminCards[i]; return false; }
int enrollLeft() { if (!enrolling) return 0; int32_t l = (int32_t)(enrollUntil - millis()); return l > 0 ? (l + 999) / 1000 : 0; }

void relaySet(bool on) { relayOn = on; digitalWrite(PIN_RELAY, (on == !RELAY_ACTIVE_LOW) ? HIGH : LOW); }
void openDoor(int sec) {
  uint32_t ms = sec > 0 ? (uint32_t)sec * 1000UL : 300UL;
  relaySet(true); relayOffAt = millis() + ms;
  if (ms < 1500) ms = 1500;
  showMsg("Selamat datang", "UNLOCK", ms);
}

// ---------- Konfigurasi & daftar kartu (LittleFS) ----------
bool parseCfg(const String& t) {
  if (t.indexOf("V=") < 0) return false;
  nCards = 0;
  int i = 0, len = t.length();
  while (i < len) {
    int j = t.indexOf('\n', i); if (j < 0) j = len;
    String ln = t.substring(i, j); ln.trim(); i = j + 1;
    if (ln.length() < 3 || ln[1] != '=') continue;
    char k = ln[0]; String v = ln.substring(2); v.trim();
    if (k == 'V') cfgVer = v.toInt();
    else if (k == 'S') openSec = constrain((int)v.toInt(), 0, 10);
    else if (k == 'E') enabled = v.toInt() != 0;
    else if (k == 'C' || k == 'A') {
      v.toUpperCase();
      if (v.length() >= 8 && v.length() <= 20 && nCards < MAX_CARDS) {
        cards[nCards] = v; adminCards[nCards] = k == 'A'; nCards++;
      }
    }
  }
  return true;
}

void saveCfg() {
  File f = LittleFS.open("/cfg.txt", "w");
  if (!f) {
    Serial.println("[CFG] Gagal membuka /cfg.txt");
    return;
  }
  f.print("V="); f.print(cfgVer); f.print("\nS="); f.print(openSec); f.print("\nE="); f.print(enabled ? 1 : 0); f.print("\n");
  for (int i = 0; i < nCards; i++) { f.print(adminCards[i] ? "A=" : "C="); f.print(cards[i]); f.print("\n"); }
  f.flush();
  f.close();
  Serial.println("[CFG] /cfg.txt tersimpan");
}
void loadCfg() {
  File f = LittleFS.open("/cfg.txt", "r"); if (!f) return;
  String t = f.readString(); f.close(); parseCfg(t);
}

// ---------- RFID ----------
String readUid() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return "";
  String u;
  for (byte i = 0; i < rfid.uid.size; i++) { char b[3]; sprintf(b, "%02X", rfid.uid.uidByte[i]); u += b; }
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  return u;
}

void handleCard(const String& uid) {
  static String lastUid; static uint32_t lastAt = 0;
  uint32_t now = millis();
  if (uid == lastUid && now - lastAt < 1500) return;
  lastUid = uid; lastAt = now;
  Serial.println("Kartu: " + uid);

  if (enrolling) {
    enrolling = false;
    bool dup = hasCard(uid);
    pushEv(dup ? "enroll_dup" : "enroll", uid);
    if (dup) showMsg("Sudah", "terdaftar", 2000); else showMsg("Kartu terbaca", "Menyimpan...", 2500);
    return;
  }
  if (!hasCard(uid)) { pushEv("unknown", uid); showMsg("Kartu belum", "di daftar", 2500); return; }
  if (!enabled && !isAdminCard(uid)) { pushEv("locked", uid);  showMsg("Selamat datang", "LOCK", 2000); return; }
  openDoor(openSec); pushEv("ok", uid);
}

// ---------- HTTP API (butuh header X-API-Key) ----------
bool auth() {
  if (cfg.apiKey.length() && (server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey)) {
    lastPoll = millis(); if (!lastPoll) lastPoll = 1; return true;
  }
  server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}");
  return false;
}

void hStatus() {
  if (!auth()) return;
  uint32_t now = millis();
  int32_t left = relayOn ? (int32_t)(relayOffAt - now) : 0; if (left < 0) left = 0;
  String j; j.reserve(1200);
  j += F("{\"ok\":true,\"device\":\"esp8266-door\",\"fw\":\""); j += FW_VER;
  j += F("\",\"boot\":"); j += bootId;
  j += F(",\"ip\":\""); j += (portalMode ? WiFi.softAPIP() : WiFi.localIP()).toString();
  j += F("\",\"rssi\":"); j += WiFi.RSSI();
  j += F(",\"uptime\":"); j += now / 1000;
  j += F(",\"heap\":"); j += ESP.getFreeHeap();
  j += F(",\"ver\":"); j += cfgVer;
  j += F(",\"open\":"); j += relayOn ? 1 : 0;
  j += F(",\"left\":"); j += left;
  j += F(",\"enabled\":"); j += enabled ? 1 : 0;
  j += F(",\"sec\":"); j += openSec;
  j += F(",\"enroll\":"); j += enrollLeft();
  j += F(",\"cards\":"); j += nCards;
  j += F(",\"events\":[");
  bool first = true;
  for (int i = 0; i < 8; i++) {
    if (!evs[i].id) continue;
    if (!first) { j += ','; }
    first = false;
    j += F("{\"id\":"); j += evs[i].id;
    j += F(",\"ago\":"); j += (uint32_t)(now - evs[i].at);
    j += F(",\"type\":\""); j += evs[i].type;
    j += F("\",\"uid\":\""); j += evs[i].uid; j += F("\"}");
  }
  j += F("]}");
  server.send(200, "application/json", j);
}

void hOpen() {
  if (!auth()) return;
  int s = server.hasArg("sec") ? constrain((int)server.arg("sec").toInt(), 0, 10) : openSec;
  openDoor(s);
  server.send(200, "application/json", "{\"ok\":true}");
}
void hClose() {
  if (!auth()) return;
  relaySet(false); msgUntil = 0;
  server.send(200, "application/json", "{\"ok\":true}");
}
void hEnroll() {
  if (!auth()) return;
  int s = constrain((int)server.arg("sec").toInt(), 0, 120);
  if (s > 0) { enrolling = true; enrollUntil = millis() + (uint32_t)s * 1000UL; }
  else { enrolling = false; showMsg("Dibatalkan", "", 1000); }
  server.send(200, "application/json", "{\"ok\":true}");
}

// ---------- OTA ----------
#define OTA_USE_GETERR 1
#if OTA_USE_GETERR
  #define OTA_ERRSTR() Update.getErrorString()
#else
  #define OTA_ERRSTR() Update.errorString()
#endif

bool otaOk = false, otaDenied = false;
String otaErr;
uint32_t otaWritten = 0, otaRestartAt = 0, otaLcdAt = 0;
int32_t otaTotal = 0;

void hOtaUpload() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    otaOk = false; otaDenied = false; otaErr = ""; otaWritten = 0; otaLcdAt = 0;
    if (!cfg.apiKey.length() || server.header("X-API-Key") != cfg.apiKey) { otaDenied = true; otaErr = "unauthorized"; return; }
    otaTotal = server.header("Content-Length").toInt();
    lcdShow("Update firmware", "0%");
    uint32_t space = (ESP.getFreeSketchSpace() - 0x1000) & 0xFFFFF000;
    if (!Update.begin(space)) otaErr = OTA_ERRSTR();
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (otaDenied || otaErr.length() || !Update.isRunning()) return;
    if (otaWritten == 0 && (up.currentSize < 1 || up.buf[0] != 0xE9)) { otaErr = "bukan gambar firmware"; return; }
    if (Update.write(up.buf, up.currentSize) != up.currentSize) { otaErr = OTA_ERRSTR(); return; }
    otaWritten += up.currentSize;
    if (millis() - otaLcdAt > 500) {
      otaLcdAt = millis();
      String b = (otaTotal > 1024 && (uint32_t)otaTotal >= otaWritten) ? String((uint32_t)((uint64_t)otaWritten * 100 / (uint32_t)otaTotal)) + "%"
                                                                : String(otaWritten / 1024) + " KB";
      lcdShow("Update firmware", b);
    }
  } else if (up.status == UPLOAD_FILE_END) {
    if (otaDenied || otaErr.length()) return;
    if (Update.end(true)) otaOk = true; else otaErr = OTA_ERRSTR();
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    if (!otaErr.length()) otaErr = "upload dibatalkan";
    if (Update.isRunning() || otaWritten) otaRestartAt = millis() + 1500;
  }
}

void hOta() {
  server.sendHeader("Connection", "close");
  if (otaDenied) { showMsg("Update gagal", "Kunci API salah", 4000); server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  if (otaOk) {
    lcdShow("Update selesai", "Restart...");
    otaRestartAt = millis() + 1200;
    server.send(200, "application/json", "{\"ok\":true,\"device\":\"esp8266-door\"}");
    return;
  }
  String e = otaErr.length() ? otaErr : (otaWritten ? "gagal menulis flash" : "tidak ada file");
  e.replace("\"", "'");
  showMsg("Update gagal", e.substring(0, 16), 6000);
  server.send(500, "application/json", "{\"ok\":false,\"error\":\"" + e + "\"}");
}

void hSync() {
  if (!auth()) return;
  if (!parseCfg(server.arg("plain"))) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"format\"}"); return; }
  saveCfg();
  server.send(200, "application/json", String("{\"ok\":true,\"ver\":") + cfgVer + "}");
}

void connectWifi() {
  if (!cfg.ssid.length()) return;
  WiFi.mode(WIFI_STA); WiFi.persistent(false); WiFi.setAutoReconnect(true);
  if (!cfg.dhcp) WiFi.config(cfg.ip, cfg.gw, cfg.mask, cfg.dns);
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
}

// ===================== HALAMAN PENGATURAN (UI BARU) =====================
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
    <input id="ip" type="text" placeholder="192.168.1.60" autocomplete="off">
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
  <p class="hint">Setelah disimpan perangkat restart lalu tersambung ke WiFi. Untuk mengubah lagi: tahan tombol FLASH/BOOT 3 detik, atau pakai Pengaturan &gt; Pintu RFID di web Termux.</p>
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
  pg.replace("%BOARD%", "ESP8266 pintu RFID");
  pg.replace("%AP%", apName);
  pg.replace("%SEC%", String(openSec));
  pg.replace("%OPENFIELD%", "<label class=\"f\">Waktu relay terbuka (detik, 0 = pulsa 0,3 dtk)</label><input id=\"sec\" type=\"text\" value=\"%SEC%\">");
  return pg;
}

// >>> Mode setup = akses fisik -> boleh simpan tanpa kunci lama
bool cfgAuth() {
  if (portalMode) return true;
  if (!cfg.apiKey.length()) return true;
  return server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey;
}
bool jsonHas(const String& body, const char* key) { return body.indexOf(String("\"") + key + "\":") >= 0; }

// ---------- WiFi ----------
void startPortal() {
  if (portalMode) return;
  portalMode = true; lastStaTry = millis();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str());
  Serial.printf("\n[%s] Mode setup aktif: sambungkan HP ke WiFi \"%s\", buka http://%s\n", FW_VER, apName.c_str(), WiFi.softAPIP().toString().c_str());
  showMsg("Mode setup", "192.168.4.1", 6000);
}
void stopPortal() {
  if (!portalMode) return;
  portalMode = false;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  Serial.printf("[%s] Terhubung ke WiFi \"%s\", mode setup dimatikan. IP: %s\n", FW_VER, cfg.ssid.c_str(), WiFi.localIP().toString().c_str());
  showMsg("Selamat datang", "Server ON", 2000);
}

// ---------- Route ----------
void hPage() { server.send(200, "text/html; charset=utf-8", pageHtml()); }

void hInfo() {
  bool ok = cfgAuth();
  char b[420];
  IPAddress ipNow = portalMode ? WiFi.softAPIP() : WiFi.localIP();
  snprintf(b, sizeof(b),
    "{\"ok\":true,\"fw\":\"" FW_VER "\",\"mode\":\"%s\",\"ap\":\"%s\",\"configured\":%d,"
    "\"ssid\":\"%s\",\"ip\":\"%s\",\"dhcp\":%d,\"ip_cfg\":\"%s\",\"gw\":\"%s\",\"mask\":\"%s\",\"dns\":\"%s\",\"sec\":%d}",
    portalMode ? "ap" : "sta", apName.c_str(), cfg.valid ? 1 : 0,
    ok ? cfg.ssid.c_str() : "", ipNow.toString().c_str(), cfg.dhcp ? 1 : 0,
    ok ? cfg.ip.toString().c_str() : "", ok ? cfg.gw.toString().c_str() : "", ok ? cfg.mask.toString().c_str() : "", ok ? cfg.dns.toString().c_str() : "", openSec);
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
  if (jsonHas(body, "pass")) cfg.pass = pass;
  if (key.length()) cfg.apiKey = key;
  cfg.dhcp = dhcp;
  if (ip.length()) cfg.ip.fromString(ip);
  if (gw.length()) cfg.gw.fromString(gw);
  if (mask.length()) cfg.mask.fromString(mask);
  if (dns.length()) cfg.dns.fromString(dns);
  if (jsonHas(body, "open_sec")) { openSec = constrain(jsonStr(body, "open_sec").toInt(), 0, 10); saveCfg(); }
  if (!cfg.ssid.length() || !cfg.apiKey.length()) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"nama WiFi dan kunci API wajib diisi\"}");
    return;
  }
  cfgSave();
  Serial.printf("[%s] Pengaturan disimpan: WiFi \"%s\", IP %s, kunci API %s\n",
                FW_VER, cfg.ssid.c_str(), cfg.dhcp ? "DHCP" : cfg.ip.toString().c_str(), cfg.apiKey.c_str());

  server.send(200, "application/json", String("{\"ok\":true,\"saved\":\"") + cfg.ssid + "\"}");
  lcdShow("Pengaturan", "disimpan");

  delay(400);                     // beri waktu TCP stack mengirim respons
  otaRestartAt = millis() + 2500; // restart total ~2.9 detik setelah respons
}

void hPortalNow() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  server.send(200, "application/json", String("{\"ok\":true,\"ap\":\"") + apName + "\",\"url\":\"http://192.168.4.1\"}");
  startPortal();
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT); relaySet(false);
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL); Wire.setClock(100000);
  lcd.begin();
  lcdShow("Selamat datang", "Konek WiFi...");

  if (!LittleFS.begin()) { LittleFS.format(); LittleFS.begin(); }
  loadCfg();

  SPI.begin(); rfid.PCD_Init(); rfid.PCD_SetAntennaGain(rfid.RxGain_max);
  Serial.printf("RC522 versi: 0x%02X\n", rfid.PCD_ReadRegister(rfid.VersionReg));

  pinMode(PIN_BTN, INPUT_PULLUP);
  cfgLoad();
  {
    String suf = String((uint16_t)(ESP.getChipId() & 0xFFFF), HEX);
    suf.toUpperCase();
    apName = String(AP_PREFIX) + "-" + suf;
  }
  const bool forceSetup = digitalRead(PIN_BTN) == LOW;
  if (cfg.valid && !forceSetup) {
    connectWifi();
    for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
    if (WiFi.status() != WL_CONNECTED) startPortal();
    else Serial.printf("\nWiFi: \"%s\" terhubung  IP: %s  kartu: %d  kunci API: %s\n", cfg.ssid.c_str(), WiFi.localIP().toString().c_str(), nCards, cfg.apiKey.c_str());
  } else {
    startPortal();
  }
  wifiOkAt = millis();
  bootId = ESP.getCycleCount() ^ ESP.getChipId(); if (!bootId) bootId = 1;
  MDNS.begin("pintu-esp8266");

  server.collectHeaders("X-API-Key");
  server.on("/", HTTP_GET, hPage);
  server.on("/api/info", HTTP_GET, hInfo);
  server.on("/api/scan", HTTP_GET, hScan);
  server.on("/api/config", HTTP_POST, hConfig);
  server.on("/api/portal", HTTP_POST, hPortalNow);
  server.on("/api/status", HTTP_GET, hStatus);
  server.on("/api/open", HTTP_POST, hOpen);
  server.on("/api/close", HTTP_POST, hClose);
  server.on("/api/enroll", HTTP_POST, hEnroll);
  server.on("/api/sync", HTTP_POST, hSync);
  server.on("/api/ota", HTTP_POST, hOta, hOtaUpload);
  server.begin();
}

void loop() {
  server.handleClient();
  MDNS.update();
  uint32_t now = millis();

  if (otaRestartAt && (int32_t)(now - otaRestartAt) >= 0) ESP.restart();

  if (relayOn && (int32_t)(now - relayOffAt) >= 0) relaySet(false);
  if (enrolling && (int32_t)(now - enrollUntil) >= 0) { enrolling = false; pushEv("enroll_timeout", ""); showMsg("Waktu habis", "", 1500); }

  static uint32_t tRfid = 0, tChk = 0, tWifi = 0;
  if (now - tRfid >= 80) { tRfid = now; String u = readUid(); if (u.length()) handleCard(u); }

  if (now - tChk >= 10000) {
    tChk = now;
    byte v = rfid.PCD_ReadRegister(rfid.VersionReg);
    if (v == 0x00 || v == 0xFF) { rfid.PCD_Init(); rfid.PCD_SetAntennaGain(rfid.RxGain_max); }
  }

  if (WiFi.status() == WL_CONNECTED) wifiOkAt = now;

  if (digitalRead(PIN_BTN) == LOW) {
    if (!btnHeld) btnHeld = now;
    else if (now - btnHeld > 3000) { btnHeld = 0; startPortal(); }
  } else btnHeld = 0;

  if (portalMode) {
    if (cfg.ssid.length() && now - lastStaTry > 20000) { lastStaTry = now; connectWifi(); }
    if (WiFi.status() == WL_CONNECTED) stopPortal();
  } else {
    if (now - tWifi >= 15000) { tWifi = now; if (WiFi.status() != WL_CONNECTED) WiFi.reconnect(); }
    if (WiFi.status() != WL_CONNECTED && cfg.ssid.length() && wifiOkAt && now - wifiOkAt > 120000UL) startPortal();
    if (now - wifiOkAt > 600000UL && !portalMode) ESP.restart();
  }

  String a, b;
  if (portalMode) { a = "Mode setup"; b = "192.168.4.1"; }
  else if (enrolling) { a = "Tambah kartu"; b = "Tempel kartu " + String(enrollLeft()) + "s"; }
  else if ((int32_t)(msgUntil - now) > 0) { a = m1; b = m2; }
  else { a = "Selamat datang"; b = relayOn ? "UNLOCK" : (serverOk() ? "Server ON" : "Server OFF"); }
  lcdShow(a, b);
  delay(2);
}
