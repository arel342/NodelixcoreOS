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
* Pratinjau foto dan pemutar video langsung di web, termasuk geser durasi (HTTP Range)
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
* AI Agent (Gemini) dengan 27 skill terstruktur: status, relay, pintu/RFID, file, sistem,
  jadwal/otomasi, riwayat sensor, dan diagnosis
* Konfirmasi tindakan sensitif yang ditegakkan backend (tombol web / Telegram), sekali pakai
  dan terikat pada sesi/chat
* Jadwal & otomasi (zona `Asia/Jakarta`) yang bertahan setelah restart
* Riwayat sensor + diagnosis yang memisahkan fakta terukur dari kemungkinan penyebab
* Fitur opsional analisis dokumen & transkripsi suara (nonaktif secara default)
* Audit log tindakan AI/skill dengan penyaringan rahasia
* Konfigurasi melalui `.env`
* Dukungan multi-bahasa
* Penyimpanan konfigurasi kalibrasi
* Sistem migrasi storage dari penyimpanan lama ke storage eksternal
* Penambahan DHT11

### Flash disk

Flash disk yang terpasang dideteksi otomatis, jadi ID/nama mount tidak perlu diubah saat mengganti flash disk. Pastikan hanya satu volume eksternal yang terpasang agar aplikasi dapat memilihnya dengan aman; jika beberapa volume terpasang sekaligus, aplikasi meminta volume lain dilepas. Folder penyimpanan di setiap flash disk adalah `upload` secara default.

### Membuka foto dan video

Di tab **Storage**, klik/tap file foto atau video, atau pilih **⋮ → Buka pratinjau**.
Penampil menyediakan tombol Sebelumnya/Berikutnya dalam folder yang sama, Download,
dan Tutup (juga bisa menekan Escape). Video memiliki kontrol putar, jeda, volume,
geser durasi, dan layar penuh sesuai dukungan browser. Tekan tombol putar untuk mulai.
Tekan lama tetap memilih file untuk operasi salin/pindah/download.

File dibaca langsung dari folder penyimpanan flash disk; tidak perlu di-upload ulang
atau disalin ke penyimpanan internal. URL `/uploads/<path>` tetap memerlukan login.
Server mendukung GET/HEAD, satu byte range (206), dan range di luar file (416).
Download file/folder dan ZIP tetap tersedia.

Foto JPG/PNG/WebP/GIF serta video MP4 (H.264/AAC) adalah pilihan umum. Dukungan
format lain seperti HEIC, MKV, MOV, AVI, atau codec HEVC bergantung pada browser
dan perangkat. Server tidak melakukan konversi; jika media tidak bisa ditampilkan,
gunakan Download atau konversi ke format yang didukung. Setelah mengganti file
aplikasi, restart server dan muat ulang halaman agar JS/CSS baru ikut terbaca.

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
├── ai.js                <- satu implementasi AI Agent (web + Telegram)
├── agent.js             <- alias: module.exports = require('./ai')
├── ai-agent.js          <- alias
├── ai_agent.js          <- alias
├── gemini.js            <- alias
├── skills.js            <- kompatibilitas lama: re-export registry skill
├── skills-registry.js   <- SATU sumber skill: schema, validasi, kebijakan, handler
├── executor.js          <- satu pengelola eksekusi terminal web + AI (kill grup proses)
├── terminal.js          <- HTTP terminal web di atas executor
├── confirm.js           <- konfirmasi tindakan sensitif (ID, TTL, identitas, sekali pakai)
├── audit.js             <- audit log JSONL + penyaringan rahasia
├── ai-history.js        <- riwayat AI terisolasi & dibatasi
├── relay-map.js         <- pemetaan relay/alias yang dipakai semua modul
├── sensor-history.js    <- riwayat sensor ringan untuk chart & skill
├── diagnostics.js       <- fakta vs kemungkinan penyebab
├── scheduler.js         <- jadwal & otomasi persisten (Asia/Jakarta)
├── optional-features.js <- dokumen/voice opsional (default mati)
├── locks.js             <- serialisasi perubahan perangkat
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
    ├── ai.html          <- halaman chat + tombol konfirmasi AI
    ├── ai.js
    └── i18n.js
```

> `node\_modules/` 

## Persyaratan

* Node.js **18.17 atau lebih baru** (diuji di Node 18/20/22; Termux: `pkg install nodejs`)
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

Transfer masuk saat ini dibatasi **20 MB** mengikuti Bot API Telegram standar; pengiriman file keluar dibatasi 49 MB. Jadi fitur dapat langsung dipakai tanpa memasang server tambahan.

Setelah token dan Chat ID disimpan, bot langsung memakai nilai baru tanpa menjalankan ulang server. Tombol
**Kirim pesan uji** memastikan token dan Chat ID benar.

`TELEGRAM_CHAT_ID` mengizinkan hanya chat pribadi admin untuk menjalankan perintah. Bot mengirim pesan sambutan saat server mulai. Perintah: `/status`, `/battery`, `/dht`, `/relay 1 on`, `/door off`, `/open`, `/close`, `/addcard Nama`, `/cancelcard`, `/upload`, `/cancelupload`, `/web off`, `/web on`, `/ai <pertanyaan>`, `/jobs`, `/cancel [id|all]`, `/reset`, `/transcribe` (balas pesan suara), dan `/analyze <path> [pertanyaan]`. Kirim dokumen, foto, video, atau audio ke bot untuk menyimpannya ke flash disk. Jika folder tidak disertakan, bot/AI akan menanyakan tujuan; balas nama folder yang sudah ada atau `.` untuk folder utama. Folder juga bisa ditentukan pada caption, misalnya `/upload Dokumen` atau `/upload foto`. Gunakan `/ai kirim file ...` untuk meminta AI mencari file di flash disk dan mengirimkannya kembali ke chat Telegram admin. File masuk dibatasi 20 MB dan file keluar 49 MB. `/door off` menolak akses kartu biasa sampai diaktifkan kembali, tetapi kartu admin tetap dapat membuka pintu; `/open` tetap merupakan perintah admin untuk membuka pintu. `/web off` menghentikan HTTP dan WebSocket saja, sedangkan proses bot dan polling perangkat tetap berjalan agar `/web on` dapat mengaktifkannya lagi. Gunakan bot hanya dari chat pribadi admin dan jangan bagikan token.

Peringatan baterai rendah dikirim jika `TELEGRAM_ALERTS=true`. DHT11 tersambung ke GPIO 4 ESP32 (DATA ke GPIO 4, VCC ke 3V3, GND ke GND; sensor telanjang mungkin memerlukan resistor pull-up DATA 10 kΩ). Firmware membaca sensor tanpa library DHT tambahan; unggah firmware terbaru dari `frimware/esp32 server sensor.ino` agar perintah `/dht` dan `/status` menampilkan suhu serta kelembapan.

## AI Agent (Gemini)

AI Agent bisa dipakai dari dua tempat dan memakai implementasi yang sama:

* **Telegram** — `/ai <pertanyaan>` atau kirim pesan biasa ke bot admin.
* **Web** — buka `/ai.html` (tombol **AI Agent** di sidebar dashboard).

`ai.js` adalah satu-satunya implementasi. `agent.js`, `ai-agent.js`, `ai_agent.js`, dan
`gemini.js` hanya berisi `module.exports = require('./ai')`, sehingga perilaku, batas, dan
kebijakan keamanannya selalu sama.

Kunci API **gratis** dari Google AI Studio: <https://aistudio.google.com/apikey>. Isi lewat
setup awal atau tab **Pengaturan** > kartu **AI Agent (Gemini)**; tidak perlu restart.

```env
AI_AGENT_ENABLED=true
GEMINI_API_KEY=AQ....
GEMINI_MODEL=gemini-3.5-flash-lite
```

### Model, fallback, dan biaya

Model yang **Anda tulis tidak diganti otomatis**. Server hanya membuang awalan `models/`.
Bila model itu sudah pensiun atau tidak tersedia untuk kunci Anda, permintaan gagal dengan
pesan yang menyebut model tersebut, lalu daftar cadangan dipakai (bila diaktifkan). Ini
disengaja: berpindah model/tier biaya tidak boleh terjadi diam-diam.

```env
GEMINI_FALLBACK_ENABLED=true
GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite
GEMINI_FALLBACK_ON_QUOTA=false          # true = cadangan juga dipakai saat kuota habis
GEMINI_HONOR_MODEL_SUGGESTION=false     # true = coba model yang disarankan pesan error Google
GEMINI_RETRY_MAX=2
GEMINI_RETRY_DELAY_MS=1200              # backoff x2, menghormati Retry-After <= 20 dtk
GEMINI_TIMEOUT_S=60
AI_MAX_ROUNDS=8
AI_MAX_TOOL_CALLS=12
AI_JOB_TIMEOUT_S=120
```

Kesalahan dibedakan menjadi: kunci ditolak (`auth`), model tidak tersedia (`model`), kuota
(`quota`), gangguan server, timeout, jaringan, output tidak valid/kosong/diblokir, dan
dibatalkan. Tindakan perangkat yang sudah berhasil **tidak diulang** saat percobaan model
berikutnya gagal, dan panggilan tool yang sama dalam satu giliran hanya dijalankan sekali.

### Skill (satu registry)

Semua skill didefinisikan di `skills-registry.js` (nama, deskripsi, schema, validator,
kebijakan, handler, ketersediaan). Deklarasi function-calling Gemini dan daftar kemampuan
di `/api/ai/status` dibangun dari sumber yang sama. Argumen divalidasi **sebelum** ada efek
samping; tipe boolean wajib `true`/`false` (string `"false"` ditolak), dan argumen tambahan
seperti `approved: true` ditolak.

| Kelompok | Skill | Izin |
| --- | --- | --- |
| Status | `get_status`, `get_system_status`, `diagnose_device`, `get_sensor_history` | otomatis |
| Relay | `set_relay` (1 & 2 → GPIO 26, 3 → GPIO 27, 4 → GPIO 32, `all`) | otomatis (target divalidasi) |
| Pintu/RFID | `open_door`, `set_door_enabled`, `enroll_card` | **konfirmasi** |
| Pintu/RFID | `close_door` | otomatis |
| Shell | `run_command` | otomatis hanya untuk allowlist status (`uptime`, `df`, `free`, `ps`, …); selebihnya **konfirmasi** |
| File | `list_files`, `search_files`, `read_text_file`, `create_folder`, `copy_file`, `compress_file` | otomatis |
| File | `rename_file`, `move_file` | **konfirmasi** |
| Telegram | `send_file_telegram` (selalu ke chat admin, bukan IP) | otomatis |
| Jadwal | `schedule_action`, `create_automation` | **konfirmasi** |
| Jadwal | `list_schedules`, `cancel_schedule`, `list_automations`, `disable_automation` | otomatis |
| Opsional | `analyze_document`, `transcribe_voice` | **konfirmasi** + fitur harus aktif |

`get_status` hanya mengembalikan ringkasan (jumlah kartu, bukan seluruh UID/log akses).
`run_command` menyaring variabel environment rahasia, menolak `.env`/private key, dan
menerapkan batas waktu `AI_COMMAND_TIMEOUT_S` (default 30). Penyaringan ini **bukan sandbox**:
perintah yang disetujui tetap berjalan dengan hak akses user Node dan bisa membaca apa pun
yang diizinkan OS.

### Konfirmasi tindakan sensitif

1. Model meminta skill sensitif → backend membuat record konfirmasi (ID unik, ringkasan
   tindakan + target, masa berlaku `CONFIRM_TTL_S`, default 300 detik).
2. Record terikat pada **aktor + kanal + sesi web atau chat Telegram** peminta. Tidak ada
   eksekusi sebelum pengguna menekan tombol.
3. Persetujuan hanya dari tombol di `/ai.html` (sesi login) atau inline keyboard Telegram
   dari chat admin. Model tidak bisa menyetujui; argumen model tidak pernah dibaca sebagai
   persetujuan.
4. Saat disetujui, status langsung `executing` (klik ganda tidak menjalankan dua kali),
   izin & ketersediaan diperiksa ulang, lalu hasilnya dicatat. Konfirmasi sekali pakai;
   kedaluwarsa, identitas/kanal lain, atau pemakaian ulang ditolak dengan pesan jelas.

Endpoint web: `GET /api/ai/confirmations`, `POST /api/ai/confirmations/:id/approve`,
`POST /api/ai/confirmations/:id/cancel`. Halaman `/ai.html` hanya menampilkan tombol yang
dibuat server; keputusan tetap di backend.

### Riwayat percakapan

Riwayat memuat pesan, panggilan tool, hasil tool (diringkas), dan jawaban akhir, sehingga
hasil sensor/file bisa dipakai pada pertanyaan lanjutan. Identitas percakapan adalah sesi
login web (`web:<sid>`) atau chat Telegram (`telegram:<chatId>`) — **alamat IP bukan
identitas**. Batas: `AI_HISTORY_MAX_TOKENS` (6000), `AI_HISTORY_MAX_TURNS` (12),
`AI_HISTORY_MAX_SESSIONS` (20), `AI_HISTORY_MAX_KB` (512). Rahasia disaring sebelum disimpan.
Bila `AI_HISTORY_PERSIST=true` (default), data ditulis atomik ke `data/ai-history.json`.
Hapus lewat tombol **Hapus riwayat**, `POST /api/ai/history/clear`, atau `DELETE /api/ai/history`.

### Batas pekerjaan

Satu permintaan dibatasi oleh jumlah putaran model (`AI_MAX_ROUNDS`), total panggilan tool
(`AI_MAX_TOOL_CALLS`), dan durasi pekerjaan (`AI_JOB_TIMEOUT_S`). Hasil tool dipotong agar
tidak membanjiri model. Pesan untuk input kosong, fitur nonaktif, kuota, timeout, output
kosong/diblokir, dan batas langkah dibuat eksplisit — bukan error jaringan yang membingungkan.

### Fitur opsional: dokumen & suara

Keduanya **nonaktif secara default**, hanya berjalan bila diminta eksplisit, dan tidak
pernah mengirim dokumen/suara otomatis.

```env
DOCUMENT_AI_ENABLED=false
DOCUMENT_AI_PROVIDER=gemini
DOCUMENT_AI_MODEL=gemini-3.5-flash-lite
DOCUMENT_AI_MAX_MB=5
VOICE_AI_ENABLED=false
VOICE_AI_PROVIDER=gemini
VOICE_AI_MODEL=gemini-3.5-flash-lite
VOICE_AI_LANGUAGE=id
VOICE_AI_MAX_MB=8
OPTIONAL_AI_TIMEOUT_S=60
```

Yang diizinkan: dokumen `txt, log, md, csv, json, xml, html, pdf, js, ino, py, yml`; audio
`ogg, oga, opus, mp3, wav, m4a, webm, flac, aac, amr`. Ukuran dibatasi sebelum file dibaca
penuh, isi file diperlakukan sebagai data tidak tepercaya, dan tidak ada file sementara di
disk. Bila fitur/provider/dependency belum siap, statusnya dilaporkan apa adanya
(`FEATURE_DISABLED` / `UNSUPPORTED_TYPE` / `413`), bukan diklaim berhasil.

## Jadwal & Otomasi

AI dapat membuat jadwal (`schedule_action`) dan otomasi kondisi sensor
(`create_automation`), lalu menampilkan/membatalkannya lewat `list_schedules`,
`cancel_schedule`, `list_automations`, dan `disable_automation`.

* Zona waktu interaksi: `SCHEDULE_TZ` (default `Asia/Jakarta`). Waktu lengkap (tanggal,
  jam, zona) ditampilkan pada konfirmasi **sebelum** jadwal disimpan.
* Contoh: “matikan relay 3 pukul 22.00 WIB”, “setiap hari 18.00 nyalakan relay 4”,
  “beri tahu bila suhu di atas 35 °C selama 1 menit”.
* Data disimpan atomik di `data/schedules.json` (tmp + rename + antrean tulis) sehingga
  bertahan setelah restart.
* Jadwal yang terlewat saat server mati **tidak dijalankan diam-diam**:
  `SCHEDULE_MISSED_POLICY=skip` (default) atau `run-once`, dengan batas
  `SCHEDULE_MAX_LATE_S=300`.
* Otomasi hanya memakai data sensor segar; data offline atau lebih tua dari
  `SENSOR_STALE_S` (default 120 detik) tidak memicu tindakan. Ada durasi kondisi,
  hysteresis, dan `cooldown_sec` agar notifikasi tidak berulang.
* Tindakan otomatis dibatasi pada operasi non-sensitif (`set_relay`, `close_door`,
  `compress_file`, `send_file_telegram`). Pintu, akses RFID, dan shell **tidak bisa**
  dijadwalkan/diotomasikan; semuanya tetap perlu konfirmasi manusia setiap kali. Ini juga
  diperiksa ulang di scheduler sebagai pertahanan berlapis.

```env
SCHEDULE_TZ=Asia/Jakarta
SCHEDULE_MISSED_POLICY=skip
SCHEDULE_MAX_LATE_S=300
AUTOMATION_EVAL_MS=2000
SENSOR_STALE_S=120
SENSOR_HISTORY_HOURS=24
SENSOR_HISTORY_MAX_POINTS=6000
SENSOR_HISTORY_MIN_INTERVAL_S=15
SENSOR_HISTORY_PERSIST=false
```

## Berkas runtime & audit

| Berkas | Isi | Default |
| --- | --- | --- |
| `data/ai-history.json` | riwayat AI terbatas (tanpa rahasia) | `AI_HISTORY_PERSIST=true` |
| `data/schedules.json` | jadwal & otomasi | selalu |
| `data/audit.log` | audit JSONL: waktu, aktor, kanal, skill, target, hasil, op ID | `AUDIT_LOG_ENABLED=true`, rotasi `AUDIT_LOG_MAX_MB=2` |
| `data/sensor-history.json` | riwayat sensor | `SENSOR_HISTORY_PERSIST=false` |

Berkas runtime ini tidak boleh di-commit (lihat `.gitignore`). Audit mencatat tindakan
otomatis, terjadwal, dan setelah konfirmasi; token/API key/password disaring sebelum ditulis.

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

Terminal tersedia di tab **Terminal** untuk menjalankan perintah pada perangkat server. Fitur ini aktif secara default dan dapat dimatikan melalui saklar terminal atau dengan mengubah `TERMINAL_ENABLED` di `.env`. **Terminal web dan skill `run_command` milik AI memakai satu executor yang sama** (`executor.js`): `TERMINAL_ENABLED` diperiksa setiap kali perintah dijalankan, shell/folder/batas waktu/ukuran output/jumlah proses mengikuti pengaturan yang sama, dan pembatalan atau timeout mematikan seluruh grup proses (termasuk `sleep`, `ping`, dan anak dari `sh -c`). Saat terminal dimatikan, pekerjaan yang masih berjalan dihentikan dengan SIGTERM lalu SIGKILL. Operasi file manager **tidak** bergantung pada terminal.

Batas waktu, ukuran output, jumlah proses bersamaan, shell, dan folder awal dapat diatur melalui variabel `TERMINAL_*` di `.env` atau dilihat di `.env.example`.

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
* Jangan menganggap prompt AI sebagai pengaman: izin sensitif ditegakkan backend
  (konfirmasi + validasi schema + audit), bukan oleh kata-kata di prompt.
* Aktifkan `TERMINAL_ENABLED=false` bila terminal/AI shell tidak diperlukan.
* Periksa `data/audit.log` bila mencurigai tindakan yang tidak diinginkan.
* Tindakan otomatis (jadwal/otomasi) sengaja dibatasi pada operasi non-sensitif.

### Catatan migrasi dari versi sebelumnya

* Model `GEMINI_MODEL` **tidak lagi ditulis ulang otomatis**. Bila dulu memakai nama model
  lama (mis. `gemini-1.5-*`), perbarui sendiri di Pengaturan; server akan menampilkan error
  yang jelas dan memakai `GEMINI_FALLBACK_MODELS` bila model itu tidak tersedia.
* `agent.js`, `ai-agent.js`, `ai_agent.js`, dan `gemini.js` kini hanya alias ke `ai.js`.
  Jangan menambahkan logika baru ke file alias.
* Riwayat AI dan jadwal disimpan di `data/` (lihat tabel di atas); amankan folder itu dan
  jangan memasukkannya ke Git.
* Tindakan sensitif (pintu, akses RFID, shell di luar allowlist, rename/move, jadwal)
  sekarang memerlukan konfirmasi eksplisit; alur otomasi/skrip lama yang memanggil skill
  tersebut tanpa konfirmasi akan ditolak.



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

Yang **belum** diverifikasi di perangkat fisik (lihat juga laporan perubahan):
pembukaan pintu, enrollment kartu, relay sungguhan, kestabilan flash disk saat dicabut,
pengiriman file besar ke Telegram, serta perilaku OTA pada jaringan nyata. Semua alur di
atas sudah diuji dengan mock/unit test, bukan dengan perangkat asli.



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
