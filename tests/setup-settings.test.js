// Isolated tests: tanpa perangkat keras, tanpa server berjalan, tanpa menulis .env asli.
// Modul settings.js & setup.js dijalankan di vm dengan app (Express palsu), saveEnv palsu,
// dan fetch palsu supaya alur pengaturan lewat web + setup awal bisa diuji.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');

const response = () => ({
    code: 200, body: null, headers: {},
    status(n) { this.code = n; return this; },
    json(j) { this.body = j; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; }
});

// App Express palsu: mencatat route GET/POST supaya bisa dipanggil langsung dari test
function fakeApp(routes) {
    return {
        get: (u, f) => { routes['GET ' + u] = f; },
        post: (u, f) => { routes['POST ' + u] = f; },
        use: () => { }
    };
}

function load(file, deps, env, fetchImpl) {
    const routes = {};
    const ctx = {
        module: { exports: {} }, __dirname: root, console,
        require: n => n === './lang' ? T : require(n),
        process: { env: { LANGUAGE: 'id', ...env }, uptime: () => 123 },
        AbortSignal, setTimeout, clearTimeout, FormData, Blob,
        fetch: fetchImpl || (async () => { throw new Error('fetch tidak diizinkan di test ini'); })
    };
    vm.runInNewContext(source(file), ctx);
    const factory = ctx.module.exports;
    const api = factory({ app: fakeApp(routes), ...deps });
    return {
        mod: factory, api, routes,
        async get(url, req = {}) { const res = response(); await routes['GET ' + url](req, res); return res; },
        async post(url, req = {}) { const res = response(); await routes['POST ' + url](req, res); return res; }
    };
}

// ---------- settings.js ----------
function settingsFixture(env = {}, fetchImpl) {
    const writes = {}, calls = { esp32: 0, door: 0, telegram: 0 };
    const auth = { verify: () => true, keepOnly: () => { }, isAuthed: () => true, createSession: () => 'sid' };
    const f = load('settings.js', {
        saveEnv: (k, v) => { writes[k] = v; },
        esp32: { reload: () => { calls.esp32++; } },
        door: { reload: () => { calls.door++; } },
        telegram: { restart: () => { calls.telegram++; }, test: async () => ({ ok: true }) },
        auth
    }, env, fetchImpl);
    return { ...f, writes, calls };
}

test('settings: GET /api/settings mengembalikan nilai bawaan', async () => {
    const s = settingsFixture();
    const res = await s.get('/api/settings');
    assert.equal(res.code, 200);
    assert.equal(res.body.esp32.port, 80);
    assert.equal(res.body.door.enrollSec, 30);
    assert.equal(res.body.telegram.alerts, true);
    assert.equal(res.body.server.port, 3000);
    assert.equal(res.body.monitor.iWarn, 5);
    assert.equal(res.body.info.setupRequired, true);      // ADMIN_PASSWORD belum diisi
});

test('settings: POST /api/settings menolak alamat/port/kunci/nilai yang tidak valid', async () => {
    const s = settingsFixture();
    const cases = [
        [{ esp32: { ip: '192.168.1.50/24' } }, 'set.badIp'],
        [{ door: { port: 99999 } }, 'set.badPort'],
        [{ esp32: { apiKey: 'kunci dengan spasi' } }, 'set.badKey'],
        [{ monitor: { iWarn: 999 } }, 'set.badNum'],
        [{ telegram: { chatId: 'bukan-angka' } }, 'set.badChat'],
        [{ esp32: { labels: 'baris\nbaru' } }, 'set.badText']
    ];
    for (const [body, key] of cases) {
        const res = await s.post('/api/settings', { body });
        assert.equal(res.code, 400, JSON.stringify(body));
        assert.ok(res.body.message.length > 0);
        assert.equal(res.body.success, false);
    }
    assert.deepEqual(s.writes, {}, 'tidak boleh ada yang tersimpan saat validasi gagal');
    assert.equal(s.calls.esp32 + s.calls.door + s.calls.telegram, 0);
});

test('settings: POST /api/settings menyimpan nilai valid dan memuat ulang modul terkait', async () => {
    const s = settingsFixture();
    const res = await s.post('/api/settings', {
        body: {
            esp32: { ip: '192.168.1.50', port: 80, apiKey: 'nlx-esp32', pollMs: 1500, labels: 'Relay 1, Relay 3' },
            door: { ip: '192.168.1.60', port: 81, apiKey: 'nlx-door', enrollSec: 45, pollMs: 800, notifyOpen: true, notifyUnknown: true },
            telegram: { alerts: true, token: '123456:AAF-abcdefghijklmnopqrstuvwxyz', chatId: '-1001234567890' },
            monitor: { iWarn: 7.5 }
        }
    });
    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.equal(s.writes.ESP32_IP, '192.168.1.50');
    assert.equal(s.writes.ESP32_POLL_MS, '1500');
    assert.equal(s.writes.ESP32_PORT, undefined, 'nilai yang tidak berubah tidak ditulis ulang');
    assert.equal(s.writes.DOOR_PORT, '81');
    assert.equal(s.writes.DOOR_ENROLL_SECONDS, '45');
    assert.equal(s.writes.DOOR_NOTIFY_OPEN, 'true');
    assert.equal(s.writes.TELEGRAM_CHAT_ID, '-1001234567890');
    assert.equal(s.writes.I_WARN_A, '7.5');
    assert.equal(s.calls.esp32, 1);
    assert.equal(s.calls.door, 1);
    assert.equal(s.calls.telegram, 1);
});

test('settings: IP perangkat boleh dikosongkan (perangkat dinonaktifkan)', async () => {
    const s = settingsFixture({ ESP32_IP: '192.168.1.50' });
    const res = await s.post('/api/settings', { body: { esp32: { ip: '' } } });
    assert.equal(res.code, 200);
    assert.equal(s.writes.ESP32_IP, '', 'mengosongkan IP = perangkat tidak dipantau');
    assert.equal(s.calls.esp32, 1);
});

test('settings: POST /api/settings/account menolak tanpa password lama dan tanpa konfirmasi', async () => {
    // password lama salah -> auth.verify mengirim 403 sendiri, tidak ada yang tersimpan
    const denied = settingsFixture({ ADMIN_PASSWORD: 'rahasia123', ADMIN_USERNAME: 'admin' }, null);
    denied.api && null;
    const s = settingsFixture({ ADMIN_PASSWORD: 'rahasia123', ADMIN_USERNAME: 'admin' });

    // password benar tapi password baru terlalu pendek
    const res = await s.post('/api/settings/account', { body: { password: 'rahasia123', username: 'admin', newPassword: 'pendek', confirmPassword: 'pendek' } });
    assert.equal(res.code, 400);
    assert.equal(s.writes.ADMIN_PASSWORD, undefined);

    // password baru tidak sama dengan konfirmasi
    const res2 = await s.post('/api/settings/account', { body: { password: 'rahasia123', username: 'admin', newPassword: 'rahasia456', confirmPassword: 'rahasia789' } });
    assert.equal(res2.code, 400);
    assert.equal(s.writes.ADMIN_PASSWORD, undefined);

    // username baru saja (password tidak diganti)
    const res3 = await s.post('/api/settings/account', { body: { password: 'rahasia123', username: 'arel', newPassword: '', confirmPassword: '' } });
    assert.equal(res3.code, 200);
    assert.equal(s.writes.ADMIN_USERNAME, 'arel');
    assert.equal(s.writes.ADMIN_PASSWORD, undefined, 'password lama tidak ditulis ulang');
});

test('settings: push ke ESP memakai kunci perangkat dan menerjemahkan 401', async () => {
    const env = { ESP32_IP: 'esp32.test', ESP32_PORT: '80', ESP32_API_KEY: 'nlx-baru' };
    const seen = [];
    const s = settingsFixture(env, async (url, opt) => {
        seen.push({ url, opt });
        return { ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) };
    });
    const res = await s.post('/api/settings/device/push', { body: { device: 'esp32', deviceKey: 'nlx-lama', ssid: 'Rumah', pass: 'rahasia-wifi' } });
    assert.equal(res.code, 502);
    assert.equal(seen[0].url, 'http://esp32.test:80/api/config');
    assert.equal(seen[0].opt.headers['X-API-Key'], 'nlx-lama');       // kunci yang masih ada di perangkat
    assert.equal(JSON.parse(seen[0].opt.body).api_key, undefined);   // kunci baru tidak dikirim kalau kosong
    assert.match(res.body.message, /kunci/i);
});

test('settings: push IP statis memerlukan IPv4 yang benar', async () => {
    const env = { DOOR_IP: 'door.test', DOOR_API_KEY: 'nlx-door' };
    const s = settingsFixture(env, async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const bad = await s.post('/api/settings/device/push', { body: { device: 'esp8266', dhcp: false, ip: '999.1.1.1', gw: '192.168.1.1', mask: '255.255.255.0' } });
    assert.equal(bad.code, 400);
    const ok = await s.post('/api/settings/device/push', { body: { device: 'esp8266', dhcp: false, ip: '192.168.1.60', gw: '192.168.1.1', mask: '255.255.255.0', openSec: 7 } });
    assert.equal(ok.code, 200);
    assert.equal(ok.body.success, true);
});

// ---------- setup.js ----------
function setupFixture(env = {}, auth = {}) {
    const writes = {}, sessions = [];
    const calls = { devices: 0, welcome: 0 };
    const A = {
        isAuthed: () => false, createSession: res => { sessions.push(res); return 'sid-baru'; },
        verify: () => true, keepOnly: () => { }, ...auth
    };
    const settings = { snapshot: () => ({ esp32: { ip: '', port: 80, apiKey: '' }, door: { ip: '', port: 80, apiKey: '', enrollSec: 30 }, telegram: { alerts: true, token: '', chatId: '' }, monitor: {}, server: {}, info: { port: 3000, ips: ['192.168.1.20'], lang: 'id', version: '1.0.0', node: 'v22', envFile: '.env', username: 'admin', setupDone: false, setupRequired: true } }), apply: () => ({ changed: [] }) };
    const f = load('setup.js', {
        saveEnv: (k, v) => { writes[k] = v; },
        settings,
        esp32: { reload: () => { } }, door: { reload: () => { } },
        telegram: { restart: () => { }, welcome: async () => { calls.welcome++; return true; } },
        auth: A,
        startDevices: () => { calls.devices++; }
    }, env);
    return { ...f, writes, calls, sessions };
}

test('setup: status terbuka sebelum ada akun, akun baru langsung membuat sesi', async () => {
    const s = setupFixture();
    const st = await s.get('/api/setup/status', { headers: {}, path: '/api/setup/status' });
    assert.equal(st.body.required, true);
    assert.equal(st.body.authed, false);

    const bad = await s.post('/api/setup/account', { body: { username: 'admin', password: 'pendek', confirmPassword: 'pendek' } });
    assert.equal(bad.code, 400);
    const bad2 = await s.post('/api/setup/account', { body: { username: 'a b', password: 'rahasia123', confirmPassword: 'rahasia123' } });
    assert.equal(bad2.code, 400);
    const bad3 = await s.post('/api/setup/account', { body: { username: 'admin', password: 'rahasia123', confirmPassword: 'rahasia124' } });
    assert.equal(bad3.code, 400);

    const res = await s.post('/api/setup/account', { body: { username: 'admin', password: 'rahasia123', confirmPassword: 'rahasia123' } });
    assert.equal(res.code, 200);
    assert.equal(s.writes.ADMIN_USERNAME, 'admin');
    assert.equal(s.writes.ADMIN_PASSWORD, 'rahasia123');
    assert.equal(s.sessions.length, 1, 'langkah berikutnya harus terautentikasi lewat sesi ini');
});

test('setup: selesai hanya boleh setelah akun ada, lalu mengaktifkan layanan perangkat', async () => {
    const s = setupFixture();
    const no = await s.post('/api/setup/finish', { body: {} });
    assert.equal(no.code, 400);

    const s2 = setupFixture({ ADMIN_PASSWORD: 'rahasia123', ADMIN_USERNAME: 'admin' }, { isAuthed: () => true });
    const res = await s2.post('/api/setup/finish', { body: {} });
    assert.equal(res.code, 200);
    assert.equal(res.body.redirect, '/');
    assert.equal(s2.writes.SETUP_DONE, '1');
    assert.equal(s2.calls.devices, 1);
    assert.equal(s2.calls.welcome, 1);
    assert.equal(s2.sessions.length, 1, 'setelah selesai admin langsung login');
});

test('setup: sudah selesai + belum login -> API setup ditolak', async () => {
    const s = setupFixture({ ADMIN_PASSWORD: 'rahasia123' }, { isAuthed: () => false });
    const res = await s.post('/api/setup/device', { body: { device: 'esp32', ip: '192.168.1.50', port: 80, apiKey: 'nlx-esp32' } });
    assert.equal(res.code, 403);
    assert.equal(s.writes.ESP32_IP, undefined);

    const s2 = setupFixture({ ADMIN_PASSWORD: 'rahasia123' }, { isAuthed: () => true });
    const ok = await s2.post('/api/setup/device', { body: { device: 'esp32', ip: '192.168.1.50', port: 80, apiKey: 'nlx-esp32' } });
    assert.equal(ok.code, 200);
});

test('setup: nilai ESP32/ESP8266 yang tidak valid ditolak dengan pesan jelas', async () => {
    const s = setupFixture({}, { isAuthed: () => true });
    // settings.apply asli dari settings.js dipakai supaya validasi ikut teruji
    const real = settingsFixture({});
    const bad = await real.post('/api/settings', { body: { esp32: { ip: 'bukan ip!' } } });
    assert.equal(bad.code, 400);
    assert.ok(bad.body.message.includes('ESP32_IP'));
    const s2 = setupFixture({});
    const res = await s2.post('/api/setup/device', { body: { device: 'tidak-ada', ip: '192.168.1.50' } });
    assert.equal(res.code, 400);
    assert.equal(s2.writes.ESP32_IP, undefined);
    assert.ok(s);
});
