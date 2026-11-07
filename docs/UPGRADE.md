# Instalasi & Upgrade (Termux / Linux) tanpa kehilangan data

Berlaku untuk NodelixcoreOS **1.2.0** (penambahan autentikasi mobile) dan seterusnya.

---

## 1. Yang perlu dijaga

| Data | Lokasi | Boleh hilang? |
|---|---|---|
| Konfigurasi | `.env` (root project) | **Tidak** — jangan ditimpa |
| Akun admin | `ADMIN_USERNAME` / `ADMIN_PASSWORD` di `.env` | **Tidak** |
| Data pintu & kartu RFID | `data/door.json` | **Tidak** |
| Kalibrasi PLTS | `data/calibration.json` | **Tidak** |
| Jadwal & otomasi | `data/schedules.json` | **Tidak** |
| Riwayat sensor / AI / audit | `data/sensor-history.json`, `data/ai-history.json`, `data/audit.log` | Sebaiknya tidak |
| Perangkat mobile terdaftar | `data/mobile-devices.json` | Tidak (harus registrasi ulang bila hilang) |
| Sesi mobile | `data/mobile-sessions.json` (hash token) | Boleh (pengguna login biometrik sekali lagi) |
| Berkas pengguna | flash disk: `<device>/upload` | **Tidak** |
| Firmware `.ino` referensi | `frimware/` | Tidak |

`.env`, `data/mobile-*.json`, `data/audit.log`, dan folder `uploads/` sudah ada di
`.gitignore` sehingga tidak pernah tertimpa oleh `git pull`.

---

## 2. Instalasi baru (Termux)

```bash
pkg update && pkg upgrade
pkg install nodejs git openssl
termux-setup-storage          # bila memakai flash disk
git clone https://github.com/arel342/NodelixcoreOS
cd NodelixcoreOS
npm install
```

Sebelum menjalankan server, ikuti [panduan HTTPS lokal](LOCAL-HTTPS.md) untuk membuat Private CA secara offline, sertifikat server, mengatur `.env`, dan membatasi CIDR LAN. Server sekarang **menolak startup** jika sertifikat/TLS belum dikonfigurasi; tidak ada fallback HTTP. Setelah CA publik dipercaya oleh perangkat klien dan hostname LAN diarahkan ke server:

```bash
npm start
```

Buka `https://<hostname-LAN>:3000/setup.html` di browser pada jaringan yang diizinkan. Node.js minimal **18.17** dan OpenSSL harus tersedia.

Setelah TLS dan allowlist LAN dikonfigurasi, jika `ADMIN_PASSWORD` belum diisi server menampilkan wizard setup melalui HTTPS. Tanpa konfigurasi TLS, server menolak startup dan tidak menyediakan halaman setup HTTP.

---

## 3. Upgrade dari 1.1.0 ke 1.2.0

> 1.2.0 **tidak** mengubah skema file data yang sudah ada. Tidak ada migrasi wajib.

### 3.1 Back up dulu (wajib)

Cara termudah (tanpa dependency tambahan):

```bash
cd ~/NodelixcoreOS
npm run backup          # -> backups/<tanggal-jam>/ berisi .env + data/ + manifest.json
```

`backup.js` hanya **membaca dan menyalin**: `.env`, isi `data/` (kalibrasi, kartu pintu,
jadwal, riwayat, audit, perangkat mobile terdaftar), plus `manifest.json` berisi versi,
commit, branch, dan daftar perubahan lokal yang belum di-commit. File sesi mobile
(`data/mobile-sessions.json`) tidak disalin karena isinya hanya hash token.

Alternatif manual:

```bash
mkdir -p ~/nodelix-backup
cp -a .env data ~/nodelix-backup/            # konfigurasi + data runtime
git rev-parse HEAD > ~/nodelix-backup/commit.txt
```

Folder `backups/` sudah masuk `.gitignore` sehingga tidak ikut ter-commit.

Flash disk tidak perlu di-backup ke folder project: isinya berada di volume terpisah
dan tidak pernah ditulis oleh proses update.

### 3.2 Hentikan server dengan rapi

Tekan `Ctrl+C` pada terminal `npm start` (server menyimpan sesi mobile, riwayat sensor,
dan riwayat AI saat berhenti). Jika berjalan lewat `tmux`/`nohup`, kirim `SIGTERM`:

```bash
kill -TERM $(pgrep -f "node server.js")
```

### 3.3 Ambil versi baru

```bash
git pull origin main
npm install
npm test            # opsional, memastikan semua modul & tes lulus
npm start
```

`git pull` **manual**. Server tidak pernah menjalankan `git pull`, `git reset --hard`,
atau menghapus perubahan lokal. Bila ada perubahan lokal yang bentrok, git akan
menolak dan Anda bisa memutuskan sendiri (`git stash`, commit, atau bandingkan).

### 3.4 Setelah upgrade

- Dashboard: login seperti biasa.
- Aplikasi Android: login sekali lagi. Aplikasi akan mencoba
  `POST /api/mobile/auth/register` (sekarang tersedia), lalu memakai biometrik
  (challenge–response ECDSA) pada login berikutnya.
- Semua perangkat ESP32/ESP8266 tetap terhubung: alamat, kunci API, dan interval
  pemantauan tidak berubah.

### 3.5 Rollback

Untuk rollback migrasi HTTPS, ikuti prosedur pada [panduan HTTPS lokal](LOCAL-HTTPS.md#10-rollback). **Jangan menjalankan kembali versi HTTP lama pada interface LAN.** Bila konfigurasi TLS tidak dapat dipulihkan, hentikan web service sampai sertifikat dan firewall dapat diperbaiki. Pulihkan `.env`, sertifikat server yang cocok, dan data pengguna dari backup; jangan pulihkan Root CA private key ke server.

---

## 4. Update Center di dashboard

`updater.js` hanya **memeriksa**:

- `git fetch origin` (tanpa `git pull`), dibatasi cooldown 30 detik,
- membandingkan commit terpasang dengan `origin/main`,
- menampilkan commit baru + lencana di dashboard dan (bila dikonfigurasi) satu
  notifikasi Telegram per commit.

Pemasangan tetap manual. Tombol di dashboard menampilkan perintah
`git pull origin main && npm install` untuk disalin ke Termux — perintah itu **tidak
dijalankan otomatis** oleh server. Ini disengaja: menjalankan `git pull` di tengah
permintaan HTTP bisa merusak proses yang sedang berjalan dan berisiko menimpa perubahan
lokal.

Bila pemeriksaan gagal (tidak ada internet, repo bukan git, rate limit GitHub), status
error ditampilkan apa adanya dan percobaan berikutnya dilakukan otomatis — server tidak
berhenti.

---

## 5. Catatan Termux

- Port diubah dengan `PORT=` di `.env` atau tab Pengaturan; perubahan port perlu restart
  server (`npm start`).
- Android mematikan proses latar belakang: gunakan `termux-wake-lock` dan (opsional)
  `sv`/`tmux` agar server tetap hidup.
- `su` diperlukan untuk menulis ke flash disk pada Termux biasa (`STORAGE_MODE=root`,
  default). Bila Node berjalan sebagai root atau folder biasa, gunakan
  `STORAGE_MODE=direct`.
- Jangan menaruh folder penyimpanan di direktori sementara (`/tmp`, `$TMPDIR`): data
  bisa hilang. Penyimpanan pengguna tetap di flash disk seperti sebelumnya.
- Selalu jalankan `npm test` setelah upgrade untuk memastikan modul termuat.

---

## 6. Variabel `.env` untuk HTTPS lokal

TLS sekarang wajib. Isi path sertifikat, private key server, public Root CA certificate, hostname SAN, dan subnet LAN aktual sebelum menjalankan server. Default allowlist hanya loopback sehingga belum mengizinkan perangkat LAN.

```env
# HTTPS lokal (wajib; tidak ada HTTP fallback)
BIND_HOST=0.0.0.0
LOCAL_ALLOWED_CIDRS=127.0.0.1/32,::1/128
TLS_CERT_PATH=./certs/server.crt
TLS_KEY_PATH=./certs/server.key
TLS_CA_CERT_PATH=./certs/root-ca.crt
TLS_SERVER_NAMES=nodelixcoreos.local

# Autentikasi mobile (aktif secara default)
MOBILE_AUTH_ENABLED=true
MOBILE_SESSION_TTL_HOURS=720
MOBILE_CHALLENGE_TTL_MS=60000
MOBILE_CHALLENGE_SKEW_MS=60000
MOBILE_MAX_PENDING_CHALLENGES=2000
# MOBILE_AUTH_SERVER_ORIGIN=https://192.168.1.10:8443

# Batas permintaan & upload
JSON_BODY_LIMIT=512kb
UPLOAD_MAX_MB=2048

# Header keamanan
ALLOW_IFRAME=false
HSTS_MAX_AGE=15552000
```

```env
# Opsional, hanya bila server di balik reverse proxy
TRUST_PROXY=false
# TRUSTED_ORIGINS=https://nodelix.example:8443
```

Tambahkan hanya bila perlu mengubah default; nilai yang tidak ada akan memakai default
di atas.

`TRUST_PROXY` harus tetap `false` untuk TLS langsung pada Node.js. Jika proxy benar-benar dipakai, hanya masukkan IP/CIDR proxy yang tepercaya; jangan menggunakan `true`. `TRUSTED_ORIGINS` (dipisah koma) menambah origin HTTPS eksplisit untuk permintaan non-GET bercookie dan handshake WebSocket. CIDR jaringan server harus diisi dengan subnet LAN yang sebenarnya.

---

## 7. Checklist setelah upgrade

```bash
npm install
npm test                              # semua tes + pemeriksaan sintaks
node -e "require('./auth'); require('./mobile-auth'); console.log('modul ok')"
```

Lalu di browser:

1. Login dashboard berhasil (cookie `sid`).
2. Tab Pengaturan memuat nilai lama (IP ESP32/ESP8266, Telegram, AI).
3. Tab Storage menampilkan flash disk dan berkas lama.
4. Kartu pintu RFID masih ada, status perangkat `online` bila alat menyala.
5. Aplikasi Android: login biometrik → `/api/mobile/auth/session` mengembalikan
   `authenticated: true`.
