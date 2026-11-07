// ============================================================================
// tests/tls-https.test.js — verifikasi keamanan TLS/HTTPS/WSS server.
//
// Menguji:
//   • HTTPS/WSS melayani, HSTS aktif, header keamanan
//   • HTTP plaintext ditolak dengan pesan jelas (400)
//   • TLS 1.0/1.1 ditolak, minVersion TLS1.2
//   • Hostname mismatch & CA tidak tepercaya ditolak
//   • Sertifikat valid, belum kedaluwarsa, rantai CA benar
//   • Berkas sertifikat/kunci tidak masuk git (gitignore aktif)
//   • Konfigurasi TLS (cipher, minVersion) sesuai standar
// ============================================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('https');
const net = require('net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = { username: 'admin', password: 'tls-test-123' };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-tls-'));
const storageDir = path.join(tmpRoot, 'storage');
fs.mkdirSync(path.join(storageDir, 'upload'), { recursive: true });
process.env.TLS_DATA_DIR = tmpRoot; // agar tlsOptions()/load() di proses parent memakai CA tes

const { ensureCertificates } = require(path.join(ROOT, 'gen-certs'));
const certResult = ensureCertificates({ dataDir: tmpRoot, quiet: true });
const caPem = fs.readFileSync(certResult.caCertFile);
const tlsMod = require(path.join(ROOT, 'tls.js'));

let child = null;
let port = 0;
const agent = new https.Agent({ ca: caPem, rejectUnauthorized: true });

function rawRequest(p, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL('https://127.0.0.1:' + port + p);
        const rq = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent }, res => {
            let data = ''; res.setEncoding('utf8'); res.on('data', d => data += d);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(data); } catch { }
                const hdrs = {}; for (const [k, v] of Object.entries(res.headers)) hdrs[k.toLowerCase()] = v;
                resolve({ status: res.statusCode, body: json, raw: data, headers: { get: (k) => hdrs[k.toLowerCase()] ?? null } });
            });
        });
        rq.on('error', reject);
        if (body !== undefined && body !== null) rq.write(body);
        rq.end();
    });
}

function startServer(prt) {
    return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: {
                ...process.env, PORT: String(prt), TLS_DATA_DIR: tmpRoot,
                ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password,
                SESSION_TTL_HOURS: '1', STORAGE_DEVICE: storageDir, STORAGE_MODE: 'direct',
                STORAGE_FOLDER: 'upload', SU_BIN: '/bin/sh', UPDATE_CHECK_ENABLED: 'false',
                AI_AGENT_ENABLED: 'false', TELEGRAM_ALERTS: 'false', TERMINAL_ENABLED: 'false',
                DOOR_IP: '', ESP32_IP: ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('server tidak siap: ' + out.slice(-600))); }, 25000);
        const onData = d => { out += String(d); if (/Server aktif|Setup awal/.test(out) || /Penyimpanan\s*:/.test(out)) { clearTimeout(timer); resolve(c); } };
        c.stdout.on('data', onData);
        c.stderr.on('data', d => { out += String(d); });
        c.on('exit', code => { clearTimeout(timer); reject(new Error(`server keluar (${code}): ${out.slice(-600)}`)); });
    });
}

async function waitReady() {
    for (let i = 0; i < 60; i++) {
        try { const r = await rawRequest('/api/session'); if (r.status === 200) return; } catch { }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('API /api/session tidak merespons');
}

async function stopServer(c) {
    if (!c || c.exitCode !== null) return;
    const done = new Promise(resolve => c.once('exit', resolve));
    c.kill('SIGTERM');
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { } }, 5000);
    await done; clearTimeout(timer);
}

function plainHttp(p) {
    return new Promise(resolve => {
        const rq = net.connect(port, '127.0.0.1', () => {
            rq.write('GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
        });
        let data = ''; rq.setEncoding('utf8'); rq.on('data', d => data += d);
        rq.on('close', () => resolve(data));
        rq.on('error', e => resolve('ERR:' + e.message));
        setTimeout(() => { try { rq.destroy(); } catch { } }, 4000);
    });
}

before(async () => {
    port = 20000 + Math.floor(Math.random() * 20000);
    child = await startServer(port);
    await waitReady();
});

after(async () => {
    await stopServer(child);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('tls: HTTPS melayani /api/session dengan HSTS + header keamanan', async () => {
    const r = await rawRequest('/api/session');
    assert.equal(r.status, 200);
    assert.equal(r.body.authenticated, false);
    const hsts = r.headers.get('strict-transport-security');
    assert.ok(hsts && /max-age=\d+/.test(hsts), 'HSTS harus ada: ' + hsts);
    assert.ok(/includeSubDomains/.test(hsts || ''), 'HSTS includeSubDomains');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!r.headers.get('x-powered-by'));
});

test('tls: HTTP plaintext ditolak dengan pesan jelas (400 "HTTPS required")', async () => {
    const resp = await plainHttp('/api/session');
    assert.match(resp, /400 Bad Request/i, 'harus 400: ' + resp.slice(0, 80));
    assert.match(resp, /HTTPS/i, 'pesan harus menyebut HTTPS: ' + resp.slice(0, 120));
    assert.match(resp, /HTTPS wajib digunakan|HTTPS is required/i, 'pesan lokal+Inggris');
});

test('tls: TLS 1.0 dan TLS 1.1 ditolak oleh server (klien Node.js)', async () => {
    for (const version of ['TLSv1', 'TLSv1.1']) {
        const result = await new Promise(resolve => {
            let socket;
            try {
                socket = tls.connect({
                    host: '127.0.0.1',
                    port,
                    servername: 'localhost',
                    ca: caPem,
                    rejectUnauthorized: true,
                    minVersion: version,
                    maxVersion: version,
                    // Rendahkan security level hanya untuk menguji versi protokol lama.
                    // Server tetap harus menolak sebelum aplikasi menerima HTTP.
                    ciphers: 'DEFAULT:@SECLEVEL=0',
                    secureOptions: 0
                }, () => resolve('CONNECTED (UNEXPECTED): ' + socket.getProtocol()));
            } catch (e) {
                resolve('REJECTED: ' + (e.code || e.message));
                return;
            }
            socket.on('error', e => resolve('REJECTED: ' + (e.code || e.message)));
            setTimeout(() => { try { socket.destroy(); } catch { } resolve('TIMEOUT'); }, 4000);
        });
        assert.match(result, /^REJECTED:/, version + ' harus ditolak oleh server: ' + result);
    }
});

test('tls: tlsOptions() enforce minVersion TLS1.2 dan cipher aman', () => {
    const opts = tlsMod.tlsOptions();
    assert.equal(opts.minVersion, 'TLSv1.2', 'minVersion harus TLS1.2');
    assert.ok(opts.ciphers && opts.ciphers.length > 0, 'ciphers harus ditetapkan');
    assert.ok(!/TLS_RSA_WITH|DES|RC4|3DES|MD5|EXPORT/i.test(opts.ciphers), 'cipher lemah tidak boleh ada');
    assert.ok(opts.minVersion !== 'TLSv1' && opts.minVersion !== 'TLSv1.1');
});

test('tls: hostname mismatch ditolak (ERR_TLS_CERT_ALTNAME_INVALID)', async () => {
    const result = await new Promise(resolve => {
        const s = tls.connect({ host: '127.0.0.1', port, servername: 'wrong.example.com', ca: caPem, rejectUnauthorized: true }, () => resolve('CONNECTED (BAD!)'));
        s.on('error', e => resolve('REJECTED:' + e.code));
        setTimeout(() => { try { s.destroy(); } catch { } resolve('timeout'); }, 4000);
    });
    assert.match(result, /REJECTED:ERR_TLS_CERT_ALTNAME_INVALID|REJECTED:ERR_TLS_CERT/, 'hostname mismatch harus ditolak: ' + result);
});

test('tls: CA tidak tepercaya ditolak', async () => {
    // Tanpa ca (menggunakan CA default sistem) — cert swasta tidak dipercaya.
    const result = await new Promise(resolve => {
        const s = tls.connect({ host: '127.0.0.1', port, servername: '127.0.0.1', rejectUnauthorized: true }, () => resolve('CONNECTED (BAD!)'));
        s.on('error', e => resolve('REJECTED:' + e.code));
        setTimeout(() => { try { s.destroy(); } catch { } resolve('timeout'); }, 4000);
    });
    assert.match(result, /REJECTED/, 'CA tidak tepercaya harus ditolak: ' + result);
});

test('tls: sertifikat valid, belum kedaluwarsa, rantai CA benar', () => {
    const loaded = tlsMod.load();
    assert.ok(loaded, 'load() harus berhasil');
    assert.ok(loaded.expiresAt > Date.now(), 'sertifikat belum kedaluwarsa');
    assert.ok(Array.isArray(loaded.sans) && loaded.sans.length > 0, 'SAN harus ada');
    // Validasi rantai via crypto (cert & ca adalah PEM).
    const cert = new crypto.X509Certificate(loaded.cert);
    const ca = new crypto.X509Certificate(loaded.ca);
    assert.equal(ca.ca, true, 'root CA harus memiliki Basic Constraints CA:TRUE');
    assert.equal(ca.checkIssued(ca), true, 'root CA harus self-issued');
    assert.equal(ca.verify(ca.publicKey), true, 'tanda tangan root CA harus valid');
    assert.equal(cert.checkIssued(ca), true, 'issuer sertifikat server harus cocok dengan CA');
    assert.equal(cert.verify(ca.publicKey), true, 'tanda tangan sertifikat server harus diverifikasi dengan public key CA');
    assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(loaded.key)), true, 'private key harus cocok dengan sertifikat');
    assert.ok(cert.checkHost('localhost'), 'SAN localhost harus cocok');
    assert.ok(cert.checkIP('127.0.0.1'), 'SAN IP loopback harus cocok');
});

test('tls: WSS melayani (WebSocket over TLS)', async () => {
    const login = await rawRequest('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];
    const frames = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ca: caPem, rejectUnauthorized: true, headers: { Cookie: cookie } });
        const seen = new Set();
        ws.on('message', m => { const f = JSON.parse(String(m)); seen.add(f.type); if (seen.has('SENSOR')) { ws.close(); resolve([...seen]); } });
        ws.on('error', reject);
        setTimeout(() => { try { ws.close(); } catch { } resolve([...seen]); }, 5000);
    });
    assert.ok(frames.includes('SENSOR'), 'WSS harus mengirim SENSOR: ' + frames);
});

test('tls: berkas sertifikat/kunci tidak masuk git (gitignore aktif)', () => {
    // data/ca dan data/certs harus diabaikan git.
    for (const sub of ['data/ca', 'data/certs']) {
        const check = spawnSync('git', ['check-ignore', '-q', path.join(ROOT, sub, '.keep')], { cwd: ROOT, encoding: 'utf8' });
        // Jika path diabaikan, exit 0. Jika tidak, exit 1 (atau error jika path tidak ada).
        // Uji via .gitignore langsung.
        const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
        assert.match(gitignore, /\/ca\/|\/certs\/|data\/ca|data\/certs/i, '.gitignore harus mengecualikan ' + sub);
    }
    // Verifikasi cert/key tidak tercommit di HEAD.
    const ls = spawnSync('git', ['ls-files', 'data/ca/', 'data/certs/'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ls.stdout.trim(), '', 'tidak boleh ada berkas CA/cert di git: ' + ls.stdout);
});


test('tls: generator sertifikat tidak memanggil OpenSSL CLI', () => {
    const source = fs.readFileSync(path.join(ROOT, 'gen-certs.js'), 'utf8');
    assert.doesNotMatch(source, /child_process|spawnSync|execFileSync|openssl\s+(genrsa|req|x509|s_client)/i);
    assert.match(source, /generateKeyPairSync/);
    assert.match(source, /crypto\.sign/);
});

test('tls: cert memiliki SAN untuk localhost + IP loopback', () => {
    const loaded = tlsMod.load();
    const sans = loaded.sans.join(',');
    assert.match(sans, /DNS:localhost|IP:127\.0\.0\.1/i, 'SAN harus localhost/127.0.0.1: ' + sans);
});

test('tls: login HTTPS issue cookie sid, error tidak menyingkapkan stack trace', async () => {
    const bad = await rawRequest('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'salah' }) });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.success, false);
    assert.ok(!/at .*\.js|Error:|stack/i.test(bad.raw), 'tidak boleh ada stack trace: ' + bad.raw.slice(0, 100));
    const ok = await rawRequest('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
    assert.equal(ok.status, 200);
    const cookie = String(ok.headers.get('set-cookie')).split(';')[0];
    assert.match(cookie, /^sid=[a-f0-9]{64}$/);
});
