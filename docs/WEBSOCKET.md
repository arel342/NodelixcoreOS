# WebSocket — Autentikasi dan Event

Server memakai `ws` dengan `noServer: true`; koneksi hanya diterima setelah
**HTTP Upgrade** lolos autentikasi.

- URL: `ws://<host>:<port>/` (atau `wss://` di balik reverse proxy TLS)
- Tidak ada token di query string. `ws://host/?token=...` **tidak didukung**.
- Path apa pun diterima setelah autentikasi berhasil (dashboard memakai `/`).

---

## 1. Handshake

| Klien | Header yang dikirim |
|---|---|
| Dashboard web | `Cookie: sid=<64 hex>` |
| Aplikasi Android | `Authorization: Bearer <sessionToken>` |

Keduanya boleh dikirim bersamaan (Bearer diutamakan).

```http
GET / HTTP/1.1
Host: 192.168.1.10:3000
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Version: 13
Authorization: Bearer <sessionToken>
```

Jika tidak sah, server **menolak sebelum upgrade diterima**:

```http
HTTP/1.1 401 Unauthorized
Connection: close
Content-Type: application/json

{"success":false,"message":"Authentication required."}
```

Aplikasi Android (OkHttp) dapat menambahkan header pada `Request.Builder` sebelum
`newWebSocket(...)`; tidak perlu trik query string.

---

## 2. Siklus hidup sesi

1. Saat upgrade, identitas sesi (`kind`, `sid` atau `tokenHash`/`deviceId`) disimpan
   pada koneksi.
2. Setiap 30 detik server memeriksa ulang: apakah sesi masih ada, belum kedaluwarsa,
   dan perangkat masih `ACTIVE`.
3. Pencabutan (`logout`, `refresh`, hapus perangkat, ganti password yang memutus sesi
   web) langsung menutup koneksi yang terkait.

Kode penutupan:

| Kode | Alasan |
|---|---|
| `4401` | Sesi tidak ada/kedaluwarsa saat validasi ulang |
| `4403` | Sesi/perangkat dicabut |
| `1000` | Ditutup normal oleh klien |

Klien sebaiknya memperlakukan `4401`/`4403` sebagai "perlu login ulang", bukan sebagai
gangguan jaringan (jangan auto-reconnect tanpa kredensial baru).

---

## 3. Event server → klien

Semua frame adalah JSON dengan bentuk `{ "type": "...", "data": { ... } }`
(kecuali `DEVICE_COUNT` dan `DOOR_NOTE` yang datanya sejajar).

| `type` | Isi |
|---|---|
| `DEVICE_COUNT` | `{ "type": "DEVICE_COUNT", "count": 2 }` — jumlah klien terhubung |
| `SENSOR` | Snapshot ESP32 (`online`, `esp`, `battery`, `current`, `dht`, `aux`, `relays`, `alerts`, `history`) |
| `DOOR` | Snapshot pintu (`configured`, `online`, `open`, `left`, `enabled`, `openSec`, `synced`, `enroll`, `cards`, `log`) |
| `DOOR_NOTE` | `{ "type": "DOOR_NOTE", "k": "<kunci i18n>", "level": "info\|warn\|error", "text": "..." }` |
| `SYSTEM` | CPU/RAM/flash (`t`, `cpu`, `ram`, `flash`, `cores`, `load`, `uptime`, `unavailable`) tiap ±2 detik |
| `FW` | Progres OTA: `{ "device": "esp32\|esp8266", "phase": "send\|reboot\|done\|error", "message": "..." }` |
| `UPDATE` | Status pemeriksa update GitHub (`installedCommit`, `latestCommit`, `commits`, …) |
| `STORAGE` | Perubahan status penyimpanan (bila ada) |

Saat koneksi dibuka, klien langsung menerima `DEVICE_COUNT`, `SENSOR`, `DOOR`, dan
`UPDATE` (snapshot tersimpan, tanpa memicu pemeriksaan GitHub baru).

Contoh frame:

```json
{"type":"SENSOR","data":{"online":true,"esp":{"ip":"192.168.1.50","rssi":-61,"fw":"1.4.2"},"battery":{"pack":12.31,"soc":78.2},"relays":[{"id":1,"on":false}]}}
```

```json
{"type":"DEVICE_COUNT","count":3}
```

---

## 4. Keamanan

- Tidak ada data perangkat/berkas sebelum autentikasi.
- Bearer dan cookie divalidasi dengan fungsi yang sama seperti REST (`auth.resolve`).
- Token tidak pernah disiarkan, tidak masuk log, dan tidak dikirim ke klien lain.
- Semua klien yang terhubung adalah sesi admin (dashboard) atau perangkat terdaftar;
  tidak ada kanal "publik".
- Koneksi diputus saat sesi dicabut/kedaluwarsa — bukan hanya saat klien memutuskan.

---

## 5. Uji otomatis

`tests/mobile-auth.test.js` dan `tests/server-integration.test.js` membuktikan:

- cookie `sid` dapat terhubung dan menerima `SENSOR`,
- Bearer mobile dapat terhubung dan menerima `SENSOR`,
- tanpa kredensial → `401` sebelum upgrade,
- logout/pencabutan perangkat → koneksi ditutup `4403`.

Jalankan:

```bash
npm test
```
