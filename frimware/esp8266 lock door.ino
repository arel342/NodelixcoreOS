/*
  ESP8266 Door Lock - RFID RC522 + LCD 1602 (I2C) + Relay, terintegrasi dengan server Termux

  Board   : NodeMCU 1.0 (ESP-12E)  atau  LOLIN(WEMOS) D1 mini  (core ESP8266 versi 3.x)
  Flash   : pilih ukuran yang punya FS, mis. "4MB (FS:2MB OTA:~1019KB)"  (kartu disimpan di LittleFS)
  Library : MFRC522 (by GithubCommunity) -> Library Manager. Driver LCD I2C sudah ada di file ini.

  Wiring (label NodeMCU / D1 mini):
    RC522   3.3V -> 3V3 | GND -> G | RST -> D0 | SDA(SS) -> D8 | SCK -> D5 | MOSI -> D7 | MISO -> D6 | IRQ -> (kosong)
    LCD I2C VCC  -> VIN (5V) | GND -> G | SDA -> D2 | SCL -> D1
    Relay   VCC  -> VIN (5V) | GND -> G | IN  -> D4   (LED bawaan ikut menyala saat relay aktif)
  Relay 1 channel; COM/NO ke kunci pintu (solenoid / door strike) dengan catu daya sendiri.

  Tampilan LCD:  "Selamat datang" / "Server ON"
    kartu sah -> UNLOCK | kartu belum terdaftar -> "Kartu belum / di daftar" | lock door dimatikan dari server -> LOCK

  Update firmware (OTA) - sejak versi 1.2:
    Server (Termux) mengirim file .bin ke POST /api/ota (multipart, header X-API-Key). Gambar baru
    ditulis ke partisi OTA lewat library Update; kalau verifikasi berhasil ESP restart sendiri dan
    memakai firmware baru, kalau gagal gambar lama tetap jalan. Pilih skema flash yang punya OTA,
    mis. "4MB (FS:2MB OTA:~1019KB)". Selama proses, LCD menampilkan "Update firmware" + persen.

  Pengaturan jaringan dari WEB - sejak versi 1.3 (tidak perlu edit file ini lagi):
    * Pertama kali dinyalakan (atau tombol FLASH/BOOT ditahan 3 detik), ESP8266 menyalakan WiFi
      sendiri "Nodelix-DOOR-xxxx". Sambungkan HP ke WiFi itu, buka http://192.168.4.1, lalu isi
      nama WiFi, password WiFi, IP (DHCP/statis), dan kunci API.
    * Nilai disimpan di LittleFS (/net.txt), tetap ada walau listrik mati. WiFi rumah juga masih
      dicoba terus dan mode setup menutup sendiri begitu tersambung.
    * Bisa juga dikirim dari web Termux: Pengaturan > Pintu RFID (Mode setup / Kirim pengaturan).
    * RFID, LCD, dan relay tetap bekerja normal saat mode setup.

  Endpoint (header X-API-Key, samakan dengan DOOR_API_KEY di .env):
    GET  /                halaman pengaturan (nama WiFi, password, IP, kunci API)
    GET  /api/info        status singkat + pengaturan sekarang
    GET  /api/scan        daftar WiFi yang terdeteksi
    POST /api/config      simpan pengaturan baru (dipakai halaman ini & web Termux)
    POST /api/portal      masuk mode setup sekarang
    GET  /api/status, POST /api/open /api/close /api/enroll /api/sync, POST /api/ota
*/
#include <ESP8266WiFi.h>
#include <SPI.h> 
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <Updater.h>          // OTA: menulis firmware baru ke partisi OTA
#include <LittleFS.h>
#include <Wire.h>
#include <MFRC522.h>

// ===================== KONFIGURASI =====================
// Nama WiFi, password WiFi, IP, dan kunci API tidak lagi ditulis di file ini: semuanya diisi
// dari halaman web mode setup (192.168.4.1) atau dari web Termux, lalu disimpan di LittleFS.
#define AP_PREFIX    "Nodelix-DOOR"
#define PIN_BTN      0            // tombol FLASH/BOOT (D3/GPIO0): tahan 3 detik -> mode setup

struct Cfg {
  String ssid, pass, apiKey;
  bool dhcp = true;
  IPAddress ip{192, 168, 1, 60}, gw{192, 168, 1, 1}, mask{255, 255, 255, 0}, dns{192, 168, 1, 1};
  bool valid = false;             // sudah pernah diisi (ada nama WiFi + kunci API)?
} cfg;

String apName;                    // nama WiFi mode setup, mis. Nodelix-DOOR-1A2B
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
void cfgSave() {
  File f = LittleFS.open("/net.txt", "w");
  if (!f) return;
  f.print("SSID="); f.print(cfg.ssid); f.print("\n");
  f.print("PASS="); f.print(cfg.pass); f.print("\n");
  f.print("KEY="); f.print(cfg.apiKey); f.print("\n");
  f.print("DHCP="); f.print(cfg.dhcp ? 1 : 0); f.print("\n");
  f.print("IP="); f.print(cfg.ip.toString()); f.print("\n");
  f.print("GW="); f.print(cfg.gw.toString()); f.print("\n");
  f.print("MASK="); f.print(cfg.mask.toString()); f.print("\n");
  f.print("DNS="); f.print(cfg.dns.toString()); f.print("\n");
  f.close();
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

#define PIN_RC_SS     15    // D8  RC522 SDA (SS)
#define PIN_RC_RST    16    // D0  RC522 RST   (SCK=D5/GPIO14, MISO=D6/GPIO12, MOSI=D7/GPIO13 tetap, SPI hardware)
#define PIN_SDA        4    // D2  LCD SDA
#define PIN_SCL        5    // D1  LCD SCL
#define PIN_RELAY      2    // D4  IN relay
#define RELAY_ACTIVE_LOW 1  // modul relay umumnya aktif LOW. Jika terbalik, ubah ke 0
#define LCD_ADDR    0x27    // alamat I2C LCD (0x27 atau 0x3F; otomatis dicoba keduanya)

#define MAX_CARDS    150
#define FW_VER       "1.3"      // 1.2 = OTA, 1.3 = mode setup AP + semua pengaturan lewat web
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
void lcdLine(uint8_t row, const String& s) {            // rata tengah, 16 kolom
  char b[17]; memset(b, ' ', 16); b[16] = 0;
  int n = s.length(); if (n > 16) n = 16;
  memcpy(b + (16 - n) / 2, s.c_str(), n);
  lcd.text16(row, b);
}
void lcdShow(const String& a, const String& b) {       // hanya menulis baris yang berubah (tanpa kedip)
  if (a != shownA) { lcdLine(0, a); shownA = a; }
  if (b != shownB) { lcdLine(1, b); shownB = b; }
}

// ---------- State ----------
MFRC522 rfid(PIN_RC_SS, PIN_RC_RST);
ESP8266WebServer server(80);

String cards[MAX_CARDS]; bool adminCards[MAX_CARDS] = {}; int nCards = 0;
long cfgVer = 0; int openSec = 5; bool enabled = true;     // dari server, disimpan di /cfg.txt
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
void openDoor(int sec) {                                 // 0 detik = pulsa singkat 0,3 detik
  uint32_t ms = sec > 0 ? (uint32_t)sec * 1000UL : 300UL;
  relaySet(true); relayOffAt = millis() + ms;
  if (ms < 1500) ms = 1500;
  showMsg("Selamat datang", "UNLOCK", ms);
}

// ---------- Konfigurasi & daftar kartu (LittleFS) ----------
// Format teks:  V=<versi> / S=<detik relay 0-10> / E=<1 lock door aktif, 0 mati> / C=<UID biasa> / A=<UID admin> (satu per baris)
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
  File f = LittleFS.open("/cfg.txt", "w"); if (!f) return;
  f.print("V="); f.print(cfgVer); f.print("\nS="); f.print(openSec); f.print("\nE="); f.print(enabled ? 1 : 0); f.print("\n");
  for (int i = 0; i < nCards; i++) { f.print(adminCards[i] ? "A=" : "C="); f.print(cards[i]); f.print("\n"); }
  f.close();
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

  if (enrolling) {                                       // mode tambah kartu: UID hanya dilaporkan ke server
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
  if (cfg.apiKey.length() && (server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey)) { lastPoll = millis(); if (!lastPoll) lastPoll = 1; return true; }
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

void hOpen() {                                           // buka tanpa kartu (dari server); tetap bisa walau lock door dimatikan
  if (!auth()) return;
  int s = server.hasArg("sec") ? constrain((int)server.arg("sec").toInt(), 0, 10) : openSec;
  openDoor(s);
  server.send(200, "application/json", "{\"ok\":true}");
}

void hClose() {                                          // kunci lagi sekarang
  if (!auth()) return;
  relaySet(false); msgUntil = 0;
  server.send(200, "application/json", "{\"ok\":true}");
}

void hEnroll() {                                         // /api/enroll?sec=30  (sec=0 membatalkan)
  if (!auth()) return;
  int s = constrain((int)server.arg("sec").toInt(), 0, 120);
  if (s > 0) { enrolling = true; enrollUntil = millis() + (uint32_t)s * 1000UL; }
  else { enrolling = false; showMsg("Dibatalkan", "", 1000); }
  server.send(200, "application/json", "{\"ok\":true}");
}

// ---------- Update firmware (OTA): POST /api/ota, body multipart berisi file .bin ----------
// Dipakai tab "Update Firmware" di web dan menu Termux (node update-fw.js).
//
// Nama fungsi pesan error berbeda antar core (ESP8266: getErrorString, ESP32: errorString).
// Kalau core kamu ternyata berbeda, tukar angka OTA_USE_GETERR di bawah.
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
    // Kunci API diperiksa sebelum satu byte pun ditulis ke flash
    if (!cfg.apiKey.length() || server.header("X-API-Key") != cfg.apiKey) { otaDenied = true; otaErr = "unauthorized"; return; }
    otaTotal = server.header("Content-Length").toInt();                 // perkiraan ukuran kiriman (untuk persen di LCD)
    lcdShow("Update firmware", "0%");
    uint32_t space = (ESP.getFreeSketchSpace() - 0x1000) & 0xFFFFF000;   // ruang maksimal untuk gambar baru
    if (!Update.begin(space)) otaErr = OTA_ERRSTR();
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (otaDenied || otaErr.length() || !Update.isRunning()) return;
    // Gambar firmware ESP selalu diawali byte 0xE9: tolak file lain sebelum ditulis
    if (otaWritten == 0 && (up.currentSize < 1 || up.buf[0] != 0xE9)) { otaErr = "bukan gambar firmware"; return; }
    if (Update.write(up.buf, up.currentSize) != up.currentSize) { otaErr = OTA_ERRSTR(); return; }
    otaWritten += up.currentSize;
    if (millis() - otaLcdAt > 500) {                                    // progres di LCD (loop() sedang sibuk)
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
    // Core ini tidak punya Update.abort(): kalau update sudah mulai, restart supaya status updater
    // bersih dan percobaan berikutnya bisa Update.begin() lagi. Firmware lama tetap dipakai karena
    // partisi boot baru diganti setelah Update.end() berhasil.
    if (Update.isRunning() || otaWritten) otaRestartAt = millis() + 1500;
  }
}

void hOta() {
  server.sendHeader("Connection", "close");
  if (otaDenied) { showMsg("Update gagal", "Kunci API salah", 4000); server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  if (otaOk) {
    lcdShow("Update selesai", "Restart...");
    otaRestartAt = millis() + 1200;                                     // jawab dulu ke server, baru restart (lihat loop)
    server.send(200, "application/json", "{\"ok\":true,\"device\":\"esp8266-door\"}");
    return;
  }
  String e = otaErr.length() ? otaErr : (otaWritten ? "gagal menulis flash" : "tidak ada file");
  e.replace("\"", "'");
  showMsg("Update gagal", e.substring(0, 16), 6000);
  server.send(500, "application/json", "{\"ok\":false,\"error\":\"" + e + "\"}");
}

void hSync() {                                           // body text/plain, format sama dengan /cfg.txt
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


// ===================== MODE SETUP: WiFi sendiri + halaman pengaturan =====================
// Halaman pengaturan yang sama seperti versi ESP32:
//   * mode setup  -> http://192.168.4.1 (perangkat menyalakan WiFi "%AP_PREFIX%-xxxx")
//   * sudah tersambung -> http://IP-perangkat (perlu kunci API bila sudah diisi)
// Nama WiFi, password WiFi, IP, dan kunci API disimpan di LittleFS (/net.txt), jadi
// tidak perlu lagi mengedit file .ino. RFID, LCD, dan relay tetap bekerja di mode setup.
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
    <label class="f">IP perangkat</label><input id="ip" placeholder="192.168.1.60">
    <label class="f">Gateway</label><input id="gw" placeholder="192.168.1.1">
    <label class="f">Netmask</label><input id="mask" placeholder="255.255.255.0">
    <label class="f">DNS</label><input id="dns" placeholder="192.168.1.1">
  </div>
  <label class="f">Kunci API (samakan dengan DOOR_API_KEY di web Termux)</label><input id="key" placeholder="nlx-...">
  <label class="f">Kunci API sekarang (wajib bila perangkat sudah pernah diisi)</label><input id="cur" placeholder="kunci lama / kosongkan bila belum pernah">
  %OPENFIELD%
  <button class="sv" id="sv" type="button" onclick="save()">Simpan &amp; restart</button>
  <div class="msg" id="msg"></div>
  <p class="hint">Setelah disimpan perangkat restart lalu tersambung ke WiFi rumah. Untuk mengubah lagi: tahan tombol FLASH/BOOT 3 detik, atau pakai Pengaturan &gt; Pintu RFID di web Termux.</p>
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
 a.forEach(function(s){if(s&&!$('ssid').value)$('ssid').value=s});
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
  pg.replace("%BOARD%", "ESP8266 pintu RFID");
  pg.replace("%AP%", apName);
  pg.replace("%SEC%", String(openSec));
  pg.replace("%OPENFIELD%", "<label class=\"f\">Waktu relay terbuka (detik, 0 = pulsa 0,3 dtk)</label><input id=\"sec\" type=\"text\" value=\"%SEC%\">");
  return pg;
}

// Perangkat baru (belum ada kunci) boleh diatur siapa saja; setelah ada kunci, harus cocok.
bool cfgAuth() {
  if (!cfg.apiKey.length()) return true;
  return server.header("X-API-Key") == cfg.apiKey || server.arg("key") == cfg.apiKey;
}
bool jsonHas(const String& body, const char* key) { return body.indexOf(String("\"") + key + "\":") >= 0; }

// ---------- WiFi ----------
void startPortal() {
  if (portalMode) return;
  portalMode = true; lastStaTry = millis();
  WiFi.mode(WIFI_AP_STA);                        // AP untuk pengaturan, STA untuk mencoba WiFi rumah terus
  WiFi.softAP(apName.c_str());                   // tanpa password: dipakai sebentar saat mengisi pengaturan
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

// ---------- Route halaman pengaturan ----------
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
  if (jsonHas(body, "pass")) cfg.pass = pass;              // password hanya diganti kalau memang dikirim
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
  otaRestartAt = millis() + 1500;                          // jawab dulu, baru restart dengan pengaturan baru
}

// Dipakai tombol "Mode setup" di web Termux
void hPortalNow() {
  if (!cfgAuth()) { server.send(401, "application/json", "{\"ok\":false,\"error\":\"unauthorized\"}"); return; }
  server.send(200, "application/json", String("{\"ok\":true,\"ap\":\"") + apName + "\",\"url\":\"http://192.168.4.1\"}");
  startPortal();
}

void setup() {
  pinMode(PIN_RELAY, OUTPUT); relaySet(false);           // relay harus OFF sedini mungkin saat boot
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL); Wire.setClock(100000);
  lcd.begin();
  lcdShow("Selamat datang", "Konek WiFi...");

  if (!LittleFS.begin()) { LittleFS.format(); LittleFS.begin(); }
  loadCfg();

  SPI.begin(); rfid.PCD_Init(); rfid.PCD_SetAntennaGain(rfid.RxGain_max);
  Serial.printf("RC522 versi: 0x%02X\n", rfid.PCD_ReadRegister(rfid.VersionReg));

  // Pengaturan jaringan dari LittleFS. Belum pernah diisi, atau tombol FLASH ditahan saat
  // menyala -> mode setup: WiFi sendiri + halaman pengaturan di http://192.168.4.1
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
  server.on("/", HTTP_GET, hPage);                         // halaman pengaturan (nama WiFi, IP, kunci API)
  server.on("/api/info", HTTP_GET, hInfo);
  server.on("/api/scan", HTTP_GET, hScan);
  server.on("/api/config", HTTP_POST, hConfig);            // dipakai halaman ini & web Termux
  server.on("/api/portal", HTTP_POST, hPortalNow);         // masuk mode setup dari web Termux
  server.on("/api/status", HTTP_GET, hStatus);
  server.on("/api/open", HTTP_POST, hOpen);
  server.on("/api/close", HTTP_POST, hClose);
  server.on("/api/enroll", HTTP_POST, hEnroll);
  server.on("/api/sync", HTTP_POST, hSync);
  server.on("/api/ota", HTTP_POST, hOta, hOtaUpload);      // update firmware dari server (OTA)
  server.begin();
}

void loop() {
  server.handleClient();
  MDNS.update();
  uint32_t now = millis();

  if (otaRestartAt && (int32_t)(now - otaRestartAt) >= 0) ESP.restart();   // OTA selesai: pakai firmware baru

  if (relayOn && (int32_t)(now - relayOffAt) >= 0) relaySet(false);
  if (enrolling && (int32_t)(now - enrollUntil) >= 0) { enrolling = false; pushEv("enroll_timeout", ""); showMsg("Waktu habis", "", 1500); }

  static uint32_t tRfid = 0, tChk = 0, tWifi = 0;         // wifiOkAt: variabel global (dipakai juga oleh mode setup)
  if (now - tRfid >= 80) { tRfid = now; String u = readUid(); if (u.length()) handleCard(u); }

  if (now - tChk >= 10000) {                             // RC522 kadang "hang": cek register versi, init ulang bila tidak menjawab
    tChk = now;
    byte v = rfid.PCD_ReadRegister(rfid.VersionReg);
    if (v == 0x00 || v == 0xFF) { rfid.PCD_Init(); rfid.PCD_SetAntennaGain(rfid.RxGain_max); }
  }

  if (WiFi.status() == WL_CONNECTED) wifiOkAt = now;

  // Tombol FLASH/BOOT ditahan 3 detik -> mode setup (untuk mengganti WiFi tanpa cabut alat)
  if (digitalRead(PIN_BTN) == LOW) {
    if (!btnHeld) btnHeld = now;
    else if (now - btnHeld > 3000) { btnHeld = 0; startPortal(); }
  } else btnHeld = 0;

  if (portalMode) {
    // WiFi rumah tetap dicoba tiap 20 detik; portal menutup sendiri begitu tersambung
    if (cfg.ssid.length() && now - lastStaTry > 20000) { lastStaTry = now; connectWifi(); }
    if (WiFi.status() == WL_CONNECTED) stopPortal();
  } else {
    if (now - tWifi >= 15000) { tWifi = now; if (WiFi.status() != WL_CONNECTED) WiFi.reconnect(); }
    // WiFi rumah hilang lebih dari 2 menit -> nyalakan mode setup supaya masih bisa diatur
    if (WiFi.status() != WL_CONNECTED && cfg.ssid.length() && wifiOkAt && now - wifiOkAt > 120000UL) startPortal();
    if (now - wifiOkAt > 600000UL && !portalMode) ESP.restart();   // WiFi putus > 10 menit -> restart
  }

  String a, b;                                           // tampilan LCD
  if (portalMode) { a = "Mode setup"; b = "192.168.4.1"; }
  else if (enrolling) { a = "Tambah kartu"; b = "Tempel kartu " + String(enrollLeft()) + "s"; }
  else if ((int32_t)(msgUntil - now) > 0) { a = m1; b = m2; }
  else { a = "Selamat datang"; b = relayOn ? "UNLOCK" : (serverOk() ? "Server ON" : "Server OFF"); }
  lcdShow(a, b);
  delay(2);
}
