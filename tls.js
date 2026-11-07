'use strict';
// ============================================================================
// tls.js — terminasi TLS internal untuk NodelixcoreOS (Private CA + HTTPS/WSS).
//
// Server berjalan HTTPS langsung memakai node:https. TLS 1.2 minimum (TLS 1.3
// diprioritaskan bila kompatibel). Sertifikat server diterbitkan oleh Private CA
// lokal; kunci CA root disimpan TERPILAH dari kunci server dan TIDAK pernah masuk
// repository.
//
// Tata letak (semua di luar Git, lihat .gitignore):
//   data/ca/root-ca.key      kunci privat CA root      (0600, terpisah dari server)
//   data/ca/root-ca.crt      sertifikat CA root         (0644, disebarkan ke klien)
//   data/ca/root-ca.srl      serial CA
//   data/certs/server.key    kunci privat server       (0600)
//   data/certs/server.crt    sertifikat server (leaf)  (0644)
//
// Buat sertifikat:  npm run gen-certs   (atau: node gen-certs.js)
//
// Config (env, lihat .env.example):
//   TLS_ENABLED        default true    false = HTTP eksplisit (harus TLS_ALLOW_HTTP=true)
//   TLS_DATA_DIR       default <repo>/data
//   TLS_CERT_DIR       default <data>/certs
//   TLS_CA_DIR         default <data>/ca
//   TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_CERT_FILE / TLS_CA_KEY_FILE
//   TLS_MIN_VERSION    default TLSv1.2
//   TLS_CIPHERS        default daftar aman (GCM/ChaCha20 ECDHE saja)
//   TLS_CERT_DAYS      default 825      (hari, dipakai gen-certs.js)
//   TLS_SAN            tambahan SAN, comma, mis. "DNS:nodelix.local,IP:10.0.0.5"
//   NODELIX_HOSTS      nama host stabil (comma) — SAN DNS tambahan
//   TLS_AUTOGEN        default false   true = buat CA+sertifikat otomatis bila belum ada
//   TLS_ALLOW_HTTP     default false   hanya dengan TLS_ENABLED=false (rollback/debug)
// ============================================================================
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];

class TlsError extends Error {
    constructor(message, code) { super(message); this.name = 'TlsError'; this.code = code || 'TLS_ERROR'; }
}

// ---------- Path ----------
function paths(dataDirOverride) {
    const dataDir = dataDirOverride || E('TLS_DATA_DIR', path.join(__dirname, 'data'));
    const certDir = E('TLS_CERT_DIR', path.join(dataDir, 'certs'));
    const caDir = E('TLS_CA_DIR', path.join(dataDir, 'ca'));
    return {
        dataDir,
        certDir, caDir,
        certFile: E('TLS_CERT_FILE', path.join(certDir, 'server.crt')),
        keyFile: E('TLS_KEY_FILE', path.join(certDir, 'server.key')),
        caCertFile: E('TLS_CA_CERT_FILE', path.join(caDir, 'root-ca.crt')),
        caKeyFile: E('TLS_CA_KEY_FILE', path.join(caDir, 'root-ca.key')),
        caSerialFile: path.join(caDir, 'root-ca.srl')
    };
}

// ---------- Config ----------
function isEnabled() { return String(E('TLS_ENABLED', 'true')).toLowerCase() !== 'false'; }
function allowHttp() { return !isEnabled() && String(E('TLS_ALLOW_HTTP', 'false')).toLowerCase() === 'true'; }
function scheme() { return isEnabled() ? 'https' : 'http'; }
function minVersion() { return E('TLS_MIN_VERSION', 'TLSv1.2'); }
function certDays() { return Math.max(1, Math.min(3650, Math.floor(Number(E('TLS_CERT_DAYS', '825'))) || 825)); }

const SECURE_CIPHERS = E('TLS_CIPHERS',
    'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256' +
    ':ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384' +
    ':ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305' +
    ':ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256');

// ---------- Alamat jaringan ----------
function lanIps() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const i of list || []) {
            if (i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) out.push(i.address);
        }
    }
    return [...new Set(out)];
}

const isIpv4 = v => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(v));
const isDns = v => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(String(v)) && String(v).length <= 253;

// Susun daftar SAN (DNS + IP) dari konfigurasi + deteksi otomatis.
function collectSans() {
    const set = new Set();
    const addDns = h => { const s = String(h).trim().toLowerCase(); if (isDns(s)) set.add('DNS:' + s); };
    const addIp = ip => { const s = String(ip).trim(); if (isIpv4(s)) set.add('IP:' + s); };
    addDns('localhost');
    addIp('127.0.0.1');
    const hostname = os.hostname();
    if (hostname) addDns(hostname);
    // NODELIX_HOSTS: nama stabil atau alamat tambahan yang ditentukan admin.
    for (const h of String(E('NODELIX_HOSTS', '')).split(',')) {
        if (!h.trim()) continue;
        if (isIpv4(h)) addIp(h); else addDns(h);
    }
    // IP LAN yang benar-benar dipakai sekarang (boleh berubah — SAN diperbarui saat pembaruan).
    for (const ip of lanIps()) addIp(ip);
    // TLS_SAN: entri eksplisit (DNS:x / IP:x).
    for (const raw of String(E('TLS_SAN', '')).split(',')) {
        const s = raw.trim();
        if (!s) continue;
        const m = /^(DNS|IP):(.+)$/i.exec(s);
        if (!m) continue;
        const v = m[2].trim();
        if (m[1].toUpperCase() === 'DNS') addDns(v); else if (isIpv4(v)) addIp(v);
    }
    return [...set];
}

// CN memakai nama host stabil bila ada, bila tidak alamat IP pertama, bila tidak "localhost".
// (Isi DNS harus bukan alamat IPv4: '127.0.0.1' juga lolos pola nama.)
function serverCn() {
    const explicit = String(E('TLS_CN', '')).trim();
    if (explicit) return explicit;
    const hosts = collectSans().map(s => s.replace(/^(DNS|IP):/, ''));
    const dns = hosts.find(h => isDns(h) && !isIpv4(h) && h !== 'localhost');
    if (dns) return dns;
    const ip = hosts.find(h => isIpv4(h));
    return ip || 'localhost';
}

// ---------- Validasi sertifikat ----------
function readCert(p) {
    try { return new crypto.X509Certificate(fs.readFileSync(p)); }
    catch (e) { throw new TlsError(`Sertifikat tidak dapat dibaca: ${p} (${e.message})`, 'CERT_READ'); }
}

// Muat & validasi sertifikat + kunci. Kembalikan { cert, key, ca, sans, expiresAt }.
// Tolak: berkas hilang, kedaluwarsa, kunci tidak cocok, rantai CA gagal.
// `p` opsional: objek paths() (dipakai ensureCertificates dengan dataDir terpisah).
function load(p) {
    if (!isEnabled()) return null;
    const pathsObj = p || paths();
    if (!fs.existsSync(pathsObj.certFile) || !fs.existsSync(pathsObj.keyFile)) {
        throw new TlsError('Sertifikat server belum dibuat. Jalankan: npm run gen-certs', 'CERT_MISSING');
    }
    const certPem = fs.readFileSync(pathsObj.certFile);
    const keyPem = fs.readFileSync(pathsObj.keyFile);
    const cert = readCert(pathsObj.certFile);
    const key = crypto.createPrivateKey(keyPem);

    // Kedaluwarsa.
    const now = Date.now();
    const validFrom = new Date(cert.validFrom).getTime();
    const expiresAt = new Date(cert.validTo).getTime();
    if (!Number.isFinite(validFrom) || validFrom > now) {
        throw new TlsError(`Sertifikat server belum berlaku (${cert.validFrom}). Periksa jam sistem atau buat ulang sertifikat.`, 'CERT_NOT_YET_VALID');
    }
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        throw new TlsError(`Sertifikat server kedaluwarsa (${cert.validTo}). Jalankan: npm run gen-certs -- --renew`, 'CERT_EXPIRED');
    }
    // Kunci privat cocok dengan sertifikat (X509Certificate.checkPrivateKey).
    try {
        if (!cert.checkPrivateKey(key)) throw new Error('tidak cocok');
    } catch (e) {
        if (e instanceof TlsError) throw e;
        throw new TlsError('Kunci privat tidak cocok dengan sertifikat server.', 'KEY_MISMATCH');
    }
    // Rantai ke CA tepercaya (bila CA terpasang).
    let caPem = null;
    if (fs.existsSync(pathsObj.caCertFile)) {
        const ca = readCert(pathsObj.caCertFile);
        // X509Certificate.checkIssued()/verify() return booleans; they do not
        // throw on a failed check. Verify the leaf with the CA public key.
        if (!ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey)) {
            throw new TlsError('Root CA tidak valid atau tanda tangan self-signed gagal.', 'CA_INVALID');
        }
        if (!cert.checkIssued(ca)) {
            throw new TlsError('Issuer sertifikat server tidak cocok dengan CA tepercaya.', 'CA_MISMATCH');
        }
        if (!cert.verify(ca.publicKey)) {
            throw new TlsError('Verifikasi tanda tangan sertifikat server gagal.', 'CA_VERIFY_FAILED');
        }
        caPem = fs.readFileSync(pathsObj.caCertFile);
    }
    // SAN harus ada (setidaknya satu).
    const sans = collectSans();
    const sanAttr = String(cert.subjectAltName || '').trim();
    if (!sanAttr) {
        // Izinkan self-signed tanpa SAN hanya bila eksplisit diizinkan (tidak direkomendasikan).
        if (String(E('TLS_ALLOW_NO_SAN', 'false')).toLowerCase() !== 'true') {
            throw new TlsError('Sertifikat server tidak memiliki Subject Alternative Name. Jalankan: npm run gen-certs -- --renew', 'NO_SAN');
        }
    }
    return {
        cert: certPem, key: keyPem, ca: caPem, sans,
        expiresAt, validFrom: new Date(cert.validFrom).getTime(),
        fingerprint: spkiFingerprint(cert)
    };
}

function spkiFingerprint(x509) {
    try {
        const der = x509.publicKey.export({ type: 'spki', format: 'der' });
        return 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '');
    } catch { return ''; }
}

function caFingerprint() {
    const p = paths();
    if (!fs.existsSync(p.caCertFile)) return '';
    try { return spkiFingerprint(readCert(p.caCertFile)); } catch { return ''; }
}

function caInfo() {
    const p = paths();
    if (!fs.existsSync(p.caCertFile)) return null;
    const ca = readCert(p.caCertFile);
    return { path: p.caCertFile, subject: ca.subject, validTo: ca.validTo, fingerprint: spkiFingerprint(ca) };
}

// ---------- HTTPS server ----------
function secureOptions() {
    const c = crypto.constants;
    const opts = [
        c.SSL_OP_NO_SSLv2, c.SSL_OP_NO_SSLv3, c.SSL_OP_NO_TLSv1, c.SSL_OP_NO_TLSv1_1,
        c.SSL_OP_NO_COMPRESSION, c.SSL_OP_CIPHER_SERVER_PRECEDENCE
    ];
    // SSL_OP_NO_RENEGOTIATION bila tersedia (mitigasi Sendra-Reneg).
    if (c.SSL_OP_NO_RENEGOTIATION !== undefined) opts.push(c.SSL_OP_NO_RENEGOTIATION);
    return opts.reduce((a, b) => a | b, 0);
}

function tlsOptions() {
    const { cert, key } = load();
    return {
        key, cert,
        minVersion: minVersion(),
        honorCipherOrder: true,
        ciphers: SECURE_CIPHERS,
        ecdhCurve: E('TLS_ECDH_CURVE', 'auto'),
        secureOptions: secureOptions()
    };
}

// Pesan jelas untuk klien yang mengirim HTTP plaintext ke port TLS.
const HTTPS_REQUIRED_BODY =
    'HTTPS wajib digunakan. Server NodelixcoreOS hanya melayani melalui TLS (HTTPS/WSS).\n' +
    'HTTPS is required. This server only serves over TLS (HTTPS/WSS).\n' +
    'Gunakan alamat https:// (dan percayai CA lokal) atau hubungi administrator.\n';

function writeHttpsRequired(socket) {
    try {
        if (!socket || socket.destroyed) return;
        const body = HTTPS_REQUIRED_BODY;
        socket.end(
            'HTTP/1.1 400 Bad Request\r\n' +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            'Cache-Control: no-store\r\n' +
            'Connection: close\r\n' +
            'Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body
        );
    } catch { /* klien sudah pergi */ }
}

// Buat server. Default HTTPS dengan deteksi protokol: port TLS hanya menerima
// ClientHello (0x16); permintaan plaintext HTTP dijawab 400 "HTTPS required"
// (bukan diam-diam diputus). TLS_ENABLED=false hanya bila TLS_ALLOW_HTTP=true.
function createServer(app, timeouts = {}) {
    if (!isEnabled()) {
        if (!allowHttp()) {
            throw new TlsError(
                'TLS dinonaktifkan (TLS_ENABLED=false) tetapi TLS_ALLOW_HTTP tidak aktif.\n' +
                'Server tidak akan berjalan HTTP terbuka tanpa perlindungan. Aktifkan TLS kembali atau, untuk rollback terkendali, set TLS_ENABLED=false TLS_ALLOW_HTTP=true secara eksplisit.',
                'HTTP_FORBIDDEN'
            );
        }
        console.warn('\n' + '='.repeat(64));
        console.warn('[TLS] ⚠  PERINGATAN BESAR: TLS DIMATIKAN. Server berjalan HTTP PLAINTEXT.');
        console.warn('[TLS]   Semua trafik (termasuk password & token) terkirim tanpa enkripsi.');
        console.warn('[TLS]   Ini hanya untuk rollback/debug terkendali. Aktifkan TLS segera.');
        console.warn('='.repeat(64) + '\n');
        return http.createServer(app);
    }
    const opts = tlsOptions();
    // http.Server hanya untuk memarser HTTP dari socket TLS yang sudah dibuka.
    const httpServer = http.createServer(app);
    if (timeouts.requestTimeout != null) httpServer.requestTimeout = timeouts.requestTimeout;
    if (timeouts.headersTimeout != null) httpServer.headersTimeout = timeouts.headersTimeout;
    if (timeouts.keepAliveTimeout != null) httpServer.keepAliveTimeout = timeouts.keepAliveTimeout;
    httpServer.on('clientError', (err, socket) => {
        // HTTP cacat di atas TLS — jangan biarkan crash proses.
        try { socket.destroy(); } catch { }
    });

    const detectMs = Math.max(1000, Math.min(30000, Math.floor(Number(E('TLS_DETECT_TIMEOUT_MS', '10000'))) || 10000));
    const server = net.createServer((socket) => {
        socket.setTimeout(detectMs, () => { try { socket.destroy(); } catch { } });
        socket.pause();
        socket.once('readable', () => {
            socket.setTimeout(0); // nonaktifkan timeout deteksi (timeout TLS diatur httpServer)
            const chunk = socket.read() || Buffer.alloc(0);
            if (chunk.length > 0 && chunk[0] === 0x16) {
                // TLS ClientHello: kembalikan chunk, wrap sebagai server TLS.
                socket.unshift(chunk);
                try {
                    const secure = new tls.TLSSocket(socket, Object.assign({}, opts, { isServer: true }));
                    secure.on('error', () => { try { secure.destroy(); } catch { } });
                    httpServer.emit('connection', secure);
                    secure.resume();
                } catch (e) {
                    try { socket.destroy(); } catch { }
                }
            } else {
                // Plaintext HTTP (atau isi tak dikenal) — tolak dengan pesan jelas.
                writeHttpsRequired(socket);
            }
        });
        socket.once('error', () => { try { socket.destroy(); } catch { } });
    });
    server.httpServer = httpServer;
    return server;
}

function describe() {
    if (!isEnabled()) return { enabled: false, scheme: 'http', httpsRequired: false };
    const p = paths();
    if (!fs.existsSync(p.certFile)) {
        return { enabled: true, scheme: 'https', ready: false, message: 'Sertifikat belum dibuat. Jalankan: npm run gen-certs' };
    }
    try {
        const cert = readCert(p.certFile);
        return {
            enabled: true, scheme: 'https', ready: true,
            sans: collectSans(),
            cn: serverCn(),
            certFile: p.certFile, keyFile: p.keyFile,
            certExpires: cert.validTo,
            certDaysLeft: Math.max(0, Math.round((new Date(cert.validTo).getTime() - Date.now()) / 86400000)),
            ca: caInfo()
        };
    } catch (e) {
        return { enabled: true, scheme: 'https', ready: false, message: e.message };
    }
}

module.exports = {
    TlsError,
    paths, isEnabled, allowHttp, scheme, minVersion, certDays, SECURE_CIPHERS,
    lanIps, collectSans, serverCn,
    load, tlsOptions, createServer, describe,
    caFingerprint, caInfo, spkiFingerprint,
    HTTPS_REQUIRED_BODY
};
