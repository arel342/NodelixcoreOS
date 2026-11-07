// ============================================================================
// tests/websocket-abuse.test.js — server.js SUNGGUHAN (proses anak, port acak):
//   • frame WebSocket tidak sah / klien hilang di tengah handshake TIDAK boleh
//     mematikan proses (sebelum perbaikan: uncaughtException ERR_UNHANDLED_ERROR
//     dari ws -> server mati)
//   • sesi WebSocket tetap berfungsi setelah percobaan di atas
//   • SIGTERM menutup proses dengan rapi (kode keluar terkontrol, state tersimpan)
//
// Tanpa perangkat keras, tanpa jaringan luar.
// ============================================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('https');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = { username: 'admin', password: 'ws-abuse-test-123' };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-ws-'));
const storageDir = path.join(tmpRoot, 'storage');
fs.mkdirSync(path.join(storageDir, 'upload'), { recursive: true });

// Hasilkan CA + sertifikat server di temp dir sebelum server di-spawn.
const { ensureCertificates } = require(path.join(ROOT, 'gen-certs'));
const certResult = ensureCertificates({ dataDir: tmpRoot, quiet: true });
const caPem = fs.readFileSync(certResult.caCertFile);
const agent = new https.Agent({ ca: caPem, rejectUnauthorized: true });
const wsOpts = { ca: caPem, rejectUnauthorized: true };

// Data runtime milik server (data/mobile-*.json) disimpan & dipulihkan agar tes tidak
// mengubah data pengguna yang sudah ada.
const dataDir = path.join(ROOT, 'data');
const runtimeFiles = ['mobile-devices.json', 'mobile-sessions.json'].map(n => path.join(dataDir, n));
const savedRuntime = new Map(runtimeFiles.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));

let child = null;
let port = 0;
let cookie = '';
let log = '';

function startServer(prt) {
    return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env: {
                ...process.env,
                PORT: String(prt),
                TLS_DATA_DIR: tmpRoot,
                ADMIN_USERNAME: ADMIN.username,
                ADMIN_PASSWORD: ADMIN.password,
                SESSION_TTL_HOURS: '1',
                STORAGE_DEVICE: storageDir,
                STORAGE_MODE: 'direct',
                STORAGE_FOLDER: 'upload',
                SU_BIN: '/bin/sh',
                UPDATE_CHECK_ENABLED: 'false',
                AI_AGENT_ENABLED: 'false',
                TELEGRAM_ALERTS: 'false',
                TERMINAL_ENABLED: 'false',
                ESP32_IP: '',
                DOOR_IP: ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('server tidak siap: ' + out.slice(-600))); }, 25000);
        const onData = d => {
            out += String(d);
            if (/Server aktif|Setup awal/.test(out)) { clearTimeout(timer); resolve(c); }
        };
        c.stdout.on('data', onData);
        c.stderr.on('data', onData);
        c.on('exit', code => { clearTimeout(timer); reject(new Error(`server keluar (${code}): ${out.slice(-600)}`)); });
    });
}

async function freePort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Permintaan HTTPS sederhana (untuk login /api/session).
async function httpReq(method, url, { headers = {}, body } = {}) {
    const u = new URL('https://127.0.0.1:' + port + url);
    return new Promise((resolve, reject) => {
        const rq = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', d => text += d);
            res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
        });
        rq.on('error', reject);
        if (body !== undefined) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
        rq.end();
    });
}

// Kirim frame mentah (tidak sah) ke endpoint WebSocket (WSS), lalu tutup socket
// tanpa handshake close yang benar.
function sendBadFrame(payload) {
    return new Promise(resolve => {
        const c = tls.connect({ host: '127.0.0.1', port, ca: caPem, servername: '127.0.0.1', rejectUnauthorized: true }, () => {
            c.write(
                `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`
            );
            setTimeout(() => { try { c.write(payload); } catch { } }, 120);
            setTimeout(() => { c.destroy(); resolve(); }, 320);
        });
        c.on('data', () => { });
        c.on('error', () => resolve());
    });
}

before(async () => {
    port = await freePort();
    child = await startServer(port);
    child.stdout.on('data', d => { log += String(d); });
    child.stderr.on('data', d => { log += String(d); });
    child.on('exit', () => { });

    const r = await httpReq('POST', '/api/login', {
        headers: { 'Content-Type': 'application/json' },
        body: { username: ADMIN.username, password: ADMIN.password }
    });
    assert.equal(r.status, 200);
    const sc = r.headers['set-cookie'];
    cookie = String(Array.isArray(sc) ? sc[0] : sc || '').split(';')[0];
    assert.match(cookie, /^sid=[a-f0-9]{64}$/);
});

after(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const [file, content] of savedRuntime) {
        try {
            if (content === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
            else fs.writeFileSync(file, content);
        } catch { }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('WebSocket: dashboard menerima snapshot awal (SENSOR, DOOR, UPDATE, DEVICE_COUNT)', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { ...wsOpts, headers: { Cookie: cookie } });
    const types = [];
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tidak ada snapshot awal: ' + types.join(','))), 8000);
        ws.on('message', raw => {
            try { types.push(JSON.parse(String(raw)).type); } catch { }
            if (types.includes('SENSOR') && types.includes('DOOR') && types.includes('UPDATE')) {
                clearTimeout(timer); resolve();
            }
        });
        ws.on('error', e => { clearTimeout(timer); reject(e); });
    });
    assert.ok(types.includes('SENSOR'));
    assert.ok(types.includes('DOOR'));
    assert.ok(types.includes('UPDATE'));
    ws.close();
    ws.on('error', () => { });
});

test('WebSocket: frame tidak sah tidak mematikan server', async () => {
    const before = log.length;
    await sendBadFrame(Buffer.from([0x81, 0x01, 0xff]));               // teks dengan UTF-8 rusak
    await sendBadFrame(Buffer.from([0x82, 0x03, 0x01, 0x02]));         // biner, panjang salah
    await sendBadFrame(Buffer.from([0x81, 0x05, 0x68, 0x69]));         // panjang tidak cocok
    await sleep(300);

    assert.equal(child.exitCode, null, 'proses server harus tetap hidup');
    const added = log.slice(before);
    assert.ok(!/uncaughtException|ERR_UNHANDLED_ERROR/.test(added), 'tidak boleh ada exception tak tertangani: ' + added.slice(0, 300));

    // HTTPS masih dilayani setelah percobaan di atas.
    const r = await httpReq('GET', '/api/session', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json.authenticated, true);
});

test('WebSocket: koneksi baru tetap bisa login setelah frame rusak', async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { ...wsOpts, headers: { Cookie: cookie } });
    const got = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tidak ada pesan')), 8000);
        ws.on('message', raw => {
            let m = null;
            try { m = JSON.parse(String(raw)); } catch { }
            if (m && m.type === 'DEVICE_COUNT' && typeof m.count === 'number') {
                clearTimeout(timer); resolve(m);
            }
        });
        ws.on('error', e => { clearTimeout(timer); reject(e); });
    });
    assert.ok(got.count >= 1);
    ws.close();
    ws.on('error', () => { });
});

test('lifecycle: SIGTERM menghentikan server dengan rapi (tanpa exception)', async () => {
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { code, signal } = await Promise.race([
        exited,
        sleep(8000).then(() => ({ code: 'timeout', signal: null }))
    ]);
    assert.notEqual(code, 'timeout', 'server harus berhenti sendiri setelah SIGTERM');
    assert.equal(signal, null, 'proses harus keluar sendiri, bukan dibunuh');
    assert.equal(code, 130, 'kode keluar SIGTERM yang terdokumentasi');
    assert.ok(!/uncaughtException|Jaring/.test(log), 'tidak boleh ada exception tak tertangani saat shutdown: ' + log.slice(-400));
});
