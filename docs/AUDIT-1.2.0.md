# Laporan Audit & Upgrade 1.1.0 → 1.2.0

Dokumen ini mencatat apa yang diperiksa, apa yang diubah, dan apa yang **tidak** diubah,
agar setiap perubahan dapat ditelusuri. Kontrak teknis ada di
[`API.md`](API.md), [`AUTHENTICATION.md`](AUTHENTICATION.md), [`WEBSOCKET.md`](WEBSOCKET.md),
dan [`UPGRADE.md`](UPGRADE.md).

---

## 1. Ringkasan

| Aspek | Sebelum (1.1.0) | Sesudah (1.2.0) |
|---|---|---|
| Autentikasi | Cookie `sid` di memori saja | Cookie `sid` (tetap) **+** Bearer mobile (persisten, hash) |
| API mobile | Belum ada (`/api/mobile/*` → 404) | 8 endpoint ECDSA P-256 + Bearer |
| WebSocket | Hanya cookie, cek sekali saat upgrade | Cookie **atau** Bearer, cek ulang tiap 30 detik, putus saat dicabut |
| Penyimpanan sesi | `Map` di memori | Web: `Map` (tidak berubah); Mobile: `data/mobile-sessions.json` (hash, atomik, 0600) |
| Registrasi perangkat | — | Wajib password admin (timing-safe + rate limit) atau sesi dashboard |
| Pencabutan | Logout web saja | Logout token, rotasi token, pencabutan perangkat + pemutusan WebSocket |
| Header keamanan | tidak ada | nosniff, referrer, frame-ancestors/XFO, HSTS via HTTPS |
| CSRF | hanya `SameSite=Lax` | + penolakan `Origin` lintas host untuk non-GET |
| Batas upload | hanya OTA | + `UPLOAD_MAX_MB` di file manager (default 2048 MB) |
| Error tak tertangani | HTML/stack bawaan Express | JSON terstruktur, tanpa stack trace |
| Backup sebelum upgrade | manual (dokumentasi) | `npm run backup` (tanpa dependency) |
| Tes | 134 | 174 (`node --test`) |

---

## 2. Struktur backend

### Sebelum

```text
server.js          express + http + ws, semua route inti, sesi Map lokal
esp32.js           pemantauan PLTS
door.js            pintu RFID
firmware.js        OTA .bin
storage.js         file manager (su)
system.js          telemetri
settings.js        pengaturan .env dari web
setup.js           wizard awal
ai.js, skills-registry.js, telegram.js, scheduler.js, updater.js, ...
```

### Sesudah (tambahan ditandai +)

```text
server.js          + memakai auth.js (requireAuth terpusat), header keamanan, CSRF,
                     error handler JSON, WS auth sebelum upgrade, mobile-auth dipasang
+ auth.js          sesi web + Bearer mobile, limiter, resolusi identitas
+ mobile-auth.js   registrasi perangkat, challenge/verify ECDSA P-256, revoke
+ backup.js        cadangan .env + data/ sebelum upgrade
esp32.js           tidak berubah
door.js            tidak berubah
firmware.js        + field success:false pada respons error (kompatibilitas mobile)
storage.js         + batas UPLOAD_MAX_MB saat streaming
lang.js            + pesan st.tooBig
public/update.js   + perintah manual menyertakan `npm run backup`
+ docs/*.md        kontrak API, autentikasi, WebSocket, upgrade, laporan ini
+ tests/auth-core.test.js, tests/mobile-auth.test.js, tests/server-integration.test.js
```

---

## 3. Berkas

### Dibuat

| Berkas | Isi |
|---|---|
| `auth.js` | Sesi terpusat: cookie `sid`, Bearer (hash SHA-256 di disk), limiter, `resolve`, `requireAuth`, `revalidate`, event pencabutan |
| `mobile-auth.js` | Endpoint `/api/mobile/*`, validasi kunci P-256, challenge sekali pakai, verifikasi DER/P1363, penyimpanan perangkat |
| `backup.js` | `npm run backup` → `backups/<stamp>/` + manifest (commit/branch/perubahan lokal) |
| `docs/API.md` | Kontrak REST lengkap |
| `docs/AUTHENTICATION.md` | Cookie, Bearer, ECDSA, origin, ancaman, konfigurasi |
| `docs/WEBSOCKET.md` | Handshake, event, kode penutupan |
| `docs/UPGRADE.md` | Instalasi/upgrade/rollback Termux tanpa kehilangan data |
| `docs/AUDIT-1.2.0.md` | Dokumen ini |
| `tests/auth-core.test.js` | 14 tes unit sesi/limiter |
| `tests/mobile-auth.test.js` | 19 tes ECDSA + REST + WebSocket (HTTP sungguhan) |
| `tests/server-integration.test.js` | 8 tes `server.js` sungguhan, termasuk restart |

### Diubah

| Berkas | Perubahan |
|---|---|
| `server.js` | Blok sesi lama diganti `auth.js`; header keamanan; CSRF; tolak token di URL; WS auth + watch; 404/error handler JSON; `express.json` limit; `saveEnv` atomik + chmod 600; `/api/session` menambah `method/deviceId/expiresAt`; `/api/logout` mencabut Bearer juga; shutdown menyimpan sesi/perangkat |
| `firmware.js` | `success:false` ditambahkan pada respons error OTA |
| `storage.js` | Batas ukuran upload per berkas (`UPLOAD_MAX_MB`) saat streaming, dengan pembersihan `.part` |
| `lang.js` | Pesan `st.tooBig` (id/en/zh) |
| `public/update.js`, `public/index.html` | Perintah pemasangan manual kini `npm run backup && git pull origin main && npm install` |
| `tests/door-admin.test.js` | Harness mengikuti limiter baru (`loginLimiter` dari `auth.js`) |
| `package.json` | Versi 1.2.0, skrip `backup`, `node --check auth.js mobile-auth.js backup.js` |
| `.env.example` | Variabel mobile, batas permintaan/upload, header, reverse proxy |
| `.gitignore` | `data/mobile-*.json`, `backups/` |
| `README.md` | Fitur mobile, struktur, bagian aplikasi Android, keamanan, status |

### Dihapus

Tidak ada berkas yang dihapus.

---

## 4. Endpoint baru

```text
POST   /api/mobile/auth/register                 registrasi kunci publik + sesi
POST   /api/mobile/devices/register              alias eksplisit
POST   /api/mobile/auth/challenge                nonce 32 byte, TTL 60 dtk
POST   /api/mobile/auth/verify                   SHA256withECDSA -> sessionToken
GET    /api/mobile/auth/session                  info sesi
POST   /api/mobile/auth/refresh                  rotasi token
POST   /api/mobile/auth/logout                   cabut token (idempoten)
GET    /api/mobile/devices/registered            daftar perangkat
DELETE /api/mobile/devices/registered/:deviceId  cabut perangkat + sesi
```

Field baru yang aditif: `success`, `message`, `method/deviceId/expiresAt` di
`/api/session`, `success:false` pada error OTA.

---

## 5. Endpoint lama yang dipertahankan

Semua endpoint 1.1.0 tetap ada dengan path, metode, dan bentuk respons yang sama:
`/api/login`, `/api/logout`, `/api/session`, `/api/request-otp`, `/api/verify-otp`,
`/api/reset-password`, `/api/settings*`, `/api/system`, `/api/esp32/*`, `/api/door/*`,
`/api/files`, `/api/create-folder`, `/api/upload`, `/api/download`, `/uploads/*`,
`/api/rename`, `/api/paste`, `/api/compress`, `/api/firmware*`, `/api/update/*`,
`/api/terminal/*`, `/api/ai/*`, `/api/setup/*`, `/api/settings/lang`.

Cookie `sid` tetap menjadi autentikasi dashboard, dengan TTL `SESSION_TTL_HOURS` yang
sama dan perilaku "restart = login ulang" yang sama.

---

## 6. Cara kerja ECDSA (ringkas)

1. Android membuat kunci P-256 non-exportable; server menerima **public key** SPKI PEM.
2. Challenge: 32 byte acak + `challengeId`, TTL 60 detik, satu per perangkat.
3. Android menandatangani `NODELIXCOREOS-AUTH-V1|deviceId|challengeId|nonce|timestamp|origin`
   (SHA256withECDSA, DER, Base64).
4. Server menghapus challenge (anti-replay), memeriksa TTL, selisih jam ±60 detik,
   status perangkat, lalu `crypto.verify('sha256', …, { dsaEncoding: 'der' })`.
5. Origin diverifikasi terhadap kandidat (`X-Forwarded-Host`/`Host`,
   `MOBILE_AUTH_SERVER_ORIGIN`, atau `serverOrigin` dari klien).
6. Berhasil → `sessionToken` (32 byte acak) disimpan sebagai hash.

---

## 7. Hasil pengujian

Dijalankan di sandbox (Node.js v22.22.3, Linux x86_64):

```bash
npm install     # 70 paket, tanpa dependency baru
npm test        # node --check 41 berkas + 174 tes
```

| Kelompok | Hasil |
|---|---|
| Pemeriksaan sintaks (`node --check`) | lulus semua |
| `tests/*.test.js` (17 berkas) | **174 lulus, 0 gagal** |
| Uji manual `server.js` nyata | register/challenge/verify, Bearer di 8 endpoint, WS cookie & Bearer, WS putus `4403` saat dicabut, sesi bertahan setelah restart, login web + file manager, OTA menolak berkas salah |

Yang **belum** diuji: perangkat ESP32/ESP8266 fisik, Android fisik (aplikasi diuji di
repo terpisah), reverse proxy TLS nyata, serta pembacaan flash disk sungguhan.

---

## 8. Kompatibilitas Termux/Linux

- Tidak ada dependency baru (`express`, `multer`, `ws` saja).
- Node.js ≥ 18.17 (tidak berubah); hanya memakai `node:crypto`, `fs`, `path`.
- `npm install && npm start` tetap menjadi cara menjalankan.
- Penyimpanan pengguna tidak dipindahkan; file baru hanya di `data/` (sudah ada).
- Semua I/O sesi memakai penulisan atomik + `unref()` timer, aman saat `Ctrl+C`.

---

## 9. Masalah yang masih tersisa (jujur)

1. **Tidak ada TLS internal.** HTTPS/WSS harus dari reverse proxy. Server tetap HTTP di
   LAN bila dikonfigurasi demikian; risikonya didokumentasikan, bukan disembunyikan.
2. **Sesi web tetap di memori.** Restart menghapus sesi dashboard (perilaku lama,
   dipertahankan agar tidak mengubah arsitektur). Hanya sesi mobile yang persisten.
3. **Admin password masih plaintext di `.env`** (agar wizard/settings lama tetap
   berjalan). Mitigasi: timing-safe compare, rate limit, `.env` ditulis atomik dengan
   mode 600. Migrasi ke hash akan memutus kompatibilitas pengaturan lama.
4. **Origin challenge bergantung pada header proxy.** Bila reverse proxy tidak
   meneruskan `Host`/`X-Forwarded-*`, isi `MOBILE_AUTH_SERVER_ORIGIN`.
5. **Jam perangkat** harus dalam ±60 detik dari jam server (bisa diatur).
6. **Rate limit berbasis IP in-memory**, bukan firewall. Di balik proxy aktifkan
   `TRUST_PROXY=true`, jika tidak semua klien berbagi satu kuota.
7. **Pemeriksaan update GitHub tidak otomatis dipasang** (memang disengaja).
8. Perangkat keras nyata (relay, solenoid, RFID) belum diverifikasi di 1.2.0 karena
   perubahan tidak menyentuh jalur perangkat; perilaku lama dipertahankan.

---

## 10. Upgrade tanpa kehilangan data

```bash
cd ~/NodelixcoreOS
npm run backup      # .env + data/ + manifest
git pull origin main
npm install
npm test
npm start
```

`.env`, `data/`, dan flash disk tidak disentuh oleh update. Rollback dan detail lengkap:
[`UPGRADE.md`](UPGRADE.md).
