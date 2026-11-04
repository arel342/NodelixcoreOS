# Laporan Perbaikan Bug Server NodelixcoreOS 1.2.0

Laporan ini merinci perbaikan bug yang **sudah ada** di backend Node.js NodeliXcoreOS.
Audit lengkap (metode, daftar temuan, area yang sengaja tidak diubah) ada di
[`SERVER_BUG_AUDIT.md`](SERVER_BUG_AUDIT.md).

| Item | Nilai |
|---|---|
| Repo | `arel342/NodelixcoreOS`, basis `ba694e4` (versi `1.2.0`) |
| Klien acuan | `arel342/Nlodelix-mobile` |
| Runtime pengujian | Node.js **22.22.3**, Linux `6.1.158` |
| Dependensi baru | **tidak ada** (`express`, `multer`, `ws` tetap) |
| Endpoint dihapus/diganti nama | **tidak ada** |
| Field respons yang dihapus | **tidak ada** (hanya penambahan field opsional) |
| Tes | 175 → **210** (209 lulus, 1 dilewati, 0 gagal) |

---

## 1. Temuan audit

Ringkas (detail per area ada di `SERVER_BUG_AUDIT.md` §2–§3):

| # | Area | Severity | Temuan |
|---|---|---|---|
| B-01 | API | Kritis | Daftar rute terlindungi manual → `/api/*` di luar daftar terbuka tanpa login |
| B-02 | Keamanan | Kritis | `/api/setup/status` mengirim kunci API + token Telegram ke pengunjung tanpa login |
| B-03 | WebSocket | Kritis | Frame WS tidak sah mematikan seluruh proses |
| B-04 | Termux | Kritis | Tidak ada penangan `unhandledRejection`/`uncaughtException` |
| B-05 | ESP32 | Tinggi | Relay dilaporkan sukses tanpa konfirmasi perangkat |
| B-06 | ESP8266 | Tinggi | Perintah pintu dilaporkan sukses walau ditolak perangkat |
| B-07 | Update | Tinggi | `updateAvailable` positif palsu saat repo lokal lebih baru |
| B-08 | Auth | Tinggi | Sesi mobile per perangkat tanpa batas |
| B-09…B-12 | ESP32/8266 | Sedang | Payload perangkat tidak divalidasi (crash / offline palsu / "online" tanpa data) |
| B-13, B-14 | ESP8266 | Sedang | `/api/door/config` dan hapus kartu tidak melaporkan hasil sinkronisasi |
| B-15 | Semua poller | Sedang | `start()`/`reload()` ganda menggandakan rantai polling |
| B-16 | Telegram | Sedang | `restart()` mereset `offset` → perintah dapat dieksekusi dua kali |
| B-17 | Termux | Sedang | `shutdown()` tidak menutup polling/WebSocket/soket |
| B-18 | Jadwal | Sedang | Kebijakan jadwal terlewat hanya berlaku saat bootstrap |
| B-19 | API | Sedang | `/api/request-otp` publik tanpa batas laju |
| B-20 | Setup | Sedang | Field kunci kosong menghapus kunci tersimpan |
| B-21…B-24 | AI/Termux/Keamanan/ESP | Rendah | Konfirmasi kedaluwarsa tampil, tanpa `no-store`, `headersTimeout=0`, pesan galat tertutup |

Empat area diperiksa dan **tidak** diubah: `resolve()` fallback cookie (B-25), limiter
login bersama (B-26), `UPLOAD_MAX_MB=0` (B-27), dan terminal bukan sandbox (B-28).

---

## 2. Bug yang terkonfirmasi

Semua bug di bawah ini **direproduksi lebih dulu**, bukan hanya diduga dari membaca kode.

| ID | Reproduksi sebelum perbaikan | Bukti setelah perbaikan |
|---|---|---|
| B-01 | `GET /api/rute-yang-belum-ada` tanpa cookie → `404` (bukan `401`) | `tests/api-gate.test.js` (8 tes) |
| B-02 | `/api/setup/status` tanpa `ADMIN_PASSWORD` memuat `esp32.apiKey`, `door.apiKey`, `telegram.token`, `chatId` | `tests/server-bugfix.test.js` — "setup: … tidak membocorkan kunci" |
| B-03 | `node` + frame `[0x81,0x01,0xff]` → `UNCAUGHT: WS_ERR_EXPECTED_MASK`, proses keluar kode 3 | `tests/websocket-abuse.test.js` (4 tes, proses `server.js` sungguhan) |
| B-04 | `throw` di `setTimeout` / promise tanpa `.catch` → proses Termux mati | `server.js` handler + tes `SIGTERM` |
| B-05 | `POST /api/esp32/relay` → `200 {success:true}` walau perangkat membalas `{ok:false}` / tanpa perubahan | `tests/server-bugfix.test.js` — 3 tes relay (200/502/502) |
| B-06 | `POST /api/door/open` → `200 {success:true}` saat perangkat membalas `{ok:false}` | `tests/server-bugfix.test.js` — "perintah buka pintu yang ditolak…" |
| B-07 | `git rev-list --left-right --count` = `2 0` → `updateAvailable: true` | `tests/server-bugfix.test.js` + `tests/updater.test.js` |
| B-08 | 3 login perangkat yang sama dengan batas 2 → 3 token sah tersimpan | `tests/server-bugfix.test.js` — "sesi mobile per perangkat dibatasi" |
| B-09 | payload tanpa `cal.taps[id]` → `TypeError` di `poll()`, `fails` naik | `tests/server-bugfix.test.js` — "payload sensor tanpa kalibrasi" |
| B-10 | kalibrasi nol + payload tanpa `current` → `TypeError` | idem — "kalibrasi arus nol dibatalkan" |
| B-11 | `ingest()` menerima string/array → `online:true` tanpa data | idem |
| B-12 | `events: {broken:true}` → pintu dianggap offline | "payload status rusak tidak membuat pintu offline" |
| B-13 | `/api/door/config` → `{success:true}` tanpa info sinkronisasi | "config melaporkan synced sesuai konfirmasi perangkat" |
| B-14 | `DELETE /api/door/cards/:uid` → `{success:true}` walau pintu offline | "hapus kartu melaporkan apakah perangkat sudah mengonfirmasi" |
| B-15 | `start(); start()` → dua timer 1000 ms aktif | "reload/start berulang tidak menggandakan rantai polling" (ESP32, pintu) |
| B-18 | jadwal 2 jam terlambat dijalankan `tick()` walau policy `skip` | `tests/schedule-behavior.test.js` (3 tes baru) |
| B-21 | `list()` menampilkan konfirmasi yang sudah lewat TTL | `tests/confirm-expiry.test.js` (3 tes) |

---

## 3. Akar masalah

1. **Fail-open by design.** Autentikasi API memakai daftar putih rute yang ditulis manual.
   Setiap rute baru yang lupa didaftarkan otomatis terbuka. Ganti dengan deny-by-default
   (daftar publik eksplisit) — bukan menambah satu per satu ke daftar lama.
2. **Data eksternal diperlakukan sebagai terpercaya.** `esp32.js`/`door.js` menganggap
   balasan HTTP perangkat selalu berbentuk objek JSON dengan field lengkap
   (`raw.current.irms`, `cal.taps[id].gain`, `j.events.slice().sort`). Satu field hilang
   → exception di dalam loop `poll()` → `fails++` → perangkat tampak offline, atau
   sebaliknya: payload sampah diterima sebagai status sah.
3. **"Sukses" berarti "permintaan terkirim", bukan "perangkat mengonfirmasi".** Handler
   relay/pintu hanya menunggu balasan HTTP 2xx dan mengabaikan isi balasan (`ok:false`),
   sehingga dashboard dan aplikasi menampilkan keberhasilan yang tidak terjadi. Ini
   berbahaya untuk pintu: pengguna mengira pintu terbuka padahal solenoid tidak bergerak.
4. **Asumsi "satu proses, satu rantai timer".** `start()`/`reload()` dipanggil ulang dari
   halaman Pengaturan setiap kali pengaturan disimpan; `setTimeout` lama tidak dibatalkan
   bila siklusnya sedang menunggu `fetch`, sehingga rantai timer bertambah.
5. **Perbandingan versi memakai identitas commit, bukan arah perbedaan.** `installed !== latest`
   tidak bisa membedakan "tertinggal" dari "mendahului".
6. **Tidak ada jaring pengaman proses.** Di Termux tidak ada supervisor; satu exception
   tak tertangani = layanan rumah mati. `ws` memancarkan `'error'` untuk pelanggaran
   protokol dan tidak ada listener-nya.
7. **`shutdown()` tidak lengkap.** Hanya tiga sub-sistem dihentikan; polling perangkat,
   klien WebSocket, dan soket pendengar dibiarkan sampai `process.exit()` memutus paksa.
8. **Penyapu konfirmasi tidak menandai status `expired`.** Hanya menghapus rekaman yang
   sudah lewat masa retensi 15 menit, sehingga daftar `pending` memuat entri mati.

---

## 4. Berkas yang diubah

| Berkas | Perubahan | Alasan |
|---|---|---|
| `server.js` | Gerbang `/api` deny-by-default; listener `'error'` pada upgrade WS; `flushState()` + jaring pengaman proses; `shutdown()` lengkap; `headersTimeout=60s`; limiter OTP; `no-store` untuk OTP/reset | B-01, B-03, B-04, B-17, B-19, B-22, B-23 |
| `esp32.js` | Validasi payload & kalibrasi, `gen` untuk polling, konfirmasi relay | B-05, B-09, B-10, B-11, B-15 |
| `door.js` | Validasi `ingest()`, `confirmed()` untuk perintah, `gen`, `synced` pada config & hapus kartu, pesan galat jelas | B-06, B-12, B-13, B-14, B-15, B-24 |
| `system.js` | `gen` untuk loop sampling | B-15 |
| `telegram.js` | `pollGen` sudah ada; `offset` dipertahankan kecuali token berganti | B-16 |
| `scheduler.js` | Kebijakan jadwal terlewat juga di `tick()` | B-18 |
| `confirm.js` | Penyapu menandai `expired`, `list()` menyaring, `sweep()` diekspos untuk tes | B-21 |
| `auth.js` | `MOBILE_MAX_SESSIONS_PER_DEVICE` + `pruneDeviceSessions()` | B-08 |
| `setup.js` | Rahasia hanya untuk sesi login, `hasKey`/`hasToken`, kunci kosong = tidak diubah | B-02, B-20 |
| `updater.js` | `aheadCount`/`behindCount`, `updateAvailable = behind > 0` | B-07 |
| `lang.js` | 7 pesan baru × 3 bahasa (`esp.badData`, `door.badData`, `door.noConfirm`, `door.noConfirm*`, `door.cardDeleted*`) | Pesan galat perangkat & kartu |
| `public/setup.js`, `public/i18n.js` | Wizard memakai `hasKey`/`hasToken`, placeholder "kunci tersimpan" | B-02, B-20 |
| `.env.example`, `docs/AUTHENTICATION.md`, `docs/API.md` | Dokumentasi gerbang `/api`, `synced`, `MOBILE_MAX_SESSIONS_PER_DEVICE` | B-01, B-08, B-13, B-14 |
| `tests/*` | 4 berkas tes baru + 2 berkas tes lama diperluas | Lihat §9 |
| `package-lock.json` | Versi lockfile disinkronkan ke `1.2.0` (efek `npm install`) | Konsistensi |

Tidak ada berkas yang dihapus dan tidak ada modul baru.

---

## 5. Perbaikan

### 5.1 Autentikasi API (B-01)

```js
// Sebelum: daftar rute terlindungi manual (fail-open)
app.use(['/api/files', ..., '/uploads'], requireAuth);

// Sesudah: deny-by-default dengan daftar publik eksplisit (fail-closed)
const PUBLIC_API = [
    /^\/api\/login$/, /^\/api\/logout$/, /^\/api\/session$/,
    /^\/api\/settings\/lang$/, /^\/api\/setup(\/|$)/, /^\/api\/mobile(\/|$)/,
    /^\/api\/request-otp$/, /^\/api\/verify-otp$/, /^\/api\/reset-password$/
];
app.use((req, res, next) => {
    const p = req.path;
    if (p === '/uploads' || p.startsWith('/uploads/')) return requireAuth(req, res, next);
    if (p !== '/api' && !p.startsWith('/api/')) return next();
    if (PUBLIC_API.some(rx => rx.test(p))) return next();
    return requireAuth(req, res, next);
});
```

Perilaku yang berubah hanya untuk permintaan **tanpa sesi**: `/api/*` yang tidak publik
kini `401` (JSON) alih-alih `404`/data. Permintaan dengan sesi sah tidak berubah.

### 5.2 Kebocoran kunci di wizard setup (B-02, B-20)

- `state()`: `hide = !authed` (dulu `!authed && !required()`), nilai rahasia diganti `''`
  dan ditambah penanda `hasKey` (ESP32/ESP8266/AI) serta `hasToken` (Telegram).
- `POST /api/setup/device` dan `/api/setup/telegram`: `apiKey`/`token` yang dikirim
  kosong dihapus dari payload (server tidak menimpa nilai tersimpan).
- `public/setup.js`: placeholder `wz.keyKept` saat `hasKey` benar, dan kunci baru hanya
  dibuat kalau belum ada kunci tersimpan.

### 5.3 WebSocket (B-03)

```js
socket.on('error', e => console.warn('[WebSocket] soket upgrade:', String(e && e.message).slice(0, 120)));
try { /* tulis 401 / handleUpgrade */ } catch (e) { /* log + destroy */ }
ws.on('error', e => console.warn('[WebSocket] koneksi:', String(e && e.message).slice(0, 120)));
```

Semua event, kode tutup (`4401`, `4403`), dan bentuk payload **tidak berubah**.

### 5.4 Jaring pengaman proses & shutdown (B-04, B-17, B-22)

- `flushState()` menyimpan riwayat sensor, riwayat AI, sesi mobile, dan daftar perangkat.
- `process.on('unhandledRejection' | 'uncaughtException')` mencatat pesan terpotong
  (tanpa stack, tanpa isi permintaan), menyimpan state, dan **tidak** mematikan proses.
- `shutdown()` sekarang menghentikan ESP32, pintu, sistem, Telegram, scheduler, updater,
  executor, riwayat sensor, konfirmasi, `auth.stop()`, `mobileAuth.stop()`, menutup klien
  WebSocket dengan kode `1001`, lalu `server.close()` + `closeAllConnections()`.
- `SIGINT`/`SIGTERM` tetap keluar dengan kode `130` (diuji).

### 5.5 ESP32 (B-05, B-09, B-10, B-11)

- `tapCal(id)` mengembalikan `{gain:1, offset:0}` bila entri kalibrasi hilang/rusak.
- `compute()` memvalidasi setiap bagian: tap tanpa `v` angka dilewati, `current` hanya
  dibuat bila `irms` angka (`peak`, `clip`, `va` tetap ada).
- `evaluate()` hanya mengevaluasi alarm arus bila `current` ada.
- `ingest()` menolak payload non-objek (`esp.badData`) sehingga dibaca sebagai gagal,
  bukan sukses.
- Kalibrasi arus nol dibatalkan bila payload tidak memuat `irms` (tidak ada `NaN`).
- `setRelay()`: `{ok:false}` → `esp.relayRejected`; balasan tanpa perubahan status relay
  → `esp.relayNoConfirm`; kedua-duanya `502` dan status lokal menampilkan keadaan
  sebenarnya yang dilaporkan perangkat. Sukses hanya setelah perangkat mengonfirmasi.

### 5.6 ESP8266 (B-06, B-12, B-13, B-14, B-24)

- `confirmed(j)` dipakai `open()`, `close()`, `enroll()`, `cancelEnroll()`: `{ok:false}`
  → `door.noConfirm` (502).
- `ingest()` menolak payload non-objek (`door.badData`) dan menyaring event tanpa `id`
  numerik; daftar kartu/log tidak terpengaruh.
- `/api/door/config` → `{ success:true, synced }` (nilai tetap disimpan walau offline).
- `DELETE /api/door/cards/:uid` → menunggu `bump()`, menjawab `{ success:true, synced, message }`.
- Wrapper galat meneruskan pesan yang sudah spesifik (`door.noConfirm`, `door.offline`,
  `door.nameEmpty`, `door.nameUsed`) dan hanya membungkus gangguan jaringan.

### 5.7 Polling ganda (B-15)

`gen`/`pollGen` dinaikkan oleh `stop()` dan oleh setiap `start()` baru; siklus `poll()`
yang sedang menunggu balasan berhenti tanpa menjadwalkan putaran berikutnya. Diterapkan
di `esp32.js`, `door.js`, `system.js`; `telegram.js` sudah memakai pola yang sama.

### 5.8 Update (B-07)

```js
const counts = await git(['rev-list', '--left-right', '--count', `${installed}...origin/${branch}`]);
state.aheadCount = ahead; state.behindCount = behind;
state.updateAvailable = behind > 0;
```

Bila `rev-list` gagal (git lama), kembali ke `installed !== latest`. `aheadCount`/
`behindCount` divalidasi saat memuat state dari disk dan diekspos di `view()`.

### 5.9 Sesi mobile (B-08)

`pruneDeviceSessions(deviceId)` mencabut token **terlama** milik perangkat yang sama
bila melewati `MOBILE_MAX_SESSIONS_PER_DEVICE` (default 10, jepit 1–100). Pencabutan
memakai jalur yang sama dengan pencabutan manual, sehingga handler `safeRevoke` juga
memutus WebSocket yang memakai token itu.

### 5.10 Jadwal, konfirmasi, Telegram (B-16, B-18, B-21)

- `scheduler.tick()` menerapkan `SCHEDULE_MAX_LATE_S` + `SCHEDULE_MISSED_POLICY` yang
  sama dengan `bootstrap()`, menghitung `missed`, dan mengirim notifikasi satu kali.
- `confirm.js`: `sweep()` menandai `pending` → `expired` dan membuang rekaman lewat
  retensi; `list()` juga menyaring entri yang sudah lewat TTL.
- `telegram.js`: `offset` hanya direset ketika `TELEGRAM_BOT_TOKEN` benar-benar berubah.

### 5.11 OTP (B-19, B-23)

Limiter 3 permintaan / 5 menit per IP untuk `/api/request-otp` (terpisah dari limiter
login), dan `Cache-Control: no-store` untuk `/api/request-otp`, `/api/verify-otp`,
`/api/reset-password`.

---

## 6. Hasil kompatibilitas API

| Kontrak | Hasil |
|---|---|
| Endpoint dihapus / diubah nama | **Tidak ada** |
| Field respons dihapus / diganti nama | **Tidak ada** |
| Field baru | `synced` (`POST /api/door/config`, `POST /api/door/cards/admin`, `DELETE /api/door/cards/:uid`), `hasKey`/`hasToken` (`GET /api/setup/status`), `aheadCount`/`behindCount` (`GET|POST /api/update/*`) |
| Klien Android | `ApiService.kt` memetakan seluruh endpoint yang dipakai; DTO memakai `ignoreUnknownKeys = true`, `coerceInputValues = true`, `explicitNulls = false` → field tambahan aman |
| `ApiDtos.kt` yang diperiksa | `SessionCheckDto`, `GenericStatusDto`, `DeviceTestResponseDto`, `RelayCommandResponseDto`, `DoorStatusDto`, `Esp32StatusDto`, `StorageStatusDto`, `FileListResponseDto`, `UpdaterStatusDto` |
| Dashboard web | `public/*.js` hanya memeriksa `success`/`message`/`synced`; tidak ada pembacaan field yang dihapus |
| Kode status berubah | Hanya pada kondisi yang sebelumnya **salah**: perintah perangkat yang tidak dikonfirmasi kini `502` (dulu `200`), `/api` non-publik tanpa sesi kini `401` (dulu `404`/data), `/api/request-otp` ke-4 dalam 5 menit `429` |
| Protokol firmware | Tidak berubah (`/api/data`, `/api/relay?ch=&state=`, `/api/status`, `/api/sync`, `/api/open?sec=`, `/api/close`, `/api/enroll?sec=`, `/api/ota`) |
| Cookie/Bearer/refresh/registrasi/pencabutan perangkat | Tidak berubah |

> Catatan: aplikasi Android menerima `message` dari server pada respons gagal; pesan 502
> baru (`door.noConfirm`, `esp.relayNoConfirm`, `esp.relayRejected`) langsung tampil
> sebagai alasan kegagalan. Ini perbaikan informasi, bukan perubahan kontrak.

---

## 7. Temuan keamanan

| # | Temuan | Dampak sebelum | Perbaikan |
|---|---|---|---|
| B-01 | `/api/*` di luar daftar terbuka tanpa login | Data sensor/sistem/perangkat bisa dibaca tanpa login; rute baru otomatis terbuka | Deny-by-default + daftar publik eksplisit |
| B-02 | Kunci API ESP32/ESP8266, token bot Telegram, chat ID dikirim ke pengunjung tanpa login | Siapa pun di LAN dapat mengambil kendali perangkat/chat | Rahasia hanya untuk sesi login + penanda `hasKey`/`hasToken` |
| B-03 | Satu frame WS rusak mematikan proses | DoS sepele (satu baris `printf` lewat `nc`) | Listener `'error'` pada soket upgrade & `ws` |
| B-04 | Promise/exception tak tertangani mematikan proses | Jaringan perangkat terputus bisa mematikan pemantauan | Jaring pengaman proses + state disimpan |
| B-19 | `/api/request-otp` publik tanpa batas laju | Banjir chat Telegram admin; OTP sah tertimpa | Limiter 3/5 menit per IP |
| B-23 | Respons OTP/reset token dapat di-cache | Token reset bocor lewat cache/proxy | `Cache-Control: no-store` |
| B-22 | `headersTimeout = 0` | Soket setengah terbuka menahan memori | `headersTimeout = 60000` |

Diperiksa dan tetap seperti semula (bukan bug): rahasia tidak pernah ditulis ke log,
token tidak pernah `console.log`, password admin diverifikasi timing-safe, password
kartu admin tidak disimpan/disiarkan, token di URL ditolak `400`, `executor.js` berjalan
sebagai user Termux (bukan root) dan hanya untuk sesi admin dengan `TERMINAL_ENABLED`.

---

## 8. Hasil verifikasi fitur (tidak ada fitur yang hilang)

| Fitur | Status | Bukti |
|---|---|---|
| Dashboard web (monitor, pengaturan, file manager, terminal, AI, update) | Utuh | `tests/server-integration.test.js`, `tests/update-ui.test.js` (dilewati: `jsdom` tidak terpasang) |
| REST API (semua endpoint) | Utuh | `tests/api-gate.test.js`, `tests/server-integration.test.js` |
| Mobile API ECDSA + Bearer | Utuh | `tests/mobile-auth.test.js` (19) |
| Auth web (cookie), login/logout, reset via OTP | Utuh | `tests/auth-core.test.js` (14) |
| Monitoring sistem (CPU/RAM/flash) | Utuh | `tests/core-behavior.test.js` |
| AI agent, konfirmasi, riwayat | Utuh | `tests/ai-behavior.test.js`, `tests/ai-history.test.js`, `tests/ai-key.test.js`, `tests/confirm-expiry.test.js` |
| Telegram (perintah, kirim berkas, potong pesan) | Utuh | `tests/telegram-behavior.test.js`, `tests/telegram-files.test.js` |
| Storage & media (Range, MIME, unggah streaming) | Utuh | `tests/storage-behavior.test.js`, `tests/storage-media.test.js` |
| ESP32 (sensor, kalibrasi, relay, riwayat) | Utuh + lebih aman | `tests/server-bugfix.test.js`, `tests/relay.test.js` |
| ESP8266 (status, buka/tutup, enroll, kartu, admin card) | Utuh + lebih aman | `tests/server-bugfix.test.js`, `tests/door-admin.test.js` |
| Firmware OTA (ESP32/ESP8266) | Utuh | `tests/firmware.test.js` |
| Scheduler & otomasi | Utuh + kebijakan terlewat konsisten | `tests/schedule-behavior.test.js` (10) |
| Terminal admin | Utuh | `tests/core-behavior.test.js` |
| WebSocket (7 event) | Utuh | `tests/websocket-abuse.test.js`, `tests/mobile-auth.test.js` |
| Sistem update (cek, notifikasi, status) | Utuh + lebih akurat | `tests/updater.test.js` (22) |
| Wizard setup | Utuh + tidak membocorkan rahasia | `tests/setup-settings.test.js` (22), `tests/server-bugfix.test.js` |
| i18n (id/en/zh) | Utuh | `tests/i18n.test.js` (4) |

---

## 9. Hasil pengujian

```
$ npm test
# node --check server.js auth.js mobile-auth.js … public/update.js   (45 berkas, semua OK)
# tests 210
# pass 209
# fail 0
# skipped 1        (tests/update-ui.test.js — jsdom tidak terpasang, prasyarat lama)
```

| Berkas tes | Jumlah | Status |
|---|---|---|
| `tests/server-bugfix.test.js` | 17 (baru) | lulus |
| `tests/api-gate.test.js` | 8 (baru) | lulus |
| `tests/websocket-abuse.test.js` | 4 (baru) | lulus |
| `tests/confirm-expiry.test.js` | 3 (baru) | lulus |
| `tests/schedule-behavior.test.js` | 10 (7 lama + 3 baru) | lulus |
| `tests/updater.test.js` | 22 (asersi rute diperbarui) | lulus |
| 17 berkas tes lain | 146 | lulus |
| `tests/update-ui.test.js` | 1 | dilewati (jsdom) |

Tes yang **ditambahkan** (semua aditif; tidak ada tes lama yang dihapus):

- `server-bugfix.test.js` — ESP32 (kalibrasi/payload/relay), ESP8266 (status/perintah/
  `synced`/hapus kartu), batas sesi mobile, arah update, kebocoran rahasia setup.
- `api-gate.test.js` — gerbang `/api` pada proses `server.js` sungguhan (401 vs 404, publik
  tetap terbuka, `/uploads`, token di URL, JSON rusak, logout).
- `websocket-abuse.test.js` — frame rusak (UTF-8, panjang salah, mask hilang), snapshot
  awal setelah serangan, dan `SIGTERM` → kode keluar **130** tanpa exception.
- `confirm-expiry.test.js` — penyapu konfirmasi, retensi, penegakan identitas.
- `schedule-behavior.test.js` — jadwal terlambat saat proses berjalan (`skip` dan `run-once`).

Tes yang bergantung perangkat keras **tidak** diklaim lulus: pengujian di atas memakai
perangkat palsu (`vm` + `fetch` stub). `tests/firmware.test.js` dan tes relay memakai
`fetch` palsu juga.

---

## 10. Verifikasi runtime Termux

Yang **benar-benar dijalankan** (Linux `6.1.158`, Node 22.22.3, bukan perangkat Termux):

1. `node server.js` di port acak dengan `ADMIN_PASSWORD`, storage sementara, dan perangkat
   kosong → server siap, login `200`, WebSocket mengirim snapshot awal
   (`SENSOR`, `DOOR`, `UPDATE`, `DEVICE_COUNT`).
2. 3 frame WebSocket rusak berturut-turut + koneksi yang diputus sepihak → proses **tetap
   hidup**, HTTP `200`, log hanya berisi peringatan terpotong, keluar tanpa exception.
3. `SIGTERM` → proses berhenti sendiri dengan kode **130**, tanpa `uncaughtException`,
   state tersimpan.
4. `npm test` penuh (210 tes) berjalan pada runtime yang sama.

Yang **belum** diverifikasi dan tidak diklaim:

- Termux/Android sungguhan (perilaku `su`, path `/storage/emulated/0`, pembekuan proses di
  latar belakang, Doze). Perbaikan `shutdown()`, `headersTimeout`, dan kebijakan jadwal
  terlewat dirancang untuk kondisi itu, tetapi hanya diuji di Linux.
- ESP32/ESP8266 fisik (relay, solenoid pintu, RFID, OTA).
- Telegram sungguhan (bot token asli, `getUpdates` jaringan nyata).
- Aplikasi Android yang berjalan (hanya definisi API yang diperiksa).

---

## 11. Masalah yang masih tersisa

| # | Masalah | Status |
|---|---|---|
| 1 | `executor.js` menjalankan shell sungguhan; bukan sandbox. Bukan root, hanya aktif dengan `TERMINAL_ENABLED=true` dan sesi admin | Batasan arsitektur (B-28), tidak diubah |
| 2 | `backup.js` tidak punya restore otomatis; pemulihan masih manual | Kemampuan yang belum ada (B-29) |
| 3 | Tidak ada pemasangan update/rollback otomatis di server; tetap manual + persetujuan admin (`docs/UPGRADE.md`) | Kemampuan yang belum ada (B-30) |
| 4 | `getRegisteredMobileDevices`/pencabutan perangkat hanya butuh sesi sah (bukan khusus admin). Pada sistem satu-admin, sesi mobile = admin, jadi tidak diubah agar fitur "kelola perangkat" di aplikasi tetap berfungsi | Sengaja dipertahankan |
| 5 | Limiter login dipakai bersama verifikasi password ulang (B-26) | Sengaja dipertahankan |
| 6 | `resolve()` fallback cookie saat Bearer tidak sah (B-25) | Sengaja dipertahankan (kompatibilitas) |
| 7 | Verifikasi perangkat keras/Termux fisik belum dilakukan | Perlu verifikasi manual (lihat §10) |
| 8 | Telegram OTP/jaringan nyata tidak diuji end-to-end | Perlu verifikasi manual |
| 9 | `tests/update-ui.test.js` dilewati karena `jsdom` tidak terpasang (tidak menambah dependensi baru) | Prasyarat lama |

---

## 12. Hal yang memerlukan perubahan aplikasi Android

Tidak ada perubahan yang **wajib** — semua endpoint, nama field, dan bentuk payload yang
dipakai aplikasi tetap ada. Yang perlu diperhatikan (opsional, bukan penghalang):

| # | Perubahan server | Dampak di aplikasi | Tindakan |
|---|---|---|---|
| 1 | Perintah pintu/relay yang tidak dikonfirmasi perangkat kini `502` + `message` | Sebelumnya aplikasi menerima `success:true` padahal perintah gagal. Sekarang `NetworkResultMapper` memetakan ke `Failure` dengan pesan server | Tidak ada perubahan wajib; jangan menambahkan percobaan ulang otomatis pada `POST /api/door/open` (risiko solenoid) |
| 2 | `DELETE /api/door/cards/:uid` mengembalikan `synced` + `message` | `GenericStatusDto` mengabaikannya (`ignoreUnknownKeys`) | Opsional: tampilkan peringatan bila `synced == false` |
| 3 | `POST /api/door/config` dan `/api/door/cards/admin` mengembalikan `synced` | Idem | Opsional: tampilkan "menunggu sinkronisasi" |
| 4 | `/api/request-otp` dibatasi 3/5 menit per IP → `429` + `message` | Layar login sebaiknya menampilkan pesan server apa adanya | Opsional: tampilkan `retryAfter` bila ada |
| 5 | `updateAvailable` lebih akurat (tidak lagi `true` saat repo lokal lebih baru) | Notifikasi update tidak muncul pada kondisi yang memang bukan update | Tidak ada perubahan |
| 6 | `GET /api/setup/status` tidak lagi mengirim rahasia tanpa sesi | Aplikasi tidak memakai endpoint ini pada mode tanpa sesi | Tidak ada perubahan |
| 7 | `/api/*` non-publik tanpa sesi → `401` (dulu `404`) | Logika "server lama tanpa endpoint" di aplikasi bisa salah menafsirkan; saat belum login hasilnya memang `401` | Tidak ada perubahan wajib; `NetworkResultMapper` sudah menangani `401` |

---

## Lampiran — perintah verifikasi

```bash
cd NodelixcoreOS
npm install
npm test

# hanya temuan utama
node --test tests/api-gate.test.js tests/websocket-abuse.test.js \
            tests/server-bugfix.test.js tests/confirm-expiry.test.js \
            tests/schedule-behavior.test.js tests/updater.test.js

# reproduksi manual bug WS (opsional, memakai koneksi mentah ke server yang sedang jalan)
npm start            # terminal 1
printf 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n\x81\x01\xff' \
  | nc 127.0.0.1 3000   # server tetap hidup setelah ini
```
