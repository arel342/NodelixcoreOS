#!/usr/bin/env node
'use strict';
// NodelixcoreOS local certificate generator.
// Pure Node.js built-in crypto/fs. No OpenSSL executable or child process.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('./tls');

const OID = {
    SHA256_RSA: '1.2.840.113549.1.1.11', ORG: '2.5.4.10', CN: '2.5.4.3',
    BASIC: '2.5.29.19', KEY_USAGE: '2.5.29.15', EXT_KEY_USAGE: '2.5.29.37',
    SAN: '2.5.29.17', SKI: '2.5.29.14', AKI: '2.5.29.35',
    SERVER_AUTH: '1.3.6.1.5.5.7.3.1'
};
const DAY_MS = 86400000;

function der(tag, value) {
    const body = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    let length;
    if (body.length < 0x80) length = Buffer.from([body.length]);
    else {
        let n = body.length, bytes = [];
        while (n > 0) { bytes.unshift(n & 255); n = Math.floor(n / 256); }
        length = Buffer.from([0x80 | bytes.length, ...bytes]);
    }
    return Buffer.concat([Buffer.from([tag]), length, body]);
}
const seq = (...a) => der(0x30, Buffer.concat(a));
const set = (...a) => der(0x31, Buffer.concat(a));
function integer(value) {
    let b = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from([value]);
    while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return der(0x02, b);
}
const bool = v => der(0x01, Buffer.from([v ? 255 : 0]));
const octet = v => der(0x04, v);
const utf8 = v => der(0x0c, Buffer.from(String(v), 'utf8'));
const nullDer = () => der(0x05, Buffer.alloc(0));
const bitString = (v, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), v]));
function base128(n) {
    const out = [n % 128]; n = Math.floor(n / 128);
    while (n > 0) { out.unshift((n % 128) | 128); n = Math.floor(n / 128); }
    return Buffer.from(out);
}
function oid(v) {
    const a = String(v).split('.').map(Number);
    if (a.length < 2 || a.some(n => !Number.isSafeInteger(n) || n < 0) || a[0] > 2 || (a[0] < 2 && a[1] > 39)) throw new Error('OID tidak valid: ' + v);
    return der(0x06, Buffer.concat([base128(a[0] * 40 + a[1]), ...a.slice(2).map(base128)]));
}
const sigAlg = () => seq(oid(OID.SHA256_RSA), nullDer());
function name(cn) {
    return seq(set(seq(oid(OID.ORG), utf8('NodelixcoreOS'))), set(seq(oid(OID.CN), utf8(cn))));
}
function timeDer(value) {
    const d = new Date(value), y = d.getUTCFullYear();
    if (!Number.isFinite(d.getTime())) throw new Error('Waktu sertifikat tidak valid.');
    const p = n => String(n).padStart(2, '0');
    const tail = p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
    return y >= 1950 && y <= 2049
        ? der(0x17, Buffer.from(p(y % 100) + tail, 'ascii'))
        : der(0x18, Buffer.from(String(y).padStart(4, '0') + tail, 'ascii'));
}
function extension(id, value, critical = false) {
    return seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
}
function bitField(indices) {
    const max = Math.max(...indices), count = Math.floor(max / 8) + 1, bytes = Buffer.alloc(count);
    for (const bit of indices) bytes[Math.floor(bit / 8)] |= 1 << (7 - bit % 8);
    return bitString(bytes, count * 8 - max - 1);
}
function ipBytes(address) {
    if (net.isIP(address) === 4) return Buffer.from(address.split('.').map(Number));
    if (net.isIP(address) !== 6) throw new Error('IP SAN tidak valid: ' + address);
    let s = address.toLowerCase();
    if (s.includes('.')) {
        const last = s.slice(s.lastIndexOf(':') + 1), v4 = Buffer.from(last.split('.').map(Number));
        s = s.slice(0, s.lastIndexOf(':')) + ':' + v4.readUInt16BE(0).toString(16) + ':' + v4.readUInt16BE(2).toString(16);
    }
    const halves = s.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length, groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) throw new Error('IP SAN IPv6 tidak valid: ' + address);
    return Buffer.concat(groups.map(h => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(h || '0', 16)); return b; }));
}
function sanDer(sans) {
    const names = [];
    for (const item of sans) {
        const m = /^(DNS|IP):(.+)$/i.exec(String(item));
        if (!m) continue;
        if (m[1].toUpperCase() === 'DNS') {
            const h = m[2].trim();
            if (!h || /[^\x21-\x7e]/.test(h) || /[,*]/.test(h)) throw new Error('DNS SAN tidak valid: ' + h);
            names.push(der(0x82, Buffer.from(h, 'ascii')));
        } else names.push(der(0x87, ipBytes(m[2].trim())));
    }
    if (!names.length) throw new Error('SAN sertifikat kosong.');
    return seq(...names);
}
function serialDer() {
    const b = crypto.randomBytes(16); b[0] &= 0x7f;
    if (b.every(x => x === 0)) b[15] = 1;
    return integer(b);
}
function readTlv(b, offset) {
    if (offset + 2 > b.length) throw new Error('DER terpotong.');
    const tag = b[offset]; let len = b[offset + 1], head = 2;
    if (len & 0x80) {
        const count = len & 0x7f;
        if (!count || count > 4 || offset + 2 + count > b.length) throw new Error('Panjang DER tidak valid.');
        len = 0;
        for (let i = 0; i < count; i++) len = len * 256 + b[offset + 2 + i];
        head += count;
    }
    const start = offset, contentStart = offset + head, end = contentStart + len;
    if (end > b.length) throw new Error('Nilai DER melampaui buffer.');
    return { tag, start, contentStart, end };
}
function children(b, node) {
    const out = []; let pos = node.contentStart;
    while (pos < node.end) { const item = readTlv(b, pos); out.push(item); pos = item.end; }
    if (pos !== node.end) throw new Error('Struktur DER tidak lengkap.');
    return out;
}
function subjectDer(certDer) {
    const outer = readTlv(certDer, 0);
    if (outer.tag !== 0x30 || outer.end !== certDer.length) throw new Error('Sertifikat CA bukan DER SEQUENCE yang valid.');
    const fields = children(certDer, outer), tbs = fields[0];
    if (!tbs || tbs.tag !== 0x30) throw new Error('TBSCertificate tidak valid.');
    const tbsFields = children(certDer, tbs);
    let i = tbsFields[0] && tbsFields[0].tag === 0xa0 ? 1 : 0;
    i += 4;
    const subject = tbsFields[i];
    if (!subject || subject.tag !== 0x30) throw new Error('Subject CA tidak ditemukan.');
    return certDer.subarray(subject.start, subject.end);
}
function skiFor(publicKey) {
    const spki = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const f = children(spki, readTlv(spki, 0)), bits = f[1];
    if (!bits || bits.tag !== 0x03 || spki[bits.contentStart] !== 0) throw new Error('Public key SPKI tidak valid.');
    return crypto.createHash('sha1').update(spki.subarray(bits.contentStart + 1, bits.end)).digest();
}
function createCert({ pub, issuer, subject, signer, before, after, extensions }) {
    const alg = sigAlg(), tbs = seq(
        der(0xa0, integer(2)), serialDer(), alg, issuer, seq(timeDer(before), timeDer(after)),
        subject, crypto.createPublicKey(pub).export({ type: 'spki', format: 'der' }),
        der(0xa3, seq(...extensions))
    );
    return seq(tbs, alg, bitString(crypto.sign('sha256', tbs, signer)));
}
function toPem(label, b) {
    const chunks = b.toString('base64').match(/.{1,64}/g) || [];
    return '-----BEGIN ' + label + '-----\n' + chunks.join('\n') + '\n-----END ' + label + '-----\n';
}
function ensureDir(dir, mode) {
    fs.mkdirSync(dir, { recursive: true, mode });
    try { fs.chmodSync(dir, mode); } catch { /* filesystem tanpa chmod */ }
}
function atomicWrite(file, data, mode) {
    ensureDir(path.dirname(file), 0o700);
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode); fs.writeFileSync(fd, data); fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        try { fs.chmodSync(tmp, mode); } catch { }
        fs.renameSync(tmp, file);
    } catch (e) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { } }
        try { fs.rmSync(tmp, { force: true }); } catch { }
        throw e;
    }
}
function keyPair(bits) {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: bits, publicExponent: 0x10001,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
}
function caCertificate(kp) {
    const n = name('NodelixcoreOS Local Root CA'), ski = skiFor(kp.publicKey), now = Date.now();
    return toPem('CERTIFICATE', createCert({
        pub: kp.publicKey, issuer: n, subject: n, signer: kp.privateKey,
        before: new Date(now - 5 * 60000), after: new Date(now + 3650 * DAY_MS),
        extensions: [
            extension(OID.BASIC, seq(bool(true)), true),
            extension(OID.KEY_USAGE, bitField([5, 6]), true),
            extension(OID.SKI, octet(ski))
        ]
    }));
}
function validateCa(caPem, keyPem) {
    let ca, key;
    try { ca = new crypto.X509Certificate(caPem); key = crypto.createPrivateKey(keyPem); }
    catch (e) { throw new Error('CA atau kunci privat CA tidak dapat dibaca: ' + e.message); }
    const now = Date.now();
    if (!ca.ca) throw new Error('Sertifikat root tidak memiliki Basic Constraints CA:TRUE.');
    if (new Date(ca.validFrom).getTime() > now || new Date(ca.validTo).getTime() <= now) throw new Error('Sertifikat root CA belum berlaku atau sudah kedaluwarsa.');
    if (!ca.checkIssued(ca) || !ca.verify(ca.publicKey)) throw new Error('Sertifikat root CA bukan self-signed yang valid.');
    if (!ca.checkPrivateKey(key)) throw new Error('Kunci privat CA tidak cocok dengan sertifikat root CA.');
    return { ca, key };
}
function buildLeaf(caPem, caKeyPem, sans, cn, days) {
    const { ca, key: caKey } = validateCa(caPem, caKeyPem);
    const kp = keyPair(2048), now = Date.now(), ski = skiFor(kp.publicKey), aki = skiFor(ca.publicKey.export({ type: 'spki', format: 'pem' }));
    const certificate = toPem('CERTIFICATE', createCert({
        pub: kp.publicKey, issuer: subjectDer(ca.raw), subject: name(cn), signer: caKey,
        before: new Date(now - 5 * 60000), after: new Date(now + days * DAY_MS),
        extensions: [
            extension(OID.BASIC, seq(), true),
            extension(OID.KEY_USAGE, bitField([0, 2]), true),
            extension(OID.EXT_KEY_USAGE, seq(oid(OID.SERVER_AUTH))),
            extension(OID.SAN, sanDer(sans)),
            extension(OID.SKI, octet(ski)),
            extension(OID.AKI, seq(der(0x80, aki)))
        ]
    }));
    const leaf = new crypto.X509Certificate(certificate);
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey) || !leaf.checkPrivateKey(crypto.createPrivateKey(kp.privateKey))) {
        throw new Error('Verifikasi sertifikat server yang baru dibuat gagal.');
    }
    return { cert: certificate, key: kp.privateKey };
}
function generateCa(caDir, caKeyFile, caCertFile, force = false) {
    ensureDir(caDir, 0o700);
    const hasKey = fs.existsSync(caKeyFile), hasCert = fs.existsSync(caCertFile);
    if (!force && hasKey && hasCert) {
        validateCa(fs.readFileSync(caCertFile), fs.readFileSync(caKeyFile));
        try { fs.chmodSync(caKeyFile, 0o600); } catch { }
        return { created: false };
    }
    if (!force && (hasKey || hasCert)) throw new Error('CA tidak lengkap (hanya kunci atau sertifikat yang ada). Pulihkan backup atau gunakan --force-ca setelah menyiapkan ulang trust klien.');
    const kp = keyPair(4096), cert = caCertificate(kp);
    validateCa(cert, kp.privateKey);
    atomicWrite(caKeyFile, kp.privateKey, 0o600);
    atomicWrite(caCertFile, cert, 0o644);
    return { created: true };
}
function generateServerCert(p, sans, days) {
    ensureDir(p.certDir, 0o700);
    if (!fs.existsSync(p.caCertFile) || !fs.existsSync(p.caKeyFile)) throw new Error('CA belum ada. Jalankan tanpa --renew untuk membuat CA + sertifikat server.');
    const cn = tls.serverCn();
    const out = buildLeaf(fs.readFileSync(p.caCertFile), fs.readFileSync(p.caKeyFile), sans, cn, days);
    atomicWrite(p.keyFile, out.key, 0o600);
    atomicWrite(p.certFile, out.cert, 0o644);
    return { cn, sans, days };
}
function ensureCertificates({ dataDir, forceCa = false, renew = false, days, quiet = false } = {}) {
    const p = tls.paths(dataDir);
    ensureDir(p.caDir, 0o700); ensureDir(p.certDir, 0o700);
    if (renew && (!fs.existsSync(p.caCertFile) || !fs.existsSync(p.caKeyFile))) throw new Error('Tidak dapat --renew karena CA belum ada. Jalankan tanpa --renew untuk membuat CA + sertifikat server.');
    const caRes = generateCa(p.caDir, p.caKeyFile, p.caCertFile, forceCa);
    const sans = tls.collectSans(), cn = tls.serverCn(), d = days || tls.certDays();
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw new Error('Masa berlaku sertifikat harus 1–3650 hari.');
    const srv = generateServerCert(p, sans, d);
    const loaded = tls.load(p);
    if (!loaded) throw new Error('TLS dinonaktifkan; sertifikat tidak dimuat.');
    if (!quiet) {
        console.log('[gen-certs] CA root: ' + (caRes.created ? 'dibuat baru' : 'dipertahankan'));
        console.log('[gen-certs] Server CN: ' + cn);
        console.log('[gen-certs] SAN: ' + sans.join(', '));
        console.log('[gen-certs] Masa berlaku: ' + d + ' hari (' + new Date().toISOString() + ')');
        console.log('Root CA: ' + p.caCertFile);
        console.log('Fingerprint SHA-256 (SPKI): ' + tls.caFingerprint());
        console.log('Android: tambahkan CA melalui Network Security Config; jangan gunakan trust-all.');
        console.log('Alamat server: https://<IP-server>:' + (process.env.PORT || 3000));
        if (forceCa) console.warn('[gen-certs] ⚠ CA diganti: semua klien harus mempercayai CA baru.');
    }
    return { caCertFile: p.caCertFile, caKeyFile: p.caKeyFile, certFile: p.certFile, keyFile: p.keyFile, sans, cn, days: d, created: caRes.created };
}
function printStatus() {
    const d = tls.describe();
    if (!d.enabled) return console.log('TLS dinonaktifkan (TLS_ENABLED=false).');
    if (!d.ready) return console.log('Belum siap: ' + d.message);
    console.log('Sertifikat server:');
    console.log('  CN     : ' + d.cn);
    console.log('  SAN    : ' + d.sans.join(', '));
    console.log('  Berlaku: ' + d.certExpires + ' (' + d.certDaysLeft + ' hari tersisa)');
    console.log('  CA     : ' + (d.ca ? d.ca.subject + ' [fingerprint ' + d.ca.fingerprint + ']' : '(tidak ada)'));
}
function main(argv = process.argv.slice(2)) {
    const has = flag => argv.includes(flag);
    if (has('--help') || has('-h')) {
        console.log('NodelixcoreOS HTTPS certificate manager\n  node gen-certs.js\n  node gen-certs.js --renew\n  node gen-certs.js --force-ca\n  node gen-certs.js --status\n  node gen-certs.js --san=DNS:nodelix.local,IP:192.168.1.10\n\nGenerator menggunakan Node.js crypto dan tidak memanggil OpenSSL CLI.');
        return;
    }
    if (has('--status')) return printStatus();
    const sanArg = argv.find(a => a.startsWith('--san='));
    if (sanArg) process.env.TLS_SAN = [process.env.TLS_SAN, sanArg.slice(6)].filter(Boolean).join(',');
    return ensureCertificates({ forceCa: has('--force-ca'), renew: has('--renew') });
}
module.exports = { ensureCertificates, generateCa, generateServerCert };
if (require.main === module) {
    try { main(); }
    catch (e) { console.error('[gen-certs] gagal: ' + e.message); process.exitCode = 1; }
}
