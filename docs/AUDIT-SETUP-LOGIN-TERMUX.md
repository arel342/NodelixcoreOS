# Audit setup dan login — 7 November 2026

## Batas verifikasi

Pengujian dijalankan pada Linux x86_64, Node v22.22.3, npm 10.9.8. Ini **bukan pengujian Termux Android asli**: tidak ada perangkat Android, `pkg`, Magisk, ESP32/ESP8266, atau akses ke jaringan Wi-Fi pengguna. Perilaku penolakan enumerasi IP Android disimulasikan dengan preload Node yang membuat `os.networkInterfaces()` melempar error. Tidak ada klaim bahwa akses USB, izin Android, browser Android, atau firmware sudah diuji langsung.

## Temuan dan perbaikan

### 1. Password diterima saat setup tetapi tidak bisa login setelah restart — tinggi

Sebelumnya `saveEnv()` menulis nilai mentah, sedangkan loader memangkas spasi dan melepas tanda kutip berpasangan. Contoh password `  "password$123"  ` berhasil dipakai dalam proses yang sama, tetapi saat restart dibaca sebagai `password$123`. Pengguna kemudian mendapatkan 401 walaupun mengetik password yang dibuat saat setup.

Perbaikan: `env-file.js` menjadi pembaca/penulis bersama untuk server dan doctor. Nilai baru disimpan sebagai string JSON berkutip agar spasi, tanda kutip, backslash, dan Unicode dipertahankan. Penulisan tetap atomik dengan mode 0600. Duplikasi key yang disimpan dihapus sehingga nilai lama tidak tertinggal. Entri lama tanpa kutip dan berkutip tunggal tetap dibaca; string berkutip ganda dengan escape JSON sekarang mengikuti semantik JSON. Jika `.env` lama berisi backslash literal dalam kutip ganda, periksa formatnya sebelum migrasi (gunakan kutip tunggal untuk nilai literal, atau simpan ulang melalui UI).

Bukti reproduksi: tes alur bersih dijalankan terhadap salinan `server.js` sebelum perbaikan dan gagal pada login setelah restart: **401, diharapkan 200**. Tes yang sama lulus setelah perbaikan. Credential uji hanya berada pada direktori sementara, bukan `.env` pengguna.

### 2. Enumerasi IP bisa menggagalkan bagian startup — tinggi untuk kompatibilitas Android

`settings.js` sudah memiliki fallback, tetapi `server.js` memanggil `os.networkInterfaces()` tanpa try/catch pada banner dan URL dashboard untuk updater. Pada Android yang menolak enumerasi antarmuka, banner melempar error setelah port HTTP terbuka. Akibatnya log melaporkan startup gagal dan `startDevices()` di bagian startup dapat terlewati meskipun socket web sempat hidup.

Perbaikan: pembungkus aman di server; alamat lokal menjadi fallback. Tidak ada upaya melewati pembatasan Android. Jika IP LAN tidak terdeteksi, gunakan `http://127.0.0.1:3000` di HP yang menjalankan Termux; untuk HP/PC lain, ambil IP Wi-Fi dari pengaturan Android secara manual.

### 3. Cookie login berbeda dari cookie setup saat HTTPS melalui proxy

Login sebelumnya selalu menerbitkan cookie tanpa `Secure`, sedangkan setup mengikuti `req.secure`. Login sekarang juga mengikuti `req.secure`. HTTP lokal tetap dapat dipakai. Reverse proxy HTTPS harus memiliki `TRUST_PROXY` yang spesifik dan benar; jangan memakai `TRUST_PROXY=true`. Jalur HTTPS proxy belum diverifikasi langsung dalam audit ini.

### 4. Dependency pada lockfile memiliki advisory keamanan

`npm ci` awal berhasil tetapi `npm audit` melaporkan 3 kerentanan (2 high, 1 moderate): body-parser, multer, qs. Lockfile diperbarui dalam rentang dependency yang sudah ada melalui `npm audit fix --ignore-scripts`. Sesudahnya audit melaporkan **0 vulnerabilities** pada saat pemeriksaan. Ini bukan jaminan tidak ada kerentanan lain di aplikasi.

## Hasil pengujian

- Sebelum perubahan: 236 tes, 235 lulus, 0 gagal, 1 dilewati.
- Sesudah perubahan: 238 tes, 237 lulus, 0 gagal, 1 dilewati.
- Tes yang dilewati adalah UI notifikasi update karena jsdom tidak terpasang; bukan tes setup/login.
- `npm run doctor`: tidak ada masalah fatal pada checkout tanpa `.env`.
- Instalasi dependency bersih: `npm ci --ignore-scripts` berhasil.
- Tes baru: `node --test tests/setup-clean.test.js`.

Tes integrasi baru menjalankan server sungguhan dalam salinan sementara tanpa `.env`: redirect `/` ke wizard, blokir API sebelum akun dibuat (409), status setup, penolakan konfirmasi password salah, pembuatan akun dan cookie, status sesi, penolakan pengambilalihan akun tanpa cookie (403), simpan port, finish, logout, restart server, penolakan password salah (401), login dengan password asli (200), dan status sesi terautentikasi. Seluruh alur berjalan dengan enumerasi IP sengaja dibuat gagal. Perangkat dan layanan eksternal dimatikan; tes ini bukan tes koneksi hardware/Gemini/Telegram ataupun otomatisasi klik browser.

## Perilaku penting yang bukan bug yang diperbaiki

1. **Setup pertama dapat diklaim oleh pengunjung jaringan.** Sebelum `ADMIN_PASSWORD` ada, endpoint wizard memang publik. Jalankan setup di jaringan privat tepercaya; jangan expose port ke internet sebelum akun selesai dibuat. Belum ada token bootstrap/pairing lokal.
2. **HTTP tidak mengenkripsi password atau cookie.** `HttpOnly` dan `SameSite=Lax` tidak menggantikan TLS. Untuk jaringan yang tidak dipercaya gunakan reverse proxy HTTPS/VPN yang dikonfigurasi benar.
3. **Password admin disimpan di `.env` sebagai plaintext**, bukan hash password. Mode 0600 membatasi akses user OS lain, bukan melindungi dari root atau backup yang bocor. Penyimpanan password hash membutuhkan migrasi tersendiri.
4. **Sesi web memang hilang setelah restart**, karena disimpan di memori. Login ulang normal; kegagalan login dengan password yang sama bukan normal. Sesi mobile memiliki penyimpanan terpisah.
5. **Kehilangan cookie setelah langkah akun dapat membuat wizard terkunci.** Buka `/`, login dengan akun yang baru dibuat, lalu buka `/setup.html` lagi. Jangan menghapus `.env` sebagai langkah pertama karena itu membuang konfigurasi dan membuka bootstrap lagi.
6. **Mengubah port tidak langsung memindahkan listener.** Wizard mengembalikan `restart: true`; selesaikan wizard pada alamat lama, restart proses, lalu buka port baru. `SETUP_DONE` hanya penanda finish; keberadaan password menentukan apakah bootstrap dikunci.
7. **Root dan izin storage bukan syarat pembuatan akun/login.** Keduanya relevan untuk akses flash disk/root monitoring. Simpan repository di HOME Termux, bukan `/sdcard`, karena npm memerlukan fitur filesystem yang tidak selalu tersedia pada shared storage Android.

## Checklist uji manual Termux dari nol

Jalankan hanya pada instalasi baru; jika folder proyek sudah ada, jangan timpa atau hapus `.env`/data. Perubahan audit ini perlu sudah tersedia pada salinan proyek yang digunakan.

```sh
pkg update && pkg upgrade
pkg install nodejs-lts git
cd "$HOME"
git clone https://github.com/arel342/NodelixcoreOS.git
cd NodelixcoreOS
node --version
npm --version
npm ci
npm run doctor
npm test
npm start
```

Gunakan Node >=18.17 (disarankan LTS yang tersedia di repository Termux). Bila `nodejs` sudah terpasang, tidak perlu memasang `nodejs-lts` bersamaan. Untuk instalasi baru dengan lockfile, `npm ci` memberi versi yang dapat direproduksi; pada instalasi yang sedang dipakai, hentikan server sebelum memasang ulang dependency.

1. Buka `http://127.0.0.1:3000` pada browser HP yang sama; harus masuk wizard.
2. Buat username 3–32 karakter tanpa spasi dan password minimal 8 karakter; konfirmasi harus sama.
3. Untuk tes minimal, biarkan port 3000 dan lewati ESP32/ESP8266/Telegram/Gemini yang belum tersedia.
4. Tekan selesai; dashboard harus terbuka. Logout, lalu login lagi.
5. Hentikan server dengan Ctrl+C, jalankan `npm start`, dan login dengan akun yang sama. Ulangi pada instalasi uji dengan password berkutip/spasi jika ingin memverifikasi regresi.
6. Uji tab privat tanpa sesi: endpoint pengaturan harus menolak akses dan wizard tidak boleh mengubah akun.
7. Bila ingin menguji port baru, ubah port lewat wizard/pengaturan, selesaikan pada port lama, restart, lalu buka alamat dengan port baru.
8. Baru setelah login dasar lulus, konfigurasi perangkat, token Telegram dan kunci Gemini; uji masing-masing secara terpisah. Izin storage Android (`termux-setup-storage`) dan izin root diberikan hanya jika fitur tersebut dibutuhkan.

Jika gagal, catat versi Android/Termux/Node, langkah terakhir, kode HTTP, dan log startup tanpa membagikan `.env`, password, cookie, token, atau kunci API.
