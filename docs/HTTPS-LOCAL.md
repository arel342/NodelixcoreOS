# HTTPS lokal NodelixcoreOS

Dokumen ini berlaku untuk koneksi dashboard dan aplikasi NodelixcoreOS Mobile ke server Node.js. Default server adalah HTTP/WS untuk LAN tepercaya. Dokumen ini menjelaskan mode HTTPS/WSS opsional dengan sertifikat dari Private Root CA lokal.

Untuk memakai HTTP, set `TLS_ENABLED=false` dan `TLS_ALLOW_HTTP=true` di `.env`, lalu restart. Buka `http://<IP-server>:3000`. Sertifikat tidak diperlukan; password/token tidak dienkripsi.

## 1. Buat sertifikat di Termux/Linux

Dari direktori project:

```bash
npm install
npm run gen-certs
TLS_ENABLED=true npm start
```

Generator `gen-certs.js` menggunakan API bawaan Node.js (`node:crypto` dan `node:fs`). OpenSSL CLI tidak perlu dipasang atau dipanggil. Node.js tetap menggunakan implementasi TLS kriptografi internalnya sendiri; yang dihilangkan adalah ketergantungan pada program `openssl` eksternal.

Pada instalasi lama, periksa `.env`: pastikan `TLS_ENABLED=true` (harus diaktifkan secara eksplisit) dan hapus/komentari `TLS_ALLOW_HTTP=true`. Nilai `TLS_ENABLED=false` menonaktifkan HTTPS secara eksplisit.

Alamat yang ditampilkan server memakai `https://`, misalnya:

```text
https://192.168.1.20:3000
```

HTTP plaintext pada port tersebut ditolak dengan respons `400 HTTPS required`; server tidak mengalihkan request HTTP ke HTTPS. Redirect plaintext tidak aman untuk request yang mungkin sudah membawa kredensial.

## 2. Simpan CA root dengan aman

File yang dihasilkan:

| File | Kegunaan | Izin Unix |
|---|---|---:|
| `data/ca/root-ca.key` | Private key Root CA | `0600` |
| `data/ca/root-ca.crt` | Sertifikat publik Root CA | `0644` |
| `data/certs/server.key` | Private key sertifikat server | `0600` |
| `data/certs/server.crt` | Sertifikat HTTPS server | `0644` |

**Jangan pernah menyalin atau membagikan `root-ca.key`.** Hanya distribusikan `root-ca.crt` melalui jalur yang aman. Cocokkan fingerprint SHA-256 yang dicetak generator pada server dengan salinan yang diterima klien.

## 3. Browser

Pasang `data/ca/root-ca.crt` sebagai CA tepercaya di perangkat/OS/browser yang mengakses dashboard. Setelah itu buka alamat HTTPS server. Jika browser masih menampilkan peringatan sertifikat, jangan lanjutkan login sebelum CA dan alamat (IP/DNS) diverifikasi.

Contoh uji API dengan curl:

```bash
curl --cacert data/ca/root-ca.crt https://192.168.1.20:3000/api/session
```

## 4. Aplikasi Android NodelixcoreOS Mobile

Aplikasi native harus mempercayai CA lokal tanpa mematikan pemeriksaan hostname atau sertifikat. Pada aplikasi yang menggunakan Android Network Security Config:

1. Salin hanya `root-ca.crt` ke resource aplikasi, misalnya `app/src/main/res/raw/nodelix_local_ca.crt`.
2. Tambahkan/merge konfigurasi berikut ke `res/xml/network_security_config.xml`.
3. Pastikan `AndroidManifest.xml` menunjuk ke konfigurasi tersebut melalui atribut `android:networkSecurityConfig`.
4. Atur base URL aplikasi menjadi `https://<IP-server>:3000`.

Contoh konfigurasi:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="@raw/nodelix_local_ca" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

Jangan memakai `trustAll`, `hostnameVerifier { _, _ -> true }`, atau menerima semua sertifikat. Jangan menghapus verifikasi hostname. Pastikan IP/DNS yang dimasukkan di aplikasi tercantum dalam SAN sertifikat.

**Catatan:** perubahan repository server ini tidak dengan sendirinya mengubah source code aplikasi Android. Jika source Android berada di repository terpisah, manifest, Network Security Config, dan base URL HTTPS perlu diperbarui di repository aplikasi tersebut.

## 5. IP/DNS dan pembaruan sertifikat

Saat sertifikat dibuat, generator memasukkan `localhost`, loopback, hostname mesin, dan alamat IPv4 LAN yang terdeteksi. Untuk alamat stabil tambahan, isi `NODELIX_HOSTS` atau `TLS_SAN` di `.env`, kemudian jalankan:

```bash
npm run gen-certs -- --renew
```

Contoh:

```dotenv
NODELIX_HOSTS=nodelix.local,192.168.1.20
TLS_SAN=DNS:nodelix.local,IP:192.168.1.20
```

Jalankan ulang generator jika alamat LAN berubah atau sertifikat server kedaluwarsa. Opsi `--renew` mempertahankan CA yang sudah dipercaya klien.

Opsi `--force-ca` membuat Root CA baru. Gunakan hanya bila memang ingin mengganti trust anchor; seluruh browser dan aplikasi Android harus mempercayai CA baru setelah itu.

## 6. TLS dan kompatibilitas

- Minimum TLS: 1.2; TLS 1.3 digunakan bila tersedia.
- Dashboard: HTTPS.
- WebSocket: WSS.
- API path, payload, Bearer token, sesi, ECDSA P-256, dan kontrak autentikasi mobile dipertahankan.
- Koneksi ESP32/ESP8266 yang tertulis sebagai `http://<IP-ESP>` adalah endpoint firmware/perangkat tersendiri; migrasi server ini tidak mengubah firmware ESP.
- HTTP/WS adalah default untuk LAN tepercaya (`TLS_ENABLED=false`, `TLS_ALLOW_HTTP=true`). Jangan ekspos mode HTTP ke internet.
