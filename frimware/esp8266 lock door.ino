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
*/
#include <ESP8266WiFi.h>
#include <SPI.h> 
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <LittleFS.h>
#include <Wire.h>
#include <MFRC522.h>

// ===================== KONFIGURASI =====================
const char* WIFI_SSID = "your-wifi-name";
const char* WIFI_PASS = "your-wifi-password";
const char* API_KEY   = "replace-this-API";// samakan dengan DOOR_API_KEY di .env server

#define USE_STATIC_IP 1                               // 1 = IP tetap (samakan dengan DOOR_IP di .env), 0 = DHCP
IPAddress IP_ADDR(192, 168, 11, 60), IP_GW(192, 168, 11, 1), IP_MASK(255, 255, 255, 0), IP_DNS(192, 168, 11, 1);

#define PIN_RC_SS     15    // D8  RC522 SDA (SS)
#define PIN_RC_RST    16    // D0  RC522 RST   (SCK=D5/GPIO14, MISO=D6/GPIO12, MOSI=D7/GPIO13 tetap, SPI hardware)
#define PIN_SDA        4    // D2  LCD SDA
#define PIN_SCL        5    // D1  LCD SCL
#define PIN_RELAY      2    // D4  IN relay
#define RELAY_ACTIVE_LOW 1  // modul relay umumnya aktif LOW. Jika terbalik, ubah ke 0
#define LCD_ADDR    0x27    // alamat I2C LCD (0x27 atau 0x3F; otomatis dicoba keduanya)

#define MAX_CARDS    150
#define FW_VER       "1.1"
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
  if (server.header("X-API-Key") == API_KEY || server.arg("key") == API_KEY) { lastPoll = millis(); if (!lastPoll) lastPoll = 1; return true; }
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
  j += F(",\"ip\":\""); j += WiFi.localIP().toString();
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

void hSync() {                                           // body text/plain, format sama dengan /cfg.txt
  if (!auth()) return;
  if (!parseCfg(server.arg("plain"))) { server.send(400, "application/json", "{\"ok\":false,\"error\":\"format\"}"); return; }
  saveCfg();
  server.send(200, "application/json", String("{\"ok\":true,\"ver\":") + cfgVer + "}");
}

void connectWifi() {
  WiFi.mode(WIFI_STA); WiFi.persistent(false); WiFi.setAutoReconnect(true);
#if USE_STATIC_IP
  WiFi.config(IP_ADDR, IP_GW, IP_MASK, IP_DNS);
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASS);
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

  connectWifi();
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.printf("\nWiFi: %s  IP: %s  kartu: %d\n", WiFi.status() == WL_CONNECTED ? "terhubung" : "GAGAL (dicoba terus)", WiFi.localIP().toString().c_str(), nCards);
  bootId = ESP.getCycleCount() ^ ESP.getChipId(); if (!bootId) bootId = 1;
  MDNS.begin("pintu-esp8266");

  server.collectHeaders("X-API-Key");
  server.on("/", HTTP_GET, [] { server.send(200, "text/plain", "ESP8266 door lock\nGET /api/status | POST /api/open /api/close /api/enroll /api/sync\nHeader: X-API-Key"); });
  server.on("/api/status", HTTP_GET, hStatus);
  server.on("/api/open", HTTP_POST, hOpen);
  server.on("/api/close", HTTP_POST, hClose);
  server.on("/api/enroll", HTTP_POST, hEnroll);
  server.on("/api/sync", HTTP_POST, hSync);
  server.begin();
}

void loop() {
  server.handleClient();
  MDNS.update();
  uint32_t now = millis();

  if (relayOn && (int32_t)(now - relayOffAt) >= 0) relaySet(false);
  if (enrolling && (int32_t)(now - enrollUntil) >= 0) { enrolling = false; pushEv("enroll_timeout", ""); showMsg("Waktu habis", "", 1500); }

  static uint32_t tRfid = 0, tChk = 0, tWifi = 0, wifiOkAt = 0;
  if (now - tRfid >= 80) { tRfid = now; String u = readUid(); if (u.length()) handleCard(u); }

  if (now - tChk >= 10000) {                             // RC522 kadang "hang": cek register versi, init ulang bila tidak menjawab
    tChk = now;
    byte v = rfid.PCD_ReadRegister(rfid.VersionReg);
    if (v == 0x00 || v == 0xFF) { rfid.PCD_Init(); rfid.PCD_SetAntennaGain(rfid.RxGain_max); }
  }

  if (WiFi.status() == WL_CONNECTED) wifiOkAt = now;
  if (now - tWifi >= 15000) { tWifi = now; if (WiFi.status() != WL_CONNECTED) WiFi.reconnect(); }
  if (now - wifiOkAt > 600000UL) ESP.restart();          // WiFi putus > 10 menit -> restart

  String a, b;                                           // tampilan LCD
  if (enrolling) { a = "Tambah kartu"; b = "Tempel kartu " + String(enrollLeft()) + "s"; }
  else if ((int32_t)(msgUntil - now) > 0) { a = m1; b = m2; }
  else { a = "Selamat datang"; b = relayOn ? "UNLOCK" : (serverOk() ? "Server ON" : "Server OFF"); }
  lcdShow(a, b);
  delay(2);
}