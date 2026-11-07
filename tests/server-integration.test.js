// ============================================================================
// tests/server-integration.test.js — server.js SUNGGUHAN (proses anak) di port acak.
// SEMUA TRAFIK HTTPS/WSS (TLS aktif). CA swasta dihasilkan di temp dir dan
// dikonfidensi ke client test via https.Agent({ca}) / ws({ca}).
//
// Menguji hal yang hanya bisa dibuktikan saat seluruh server berjalan:
//   • login web lama -> cookie `sid` -> API data
//   • API tanpa sesi -> 401, Bearer mobile di endpoint lama -> 200
//   • register + challenge + verify ECDSA -> semua endpoint REST
//   • file manager (folder, daftar, rename, hapus) di folder sementara
//   • ESP32/ESP8266 (snapshot offline, validasi perintah relay) & firmware OTA (tolak file salah)
//   • WebSocket (WSS): cookie & Bearer diterima, tanpa kredensial 401
//   • restart proses: sesi Bearer tetap berlaku
//
// Lingkungan: tanpa perangkat keras, tanpa `su` (SU_BIN=/bin/sh), tanpa jaringan luar.
// ============================================================================
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('https');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = { username: 'admin', password: 'integrasi-test-123' };
const DEVICE_ID = 'ndlx-int-0123456789abcdef';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-int-'));
const storageDir = path.join(tmpRoot, 'storage');
fs.mkdirSync(path.join(storageDir, 'upload'), { recursive: true });

// Hasilkan CA + sertifikat server di temp dir sebelum server di-spawn, agar
// client test (https.request/ws) dan server memakai CA yang sama.
const { ensureCertificates } = require(path.join(ROOT, 'gen-certs'));
const certResult = ensureCertificates({ dataDir: tmpRoot, quiet: true });
const caPem = fs.readFileSync(certResult.caCertFile);

// Berkas data milik server.js (data/mobile-*.json). Disimpan/dipulihkan agar
// menjalankan tes tidak mengubah data pengguna yang sudah ada.
const dataDir = path.join(ROOT, 'data');
const runtimeFiles = ['mobile-devices.json', 'mobile-sessions.json'].map(n => path.join(dataDir, n));
const savedRuntime = new Map(runtimeFiles.map(f => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));

let child = null;
let port = 0;
let base = '';
let wsOpts = {};

const agent = new https.Agent({ ca: caPem, rejectUnauthorized: true });

function rawRequest(p, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL('https://127.0.0.1:' + port + p);
        const rq = https.request({
            hostname: u.hostname, port: u.port,
            path: u.pathname + u.search, method, headers, agent
        }, res => {
            let data = ''; res.setEncoding('utf8'); res.on('data', d => data += d);
            res.on('end', () => {
                let json = null; try { json = JSON.parse(data); } catch { }
                const hdrs = {};
                for (const [k, v] of Object.entries(res.headers)) hdrs[k.toLowerCase()] = v;
                resolve({
                    status: res.statusCode, body: json, raw: data,
                    headers: { get: (k) => hdrs[k.toLowerCase()] ?? null }
                });
            });
        });
        rq.on('error', reject);
        if (body !== undefined && body !== null) rq.write(body);
        rq.end();
    });
}
const req = (p, opts = {}) => rawRequest(p, opts);
const post = (p, body, headers = {}) => rawRequest(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body || {}) : undefined
});
const bearer = t => ({ Authorization: `Bearer ${t}` });

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
                DOOR_IP: '',
                ESP32_IP: ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new Error('server tidak siap: ' + out.slice(-600))); }, 25000);
        const onData = d => {
            out += String(d);
            if (/Server aktif|Setup awal/.test(out) || /Penyimpanan\s*:/.test(out)) {
                clearTimeout(timer);
                resolve(c);
            }
        };
        c.stdout.on('data', onData);
        c.stderr.on('data', d => { out += String(d); });
        c.on('exit', code => { clearTimeout(timer); reject(new Error(`server keluar (${code}): ${out.slice(-600)}`)); });
    });
}

async function waitReady() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await rawRequest('/api/session');
            if (r.status === 200) return true;
        } catch { }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('API /api/session tidak merespons');
}

async function stopServer(c) {
    if (!c || c.exitCode !== null) return;
    const done = new Promise(resolve => c.once('exit', resolve));
    c.kill('SIGTERM');
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { } }, 5000);
    await done;
    clearTimeout(timer);
}

async function boot() {
    for (let attempt = 0; attempt < 5; attempt++) {
        port = 20000 + Math.floor(Math.random() * 20000);
        child = await startServer(port);
        base = `https://127.0.0.1:${port}`;
        wsOpts = { ca: caPem, rejectUnauthorized: true };
        try { await waitReady(); return; }
        catch (e) { await stopServer(child); if (attempt === 4) throw e; }
    }
}

// Kunci perangkat + alur ECDSA lengkap (kanonik sama dengan aplikasi Android).
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const canonical = (id, chId, nonce, ts, origin) =>
    ['NODELIXCOREOS-AUTH-V1', id, chId, nonce, String(ts), origin.trim().replace(/\/+$/, '').toLowerCase()].join('|');

async function mobileLogin() {
    const reg = await post('/api/mobile/auth/register', {
        username: ADMIN.username,
        password: ADMIN.password,
        deviceId: DEVICE_ID,
        deviceName: 'Integration Phone',
        androidVersion: 'Android 15',
        appVersion: '1.0.0',
        publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
    });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const ch = await post('/api/mobile/auth/challenge', { deviceId: DEVICE_ID });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const ts = Date.now();
    const sig = crypto.sign('sha256', Buffer.from(canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, base), 'utf8'), privateKeyOpts())
        .toString('base64');
    const ver = await post('/api/mobile/auth/verify', { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: sig });
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
    return ver.body.sessionToken;
}

function privateKeyOpts() {
    return { key: pair.privateKey, dsaEncoding: 'der' };
}

before(async () => { await boot(); });

after(async () => {
    await stopServer(child);
    // Pulihkan berkas data agar tidak mengubah instalasi pengguna.
    for (const [file, content] of savedRuntime) {
        try {
            if (content === null) fs.rmSync(file, { force: true });
            else fs.writeFileSync(file, content);
        } catch { }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('integrasi: server.js berjalan HTTPS dan API tanpa sesi ditolak 401 JSON', async () => {
    const s = await req('/api/session');
    assert.equal(s.status, 200);
    assert.equal(s.body.authenticated, false);
    assert.ok(s.headers.get('strict-transport-security'), 'HSTS harus ada');

    for (const p of ['/api/system', '/api/files', '/api/esp32/status', '/api/door/status', '/api/firmware']) {
        const r = await req(p);
        assert.equal(r.status, 401, p);
        assert.equal(r.body.success, false, p);
    }
    const headers = (await req('/api/system')).headers;
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!headers.get('x-powered-by'));
});

test('integrasi: login web lama + cookie sid tetap berfungsi', async () => {
    const bad = await post('/api/login', { username: 'admin', password: 'salah' });
    assert.equal(bad.status, 401);
    const ok = await post('/api/login', ADMIN);
    assert.equal(ok.status, 200);
    const cookie = String(ok.headers.get('set-cookie')).split(';')[0];
    assert.match(cookie, /^sid=[a-f0-9]{64}$/);
    const r = await req('/api/system', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.ok(r.body.now);
    const session = await req('/api/session', { headers: { Cookie: cookie } });
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.method, 'web');
});

test('integrasi: CSRF — Origin lintas situs ditolak, same-origin & Bearer diizinkan', async () => {
    const login = await post('/api/login', ADMIN);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];

    const cross = await req('/api/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'http://evil.example' },
        body: JSON.stringify({ dir: '', folderName: 'csrf' })
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.success, false);

    const same = await req('/api/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base },
        body: JSON.stringify({ dir: '', folderName: 'csrf-ok' })
    });
    assert.equal(same.status, 200);
    await req('/api/files?path=csrf-ok', { method: 'DELETE', headers: { Cookie: cookie } });

    const token = await mobileLogin();
    const bearerCross = await req('/api/create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: 'http://evil.example' },
        body: JSON.stringify({ dir: '', folderName: 'csrf-bearer' })
    });
    assert.equal(bearerCross.status, 200, 'Bearer tidak rentan CSRF');
    await req('/api/files?path=csrf-bearer', { method: 'DELETE', headers: { Cookie: cookie } });
});

test('integrasi: file manager (folder, daftar, rename, hapus) berjalan di storage', async () => {
    const login = await post('/api/login', ADMIN);
    const cookie = { Cookie: String(login.headers.get('set-cookie')).split(';')[0] };
    const st = await req('/api/storage/status', { headers: cookie });
    assert.equal(st.status, 200);
    assert.equal(st.body.ready, true);

    assert.equal((await post('/api/create-folder', { dir: '', folderName: 'integrasi' }, cookie)).status, 200);
    assert.equal((await post('/api/create-folder', { dir: 'integrasi', folderName: '..' }, cookie)).status, 400);
    const list = await req('/api/files?dir=', { headers: cookie });
    assert.ok(list.body.files.some(f => f.name === 'integrasi' && f.isDirectory === true));
    assert.equal((await post('/api/rename', { dir: '', oldName: 'integrasi', newName: 'integrasi2' }, cookie)).status, 200);
    assert.ok((await req('/api/files?dir=', { headers: cookie })).body.files.some(f => f.name === 'integrasi2'));
    assert.equal((await req('/api/files?path=integrasi2', { method: 'DELETE', headers: cookie })).status, 200);
    assert.ok(!(await req('/api/files?dir=', { headers: cookie })).body.files.some(f => f.name === 'integrasi2'));
    // Path traversal tidak boleh keluar folder penyimpanan.
    const escape = await req('/api/files?dir=../../etc', { headers: cookie });
    assert.ok([400, 403, 404, 500].includes(escape.status), 'traversal harus gagal: ' + escape.status);
});

test('integrasi: ESP32/ESP8266 snapshot + validasi relay, firmware OTA menolak file salah', async () => {
    const login = await post('/api/login', ADMIN);
    const cookie = { Cookie: String(login.headers.get('set-cookie')).split(';')[0] };

    const esp = await req('/api/esp32/status', { headers: cookie });
    assert.equal(esp.status, 200);
    assert.equal(typeof esp.body.online, 'boolean');
    assert.ok(Array.isArray(esp.body.relays) || esp.body.relays === null || typeof esp.body.relays === 'object');

    const badRelay = await post('/api/esp32/relay', { id: 'tidak-ada', state: true }, cookie);
    assert.equal(badRelay.status, 400);
    assert.equal(badRelay.body.success, false);

    const door = await req('/api/door/status', { headers: cookie });
    assert.equal(door.status, 200);
    assert.equal(door.body.configured, false);
    assert.ok(Array.isArray(door.body.cards));

    const fw = await req('/api/firmware', { headers: cookie });
    assert.equal(fw.status, 200);
    assert.deepEqual(fw.body.devices.map(d => d.key).sort(), ['esp32', 'esp8266']);

    // Flash tanpa file -> 400 (bukan crash), dengan `success:false` untuk aplikasi mobile.
    const boundary = '----nodelixinttest';
    const flashBody = '--' + boundary + '\r\n--\r\n';
    const noFile = await req('/api/firmware/flash', {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: flashBody
    });
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.success, false);
});

test('integrasi: ECDSA mobile -> Bearer berlaku di seluruh API lama', async () => {
    const token = await mobileLogin();
    assert.match(token, /^[a-f0-9]{64}$/);

    for (const p of ['/api/system', '/api/settings', '/api/files?dir=', '/api/storage/status', '/api/esp32/status', '/api/door/status', '/api/firmware', '/api/update/status']) {
        const r = await req(p, { headers: bearer(token) });
        assert.equal(r.status, 200, p);
    }
    const ses = await req('/api/mobile/auth/session', { headers: bearer(token) });
    assert.equal(ses.body.authenticated, true);
    assert.equal(ses.body.deviceId, DEVICE_ID);
    assert.equal(ses.body.deviceStatus, 'ACTIVE');

    // Token tidak boleh lewat query string.
    const q = await req('/api/system?token=' + token);
    assert.equal(q.status, 400);
});

test('integrasi: WebSocket (WSS) menerima cookie & Bearer, menolak tanpa kredensial', async () => {
    const anon = await new Promise(resolve => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, wsOpts);
        ws.on('unexpected-response', (_, r) => resolve(r.statusCode));
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('error', () => resolve('error'));
    });
    assert.equal(anon, 401);

    const token = await mobileLogin();
    const frames = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ...wsOpts, headers: bearer(token) });
        const seen = new Set();
        ws.on('message', m => {
            const f = JSON.parse(String(m));
            seen.add(f.type);
            if (seen.has('SENSOR') && seen.has('DOOR') && seen.has('DEVICE_COUNT')) { ws.close(); resolve([...seen]); }
        });
        ws.on('error', reject);
        setTimeout(() => { try { ws.close(); } catch { } resolve([...seen]); }, 5000);
    });
    assert.ok(frames.includes('SENSOR'));
    assert.ok(frames.includes('DOOR'));
    assert.ok(frames.includes('DEVICE_COUNT'));

    const login = await post('/api/login', ADMIN);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];
    const withCookie = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ...wsOpts, headers: { Cookie: cookie } });
        ws.on('message', m => { ws.close(); resolve(JSON.parse(String(m)).type); });
        ws.on('error', reject);
    });
    assert.ok(['SENSOR', 'DOOR', 'DEVICE_COUNT', 'UPDATE', 'SYSTEM'].includes(withCookie));
});

test('integrasi: monitor CPU/RAM berjalan — dashboard menerima SYSTEM berisi angka', async () => {
    const login = await post('/api/login', ADMIN);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];
    const frame = await new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, { ...wsOpts, headers: { Cookie: cookie } });
        ws.on('message', m => {
            const f = JSON.parse(String(m));
            if (f.type === 'SYSTEM' && f.data && f.data.cpu != null && f.data.ram) { ws.close(); resolve(f.data); }
        });
        ws.on('error', reject);
        setTimeout(() => { try { ws.close(); } catch { } resolve(null); }, 6000);
    });
    assert.ok(frame, 'pesan SYSTEM dengan CPU & RAM harus diterima (bukan N/A)');
    assert.ok(frame.cpu >= 0 && frame.cpu <= 100, 'cpu ' + frame.cpu);
    assert.ok(frame.ram.total > 0 && frame.ram.pct >= 0 && frame.ram.pct <= 100);
    assert.ok(frame.cores > 0);
    const api = await req('/api/system', { headers: { Cookie: cookie } });
    assert.equal(api.status, 200);
    assert.ok(api.body.snapshot && typeof api.body.snapshot.cpu === 'number');
    assert.ok(api.body.history.length >= 1);
});

test('integrasi: server.js meneruskan semua fungsi auth yang dipakai settings.js & setup.js', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const m = /const authDeps = \{([\s\S]*?)\n\};/.exec(server) || /const authDeps = \{([^}]*)\}/.exec(server);
    assert.ok(m, 'authDeps ditemukan');
    const keys = new Set([...m[1].matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/gm)].map(x => x[1]));
    for (const file of ['settings.js', 'setup.js', 'ai.js']) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const [, fn] of src.matchAll(/\bauth\.([A-Za-z_$][\w$]*)\s*\(/g)) {
            assert.ok(keys.has(fn), `${file} memanggil auth.${fn}() tetapi server.js tidak meneruskannya`);
        }
    }
});

test('integrasi: restart server -> Bearer tetap berlaku, cookie web lama tidak', async () => {
    const token = await mobileLogin();
    const login = await post('/api/login', ADMIN);
    const cookie = String(login.headers.get('set-cookie')).split(';')[0];

    await stopServer(child);
    child = await startServer(port);
    await waitReady();

    const r = await req('/api/system', { headers: bearer(token) });
    assert.equal(r.status, 200, 'sesi mobile harus bertahan setelah restart');

    const c = await req('/api/system', { headers: { Cookie: cookie } });
    assert.equal(c.status, 401, 'sesi web memang hanya di memori (perilaku lama, didokumentasikan)');

    // Login ulang dashboard tetap memungkinkan.
    const again = await post('/api/login', ADMIN);
    assert.equal(again.status, 200);
});
