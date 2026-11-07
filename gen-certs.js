#!/usr/bin/env node
'use strict';
// ============================================================================
// gen-certs.js — buat Private CA + sertifikat server untuk NodelixcoreOS.
//
//   node gen-certs.js                 buat CA + server cert (atau perbarui server)
//   node gen-certs.js --renew         perbarui server cert saja (CA tetap)
//   node gen-certs.js --force-ca      buat CA baru (mengganti trust semua klien!)
//   node gen-certs.js --status        tampilkan status sertifikat
//   node gen-certs.js --san "DNS:x,IP:y"    tambah/ganti SAN (ditambah deteksi otomatis)
//
// Kunci CA root disimpan terpisah (data/ca) dan TIDAK masuk Git (lihat .gitignore).
// Server hanya menyimpan kunci + sertifikat server (data/certs).
//
// Syarat: openssl terpasang (Termux: pkg install openssl).
// ============================================================================
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('./tls');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    if (r.status !== 0) {
        const err = (r.stderr || r.stdout || '').trim();
        throw new Error(`${cmd} gagal (${r.status}): ${err || 'tanpa output'}`);
    }
    return (r.stdout || '').trim();
}

function ensureDir(dir, mode) {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, mode); } catch { /* fs tanpa unix */ }
}

function writePem(file, text, mode) {
    fs.writeFileSync(file, text, { mode });
    try { fs.chmodSync(file, mode); } catch { /* fs tanpa unix */ }
}

function opensslAvailable() {
    try { return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0; }
    catch { return false; }
}

// ---------- CA ----------
function generateCa(caDir, caKeyFile, caCertFile, force) {
    if (!force && fs.existsSync(caKeyFile) && fs.existsSync(caCertFile)) {
        return { created: false };
    }
    ensureDir(caDir, 0o700);
    if (fs.existsSync(caKeyFile) && !force) throw new Error('Kunci CA sudah ada; gunakan --force-ca untuk mengganti.');
    // genrsa -out menulis kunci langsung ke berkas (bukan stdout).
    run('openssl', ['genrsa', '-out', caKeyFile, '4096']);
    try { fs.chmodSync(caKeyFile, 0o600); } catch { }
    const subj = '/O=NodelixcoreOS/CN=NodelixcoreOS Local Root CA';
    run('openssl', ['req', '-x509', '-new', '-key', caKeyFile, '-sha256', '-days', '3650',
        '-subj', subj,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-addext', 'subjectKeyIdentifier=hash',
        '-out', caCertFile]);
    try { fs.chmodSync(caCertFile, 0o644); } catch { }
    // Serial CA dibuat otomatis oleh `x509 -req -CAcreateserial` saat penandatanganan
    // pertama (format integer hex murni). Jangan dibuat manual: `x509 -serial`
    // menulis format '0A:B0:...' yang tidak bisa dibaca kembali oleh -CAserial.
    return { created: true };
}

// ---------- Server cert ----------
function generateServerCert(p, sans, days, forceCa) {
    ensureDir(p.certDir, 0o700);
    if (!fs.existsSync(p.caCertFile) || !fs.existsSync(p.caKeyFile)) {
        throw new Error('CA belum ada. Jalankan tanpa --renew untuk membuat CA + server cert.');
    }
    const cn = tls.serverCn();
    const sanStr = sans.join(',');
    const keyFile = p.keyFile;
    const certFile = p.certFile;
    // Tulis ekstensi ke file sementara (bukan process substitution — portabel).
    const extFile = path.join(p.certDir, '.server.ext');
    const ext = [
        `subjectAltName=${sanStr}`,
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid:always,issuer'
    ].join('\n');
    writePem(extFile, ext + '\n', 0o600);

    try {
        run('openssl', ['genrsa', '-out', keyFile, '2048']);
        try { fs.chmodSync(keyFile, 0o600); } catch { }
        const csrFile = path.join(p.certDir, '.server.csr');
        run('openssl', ['req', '-new', '-key', keyFile, '-subj', `/O=NodelixcoreOS/CN=${cn}`,
            '-addext', `subjectAltName=${sanStr}`, '-out', csrFile]);
        // Tanda tangani dengan CA. -CAcreateserial membuat/memperbarui .srl.
        // (openssl x509 -req memakai -CA, bukan -CAfile.)
        run('openssl', ['x509', '-req', '-in', csrFile,
            '-CA', p.caCertFile, '-CAkey', p.caKeyFile, '-CAcreateserial',
            '-out', certFile, '-days', String(days), '-sha256',
            '-extfile', extFile]);
    } finally {
        for (const f of [extFile]) { try { fs.rmSync(f, { force: true }); } catch { } }
    }
    writePem(certFile, fs.readFileSync(certFile), 0o644);
    return { cn, sans, days };
}

function printStatus() {
    const d = tls.describe();
    if (!d.enabled) { console.log('TLS dinonaktifkan (TLS_ENABLED=false).'); return; }
    if (!d.ready) { console.log('Belum siap: ' + d.message); return; }
    console.log('Sertifikat server:');
    console.log('  CN     : ' + d.cn);
    console.log('  SAN    : ' + d.sans.join(', '));
    console.log('  Berlaku: ' + d.certExpires + '  (' + d.certDaysLeft + ' hari tersisa)');
    console.log('  CA     : ' + (d.ca ? d.ca.subject + '  [fingerprint ' + d.ca.fingerprint + ']' : '(tidak ada)'));
}

function printTrustGuide(caFile) {
    const fp = tls.caFingerprint();
    console.log('\n' + '='.repeat(64));
    console.log('Sertifikat CA root (sebar ke klien yang akan mempercayai server):');
    console.log('  ' + caFile);
    console.log('  Fingerprint SHA-256 (SPKI): ' + (fp || '(belum tersedia)'));
    console.log('\nAndroid (aplikasi NodelixcoreOS Mobile):');
    console.log('  1. Salin root-ca.crt ke HP (mis. via USB/Telegram/WiFi).');
    console.log('  2. Pasang sebagai sertifikat CA sistem (Settings > Security > Install CA)');
    console.log('     ATAU gunakan Network Security Config yang secara eksplisit mempercayai CA ini');
    console.log('     (lihat docs/HTTPS-LOCAL.md untuk snippet pinning/trust).');
    console.log('  3. Gunakan https://<IP-server>:<port> sebagai baseUrl di aplikasi.');
    console.log('\nBrowser dashboard:');
    console.log('  Percayai CA lokal di sistem OS/browser, lalu buka https://<IP>:<port>.');
    console.log('='.repeat(64));
}

// ---------- main ----------
function main() {
    const argv = process.argv.slice(2);
    const has = f => argv.includes(f);
    if (has('--help') || has('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('//   node gen-certs.js')[0]);
        return;
    }
    if (!opensslAvailable()) {
        console.error('openssl tidak terpasang. Pasang dulu: pkg install openssl (Termux) atau apt install openssl.');
        process.exit(2);
    }
    const p = tls.paths();
    if (has('--status')) { printStatus(); return; }

    const forceCa = has('--force-ca');
    const renew = has('--renew');
    const days = tls.certDays();

    // Pembaruan SAN dari argumen --san (ditambah deteksi otomatis & env).
    const sanArg = argv.find(a => a.startsWith('--san='));
    if (sanArg) {
        const val = sanArg.slice('--san='.length);
        process.env.TLS_SAN = [process.env.TLS_SAN, val].filter(Boolean).join(',');
    }

    const caRes = generateCa(p.caDir, p.caKeyFile, p.caCertFile, forceCa);
    const sans = tls.collectSans();
    const srvRes = generateServerCert(p, sans, days, forceCa);

    // Verifikasi hasil dengan modul runtime (tolak cert cacat).
    const loaded = tls.load();
    if (!loaded) { console.error('TLS dinonaktifkan; tidak ada sertifikat yang dimuat.'); process.exit(1); }

    console.log('[gen-certs] CA root    : ' + (caRes.created ? 'dibuat baru' : 'dipertahankan'));
    console.log('[gen-certs] Server CN  : ' + srvRes.cn);
    console.log('[gen-certs] SAN        : ' + srvRes.sans.join(', '));
    console.log('[gen-certs] Masa berlaku: ' + days + ' hari (diperbarui ' + new Date().toISOString() + ')');
    printTrustGuide(p.caCertFile);
    if (forceCa) {
        console.warn('[gen-certs] ⚠ CA diganti: SEMUA klien (Android/browser) harus memasang CA baru lagi.');
    }
}

// ---------- Programmatic API (dipakai pengujian & TLS_AUTOGEN) ----------
// Buat/perbarui CA + sertifikat server di dataDir yang diberikan. Kembalikan
// { caCertFile, certFile, keyFile, sans, cn, days }.
function ensureCertificates({ dataDir, forceCa = false, renew = false, days, quiet = false } = {}) {
    if (!opensslAvailable()) throw new Error('openssl tidak terpasang (pkg install openssl).');
    const p = tls.paths(dataDir);
    const caRes = generateCa(p.caDir, p.caKeyFile, p.caCertFile, forceCa);
    const sans = tls.collectSans();
    const cn = tls.serverCn();
    const d = days || tls.certDays();
    const srvRes = generateServerCert(p, sans, d, forceCa);
    // Verifikasi hasil dengan modul runtime (tolak cert cacat).
    const loaded = tls.load(p);
    if (!loaded) throw new Error('TLS dinonaktifkan; tidak ada sertifikat yang dimuat.');
    if (!quiet) {
        console.log('[gen-certs] CA root    : ' + (caRes.created ? 'dibuat baru' : 'dipertahankan'));
        console.log('[gen-certs] Server CN  : ' + cn);
        console.log('[gen-certs] SAN        : ' + sans.join(', '));
        console.log('[gen-certs] Masa berlaku: ' + d + ' hari');
    }
    return { caCertFile: p.caCertFile, caKeyFile: p.caKeyFile, certFile: p.certFile, keyFile: p.keyFile, sans, cn, days: d, created: caRes.created };
}

module.exports = { ensureCertificates, generateCa, generateServerCert, opensslAvailable, run };

// ---------- main (CLI) ----------
if (require.main === module) {
    try { main(); }
    catch (e) {
        console.error('[gen-certs] gagal: ' + e.message);
        process.exit(1);
    }
}
