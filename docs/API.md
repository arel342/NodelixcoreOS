# NodelixcoreOS — REST API Contract

Dokumentasi ini menjelaskan **API yang benar-benar berjalan** di `server.js` versi 1.2.0
(dashboard web + NodelixcoreOS Mobile). Tidak ada endpoint rencana di sini: setiap baris
telah diperiksa terhadap kode dan diuji di `tests/`.

- Autentikasi: [`docs/AUTHENTICATION.md`](AUTHENTICATION.md)
- WebSocket: [`docs/WEBSOCKET.md`](WEBSOCKET.md)
- Upgrade server: [`docs/UPGRADE.md`](UPGRADE.md)

---

## 1. Dasar

| Item | Nilai |
|---|---|
| Base URL | `http://<IP-server>:<PORT>` (default `3000`, LAN tepercaya); HTTPS opsional melalui `TLS_ENABLED=true` |
| Format | JSON (`Content-Type: application/json`), kecuali upload/hasil download |
| Encoding | UTF-8 |
| Autentikasi web | Cookie `sid` (`HttpOnly; SameSite=Lax`) |
| Autentikasi mobile | `Authorization: Bearer <sessionToken>` |
| Token di URL | **Ditolak** (`400`) — jangan pernah `?token=...` |
| Gerbang `/api` | **Deny-by-default**: setiap `/api/*` (dan `/uploads/*`) wajib sesi sah, kecuali endpoint publik yang tercantum di bagian 2 (`login`, `logout`, `session`, `settings/lang`, `setup/*`, `mobile/*`, `request-otp`, `verify-otp`, `reset-password`) |
| Header keamanan | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN` (dapat dimatikan dengan `ALLOW_IFRAME=true`), HSTS hanya lewat HTTPS |

### 1.1 Bentuk respons

- Endpoint lama (dashboard) memakai bentuk yang sudah ada: `{ "success": true }` atau
  `{ "error": "..." }`. Bentuk ini **dipertahankan** agar dashboard tidak rusak.
- Endpoint `/api/mobile/*` memakai bentuk standar berikut:

```json
{ "success": true, "message": "Authentication successful" }
```

Kesalahan pada jalur mobile:

```json
{ "success": false, "ok": false, "code": "challenge_invalid", "message": "Challenge tidak dikenal atau bukan milik perangkat ini." }
```

### 1.2 Kode status yang dipakai

| Kode | Arti |
|---|---|
| `200` | Berhasil |
| `206` | Rentang byte (`Range`) untuk media |
| `400` | Permintaan/parameter tidak valid |
| `401` | Belum login / token tidak sah / kedaluwarsa |
| `403` | Tidak berhak (password admin salah, perangkat dicabut, CSRF) |
| `404` | Endpoint/perangkat/berkas tidak ada |
| `405` | Metode HTTP tidak didukung untuk endpoint tersebut |
| `409` | Setup awal belum selesai; atau proses lain sedang berjalan (OTA) |
| `413` | Berkas terlalu besar |
| `416` | Rentang byte di luar berkas |
| `429` | Terlalu banyak percobaan (lihat header/`retryAfter`) |
| `502` | Perangkat ESP tidak merespons |

---

## 2. Setup awal & sesi web

| Metode & Path | Auth | Keterangan |
|---|---|---|
| `GET /api/setup/status` | publik | Status wizard setup (rahasia hanya untuk sesi login) |
| `POST /api/setup/*` | publik (saat setup) | Langkah setup: akun, server, perangkat, Telegram, AI |
| `GET /api/settings/lang` | publik | `{ "lang": "id" }` |
| `POST /api/settings/lang` | publik | Ganti bahasa (`id`/`en`/`zh`) |
| `POST /api/login` | publik | `{ "username", "password" }` → `Set-Cookie: sid=...` |
| `GET /api/session` | publik | `{ authenticated, method, deviceId, expiresAt }` |
| `POST /api/logout` | sesi | Memutus sesi web **dan** mencabut Bearer bila dikirim |
| `POST /api/request-otp` | publik | Kirim OTP reset password ke Telegram admin |
| `POST /api/verify-otp` | publik | `{ "code": "123456" }` → `{ "token": "..." }` |
| `POST /api/reset-password` | publik (token) | Ganti password admin; semua sesi web diputus |

Contoh:

```bash
curl -i -X POST http://192.168.1.10:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"rahasia"}'
# HTTP/1.1 200 OK
# Set-Cookie: sid=<64 hex>; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200
```

Batas login: 5 kali gagal → `429` selama 5 menit per IP. Perbandingan password memakai
`crypto.timingSafeEqual`.

---

## 3. Autentikasi mobile (ECDSA P-256)

Ringkasan kontrak (detail lengkap di [`docs/AUTHENTICATION.md`](AUTHENTICATION.md)):

| Metode & Path | Auth | Keterangan |
|---|---|---|
| `POST /api/mobile/auth/register` | password admin (atau sesi dashboard) | Daftarkan kunci publik perangkat, langsung menerima sesi |
| `POST /api/mobile/devices/register` | sama | Alias eksplisit untuk registrasi perangkat |
| `POST /api/mobile/auth/challenge` | publik (perangkat harus terdaftar) | Nonce 32 byte, sekali pakai, TTL 60 detik |
| `POST /api/mobile/auth/verify` | tanda tangan ECDSA | Menerbitkan `sessionToken` |
| `GET /api/mobile/auth/session` | Bearer/cookie | Info sesi berjalan |
| `POST /api/mobile/auth/refresh` | Bearer | Rotasi token (token lama dicabut) |
| `POST /api/mobile/auth/logout` | Bearer | Cabut token (idempoten) |
| `GET /api/mobile/devices/registered` | Bearer/cookie | Daftar perangkat terdaftar |
| `DELETE /api/mobile/devices/registered/:deviceId` | Bearer/cookie | Cabut perangkat + seluruh sesinya |

### 3.1 `POST /api/mobile/auth/register`

```json
{
  "username": "admin",
  "password": "<password admin>",
  "deviceId": "ndlx-550e8400-e29b-41d4-a716-446655440000",
  "deviceName": "Google Pixel 9",
  "androidVersion": "Android 15 (API 35)",
  "appVersion": "1.0.0",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...\n-----END PUBLIC KEY-----"
}
```

Respons `200`:

```json
{
  "success": true,
  "ok": true,
  "deviceId": "ndlx-550e8400-e29b-41d4-a716-446655440000",
  "status": "ACTIVE",
  "registeredAt": 1762041600000,
  "publicKeyFingerprint": "SHA256:AB:CD:...:9F",
  "algorithm": "ECDSA_P256_SHA256",
  "sessionToken": "<64 hex>",
  "accessToken": "<64 hex>",
  "tokenType": "Bearer",
  "expiresAt": 1762128000000,
  "username": "admin",
  "message": "Device registered",
  "sessionsRevoked": 0
}
```

`sessionToken` adalah nama field **standar**. `accessToken`, `ok`, dan `tokenType`
disediakan sebagai alias kompatibilitas untuk aplikasi Android yang sudah beredar —
keduanya berisi nilai yang sama.

Kemungkinan kesalahan:

| Status | `code` | Sebab |
|---|---|---|
| `400` | `bad_device_id` | `deviceId` kosong/karakter tidak sah |
| `400` | `bad_public_key` | Bukan PEM SPKI, bukan EC, bukan P-256, atau berisi private key |
| `403` | `admin_credentials_required` | Username/password admin salah atau tidak dikirim (maks. 10 percobaan / 5 menit per IP) |
| `403` | `adminPasswordWrong` (dari dashboard) | Password admin salah |
| `404` | `mobile_auth_disabled` | `MOBILE_AUTH_ENABLED=false` |
| `409` | `setup_required` | Setup awal belum selesai |
| `429` | `too_many_attempts` | Percobaan registrasi terlalu sering |

### 3.2 `POST /api/mobile/auth/challenge`

```json
{ "deviceId": "ndlx-550e8400-e29b-41d4-a716-446655440000" }
```

```json
{
  "success": true,
  "ok": true,
  "challengeId": "chl_9f8a7b6c5d4e6f7a8b9c0d1e",
  "nonce": "<Base64 32 byte>",
  "issuedAt": 1762041600000,
  "expiresAt": 1762041660000,
  "serverOrigin": "http://192.168.1.10:3000",
  "originCandidates": 3,
  "algorithm": "ECDSA_P256_SHA256",
  "ttlMs": 60000,
  "message": "Challenge issued"
}
```

- Hanya **satu** challenge aktif per perangkat (yang lama otomatis dibatalkan).
- Perangkat tidak dikenal/dicabut → `403` dengan `code` `device_not_registered` /
  `device_revoked`. **Bukan** `404`, supaya aplikasi tidak salah menyimpulkan bahwa
  server belum mendukung API mobile.

### 3.3 `POST /api/mobile/auth/verify`

```json
{
  "deviceId": "ndlx-550e8400-e29b-41d4-a716-446655440000",
  "challengeId": "chl_9f8a7b6c5d4e6f7a8b9c0d1e",
  "timestamp": 1762041612345,
  "signatureBase64": "<DER SHA256withECDSA, Base64>"
}
```

- `signature` (tanpa `Base64`) juga diterima sebagai alias.
- `serverOrigin` opsional; dipakai bila reverse proxy membuat `Host` berbeda dari URL
  yang diketik di aplikasi.
- Yang ditandatangani (UTF-8, persis):

```text
NODELIXCOREOS-AUTH-V1|<deviceId>|<challengeId>|<nonce>|<timestampMillis>|<origin>
```

```json
{
  "success": true,
  "ok": true,
  "sessionToken": "<64 hex>",
  "accessToken": "<64 hex>",
  "tokenType": "Bearer",
  "expiresAt": 1762128000000,
  "deviceId": "ndlx-550e8400-e29b-41d4-a716-446655440000",
  "username": "admin",
  "origin": "http://192.168.1.10:3000",
  "message": "Authentication successful"
}
```

| Status | `code` | Sebab |
|---|---|---|
| `400` | `bad_*` | Body/format tanda tangan tidak valid |
| `401` | `challenge_invalid` | Challenge tidak ada, sudah dipakai (replay), atau milik perangkat lain |
| `401` | `challenge_expired` | Lewat TTL 60 detik |
| `401` | `timestamp_out_of_range` | Selisih jam > 60 detik |
| `401` | `invalid_signature` | Tanda tangan tidak cocok dengan kunci terdaftar |
| `403` | `device_not_registered` / `device_revoked` | Perangkat tidak aktif |
| `429` | `too_many_attempts` | Maks. 20 percobaan/5 menit per IP, 10/5 menit per perangkat |

Challenge **selalu** dihanguskan pada percobaan verifikasi pertama, berhasil maupun
gagal (anti-replay).

### 3.4 Sesi mobile

`GET /api/mobile/auth/session` (Bearer):

```json
{
  "success": true,
  "authenticated": true,
  "method": "mobile",
  "deviceId": "ndlx-...",
  "deviceStatus": "ACTIVE",
  "deviceName": "Google Pixel 9",
  "publicKeyFingerprint": "SHA256:AB:...",
  "username": "admin",
  "expiresAt": 1762128000000
}
```

Tanpa sesi sah → `401` dengan `{ "authenticated": false }`.

`POST /api/mobile/auth/refresh` → `sessionToken` baru; token lama langsung tidak berlaku.

`POST /api/mobile/auth/logout` → `{ "success": true, "revoked": true }` (idempoten).
Koneksi WebSocket milik token tersebut langsung ditutup (`4403`).

### 3.5 Manajemen perangkat

`GET /api/mobile/devices/registered`:

```json
{
  "success": true,
  "count": 1,
  "devices": [
    {
      "deviceId": "ndlx-...",
      "deviceName": "Google Pixel 9",
      "androidVersion": "Android 15 (API 35)",
      "appVersion": "1.0.0",
      "publicKeyFingerprint": "SHA256:AB:...",
      "algorithm": "ECDSA_P256_SHA256",
      "registeredAt": 1762041600000,
      "lastSeenAt": 1762045200000,
      "status": "ACTIVE",
      "revokedAt": null,
      "sessions": 1,
      "isCurrentDevice": true
    }
  ]
}
```

Public key **tidak** dikirim ke klien (hanya fingerprint). Password admin, token
Telegram/Gemini, dan kunci API perangkat juga tidak pernah dikirim.

`DELETE /api/mobile/devices/registered/:deviceId` → perangkat menjadi `REVOKED`, semua
sesinya dicabut, dan challenge yang belum dipakai dibuang:

```json
{ "success": true, "deviceId": "ndlx-...", "status": "REVOKED", "revokedAt": 1762049000000, "sessionsRevoked": 1 }
```

Perangkat yang dicabut harus **registrasi ulang** dengan password admin untuk bisa
login kembali.

---

## 4. Telemetri & pengaturan

Semua endpoint di bawah menerima **cookie `sid`** maupun **Bearer**.

| Metode & Path | Keterangan |
|---|---|
| `GET /api/system` | `{ now, snapshot, history }` — CPU/RAM/flash terakhir (`snapshot` = data lengkap seperti event `SYSTEM`) + 90 sampel terakhir |
| `GET /api/settings` | `{ esp32, door, telegram, ai, server, monitor, info }` |
| `POST /api/settings` | Simpan sebagian pengaturan (validasi ketat, tanpa restart) |
| `POST /api/settings/account` | Ubah username/password admin (wajib password lama) |
| `POST /api/settings/telegram/test` | Kirim pesan uji Telegram |
| `POST /api/settings/device/test` | Uji koneksi ESP32/ESP8266 |
| `POST /api/settings/device/push` | Kirim ulang konfigurasi WiFi/IP ke ESP |
| `POST /api/settings/device/portal` | Minta ESP masuk mode setup |

> `GET /api/settings` mengembalikan kunci API perangkat dan token Telegram ke **sesi
> admin** (dipakai halaman Pengaturan). Aplikasi Android tidak menampilkannya; jangan
> pernah mengirim respons ini ke pihak ketiga.

---

## 5. ESP32 (PLTS) & relay

| Metode & Path | Body | Keterangan |
|---|---|---|
| `GET /api/esp32/status` | — | Snapshot pemantauan + riwayat |
| `POST /api/esp32/relay` | `{ "id": "1&2" \| "3" \| "4" \| "all", "state": true }` | `state` boleh boolean, `"on"/"off"`, `1/0` |
| `POST /api/esp32/calibrate` | `{ "type": "tap", "id": 1, "actual": 4.18 }` / `{ "type": "i-zero" }` / `{ "type": "i-gain", "actual": 1.25 }` / `{ "type": "reset" }` | Kalibrasi ADC/arus |

`GET /api/esp32/status` mengembalikan `online`, `lastOk`, `fails`, `lastError`, `esp`,
`battery`, `current`, `dht`, `aux`, `relays`, `alerts`, `limits`, `history`.
Nilai **tidak pernah dikarang**: perangkat offline → `online:false` dan data terakhir
yang benar-benar terukur (dengan penanda waktu).

---

## 6. Pintu RFID (ESP8266)

| Metode & Path | Body | Keterangan |
|---|---|---|
| `GET /api/door/status` | — | `configured, online, open, left, enabled, openSec, synced, enroll, cards, log` |
| `POST /api/door/open` | `{}` | Buka pintu (jangan pernah auto-retry di klien) |
| `POST /api/door/close` | `{}` | Tutup pintu |
| `POST /api/door/lock` | `{ "enabled": true\|false }` | Boolean wajib (string ditolak) |
| `POST /api/door/config` | `{ "openSec": 0..10 }` | Lama solenoid terbuka |
| `POST /api/door/enroll` | `{ "action": "start"\|"cancel" }` | Daftarkan kartu baru |
| `POST /api/door/cards/rename` | `{ "uid": "11223344", "name": "Kunci Depan" }` | Ganti nama kartu |
| `POST /api/door/cards/admin` | `{ "uid", "admin": true, "password": "<password admin>" }` | Hanya untuk menaikkan hak admin |
| `DELETE /api/door/cards/:uid` | — | Hapus kartu (respons menyertakan `synced`) |

`POST /api/door/cards/admin` memverifikasi password admin di server (timing-safe,
5 percobaan/5 menit per IP) dan tidak pernah menyimpan/menyiarkan password itu.

**Konfirmasi perangkat.** `POST /api/door/config`, `POST /api/door/cards/admin`, dan
`DELETE /api/door/cards/:uid` menyimpan perubahan di server lebih dulu, lalu melaporkan
`synced: true` hanya kalau ESP8266 menerima dan menggemakan versi konfigurasi yang baru.
`synced: false` berarti perubahan **belum** berlaku di perangkat (mis. pintu offline) —
nilai tetap tersimpan dan akan dikirim pada sinkronisasi berikutnya. Field `success`
tidak berubah (tetap `true`), jadi klien lama tidak terpengaruh.

Perintah `POST /api/door/open`, `/close`, dan `/enroll` hanya dijawab `success: true`
setelah perangkat membalas `{"ok":true}`. Balasan `{"ok":false}` atau perangkat tidak
merespons dijawab **502** dengan `success: false` dan pesan yang menjelaskan sebabnya.

---

## 7. Storage & file manager

| Metode & Path | Keterangan |
|---|---|
| `GET /api/storage/status` | `{ mode, root, ready, message, total, free }` |
| `GET /api/files?dir=<rel>` | `{ currentDir, files:[{ name, isDirectory, size, modified }] }` |
| `POST /api/create-folder` | `{ "dir": "", "folderName": "backup" }` |
| `POST /api/upload?dir=<rel>` | `multipart/form-data`, part `file` |
| `GET /api/download?path=<rel>&zip=1` | Unduh berkas/folder (zip) |
| `GET /uploads/<rel>` | Pratinjau inline; mendukung `Range` (206/416) |
| `POST /api/rename` | `{ "dir", "oldName", "newName" }` |
| `POST /api/compress` | `{ "dir", "name" }` → membuat `.zip` |
| `POST /api/paste` | `{ "action": "copy"\|"move", "sourceDir", "targetDir", "items": [] }` |
| `DELETE /api/files?path=<rel>` | Hapus berkas/folder |

Batas keamanan: nama divalidasi (tanpa `..`, tanpa karakter kontrol), path dijaga tetap
di dalam folder penyimpanan (termasuk pemeriksaan symlink), dan ukuran satu upload
dibatasi `UPLOAD_MAX_MB` (default 2048 MB, `0` = tanpa batas).

---

## 8. Firmware OTA

| Metode & Path | Keterangan |
|---|---|
| `GET /api/firmware` | `{ devices:[{ key, label, host, port, configured, online, fw, ip, rssi, updating }], maxMB, busy, busyDevice }` |
| `POST /api/firmware/flash` | `multipart/form-data`: `device` (`esp32`\|`esp8266`) + `file` `.bin` |

Berkas diperiksa di server sebelum dikirim: ekstensi `.bin`, ukuran ≤ `OTA_MAX_MB`, dan
magic byte gambar ESP `0xE9`. Kesalahan selalu berupa JSON dengan `success:false` dan
`error`, mis. `{ "success": false, "error": "Berkas bukan gambar firmware ESP." }`.

---

## 9. Update Center (GitHub)

| Metode & Path | Keterangan |
|---|---|
| `GET /api/update/status` | `{ success, enabled, installedCommit, latestCommit, updateAvailable, commits, lastCheckedAt, ... }` |
| `POST /api/update/check` | Menjalankan `git fetch origin` (cooldown 30 detik) |
| `POST /api/update/notify` | Kirim ringkasan update ke Telegram |

Server **tidak pernah** menjalankan `git pull`/`git reset` otomatis. Pemasangan update
adalah tindakan manual (lihat [`docs/UPGRADE.md`](UPGRADE.md)).

---

## 10. Terminal web & AI Agent

| Metode & Path | Keterangan |
|---|---|
| `GET /api/terminal/info` | Status terminal (`TERMINAL_ENABLED`) |
| `POST /api/terminal/enabled` | Nyalakan/matikan terminal |
| `POST /api/terminal/run` | Jalankan perintah (`{ cmd }`) |
| `GET /api/terminal/job/:id` | Status pekerjaan |
| `POST /api/terminal/input` | Kirim stdin |
| `POST /api/terminal/kill` | Hentikan pekerjaan |
| `POST /api/ai/*` | Chat AI, konfirmasi tindakan, riwayat |

Semua endpoint ini memerlukan sesi admin (cookie atau Bearer) dan tidak pernah terbuka
tanpa login.

---

## 11. Catatan kompatibilitas

- Endpoint dan bentuk respons lama **tidak diubah**; perubahan bersifat aditif
  (`success`, `message`, field baru, endpoint `/api/mobile/*`).
- Endpoint `/api/*` yang tidak dikenal mengembalikan **JSON 404**, sehingga aplikasi
  dapat membedakan "tidak ada endpoint" dari "salah metode" (`405`).
- Stack trace dan detail internal tidak pernah dikirim ke klien; kesalahan server
  menjadi `500` dengan pesan umum.
