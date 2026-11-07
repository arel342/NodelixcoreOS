// ============================================================================
// tests/api-gate.test.js — server.js SUNGGUHAN (proses anak, port acak):
// gerbang autentikasi /api bersifat deny-by-default.
//
// Bug yang diperbaiki: server.js memakai daftar rute terlindungi yang ditulis manual
// (app.use(['/api/files', ...], requireAuth)). Endpoint /api yang tidak ada di daftar
// itu — termasuk rute baru yang ditambahkan kemudian — otomatis dapat diakses tanpa
// login. Sekarang hanya PUBLIC_API yang terbuka; sisanya wajib sesi sah.
//
// Tanpa perangkat keras, tanpa jaringan luar.
// ============================================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = { username: 'admin', password: 'api-gate-test-123' };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-gate-'));
const storageDir = path.join(tmpRoot, 'storage');
fs.mkdirSync(path.join(storageDir, 'upload'), { recursive: true });

// Hasilkan CA + sertifikat server di temp dir sebelum server di-spawn.
const { ensureCertificates } = require(path.join(ROOT, 'gen-certs'));
const certResult = ensureCertificates({ dataDir: tmpRoot, quiet: true });
const caPem = fs.readFileSync(certResult.caCertFile);
const agent = new https.Agent({ ca: caPem, rejectUnauthorized: true });

// Data runtime milik server disimpan & dipulihkan agar tes tidak mengubah data pengguna.
const dataDir = path.join(ROOT, 'data');
const runtimeFiles = ['mobile-devices.json', 'mobile-sessions.json'].map(n => path.join(dataDir, n));
const savedRuntime = new Map(runtimeFiles.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));

let child = null;
let port = 0;
let cookie = '';

async function freePort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

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

// Permintaan dengan/tanpa cookie sesi; badan selalu dibaca sebagai teks lalu JSON bila bisa.
async function req(method, url, { body, withCookie = false, headers = {} } = {}) {
    const h = { ...headers };
    if (withCookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const u = new URL('https://127.0.0.1:' + port + url);
    const r = await new Promise((resolve, reject) => {
        const rq = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, agent }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', d => text += d);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(text); } catch { }
                resolve({ status: res.statusCode, json, text, headers: res.headers });
            });
        });
        rq.on('error', reject);
        if (body !== undefined) rq.write(typeof body === 'string' ? body : JSON.stringify(body));
        rq.end();
    });
    return r;
}

before(async () => {
    port = await freePort();
    child = await startServer(port);
    child.on('exit', () => { });
    const r = await req('POST', '/api/login', { body: ADMIN });
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

test('gerbang /api: endpoint data tanpa sesi ditolak 401 (JSON, bukan HTML)', async () => {
    for (const url of ['/api/system', '/api/files?dir=', '/api/settings', '/api/door/status', '/api/esp32/status',
        '/api/terminal/info', '/api/storage/status', '/api/ai/status']) {
        const r = await req('GET', url);
        assert.equal(r.status, 401, url + ' harus 401 tanpa login');
        assert.equal(r.json && r.json.success, false, url + ' harus mengembalikan JSON { success:false }');
    }
});

test('gerbang /api: rute yang belum terdaftar pun tidak terbuka tanpa login', async () => {
    // Sebelum perbaikan, endpoint baru/asing lolos gerbang dan hanya dijawab 404.
    const anon = await req('GET', '/api/rute-yang-belum-ada');
    assert.equal(anon.status, 401, 'endpoint asing harus 401 untuk pengunjung tanpa sesi');

    const authed = await req('GET', '/api/rute-yang-belum-ada', { withCookie: true });
    assert.equal(authed.status, 404, 'setelah login, endpoint asing dijawab 404 JSON');
    assert.equal(authed.json.success, false);
});

test('gerbang /api: /uploads juga wajib login', async () => {
    const r = await req('GET', '/uploads/berkas-tidak-ada.txt');
    assert.equal(r.status, 401);
});

test('gerbang /api: endpoint publik tetap terbuka (bahasa, sesi, mobile, setup)', async () => {
    const lang = await req('GET', '/api/settings/lang');
    assert.equal(lang.status, 200);
    assert.ok(['id', 'en', 'zh'].includes(lang.json.lang));

    const sesi = await req('GET', '/api/session');
    assert.equal(sesi.status, 200);
    assert.equal(sesi.json.authenticated, false);

    const setup = await req('GET', '/api/setup/status');
    assert.equal(setup.status, 200);

    // Route mobile tetap sampai ke handler-nya sendiri (menjawab 401 JSON, bukan halaman).
    const mobile = await req('GET', '/api/mobile/auth/session');
    assert.equal(mobile.status, 401);
    assert.equal(mobile.json.success, false);
});

test('gerbang /api: sesi sah tetap bisa memakai endpoint yang sama', async () => {
    const r = await req('GET', '/api/system', { withCookie: true });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json, 'object');

    const sesi = await req('GET', '/api/session', { withCookie: true });
    assert.equal(sesi.json.authenticated, true);
    assert.equal(sesi.json.method, 'web');
});

test('gerbang /api: token di URL tetap ditolak sebelum autentikasi', async () => {
    const r = await req('GET', '/api/system?token=' + 'a'.repeat(64));
    assert.equal(r.status, 400);
    assert.equal(r.json.success, false);
});

test('gerbang /api: JSON rusak pada rute login dijawab JSON 400, bukan HTML/stack', async () => {
    const r = await req('POST', '/api/login', { body: '{"username":' });
    assert.equal(r.status, 400);
    assert.equal(r.json.success, false);
    assert.ok(!/at Object|node:internal/.test(r.text), 'tidak boleh membocorkan stack trace');
});

test('gerbang /api: logout menghapus sesi web (endpoint setelahnya kembali 401)', async () => {
    const r = await req('POST', '/api/logout', { withCookie: true, body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.success, true);
    const after = await req('GET', '/api/system', { withCookie: true });
    assert.equal(after.status, 401, 'cookie lama tidak boleh berlaku setelah logout');
});
