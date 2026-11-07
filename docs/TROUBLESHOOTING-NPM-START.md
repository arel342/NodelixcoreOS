# `npm start` gagal — analisis & pemecahan masalah

Dokumen ini menjelaskan **mengapa** `npm start` bisa gagal pada NodelixcoreOS dan
cara menemukan penyebabnya dalam hitungan detik, tanpa menebak-nebak.

Alat bantu utama:

```bash
npm run doctor
```

Perintah itu memeriksa Node, dependensi, `.env`, TLS, port, dan folder `data`
lalu menuliskan penyebab + perintah perbaikannya.

---

## 1. Yang sudah diverifikasi pada repo ini

Pemeriksaan pada checkout bersih (Node 22.22.3, npm 10.9.8):

| Uji | Hasil |
| --- | --- |
| `npm install` | berhasil, 77 paket, tanpa dependency hilang |
| `node --check server.js` | sintaks valid |
| `npm start` | server menyala di port 3000, banner tampil, mode setup awal |
| `npm test` | 248 tes, 247 lulus, 1 di-skip, 0 gagal |

Artinya: **kegagalan `npm start` hampir selalu berasal dari lingkungan**
(folder salah, `node_modules` belum ada, port bentrok, `.env`/sertifikat tidak
konsisten, atau versi Node terlalu lama), bukan dari sintaks program.

## 2. Titik kegagalan saat startup (`server.js`)

Urutan eksekusi dan titik yang bisa menghentikan proses:

| # | Tahap | Perilaku bila gagal | Pesan yang muncul |
| --- | --- | --- | --- |
| 1 | `require(express / ws / multer)` | proses berhenti | `Error: Cannot find module 'express'` |
| 2 | Baca `.env` | baris tidak sesuai format **diabaikan diam-diam** | (tidak ada pesan) |
| 3 | `tls.createServer()` | `process.exit(1)` | `[TLS] Gagal memuat sertifikat: ...` |
| 4 | `validateSecurityConfig()` | `process.exit(1)` | `[Security] Validasi konfigurasi gagal:` + daftar alasan |
| 5 | `server.listen(PORT, '0.0.0.0')` | `exitCode = 1` | `[Web] Gagal menjalankan server: listen EADDRINUSE ...` |
| 6 | Penyimpanan flash disk / perangkat | **tidak fatal**, server tetap jalan | `PENYIMPANAN BELUM SIAP: ...` |

Kode keluar non-nol hanya terjadi pada tahap 1–5. Tahap 6 hanya peringatan:
dashboard tetap bisa dibuka walau flash disk belum terpasang.

## 3. Tabel gejala → penyebab → perbaikan

| Gejala di terminal | Penyebab | Perbaikan |
| --- | --- | --- |
| `npm ERR! Missing script: "start"` | perintah dijalankan di folder yang salah (tidak ada `package.json`) | `cd ~/NodelixcoreOS` lalu `npm start` |
| `Cannot find module 'express'` / `'ws'` / `'multer'` | `npm install` belum dijalankan, terputus, atau `node_modules` terhapus | `npm install` (ulangi dengan `rm -rf node_modules && npm install` bila perlu) |
| `SyntaxError: Invalid or unexpected token` / sintaks lain | Node terlalu lama, atau `server.js` rusak/terpotong saat unduh | cek `node -v` (butuh ≥ 18.17), lalu `git pull` atau unduh ulang ZIP rilis |
| `[TLS] Gagal memuat sertifikat: Sertifikat server belum dibuat` | `TLS_ENABLED=true` tetapi sertifikat belum ada | `npm run gen-certs` **atau** kembali ke HTTP: `TLS_ENABLED=false`, `TLS_ALLOW_HTTP=true` di `.env` |
| `Sertifikat server kedaluwarsa` / `tidak cocok dengan CA` | sertifikat lama / jam sistem bergeser | `npm run gen-certs -- --renew` |
| `[Security] Validasi konfigurasi gagal: TLS_ENABLED=false tetapi TLS_ALLOW_HTTP tidak aktif` | `.env` melarang HTTP padahal TLS mati | set `TLS_ALLOW_HTTP=true`, atau aktifkan TLS |
| `ADMIN_PASSWORD terlalu pendek` | password < 8 karakter | ganti `ADMIN_PASSWORD` (≥ 8 karakter) di `.env` |
| `SESSION_TTL_HOURS=... terlalu panjang` | nilai > 720 jam | turunkan ke ≤ 720 |
| `[Web] Gagal menjalankan server: listen EADDRINUSE ... :3000` | port 3000 masih dipakai proses lama (Termux sering meninggalkan sesi `node server.js`) | `pkill -f "node server.js"` lalu `npm start`; atau ubah `PORT=3001` di `.env` |
| `listen EACCES` | memakai port < 1024 tanpa root | gunakan `PORT=3000` (atau ≥ 1024) |
| Server jalan tapi browser tidak bisa dibuka | alamat/IP salah, atau hanya mendengarkan di loopback | buka alamat yang dicetak banner (`http://<IP-Termux>:3000`), pastikan HP/PC satu Wi-Fi |
| `PENYIMPANAN BELUM SIAP: Flash disk tidak terdeteksi` | `STORAGE_DEVICE` kosong / flash disk lepas | tidak fatal; isi `STORAGE_DEVICE` atau abaikan bila tidak memakai upload |
| `su: not found` pada mode penyimpanan `root` | Termux tanpa root | `STORAGE_MODE=direct` atau jalankan sebagai root |
| `EADDRINUSE` pada port lain / `EACCES` lain | VPN/aplikasi lain memakai port | `PORT=3001 npm start` untuk uji cepat |

## 4. Cara memakai `npm run doctor`

```bash
cd ~/NodelixcoreOS
npm install        # sekali saja / setelah update dependency
npm run doctor
npm start
```

Contoh keluaran sehat:

```text
[ OK ] Versi Node — 22.22.3 (butuh >=18.17)
[ OK ] express — 5.2.1
[ OK ] multer — 2.4.0
[ OK ] Sintaks server.js — valid
[INFO] .env belum ada — normal pada instalasi baru
[ OK ] Mode transport — HTTP plaintext di LAN
[ OK ] Port 3000 — bisa dipakai (bind 0.0.0.0 berhasil)
[ OK ] Folder data — .../data (bisa ditulis)
=========================================================
Tidak ada masalah fatal. `npm start` seharusnya bisa berjalan.
```

Contoh keluaran saat port bentrok — lengkap dengan PID pemakainya:

```text
[FAIL] Port 3000 sudah dipakai — EADDRINUSE — dipakai PID 3273 (node server.js)
   → Hentikan server lama: pkill -f "node server.js"
```

Skrip ini **tidak menyalakan server** dan **tidak mengubah berkas**; ia hanya
membaca konfigurasi, mencoba bind port sejenak, dan menulis satu berkas uji kecil
di `data/` yang langsung dihapus.

Opsi: `npm run doctor -- --port 3001` untuk memeriksa port lain tanpa mengubah `.env`.

## 5. Bila `npm run doctor` menyatakan semua OK tetapi `npm start` tetap gagal

Kirimkan **seluruh** keluaran terminal, termasuk:

```bash
node -v
npm -v
npm run doctor
npm start 2>&1 | head -40
```

Baris pertama setelah banner biasanya sudah menyebut penyebabnya. Jangan hanya
mengirim "tidak bisa": pesan `Cannot find module`, `EADDRINUSE`, dan `[Security]`
menunjuk ke perbaikan yang sangat berbeda.
