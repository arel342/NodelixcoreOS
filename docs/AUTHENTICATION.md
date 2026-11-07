# Autentikasi: Cookie Web, Bearer Mobile, dan ECDSA P-256

Dokumen ini menjelaskan cara kerja autentikasi NodelixcoreOS 1.2.0 sebagaimana
diimplementasikan di `auth.js`, `mobile-auth.js`, dan `server.js`.

---

## 1. Ringkasan

| Klien | Mekanisme | Disimpan di | Berlaku setelah restart? |
|---|---|---|---|
| Dashboard web | Cookie `sid` (64 hex) | Memori server (`Map`) | **Tidak** — login ulang (perilaku lama) |
| Aplikasi Android | `Authorization: Bearer <sessionToken>` | `data/mobile-sessions.json` (hash SHA-256) | **Ya** (default 30 hari) |

Keduanya melewati **satu** pemeriksaan (`auth.requireAuth`), sehingga Bearer tidak bisa
melewati aturan apa pun yang berlaku untuk dashboard: semua endpoint admin tetap
memerlukan sesi sah, dan aksi yang butuh password admin (mis. menaikkan kartu RFID
menjadi admin) tetap meminta password tersebut.

Kedua mekanisme tidak pernah menaruh token pada URL. Permintaan dengan
`?token=`, `?session_token=`, `?access_token=`, `?bearer=`, atau `?authorization=`
ditolak `400` sebelum diproses.

---

## 2. Login web (tidak berubah)

```http
POST /api/login
{ "username": "admin", "password": "<password>" }
```

- Perbandingan memakai `crypto.timingSafeEqual` di atas SHA-256 (panjang tetap).
- 5 percobaan gagal → `429` selama 5 menit per IP (juga dipakai untuk aksi yang
  memverifikasi ulang password admin).
- Berhasil → `Set-Cookie: sid=<64 hex>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<TTL>`.
- `SESSION_TTL_HOURS` (default 12) menentukan masa berlaku.
- `POST /api/logout` menghapus sesi tersebut; `POST /api/settings/account` (ganti
  password dari dashboard) memutus semua sesi web lain; `POST /api/reset-password`
  (OTP Telegram) memutus **semua** sesi web.

Sesi web sengaja tetap di memori seperti versi sebelumnya: restart server = harus login
ulang di browser. Ini tidak berlaku untuk sesi mobile.

---

## 3. Registrasi perangkat mobile

Perangkat Android membuat kunci **ECDSA P-256 non-exportable** di Android Keystore,
lalu mengirim **public key**-nya:

```http
POST /api/mobile/auth/register
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

Otorisasi:

1. Sesi dashboard yang sudah login (cookie `sid`) **atau**
2. `username` + `password` admin yang benar (timing-safe), maksimal 10 percobaan per
   5 menit per IP.

Tidak ada jalur lain: public key tidak bisa didaftarkan tanpa otorisasi admin.

Validasi kunci (ditolak `400` `bad_public_key` bila gagal):

| Pemeriksaan | Aturan |
|---|---|
| Format | PEM `-----BEGIN PUBLIC KEY-----` … `-----END PUBLIC KEY-----` (SPKI) |
| Private key | Ditolak (`BEGIN PRIVATE KEY`/`EC PRIVATE KEY`) |
| Tipe | `asymmetricKeyType === 'ec'` |
| Kurva | `prime256v1` (P-256 / secp256r1) |
| Ukuran | ≤ 4 KB |

Server menyimpan hanya public key + fingerprint SHA-256 (SPKI DER). **Private key tidak
pernah dikirim ke server dan tidak pernah diminta.**

Registrasi ulang dengan `deviceId` yang sama akan:
- memperbarui metadata perangkat,
- mengganti public key tersimpan,
- mencabut semua sesi lama perangkat itu,
- menerbitkan sesi baru.

---

## 4. Challenge–response

### 4.1 Permintaan challenge

```http
POST /api/mobile/auth/challenge
{ "deviceId": "ndlx-..." }
```

Server membuat:

- `challengeId` = `chl_` + 12 byte acak (hex),
- `nonce` = 32 byte dari `crypto.randomBytes(32)` (Base64),
- `issuedAt`, `expiresAt = issuedAt + 60 000 ms`,
- daftar kandidat **origin** (lihat §5).

Aturan:

- Hanya satu challenge aktif per perangkat; challenge lama dibatalkan.
- Challenge disimpan di memori (tanpa disk) — tidak perlu bertahan restart karena
  umurnya hanya 60 detik.
- Perangkat tidak terdaftar / dicabut → `403` (bukan `404`, agar aplikasi tidak salah
  menyimpulkan "server belum mendukung API mobile").

### 4.2 Menandatangani

Aplikasi menandatangani string kanonik berikut dengan `SHA256withECDSA`
(`Signature.getInstance("SHA256withECDSA")`, hasil ASN.1 DER, Base64 tanpa baris baru):

```text
NODELIXCOREOS-AUTH-V1|<deviceId>|<challengeId>|<nonceBase64>|<timestampMillis>|<origin>
```

- `deviceId`, `challengeId`, `nonce` di-trim.
- `timestampMillis` = waktu perangkat (epoch ms).
- `origin` = `scheme://host:port` server seperti yang diketik di aplikasi, huruf kecil,
  tanpa garis miring di akhir (mis. `http://192.168.1.10:3000`).

Contoh Node.js (untuk pengujian/manual):

```js
const crypto = require('node:crypto');
const canonical = ['NODELIXCOREOS-AUTH-V1', deviceId, challengeId, nonce, String(ts), origin.toLowerCase()].join('|');
const signature = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), { key: privateKey, dsaEncoding: 'der' });
```

### 4.3 Verifikasi

```http
POST /api/mobile/auth/verify
{
  "deviceId": "ndlx-...",
  "challengeId": "chl_...",
  "timestamp": 1762041612345,
  "signatureBase64": "<DER Base64>",
  "serverOrigin": "http://192.168.1.10:3000"   // opsional
}
```

Pemeriksaan berurutan (semua wajib lolos):

1. **Format** body valid (`400` bila tidak).
2. **Rate limit**: 20 percobaan/5 menit per IP, 10/5 menit per perangkat.
3. **Challenge ada dan milik perangkat itu** — jika tidak, `401 challenge_invalid`.
4. **Challenge langsung dihanguskan** (single-use, sebelum verifikasi berikutnya).
5. **Belum kedaluwarsa** (60 detik) → `401 challenge_expired`.
6. **Timestamp** dalam ±60 detik dan tidak mendahului `issuedAt` →
   `401 timestamp_out_of_range`.
7. **Perangkat masih `ACTIVE`** → `403` bila dicabut.
8. **Tanda tangan valid** untuk salah satu kandidat origin →
   `401 invalid_signature` bila tidak ada yang cocok.

Format tanda tangan yang diterima:

- **ASN.1 DER** (format Android Keystore) — jalur utama,
- **r||s 64 byte mentah** (P1363/JOSE) — untuk klien lain,
- Base64 (utama) atau hex dengan panjang yang sesuai.

`crypto.verify('sha256', payload, { key, dsaEncoding })` dipakai sehingga tidak ada
implementasi kriptografi buatan sendiri.

### 4.4 Hasil

```json
{
  "success": true,
  "sessionToken": "<64 hex>",
  "accessToken": "<64 hex>",
  "tokenType": "Bearer",
  "expiresAt": 1762128000000,
  "deviceId": "ndlx-...",
  "username": "admin",
  "message": "Authentication successful"
}
```

`sessionToken` adalah nama standar; `accessToken` adalah alias untuk kompatibilitas
aplikasi. Masa berlaku sesi = `MOBILE_SESSION_TTL_HOURS` (default **720 jam / 30 hari**),
dapat diperpanjang dengan `POST /api/mobile/auth/refresh` (rotasi token).

---

## 5. Origin: mengapa ada kandidat

`origin` adalah bagian dari tanda tangan (domain separation) supaya tanda tangan untuk
satu server tidak bisa dipakai ulang di server lain. Aplikasi tidak mengirim `origin`
saat `verify`, sehingga server menyusun kandidat dari:

1. `MOBILE_AUTH_SERVER_ORIGIN` (bila diisi, daftar dipisah koma) — **disarankan** jika
   server berada di balik reverse proxy TLS,
2. `X-Forwarded-Host` / `Host` + `X-Forwarded-Proto`, dalam varian `https://` dan
   `http://` untuk host yang sama,
3. `serverOrigin` yang dikirim klien pada body `verify` (bila ada).

Tanda tangan dianggap sah bila cocok dengan **salah satu** kandidat. Nonce tetap
sekali pakai, sehingga memperluas daftar origin tidak membuka replay.

Contoh reverse proxy (Caddy/Nginx) yang meneruskan header:

```nginx
proxy_set_header Host $host:$server_port;
proxy_set_header X-Forwarded-Host $host:$server_port;
proxy_set_header X-Forwarded-Proto $scheme;
```

Atau sederhanakan dengan `.env`:

```env
MOBILE_AUTH_SERVER_ORIGIN=https://192.168.1.10:8443
```

---

## 6. Bearer token

- Nilai: 32 byte acak kriptografis → 64 karakter hex (opaque, tanpa makna internal).
- Yang disimpan di disk: **SHA-256 dari token**, bukan token itu sendiri.
  File: `data/mobile-sessions.json` (mode `0600`, penulisan atomik `tmp` + `rename`).
- Masa berlaku dicek pada setiap permintaan; token kedaluwarsa dihapus dari memori &
  disk (penyapu tiap 10 menit + saat startup).
- `lastUsedAt` diperbarui maksimal sekali per menit agar tidak menulis disk terus-menerus.
- Pencabutan: `POST /api/mobile/auth/logout` (satu token), `POST /api/mobile/auth/refresh`
  (token lama dicabut + token baru), `DELETE /api/mobile/devices/registered/:deviceId`
  (semua token perangkat + perangkat ditandai `REVOKED`).
- Setiap pencabutan langsung memutus koneksi WebSocket milik sesi tersebut.

Header yang dipakai:

```http
Authorization: Bearer <sessionToken>
```

Token **tidak** pernah dicatat di log server (`[Mobile]` hanya mencatat `deviceId` dan
origin).

---

## 7. Tabel konfigurasi

| Variabel `.env` | Default | Arti |
|---|---|---|
| `MOBILE_AUTH_ENABLED` | `true` | `false` → semua endpoint `/api/mobile/*` menjawab `404` (aplikasi otomatis memakai mode cookie) |
| `MOBILE_SESSION_TTL_HOURS` | `720` | Masa berlaku sesi Bearer |
| `MOBILE_CHALLENGE_TTL_MS` | `60000` | Umur challenge |
| `MOBILE_CHALLENGE_SKEW_MS` | `60000` | Toleransi selisih jam perangkat |
| `MOBILE_MAX_PENDING_CHALLENGES` | `2000` | Batas challenge tersimpan di memori |
| `MOBILE_MAX_SESSIONS_PER_DEVICE` | `10` | Batas sesi aktif per perangkat (1–100). Sesi terlama dicabut otomatis saat batas terlampaui |
| `MOBILE_AUTH_SERVER_ORIGIN` | *(kosong)* | Origin eksplisit (dipisah koma) untuk reverse proxy |
| `SESSION_TTL_HOURS` | `12` | Masa berlaku cookie dashboard |
| `JSON_BODY_LIMIT` | `512kb` | Batas body JSON |
| `UPLOAD_MAX_MB` | `2048` | Batas satu berkas upload (`0` = tanpa batas) |

---

## 8. Model ancaman & batasan

| Ancaman | Mitigasi |
|---|---|
| Replay challenge | Challenge sekali pakai, dihanguskan sebelum verifikasi; TTL 60 detik |
| Replay timestamp | Tanda tangan mengikat `timestamp` + `nonce` + `challengeId` |
| Kunci perangkat dicuri | Kunci private tidak pernah keluar dari Android Keystore (non-exportable, biometrik) |
| Registrasi perangkat liar | Wajib password admin (timing-safe, dibatasi) atau sesi dashboard |
| Brute force login/Bearer | Rate limit per IP & per perangkat; token 256-bit |
| Token bocor lewat URL/log | Token di URL ditolak `400`; token hanya di header; log tidak memuat token |
| CSRF dari situs lain | Cookie `SameSite=Lax` + penolakan `Origin` lintas host untuk metode non-GET |
| Clickjacking | `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` |
| Path traversal di file manager | Normalisasi + pemeriksaan symlink (sudah ada) |
| Penyadapan jaringan | **HTTP hanya untuk LAN tepercaya.** Gunakan reverse proxy TLS (`https/wss`) di luar LAN |

Catatan jujur: server ini **tidak** menyediakan enkripsi transport sendiri. Pada
Termux/Android, jalankan di belakang Caddy/Nginx dengan sertifikat lokal, atau terima
risiko penyadapan pada jaringan yang tidak tepercaya. Jangan meneruskan port server ke
internet tanpa TLS.
