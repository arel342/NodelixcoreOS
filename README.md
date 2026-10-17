# NodelixcoreOS — Web Server \& Storage Manager

Server berbasis **Node.js + Express** yang dirancang untuk berjalan pada perangkat seperti **Android/Termux** dan digunakan sebagai server lokal untuk mengelola file, storage eksternal, perangkat ESP32, serta kontrol lock door.

Project ini menyediakan antarmuka web untuk mengelola penyimpanan dan berkomunikasi dengan perangkat IoT melalui HTTP/WebSocket.

## Fitur

* Web server berbasis Node.js dan Express
* Setup awal lewat browser (buat akun admin, isi port ESP32/ESP8266, bot Telegram, dan
  kunci API Gemini untuk AI Agent)
* Pengaturan lewat web: semua isi `.env` bisa diubah dari tab Pengaturan (tanpa edit file di Termux)
* Login administrator
* File manager berbasis web
* Upload dan download file
* Membuat folder
* Rename file/folder
* Copy dan move file
* Hapus file/folder
* Compress file/folder
* Penyimpanan pada flash disk / external storage
* Dukungan storage melalui Termux
* Monitoring status storage
* Terminal perintah melalui web (dapat dimatikan di Pengaturan)
* Integrasi ESP32
* Integrasi ESP8266/ESP lock door
* Mode setup di ESP32 & ESP8266: perangkat menyalakan WiFi sendiri, pengaturan
  (nama WiFi, password WiFi, IP, kunci API) diisi dari halaman web di `192.168.4.1`
* Update firmware ESP8266 & ESP32 lewat file `.bin` (OTA dari web atau menu Termux)
* WebSocket untuk komunikasi real-time
* Sistem notifikasi
* Integrasi Telegram
* Konfigurasi melalui `.env`
* Dukungan multi-bahasa
* Penyimpanan konfigurasi kalibrasi
* Sistem migrasi storage dari penyimpanan lama ke storage eksternal
* Penambahan DHT11

### Flash disk

Flash disk yang terpasang dideteksi otomatis, jadi ID/nama mount tidak perlu diubah saat mengganti flash disk. Pastikan hanya satu volume eksternal yang terpasang agar aplikasi dapat memilihnya dengan aman; jika beberapa volume terpasang sekaligus, aplikasi meminta volume lain dilepas. Folder penyimpanan di setiap flash disk adalah `upload` secara default.

## code

* Node.js
* Express
* Multer
* WebSocket (`ws`)
* JavaScript
* HTML
* CSS
* Termux/Android untuk deployment tertentu

## Struktur Project

```text
NodelixcoreOS/
├── server.js
├── settings.js          <- pengaturan lewat web (ESP32, ESP8266, Telegram, AI, akun, monitoring)
├── setup.js             <- setup awal (halaman /setup.html), termasuk langkah kunci API Gemini
├── ai.js                <- AI Agent Gemini (dipakai perintah /ai di Telegram)
├── skills.js            <- daftar "skill"/alat yang boleh dipanggil AI Agent
├── esp32.js
├── door.js
├── firmware.js
├── fwstate.js
├── storage.js
├── system.js
├── terminal.js
├── lang.js
├── migrate.js
├── update-fw.js
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── README.md
├── data/
│   └── calibration.json
├── frimware/
│   ├── esp32 server sensor.ino
│   └── esp8266 lock door.ino
└── public/
    ├── index.html
    ├── setup.html       <- halaman panduan setup pertama kali
    ├── setup.js
    ├── settings.js      <- kartu pengaturan di tab Pengaturan
    ├── monitor.js
    ├── monitor.css
    ├── door.js
    ├── firmware.js
    ├── system.js
    ├── terminal.js
    ├── upload.js
    ├── ui.js
    └── i18n.js
```

> `node\_modules/` 

## Persyaratan

* Node.js
* npm
* Git

Untuk Android/Termux:

* Termux
* Node.js pada Termux
* Akses storage Termux
* Flash disk/external storage jika diperlukan
* root magisk
  
Dengan port default:

```text
http://localhost:3000
```

Dari perangkat lain dalam jaringan:

```text
http://IP-SERVER:3000
```

Contoh:

```text
http://192.168.1.20:3000
```

## Menjalankan di Termux

```bash
pkg update
pkg upgrade
pkg install nodejs git
```
Untuk akses storage Android:

```bash
termux-setup-storage
```

Clone repository:

```bash
git clone https://github.com/arel342/NodelixcoreOS
```

Masuk ke project:

```bash
cd ~/NodelixcoreOS
```

Install dependency:

```bash
npm install
```

Buat `.env`:

```bash
cp .env.example .env
```

```bash
nano .env
```

Jalankan:

```bash
npm start
```

Setelah jalan, terminal menampilkan alamat server, mis.:

```text
=================================
Setup awal: http://192.168.1.20:3000/setup.html
- Buka alamat itu di HP/PC (satu WiFi dengan Termux).
- Di halaman setup: buat username & password, isi IP/port/kunci API ESP32
  dan ESP8266, lalu isi bot Telegram. .env diisi otomatis.
=================================
```

## Setup Awal (lewat browser)

`.env` tidak perlu diisi manual. Saat pertama kali dijalankan, semua permintaan
diarahkan ke halaman panduan `/setup.html` sampai ada akun admin. Langkahnya:

1. **Akun admin** — buat username dan password untuk login dashboard.
2. **Alamat web server** — IP Termux + port ditampilkan otomatis (port bisa diubah di sini).
3. **ESP32 (monitor PLTS)** — isi IP, port, dan kunci API. Tekan **Acak** untuk membuat kunci API
   baru, lalu salin kunci itu ke halaman pengaturan ESP32 (lihat bagian ESP32 di bawah).
4. **ESP8266 (pintu RFID)** — sama seperti ESP32: IP, port, dan kunci API.
5. **Bot Telegram (opsional)** — tempel token bot dari @BotFather dan Chat ID admin,
   lalu tekan **Kirim pesan uji** untuk memastikan bot bekerja.
6. **AI Agent / Gemini (opsional)** — tempel kunci API dari Google AI Studio, pilih model,
   lalu tekan **Uji kunci** untuk memastikan kuncinya diterima Google sebelum disimpan.
   Kolom kunci yang dibiarkan kosong tidak menimpa kunci yang sudah tersimpan di `.env`.
7. **Selesai** — layanan perangkat dijalankan dan admin langsung masuk dashboard.

Panduan ini bisa dibuka lagi kapan saja dari tab **Pengaturan** (kartu paling atas,
tombol **Buka panduan**).

> Pengamanan: selesaikan setup segera setelah server dijalankan pertama kali. Selama
> belum ada akun admin, siapa pun yang bisa membuka alamat server dapat membuat akun itu.

## Pengaturan lewat web

Tab **Pengaturan** di dashboard berisi kartu yang mengubah isi `.env` langsung dari browser —
tidak perlu lagi membuka Termux:

| Kartu | Yang bisa diubah |
| --- | --- |
| ESP32 | IP, port, kunci API, interval pemantauan, nama relay. Ada tombol **Uji koneksi**, **Kirim pengaturan ke perangkat**, dan **Mode setup (WiFi ESP)** |
| ESP8266 (pintu) | IP, port, kunci API, interval pemantauan, waktu tambah kartu, notifikasi Telegram |
| Bot Telegram | Aktif/nonaktif notifikasi, token bot, Chat ID admin |
| AI Agent (Gemini) | Aktif/nonaktif AI Agent, kunci API Gemini, model Gemini. Ada tombol **Uji kunci ke Gemini** |
| Akun admin | Username, password (perlu password yang sedang dipakai) |
| Server & Web | Port web, masa berlaku login, folder penyimpanan, batas firmware OTA |
| Batas alarm monitoring | Ambang tegangan sel, arus, estimasi daya AC |

Perubahan langsung dipakai proses yang berjalan (pemantauan perangkat dan bot Telegram
dimuat ulang sendiri); hanya **port web** yang berlaku setelah `npm start` dijalankan ulang.

## ESP32

Firmware ESP32 versi 1.3 ke atas **tidak lagi menyimpan WiFi/API key di file `.ino`**. Semua
pengaturan diisi dari halaman web perangkat:

1. Nyalakan ESP32. Kalau WiFi-nya belum pernah diisi, perangkat menyalakan WiFi sendiri
   bernama `Nodelix-ESP32-xxxx`.
2. Sambungkan HP ke WiFi itu (tanpa password), lalu buka `http://192.168.4.1`.
3. Isi **nama WiFi, password WiFi, IP (DHCP atau statis), dan kunci API** — kunci API harus sama
   dengan `ESP32_API_KEY` di web Termux (bisa pakai tombol **Acak** di halaman setup Termux,
   lalu salin ke sini).
4. Simpan: perangkat restart dan tersambung ke WiFi rumah. Kartu di dashboard akan menunjukkan
   ESP32 online, firmware, IP, dan RSSI.

Mengubah pengaturan lagi nanti:

* Tahan tombol **BOOT** di ESP32 selama 3 detik → mode setup menyala lagi, **atau**
* dari web Termux: **Pengaturan > ESP32 > Mode setup (WiFi ESP)**, **atau**
* **Pengaturan > ESP32 > Kirim pengaturan ke perangkat** untuk mengirim WiFi/IP/kunci API baru
  lewat jaringan (tanpa menekan tombol apa pun).

Catatan:

* WiFi rumah hilang lebih dari 2 menit → mode setup menyala sendiri; begitu WiFi rumah
  tersambung, mode setup tertutup otomatis.
* Pengaturan disimpan di flash (NVS), jadi tetap ada setelah listrik mati.
* Kalau kunci API di kedua sisi berbeda, dashboard menampilkan ESP32 offline (server dapat
  balasan 401). Samakan kuncinya lewat mode setup di atas — kolom **Kunci di perangkat saat ini**
  di kartu push berguna kalau kunci di `.env` sudah berubah duluan.

## Door Lock (ESP8266)

Sama seperti ESP32: WiFi, IP, dan kunci API diisi dari halaman web perangkat (folder
`frimware/esp8266 lock door.ino`, firmware 1.3 ke atas).

1. Nyalakan ESP8266. Kalau belum pernah diatur, LCD menampilkan **Mode setup** dan perangkat
   menyalakan WiFi `Nodelix-DOOR-xxxx`.
2. Sambungkan HP ke WiFi itu, buka `http://192.168.4.1`.
3. Isi nama WiFi, password WiFi, IP (DHCP/statis), kunci API (samakan dengan `DOOR_API_KEY`),
   dan waktu relay terbuka, lalu simpan. Perangkat restart dan tersambung ke WiFi rumah.
4. Kartu RFID, LCD, dan relay tetap bekerja normal selama mode setup.

Untuk mengubah lagi: tahan tombol **FLASH/BOOT** 3 detik saat perangkat menyala (mode setup),
atau pakai **Pengaturan > Pintu RFID** di web Termux (Mode setup / Kirim pengaturan ke perangkat).

Nilai lain (masih bisa diatur dari web **Pengaturan > Pintu RFID** atau `.env`):

```env
DOOR_ENROLL_SECONDS=30
DOOR_POLL_MS=1000
DOOR_NOTIFY_OPEN=false
DOOR_NOTIFY_UNKNOWN=false
```

## Telegram

Token bot dan Chat ID diisi dari **Pengaturan > Bot Telegram** (atau saat setup awal) dan
disimpan ke `.env`:

```env
TELEGRAM_ALERTS=true
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
```

Setelah disimpan, bot langsung memakai nilai baru tanpa menjalankan ulang server. Tombol
**Kirim pesan uji** memastikan token dan Chat ID benar.

`TELEGRAM_CHAT_ID` mengizinkan hanya chat pribadi admin untuk menjalankan perintah. Bot mengirim pesan sambutan saat server mulai. Perintah: `/status`, `/battery`, `/dht`, `/relay 1 on`, `/door off`, `/open`, `/close`, `/addcard Nama`, `/cancelcard`, `/web off`, `/web on`, dan `/ai <pertanyaan>`. `/door off` menolak akses kartu biasa sampai diaktifkan kembali, tetapi kartu admin tetap dapat membuka pintu; `/open` tetap merupakan perintah admin untuk membuka pintu. `/web off` menghentikan HTTP dan WebSocket saja, sedangkan proses bot dan polling perangkat tetap berjalan agar `/web on` dapat mengaktifkannya lagi. Gunakan bot hanya dari chat pribadi admin dan jangan bagikan token.

Peringatan baterai rendah dikirim jika `TELEGRAM_ALERTS=true`. DHT11 tersambung ke GPIO 4 ESP32 (DATA ke GPIO 4, VCC ke 3V3, GND ke GND; sensor telanjang mungkin memerlukan resistor pull-up DATA 10 kΩ). Firmware membaca sensor tanpa library DHT tambahan; unggah firmware terbaru dari `frimware/esp32 server sensor.ino` agar perintah `/dht` dan `/status` menampilkan suhu serta kelembapan.

## AI Agent (Gemini)

AI Agent menambahkan asisten berbasis Gemini yang dipakai lewat perintah `/ai <pertanyaan>`
di Telegram. Ia punya "skill" (`skills.js`) untuk membaca status ESP32/pintu, menyalakan
relay, membuka pintu, dan menjalankan perintah Termux, jadi kuncinya layak dianggap sensitif.

Kunci API **gratis** dari Google AI Studio: <https://aistudio.google.com/apikey>. Ada dua cara
mengisinya, keduanya menulis ke `.env` tanpa perlu restart:

| Cara | Yang diisi |
| --- | --- |
| Setup awal `/setup.html` (langkah 6) | `AI_AGENT_ENABLED`, `GEMINI_API_KEY`, `GEMINI_MODEL` |
| Tab **Pengaturan** > kartu **AI Agent (Gemini)** | nilai yang sama, plus tombol **Uji kunci ke Gemini** |

```env
AI_AGENT_ENABLED=true
GEMINI_API_KEY=AQ....
GEMINI_MODEL=gemini-3.5-flash-lite
```

Kalau `GEMINI_API_KEY` masih kosong, `/ai` balasnya adalah cara mengisinya (bukan error
jaringan), dan log server menampilkan `[AI] GEMINI_API_KEY belum diisi...` saat server mulai.
`AI_AGENT_ENABLED=false` menonaktifkan AI Agent tanpa menghapus kuncinya. Uji cepat dari
browser: `GET /api/ai/status` (status + model) dan `POST /api/ai/test` (mengirim prompt
pendek ke Gemini).

## Monitoring

Contoh konfigurasi monitoring:

```env
I_WARN_A=5
CELL_V_MAX=4.20
CELL_V_CRIT=3.00
CELL_V_LOW=3.50
CELL_DELTA_WARN=0.10
I_DEADBAND_A=0.10
AC_VOLTAGE_NOMINAL=220
AC_POWER_FACTOR=0.80
```

## Relay

```env
RELAY_LABELS=Relay 1 & 2, Relay 3, Relay 4
```

## Bahasa

```env
LANGUAGE=id
```

File `lang.js` menangani teks dan pesan yang digunakan aplikasi.

## Terminal Web

Terminal tersedia di tab **Pengaturan** untuk menjalankan perintah pada perangkat server. Fitur ini aktif secara default dan dapat dimatikan melalui saklar terminal atau dengan mengubah `TERMINAL_ENABLED` di `.env`. Batas waktu, ukuran output, jumlah proses bersamaan, shell, dan folder awal dapat diatur melalui variabel `TERMINAL_*` di `.env` atau dilihat di `.env.example`.

Terminal memberikan akses menjalankan perintah pada perangkat server. Gunakan hanya pada jaringan tepercaya, lindungi akun administrator, dan matikan fitur ini jika tidak diperlukan.

## Update Firmware ESP (OTA)

Firmware ESP8266 (pintu) dan ESP32 (monitor) bisa diperbarui dari jarak jauh memakai file `.bin`
hasil kompilasi Arduino — tanpa mencabut perangkat dan tanpa kabel USB.

Dari web (**menu Update Firmware**):

1. Pilih perangkat: **ESP8266 (pintu RFID)** atau **ESP32 (monitor PLTS)**.
2. Ketuk **Pilih file .bin** lalu pilih file firmware (mis. `esp32 server sensor.ino.bin`).
3. Tekan **Update firmware**. Progres muncul: unggah ke server, kirim ke ESP, lalu ESP restart.
   Setelah selesai, versi firmware baru langsung tampil di kartu perangkat.

Kalau file yang dipilih **bukan `.bin`**, web langsung menampilkan peringatan dan minta konfirmasi;
server juga menolak file yang isinya bukan gambar firmware ESP (header `0xE9` tidak ditemukan).
Peringatan Telegram dikirim otomatis saat update berhasil atau gagal.

Dari Termux (menu teks, tanpa web):

```bash
npm run update-fw
# atau
node update-fw.js
```

Menu menampilkan pilihan perangkat, lalu meminta path file `.bin` (bisa juga mengarah ke folder
Download supaya file `.bin` di dalamnya bisa dipilih dengan nomor). Mode langsung:

```bash
node update-fw.js esp8266 ~/storage/downloads/esp8266.bin
node update-fw.js esp32 ~/storage/downloads/esp32.bin
```

Syarat & catatan:

* Firmware di perangkat harus **versi 1.2 ke atas** (sudah ada di repo ini) karena rute OTA
  `POST /api/ota` baru ditambahkan di versi tersebut. ESP lama perlu di-flash sekali lewat USB.
* ESP8266: pakai skema flash yang punya partisi OTA, mis. `4MB (FS:2MB OTA:~1019KB)`.
* ESP32: pakai skema partisi dengan OTA, mis. `Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)`.
  Skema bawaan `Default 4MB with spiffs` tidak punya partisi OTA, jadi update akan ditolak.
* Perangkat harus bisa dihubungi server (`DOOR_IP` / `ESP32_IP` dan kunci API benar di `.env`).
* Jangan putuskan daya saat proses berjalan. Kalau gagal, ESP tetap memakai firmware lama.
* Selama OTA, alarm Telegram "perangkat offline" dan "kembali online" ditahan karena perangkat
  memang berhenti menjawab sejenak.

Pengaturan di `.env`:

```env
OTA_MAX_MB=4
OTA_TIMEOUT_S=240
OTA_WAIT_S=60
```

## Migrasi Storage

Jika diperlukan:

```bash
node migrate.js
```

Pastikan storage tujuan tersedia dan dapat ditulis sebelum melakukan migrasi.

## Update Project

Ambil perubahan terbaru:

```bash
git pull origin main
```

Jika dependency berubah:

```bash
npm install
```

Kemudian:

```bash
npm start
```

## Keamanan

Project sebaiknya digunakan pada jaringan yang dikontrol oleh pemilik.

Untuk deployment ke internet, pertimbangkan:

* HTTPS
* Reverse proxy
* Firewall
* Authentication yang lebih kuat
* Rate limiting
* Session security
* Validasi upload
* Pembatasan ukuran file
* Pembatasan akses storage
* Rotasi API key
* Secret management



## Dependency

Dependency lengkap ditentukan oleh:

```text
package.json
package-lock.json
```

## Lisensi

Project ini menggunakan lisensi yang ditentukan pada `package.json`.

## Status

Project masih dalam pengembangan.

Gunakan dan uji pada jaringan lokal sebelum melakukan deployment ke internet.



## Author

Project `NodelixcoreOS` dikembangkan sebagai server lokal/IoT berbasis Node.js untuk pengelolaan storage dan komunikasi dengan perangkat IoT.

## Skema Pemasangan Pin (Pinout Wiring)

Berikut adalah panduan koneksi dan skema pin hardware mikrokontroler yang terhubung ke sistem :

## 1. ESP8266 (Door Lock RFID & LCD)

* **Board**: NodeMCU 1.0 (ESP-12E) / LOLIN (WEMOS) D1 mini
* **Modul RFID RC522**:
  * `3.3V` ➔ `3V3`
  * `GND` ➔ `G` (GND)
  * `RST` ➔ `D0` (GPIO 16)
  * `SDA (SS)` ➔ `D8` (GPIO 15)
  * `SCK` ➔ `D5` (GPIO 14)
  * `MOSI` ➔ `D7` (GPIO 13)
  * `MISO` ➔ `D6` (GPIO 12)
* **Modul LCD 1602 I2C**:
  * `VCC` ➔ `VIN` (5V)
  * `GND` ➔ `G` (GND)
  * `SDA` ➔ `D2` (GPIO 4)
  * `SCL` ➔ `D1` (GPIO 5)
* **Modul Relay**:
  * `VCC` ➔ `VIN` (5V)
  * `GND` ➔ `G` (GND)
  * `IN` ➔ `D4` (GPIO 2) *(Active LOW)*

---

## 2. ESP32 (PLTS Monitor & Relay)

* **Board**: ESP32 Dev Module
* **Sensor Arus ACS712-20A**:
  * `OUT` ➔ `GPIO 34` (ADC1)
* **Pembagi Tegangan Baterai (Voltage Divider)**:
  * Tap 1S ➔ `GPIO 35` (ADC1) 
  * Tap 2S ➔ `GPIO 36 / VP` (ADC1) 
  * Pack 3S ➔ `GPIO 39 / VN` (ADC1) 
* **Modul Relay (4 Channel)**:
  * Relay 1 & 2 (Paralel) ➔ `GPIO 26`
  * Relay 3 ➔ `GPIO 27`
  * Relay 4 ➔ `GPIO 32`
  * Keluaran Pendamping Relay 1 & 2 *(Active HIGH)*:
    * Relay 1 & 2 ON ➔ `GPIO 23` ON (`HIGH`), `GPIO 22` OFF (`LOW`)
    * Relay 1 & 2 OFF ➔ `GPIO 22` ON (`HIGH`), `GPIO 23` OFF (`LOW`)
* **module DHT11**:
  *DHT11 ➔ 'GPIO 4'

### Tombol mode setup (WiFi sendiri)

* **ESP32**: tombol **BOOT** (GPIO 0) — tahan 3 detik saat perangkat menyala untuk masuk
  mode setup, atau tahan saat perangkat sedang jalan lalu lepaskan.
* **ESP8266**: tombol **FLASH** (GPIO 0 / D3) — tahan 3 detik saat perangkat sudah menyala
  (kalau ditahan saat menyalakan, ESP masuk mode flash USB, bukan mode setup).

Di mode setup kedua perangkat menyalakan WiFi tanpa password (`Nodelix-ESP32-xxxx` /
`Nodelix-DOOR-xxxx`) dan halaman pengaturan di `http://192.168.4.1`.

### Kartu admin pintu RFID

Di tab **Pintu RFID / Lock Door**, tekan menu **⋮** pada kartu terdaftar untuk mengubah nama, menghapus kartu, atau memilih **Jadikan kartu admin**. Penetapan admin memerlukan password login dashboard saat ini (diverifikasi di server). Kartu admin tetap bisa membuka pintu ketika lock door dimatikan. **Hapus admin** hanya mencabut hak admin, tidak menghapus kartu dari daftar.

**Wajib unggah ulang `frimware/esp8266 lock door.ino` (versi 1.1 ke atas)** agar ESP8266 mengenali kartu admin. Status admin disimpan di server dan disinkronkan ke LittleFS ESP8266, sehingga tetap berlaku saat server offline atau ESP restart setelah sinkronisasi. Perubahan saat perangkat offline baru berlaku di pintu setelah sinkronisasi berhasil. Kartu lama otomatis tetap menjadi kartu biasa.
