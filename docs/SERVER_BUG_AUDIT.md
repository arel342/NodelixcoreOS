# Audit Bug Backend NodelixcoreOS 1.2.0

Dokumen ini mencatat **apa yang diperiksa, apa yang terbukti bermasalah, dan apa yang
sengaja tidak diubah** pada server Node.js NodeliXcoreOS. Fokusnya hanya perbaikan bug
yang sudah ada — tidak ada fitur baru, tidak ada penulisan ulang arsitektur.

Laporan perbaikan (root cause, berkas yang diubah, hasil pengujian) ada di
[`SERVER_BUG_FIX_REPORT.md`](SERVER_BUG_FIX_REPORT.md). Kontrak teknis tetap di
[`API.md`](API.md), [`AUTHENTICATION.md`](AUTHENTICATION.md), [`WEBSOCKET.md`](WEBSOCKET.md),
dan [`UPGRADE.md`](UPGRADE.md).

| Item | Nilai |
|---|---|
| Basis kode | `arel342/NodelixcoreOS` @ `ba694e4` (versi `1.2.0`) |
| Klien acuan | `arel342/Nlodelix-mobile` (Kotlin/Compose, Retrofit + OkHttp) |
| Runtime audit | Node.js **22.22.3**, Linux `6.1.158` (bukan perangkat Termux fisik) |
| Dependensi | `express ^5.2.1`, `multer ^2.4.0`, `ws ^8.22.0` — **tidak ada tambahan** |
| Tes sebelum | 175 (174 lulus, 1 dilewati karena `jsdom` tidak terpasang) |
| Tes sesudah | **210** (209 lulus, 1 dilewati), 0 gagal |

---

## 1. Metode

1. Membaca ulang seluruh modul server (`server.js`, `auth.js`, `mobile-auth.js`,
   `storage.js`, `esp32.js`, `door.js`, `system.js`, `settings.js`, `setup.js`,
   `telegram.js`, `scheduler.js`, `updater.js`, `firmware.js`, `terminal.js`,
   `executor.js`, `confirm.js`, `ai.js`, `skills-registry.js`, `sensor-history.js`,
   `backup.js`, `audit.js`, `optional-features.js`, `relay-map.js`, `migrate.js`,
   `update-fw.js`) beserta `lang.js`, `public/*`, `docs/*`, `firmware/*.ino`.
2. Membandingkan setiap endpoint dengan definisi API di aplikasi Android
   (`ApiService.kt`, `ApiDtos.kt`, `NetworkResult.kt`, `ResultStore`, dsb).
3. Mencari bug dengan tiga cara: pembacaan kode, **reproduksi runtime** (proses
   `server.js` sungguhan di port acak), dan tes unit/integrasi baru yang meniru
   perangkat keras (modul dijalankan di `vm` dengan `fs`/`setTimeout`/`fetch` palsu).
4. Setiap perbaikan hanya diterima kalau ada bukti: tes baru yang gagal sebelum
   perbaikan dan lulus sesudahnya, atau reproduksi manual yang terdokumentasi.

---

## 2. Ringkasan temuan

Severity: **K**ritis (server mati / bypass autentikasi / rahasia bocor),
**T**inggi, **S**edang, **R**endah.

| ID | Area | Severity | Temuan | Status |
|---|---|---|---|---|
| B-01 | API/routing | K | Daftar rute terlindungi ditulis manual; `/api/*` di luar daftar terbuka tanpa login | Diperbaiki |
| B-02 | Keamanan | K | `GET /api/setup/status` mengirim kunci API ESP32/ESP8266 + token bot Telegram ke pengunjung yang belum login | Diperbaiki |
| B-03 | WebSocket | K | Frame WS tidak sah (mask hilang / UTF-8 rusak / panjang salah) mematikan seluruh proses | Diperbaiki |
| B-04 | Termux | K | Tidak ada penangan `unhandledRejection`/`uncaughtException` → satu promise gagal menghentikan pemantauan | Diperbaiki |
| B-05 | ESP32 | T | Relay dilaporkan `success` tanpa konfirmasi perangkat; `{"ok":false}` dianggap berhasil | Diperbaiki |
| B-06 | ESP8266 | T | Buka/tutup/enroll pintu dilaporkan sukses walau perangkat menolak perintah | Diperbaiki |
| B-07 | Update | T | `updateAvailable = installed !== latest` → positif palsu saat repo lokal lebih baru | Diperbaiki |
| B-08 | Auth | T | Sesi mobile per perangkat tanpa batas → berkas sesi tumbuh terus, token lama tetap sah 30 hari | Diperbaiki |
| B-09 | ESP32 | S | `data/calibration.json` tanpa entri tap (atau `current: null`) membuat seluruh pembacaan gagal → perangkat tampak offline | Diperbaiki |
| B-10 | ESP32 | S | Kalibrasi arus nol menghapus `current.irms` → `TypeError` di `ingest()` | Diperbaiki |
| B-11 | ESP32 | S | Balasan bukan objek JSON (halaman portal ESP) diterima sebagai data sah → perangkat "online" tanpa data | Diperbaiki |
| B-12 | ESP8266 | S | `events` bukan array → satu payload rusak membuat pintu tampak offline | Diperbaiki |
| B-13 | ESP8266 | S | `/api/door/config` menjawab sukses tanpa melaporkan apakah ESP sudah sinkron | Diperbaiki |
| B-14 | ESP8266 | S | `DELETE /api/door/cards/:uid` memanggil `sync()` tanpa menunggu dan tanpa melaporkan hasil | Diperbaiki |
| B-15 | ESP32/8266/sistem/Telegram | S | `start()`/`reload()` dipanggil dua kali → dua rantai polling paralel | Diperbaiki |
| B-16 | Telegram | S | `restart()` mereset `offset = 0` → update terakhir dapat dieksekusi dua kali | Diperbaiki |
| B-17 | Termux | S | `shutdown()` tidak menghentikan polling perangkat, tidak menutup WebSocket, tidak menutup soket pendengar | Diperbaiki |
| B-18 | Jadwal | S | Kebijakan `SCHEDULE_MISSED_POLICY` hanya berlaku saat bootstrap; `tick()` menjalankan jadwal yang terlambat berjam-jam | Diperbaiki |
| B-19 | API | S | `POST /api/request-otp` publik tanpa batas laju → spam chat Telegram admin & OTP sah tertimpa | Diperbaiki |
| B-20 | Setup | S | Field kunci kosong di wizard setup menghapus kunci API/token yang sudah tersimpan | Diperbaiki |
| B-21 | AI/Konfirmasi | R | Konfirmasi kedaluwarsa tetap berstatus `pending` dan terus tampil di dashboard (tombolnya selalu 410) | Diperbaiki |
| B-22 | Termux | R | `server.headersTimeout = 0` → header yang menggantung tidak pernah ditutup | Diperbaiki |
| B-23 | Keamanan | R | Respons OTP/reset token tanpa `Cache-Control: no-store` | Diperbaiki |
| B-24 | ESP8266 | R | Pesan galat perangkat dibungkus ulang ("tidak merespons") sehingga sebab sebenarnya hilang | Diperbaiki |
| B-25 | Auth | — | `auth.resolve()` memakai cookie web bila Bearer tidak sah | **Sengaja dipertahankan** |
| B-26 | Auth | — | Limiter login dipakai bersama verifikasi password ulang (kartu admin, ubah akun) | **Sengaja dipertahankan** |
| B-27 | Storage | — | `UPLOAD_MAX_MB=0` berarti tanpa batas | **Perilaku terdokumentasi** |
| B-28 | Terminal | — | `executor.js` menjalankan shell sungguhan, bukan sandbox | **Batasan terdokumentasi** |
| B-29 | Backup | — | `backup.js` hanya membuat cadangan; tidak ada restore otomatis | **Kemampuan yang belum ada** |
| B-30 | Update | — | Tidak ada endpoint pasang update/rollback di server | **Kemampuan yang belum ada** |

---

## 3. Temuan per area

### 3.1 API & routing (B-01, B-19, B-23)

`server.js` melindungi API dengan daftar manual:

```js
app.use(['/api/files', '/api/create-folder', ..., '/api/update', '/uploads'], requireAuth);
```

Konsekuensinya rute `/api/*` yang tidak tercantum di daftar itu **tidak pernah**
diperiksa. Saat audit, semua rute yang ada memang sudah tercantum (`/api/ai`, `/api/terminal`,
`/api/storage/status` tercakup prefiksnya), tetapi pola ini gagal-terbuka: menambah satu
rute baru tanpa memperbarui daftar langsung membuka endpoint data tanpa login. Ini
dibuktikan dengan memanggil endpoint asing (`/api/rute-yang-belum-ada`): sebelum
perbaikan dijawab `404`, bukan `401`.

Perbaikan: gerbang **deny-by-default** — semua `/api/*` dan `/uploads/*` wajib sesi sah,
kecuali sembilan kelompok endpoint publik yang memang harus publik (login, logout,
session, settings/lang, setup/*, mobile/*, request-otp, verify-otp, reset-password).
Daftar publik ini sekaligus menjadi dokumentasi eksplisit (lihat `docs/API.md` §1).

`POST /api/request-otp` juga publik (dipakai layar login web & Android). Sebelumnya satu-
satunya pembatas adalah "tunggu 60 detik bila OTP masih ada", sehingga penyerang di LAN
bisa meminta OTP berulang: chat Telegram admin dibanjiri dan OTP yang sedang dipakai
admin menjadi tidak berlaku. Sekarang ada limiter 3 permintaan / 5 menit per IP
(`createLimiter` yang sudah ada), terpisah dari limiter login agar tidak mengunci login.

### 3.2 Autentikasi & sesi (B-08, B-25, B-26)

Diperiksa: pembuatan/validasi cookie `sid`, TTL, `revokeToken`, `revokeDeviceSessions`,
`refreshMobileSession`, registrasi perangkat ECDSA P-256, challenge (TTL, skew, sekali
pakai), pemeriksaan tanda tangan, pencabutan perangkat, kompatibilitas sesi lama
(mode cookie untuk aplikasi), dan pemutusan WebSocket saat sesi dicabut.

Temuan nyata hanya satu: **sesi mobile per perangkat tidak dibatasi**. Setiap login
biometrik menerbitkan token baru, dan token lama tetap berlaku sampai TTL 720 jam. Di
perangkat yang sering login ulang (mis. setelah update aplikasi), `data/mobile-sessions.json`
tumbuh terus dan token lama yang seharusnya sudah tidak dipakai tetap bisa dipakai.
Sekarang jumlah sesi per perangkat dibatasi `MOBILE_MAX_SESSIONS_PER_DEVICE` (default 10,
dijepit 1–100) dan token terlama dicabut otomatis (lewat jalur `safeRevoke` yang sama
dengan pencabutan manual, termasuk pemutusan WebSocket-nya).

Dua hal diperiksa dan **tidak** diubah karena bukan bug:

- **B-25** `resolve()` sengaja menerima cookie web yang masih sah saat Bearer tidak sah
  (aplikasi Android boleh menyimpan keduanya). Tidak ada eskalasi hak: yang punya cookie
  sah memang sudah terautentikasi.
- **B-26** Limiter login dipakai bersama verifikasi password ulang. Hanya sesi yang sudah
  login yang bisa memicu verifikasi itu (kartu admin / ubah akun), jadi tidak bisa dipakai
  untuk mengunci login orang lain tanpa akses lebih dulu.

### 3.3 WebSocket (B-03)

Event `SYSTEM`, `SENSOR`, `DOOR`, `DOOR_NOTE`, `FW`, `UPDATE`, `DEVICE_COUNT` beserta
bentuk payload diperiksa satu per satu dan **tidak diubah**.

Bug kritis yang ditemukan dan direproduksi:

```
$ node /tmp/wserr.js            # klien mengirim frame teks tanpa mask
UNCAUGHT: WS_ERR_EXPECTED_MASK
proses keluar dengan kode 3
```

`ws` memancarkan `'error'` pada soket/objek WebSocket untuk pelanggaran protokol (mask
hilang, UTF-8 tidak sah, panjang frame salah). Handler upgrade di `server.js` tidak
memasang listener `'error'` pada soket hasil `upgrade` maupun pada `ws`, sehingga error
itu menjadi `uncaughtException` dan mematikan proses — di Termux artinya pemantauan ESP32
dan pintu ikut mati hanya karena satu klien (atau scanner port) mengirim frame rusak.
Perbaikan: listener `'error'` pada soket upgrade dan pada `ws`, `try/catch` di sekitar
penulisan `401` dan `handleUpgrade`, serta log terpotong tanpa data sensitif.

Diperiksa dan benar tanpa perubahan: autentikasi sebelum upgrade (cookie/Bearer), tolak
token di URL, pemeriksaan ulang sesi tiap 30 detik, putus dengan kode `4403` saat sesi
dicabut, `4401` saat tidak terautentikasi, pembersihan pada `close`, dan penargetan
siaran (semua klien terautentikasi).

### 3.4 Penyimpanan & file manager (B-27)

Diperiksa: normalisasi path relatif, penolakan `..` dan NUL, resolusi symlink, pemeriksaan
mount sebelum menulis, kutipan argumen shell (`q()` memakai kutip tunggal dengan escape),
`Content-Length`, `Content-Type` (MIME), `Range`/`If-Range` (206/416), `HEAD`, unggah
streaming ke `.part` lalu `mv` atomik, batas ukuran, dan konkurensi (kunci antrean).

Tidak ditemukan bug yang perlu diperbaiki. `UPLOAD_MAX_MB=0` berarti "tanpa batas" dan itu
memang perilaku yang didokumentasikan di `.env.example` (B-27). Tidak ada akses filesystem
arbitrer: semua operasi menerima path relatif terhadap folder storage dan menolak keluar
dari folder itu.

### 3.5 ESP32 & ESP8266 (B-05, B-06, B-09 … B-15, B-24)

Ini area dengan bug terbanyak. Semuanya dibuktikan dengan modul yang dijalankan di `vm`
(fs/timer/fetch palsu) di `tests/server-bugfix.test.js`.

| Bug | Sebelum | Sesudah |
|---|---|---|
| Kalibrasi tap hilang | `cal.taps[b.id]` → `TypeError` di dalam `poll()`, `fails++`, perangkat tampak offline | faktor netral (gain 1, offset 0) |
| `current: null` | `raw.current.irms` → `TypeError` | bagian arus dilewati, `current: null` |
| `ingest()` non-objek | dianggap pembacaan sukses, `online: true` tanpa data | dianggap gagal baca (`esp.badData` / `door.badData`) |
| Kalibrasi nol tanpa `irms` | `zeroing.push(undefined)` → `TypeError` | kalibrasi dibatalkan, `zeroing=false` |
| Relay tanpa konfirmasi | `200 {success:true}` walau perangkat tidak berubah | `502 esp.relayNoConfirm` / `esp.relayRejected` |
| Buka pintu ditolak | `200 {success:true}` | `502 door.noConfirm` |
| `events` rusak | seluruh pembacaan gagal | entri tanpa `id` numerik dilewati, perangkat tetap online |
| `start()` ganda | dua rantai polling → dua permintaan/detik ke perangkat | tepat satu rantai (`gen`) |
| `stop()` saat poll berjalan | siklus lama menjadwalkan putaran baru | siklus lama berhenti (`gen++`) |
| Hapus kartu | `sync()` tidak ditunggu, hasil tidak dilaporkan | `synced` + pesan jelas |

Aturan yang dipegang: **perintah tidak pernah dilaporkan berhasil sebelum perangkat
mengonfirmasi**. Perbaikan ini tidak mengubah protokol firmware: permintaan dan bentuk
balasan tetap sama (`/api/data`, `/api/relay?ch=&state=`, `/api/status`, `/api/sync`,
`/api/open?sec=`, `/api/close`, `/api/enroll?sec=`). Yang berubah hanya cara server
menafsirkan balasan yang sudah ada.

### 3.6 Termux & siklus hidup (B-04, B-17, B-22)

- Tidak ada `unhandledRejection`/`uncaughtException`: satu promise gagal (mis. `fetch`
  perangkat terputus saat jaringan berganti) menghentikan proses di Node 22. Sekarang
  dicatat ringkas (tanpa stack, tanpa isi permintaan), state penting disimpan, proses
  tetap hidup.
- `telegram.start()` dipanggil tanpa `.catch` saat `startDevices()`.
- `shutdown()` hanya menghentikan scheduler/updater/executor. Ditambah: seluruh polling
  perangkat, pengawas sesi WS, `auth.stop()`, `mobileAuth.stop()`, `confirm.stop()`,
  `sensorHistory.stop()`, penutupan klien WebSocket dengan kode standar `1001`, dan
  `server.close()` + `closeAllConnections()`.
- `headersTimeout = 0` membuat header yang menggantung tidak pernah ditutup; diubah ke
  60 detik. `requestTimeout = 0` **dipertahankan** karena unggahan besar ke flash disk
  memang bisa lama.

Tidak ada asumsi systemd: skrip `npm start`/`npm test` dan `shutdown()` tidak bergantung
pada systemd; perilaku `SIGINT`/`SIGTERM` tetap mengakhiri proses dengan kode `130`
(diverifikasi oleh tes yang menjalankan `server.js` sungguhan).

### 3.7 Keamanan (B-02, B-20, B-23)

Kebocoran rahasia paling serius: `GET /api/setup/status` memakai
`hide = !authed && !required()`. Ketika `ADMIN_PASSWORD` belum terisi (setup belum
selesai, atau `.env` disunting manual, atau wizard ditinggalkan di tengah), `hide` menjadi
`false` sehingga **kunci API ESP32, kunci API ESP8266, token bot Telegram, dan chat ID**
dikirim ke siapa pun yang membuka halaman itu di LAN. Halaman setup tidak membutuhkan
nilai-nilai itu untuk bekerja — ia hanya perlu tahu bahwa nilainya sudah ada. Sekarang
rahasia tidak pernah dikirim tanpa sesi login; halaman memakai penanda `hasKey`/`hasToken`.

Terkait: formulir setup mengirim balik nilai kosong untuk field yang tidak ditampilkan,
sehingga dulu menyimpan ulang wizard bisa menghapus kunci yang sudah tersimpan. Sekarang
nilai kosong berarti "tidak diubah".

Diperiksa dan tidak diubah: header keamanan (`nosniff`, `Referrer-Policy`,
`X-Frame-Options`/`frame-ancestors`, HSTS via HTTPS), pemeriksaan `Origin` untuk non-GET,
penolakan token di URL, `Cache-Control: no-store` pada respons sesi mobile, dan tidak
adanya pencatatan token/password di log (`audit.js` tidak menyimpan rahasia).

### 3.8 Sistem update (B-07, B-30)

`updater.js` membandingkan `installed !== latest` untuk menentukan `updateAvailable`.
Pada repo yang punya commit lokal lebih baru dari `origin/main` (mis. server yang dipakai
untuk pengembangan, atau `git pull` dilakukan manual), hasilnya `true` padahal tidak ada
yang perlu dipasang. Sekarang memakai `git rev-list --left-right --count installed...origin/<branch>`
sehingga `updateAvailable = behind > 0`, dengan `aheadCount`/`behindCount` diekspos
(hanya tambahan field; klien Android memakai `ignoreUnknownKeys = true`). Bila git versi
lama tidak mendukung, kembali ke perbandingan commit seperti sebelumnya.

Server **tidak** punya dan tidak ditambahkan endpoint pemasangan update (B-30): tes yang
sudah ada (`tests/updater.test.js`) memang memastikan tidak ada rute `install/apply/pull`.
Prosedur pemasangan tetap manual dan memerlukan persetujuan admin (`docs/UPGRADE.md`),
`npm run backup` tetap cadangan satu arah — belum ada restore otomatis (B-29).

### 3.9 Telegram, jadwal, AI (B-16, B-18, B-21)

- `restart()` mengosongkan `offset`, sehingga setelah `getUpdates` berikutnya perintah
  terakhir yang belum di-ack dapat dijalankan ulang (mis. `/file` dua kali). Sekarang
  `offset` hanya direset bila token bot benar-benar berganti.
- `tick()` menjalankan semua jadwal yang sudah jatuh tempo, tanpa batas keterlambatan,
  sehingga jadwal "buka pintu 08:00" bisa dieksekusi berjam-jam terlambat setelah Termux
  dibekukan di latar belakang. Sekarang kebijakan `SCHEDULE_MISSED_POLICY` dan
  `SCHEDULE_MAX_LATE_S` berlaku juga saat proses berjalan (sama seperti saat bootstrap).
- Penyapu konfirmasi hanya menghapus rekaman yang lewat masa retensi; rekaman
  `pending` yang kedaluwarsa tidak pernah ditandai `expired`, sehingga
  `GET /api/ai/confirmations` menampilkan tombol yang selalu gagal (410). Sekarang
  penyapu menandai `expired` dan `list()` juga menyaring yang sudah lewat TTL.

---

## 4. Yang diperiksa dan sengaja tidak diubah

| Area | Alasan |
|---|---|
| Bentuk respons & nama field semua endpoint | Kompatibilitas dashboard + aplikasi Android; hanya menambah field opsional (`synced`, `hasKey`, `hasToken`, `aheadCount`, `behindCount`) |
| Event & payload WebSocket | Kontrak `docs/WEBSOCKET.md` dan pemakaian di aplikasi |
| Protokol firmware `/api/*` pada ESP32/ESP8266 | Firmware di `frimware/` tidak boleh berubah |
| Cookie `sid`, Bearer, refresh, registrasi/pencabutan perangkat | Kontrak `docs/AUTHENTICATION.md` |
| `executor.js` (terminal) | Perilaku lama: opt-in `TERMINAL_ENABLED`, hanya sesi admin, berjalan sebagai user Termux (bukan root); bukan sandbox dan tidak diubah menjadi sandbox karena itu perubahan arsitektur (B-28) |
| `backup.js` (tanpa restore) | Kemampuan yang belum ada; dibangun hanya jika diminta (B-29) |
| `UPLOAD_MAX_MB=0` | Perilaku terdokumentasi (B-27) |
| `resolve()` fallback cookie (B-25), limiter bersama (B-26) | Bukan bug (lihat §3.2) |

---

## 5. Keterbatasan audit

- **Tidak ada perangkat keras fisik** (ESP32/ESP8266) dan tidak ada perangkat Termux
  fisik. Semua perilaku perangkat diuji dengan modul palsu (`vm` + `fetch` stub) atau
  dengan firmware sebagai acuan kontrak. Verifikasi di perangkat sungguhan masih perlu
  (lihat bagian 11 laporan perbaikan).
- **Tidak ada perangkat Android** yang menjalankan aplikasi; kompatibilitas diperiksa
  dari definisi API (`ApiService.kt`, `ApiDtos.kt`) dan konfigurasi JSON
  (`ignoreUnknownKeys = true`, `coerceInputValues = true`, `explicitNulls = false`).
- Bagian Telegram yang membutuhkan jaringan (`getUpdates`, kirim pesan) tidak diuji
  end-to-end; tes memakai `fetch` palsu seperti tes Telegram yang sudah ada.
- Uji beban/Soak (mis. 24 jam berjalan) tidak dilakukan.

---

## 6. Cara memverifikasi ulang

```bash
cd NodelixcoreOS
npm install          # node_modules tidak ikut dalam snapshot
npm test             # node --check semua berkas + node --test tests/*.test.js
```

Tes yang relevan dengan temuan di atas:

| Berkas | Isi |
|---|---|
| `tests/server-bugfix.test.js` | ESP32 (kalibrasi, payload rusak, relay konfirmasi), ESP8266 (status, perintah, `synced`, hapus kartu), sesi mobile, updater, setup |
| `tests/api-gate.test.js` | Gerbang `/api` deny-by-default pada `server.js` sungguhan |
| `tests/websocket-abuse.test.js` | Frame WS rusak tidak mematikan proses; `SIGTERM` → kode 130 |
| `tests/confirm-expiry.test.js` | Penyapu konfirmasi & daftar pending |
| `tests/schedule-behavior.test.js` | Kebijakan jadwal terlewat saat proses berjalan |
| `tests/updater.test.js` | `ahead`/`behind`, kegagalan `git`, rute update di balik auth |
| `tests/storage-behavior.test.js`, `tests/storage-media.test.js` | Path traversal, symlink, Range/206/416, unggah streaming |
| `tests/mobile-auth.test.js` | ECDSA, challenge, refresh, pencabutan, pemutusan WS `4403` |
| `tests/server-integration.test.js` | Alur HTTP nyata: login, CSRF, 404 JSON, header keamanan |
