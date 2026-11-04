// ============================================================================
// tests/server-bugfix.test.js — regresi untuk bug yang diperbaiki pada audit
// "bug fix & stabilization" (lihat docs/SERVER_BUG_AUDIT.md).
//
// Semua tes di sini berjalan TANPA perangkat keras, tanpa jaringan luar, dan tanpa
// menyentuh data pengguna (folder sementara):
//   • ESP32: payload rusak tidak boleh membuat perangkat dianggap offline
//   • ESP32: perintah relay hanya sukses setelah dikonfirmasi perangkat
//   • ESP32: reload/start berulang tidak menggandakan rantai polling
//   • ESP8266: payload status rusak & perintah tanpa konfirmasi ditangani
//   • ESP8266: /api/door/config melaporkan `synced` (tidak mengklaim sinkron)
//   • auth: jumlah sesi per perangkat dibatasi
//   • updater: repo yang lebih baru dari origin BUKAN "update tersedia"
//   • setup: kunci API/token tidak pernah dikirim ke pengunjung yang belum login
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');
const fwstate = require('../fwstate');
const createAuth = require('../auth');
const createUpdater = require('../updater');
const createSetup = require('../setup');

const envFrom = obj => (k, d) => (obj[k] === undefined || obj[k] === '' ? d : obj[k]);
const tick = () => new Promise(r => setImmediate(r));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-bugfix-'));

const response = () => ({
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(j) { this.body = j; return this; },
    setHeader() { }
});

// ---------------------------------------------------------------------------
// Harness ESP32 (esp32.js dimuat di konteks terpisah, waktu & fetch dikendalikan tes)
// ---------------------------------------------------------------------------
function esp32Fixture({ env = {}, data, relay } = {}) {
    const routes = {}, requests = [], timers = new Map(), messages = [];
    let timerId = 0;
    const dataOf = typeof data === 'function' ? data : () => (data || {
        ok: true, device: 'esp32-plts', fw: '1.4.0', ip: '192.168.1.50', rssi: -55, uptime: 10, heap: 100000,
        battery: [{ id: 's3', pin: 39, en: 1, ratio: 4.3, mv: 2800, v: 12.04 }],
        current: { pin: 34, irms: 0.5, ipk: 0.7, clip: 0, n: 800 },
        relays: [
            { id: 1, name: 'Relay 1 & 2', pin: 26, on: 0 },
            { id: 2, name: 'Relay 3', pin: 27, on: 0 },
            { id: 3, name: 'Relay 4', pin: 32, on: 0 }
        ],
        aux: { relay: 1, on_pin: 23, off_pin: 22, on: 0, off: 1 }
    });
    const fakeFs = {
        readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        mkdirSync() { }, writeFileSync() { }, chmodSync() { }
    };
    const context = {
        module: { exports: {} }, __dirname: root,
        console: { log() { }, error() { }, warn() { } },
        AbortSignal,
        setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        require: n => n === './lang' ? T : n === './fwstate' ? fwstate : n === 'fs' ? fakeFs : n === 'path' ? path : require(n),
        process: { env: { ESP32_IP: '192.168.1.50', ESP32_PORT: '80', ESP32_API_KEY: 'kunci', LANGUAGE: 'id', TELEGRAM_ALERTS: 'false', ...env } },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            if (String(url).includes('/api/relay')) {
                const j = relay ? relay(new URL(url), requests) : { ok: true, relays: dataOf().relays };
                return { ok: true, status: 200, json: async () => j };
            }
            const d = dataOf();
            if (d instanceof Error) throw d;
            return { ok: true, status: 200, json: async () => d };
        }
    };
    vm.runInNewContext(source('esp32.js'), context);
    const app = {
        get: (u, f) => { routes['GET ' + u] = f; },
        post: (u, f) => { routes['POST ' + u] = f; }
    };
    const api = context.module.exports({ app, broadcast: m => messages.push(m), notify: () => { } });
    return {
        api, routes, requests, timers, messages,
        async post(url, body) {
            const res = response();
            await routes['POST ' + url]({ body }, res);
            for (let i = 0; i < 50 && !res.body; i++) await tick();
            return res;
        },
        pending() { return [...timers.values()]; }
    };
}

test('esp32: payload sensor tanpa kalibrasi / tanpa arus tidak membuat perangkat offline', async () => {
    // Tap "s9" tidak ada di data/calibration.json dan current null: sebelumnya ini
    // melempar TypeError di dalam ingest() sehingga perangkat dianggap offline.
    const f = esp32Fixture({
        data: () => ({
            ok: true, fw: '1.4.0', ip: '192.168.1.50', rssi: -60,
            battery: [{ id: 's9', pin: 39, en: 1, v: 3.9 }, { id: 's1', en: 1 }],
            current: null,
            relays: [{ id: 1, name: 'Relay 1 & 2', pin: 26, on: 0 }]
        })
    });
    f.api.start();
    await tick(); await tick();

    const snap = f.api.snapshot();
    assert.equal(snap.online, true, 'perangkat harus tetap online');
    assert.equal(snap.fails, 0);
    assert.equal(snap.current, null, 'arus tidak sah dilaporkan null, bukan NaN');
    assert.equal(snap.lastError, '');
});

test('esp32: kalibrasi arus nol dibatalkan bila payload tidak berisi arus sah', async () => {
    let payload = { ok: true, battery: [], current: { irms: 0.2, ipk: 0.3, clip: 0 }, relays: [] };
    const f = esp32Fixture({ data: () => payload });
    f.api.start();
    await tick(); await tick();

    const started = await f.post('/api/esp32/calibrate', { type: 'i-zero' });
    assert.equal(started.body.success, true);
    assert.equal(f.api.snapshot().zeroing, true);

    payload = { ok: true, battery: [], current: null, relays: [] };      // arus hilang
    const t = f.pending().find(x => x.fn);
    assert.ok(t, 'poll berikutnya terjadwal');
    t.fn();                                                              // satu putaran poll
    await tick(); await tick();
    assert.equal(f.api.snapshot().online, true);
    assert.equal(f.api.snapshot().zeroing, false, 'kalibrasi dibatalkan, bukan crash');
});

test('esp32: reload/start berulang tidak menggandakan rantai polling', async () => {
    const f = esp32Fixture();
    f.api.start();
    f.api.start();          // dipanggil lagi saat permintaan pertama masih berjalan
    await tick(); await tick(); await tick();

    const polls = f.pending().filter(x => x.ms === 1000);
    assert.equal(polls.length, 1, `harus tepat satu rantai polling, bukan ${polls.length}`);
    assert.equal(f.requests.filter(r => r.url.endsWith('/api/data')).length, 2);
});

test('esp32: perintah relay ditolak perangkat -> 502, status lokal tidak diklaim berubah', async () => {
    const f = esp32Fixture({
        relay: () => ({ ok: false, error: 'ch' })
    });
    f.api.start();
    await tick(); await tick();

    const r = await f.post('/api/esp32/relay', { id: 1, state: true });
    assert.equal(r.code, 502);
    assert.equal(r.body.success, false);
    assert.equal(r.body.message, T('esp.relayRejected'));
    assert.equal(f.api.snapshot().relays[0].on, false, 'relay tidak boleh tampil menyala');
});

test('esp32: relay tanpa konfirmasi status dari perangkat -> 502 (bukan sukses)', async () => {
    const f = esp32Fixture({
        // Balasan HTTP 200 tetapi daftar relay tidak menunjukkan perubahan.
        relay: () => ({ ok: true, relays: [
            { id: 1, name: 'Relay 1 & 2', pin: 26, on: 0 },
            { id: 2, name: 'Relay 3', pin: 27, on: 0 },
            { id: 3, name: 'Relay 4', pin: 32, on: 0 }
        ] })
    });
    f.api.start();
    await tick(); await tick();

    const r = await f.post('/api/esp32/relay', { id: 1, state: true });
    assert.equal(r.code, 502);
    assert.equal(r.body.message, T('esp.relayNoConfirm'));
    assert.equal(f.api.snapshot().relays[0].on, false);
});

test('esp32: relay yang dikonfirmasi perangkat tetap sukses seperti sebelumnya', async () => {
    const state = [
        { id: 1, name: 'Relay 1 & 2', pin: 26, on: 0 },
        { id: 2, name: 'Relay 3', pin: 27, on: 0 },
        { id: 3, name: 'Relay 4', pin: 32, on: 0 }
    ];
    const f = esp32Fixture({
        relay: url => {
            const ch = url.searchParams.get('ch');
            const st = url.searchParams.get('state') === '1' ? 1 : 0;
            if (ch === 'all') state.forEach(r => { r.on = st; });
            else state[Number(ch) - 1].on = st;
            const ax = !!state[0].on;
            return { ok: true, relays: state.map(r => ({ ...r })), aux: { relay: 1, on_pin: 23, off_pin: 22, on: ax ? 1 : 0, off: ax ? 0 : 1 } };
        }
    });
    f.api.start();
    await tick(); await tick();

    const r = await f.post('/api/esp32/relay', { id: 1, state: true });
    assert.equal(r.code, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.relays[0].on, true);
    assert.deepEqual({ ...r.body.aux }, { relay: 1, on_pin: 23, off_pin: 22, on: 1, off: 0 });
});

// ---------------------------------------------------------------------------
// Harness ESP8266 (door.js)
// ---------------------------------------------------------------------------
function doorFixture({ env = {}, status, command, db = {} } = {}) {
    const routes = {}, requests = [], timers = new Map(), broadcast = [];
    let timerId = 0;
    const fakeFs = {
        readFileSync: () => JSON.stringify({ ver: 1, enabled: true, openSec: 5, cards: [], log: [], ...db }),
        mkdirSync() { }, writeFileSync() { }, renameSync() { }
    };
    const context = {
        module: { exports: {} }, __dirname: root,
        console: { log() { }, error() { }, warn() { } },
        AbortSignal,
        setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        require: n => n === './lang' ? T : n === './fwstate' ? fwstate : n === 'fs' ? fakeFs : n === 'path' ? path : require(n),
        process: { env: { DOOR_IP: 'device.test', DOOR_PORT: '80', DOOR_API_KEY: 'k', LANGUAGE: 'id', TELEGRAM_ALERTS: 'false', ...env } },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            let j;
            if (String(url).includes('/api/status')) j = status ? status() : { ok: true, ver: 1, boot: 1, events: [], enroll: 0, fw: '1.1' };
            else j = command ? command(new URL(url), options) : { ok: true };
            if (j instanceof Error) throw j;
            return { ok: true, status: 200, json: async () => j };
        }
    };
    vm.runInNewContext(source('door.js'), context);
    const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m, (u, f) => { routes[m + ' ' + u] = f; }]));
    const api = context.module.exports({
        app, broadcast: m => broadcast.push(m), notify: () => { },
        verifyDashboardPassword: () => true
    });
    return {
        api, routes, requests, broadcast, timers,
        async request(method, url, body, params) {
            const res = response();
            // Cocokkan juga pola ':param' (mis. DELETE /api/door/cards/:uid) seperti Express.
            const key = method + ' ' + url;
            let fn = routes[key], matched = {};
            if (!fn) {
                for (const k of Object.keys(routes)) {
                    if (!k.startsWith(method + ' ')) continue;
                    const parts = k.slice(method.length + 1).split('/'), segs = url.split('/');
                    if (parts.length !== segs.length) continue;
                    const got = {};
                    let same = true;
                    for (let i = 0; i < parts.length; i++) {
                        if (parts[i].startsWith(':')) got[parts[i].slice(1)] = decodeURIComponent(segs[i]);
                        else if (parts[i] !== segs[i]) { same = false; break; }
                    }
                    if (same) { fn = routes[k]; matched = got; break; }
                }
            }
            assert.equal(typeof fn, 'function', 'route tidak ditemukan: ' + key);
            await fn({ body, params: { ...matched, ...(params || {}) } }, res);
            for (let i = 0; i < 50 && !res.body; i++) await tick();
            return res;
        },
        async online() { api.start(); await tick(); await tick(); },
        pending() { return [...timers.values()]; }
    };
}

test('esp8266: payload status rusak tidak membuat pintu dianggap offline', async () => {
    const f = doorFixture({
        status: () => ({ ok: true, ver: 1, boot: 1, events: { broken: true }, enroll: 0 })   // events bukan array
    });
    f.api.start();
    await tick(); await tick();
    const snap = f.api.snapshot();
    assert.equal(snap.online, true);
    assert.equal(snap.fails, 0);
});

test('esp8266: reload/start berulang tidak menggandakan rantai polling pintu', async () => {
    const f = doorFixture();
    f.api.start();
    f.api.start();
    await tick(); await tick(); await tick();
    const polls = f.pending().filter(x => x.ms === 1000);
    assert.equal(polls.length, 1);
});

test('esp8266: perintah buka pintu yang ditolak perangkat tidak dilaporkan sukses', async () => {
    const f = doorFixture({ command: () => ({ ok: false, error: 'busy' }) });
    await f.online();
    const r = await f.request('post', '/api/door/open', {});
    assert.equal(r.code, 502);
    assert.equal(r.body.success, false);
    assert.equal(r.body.message, T('door.noConfirm'));
});

test('esp8266: /api/door/config melaporkan synced sesuai konfirmasi perangkat', async () => {
    // Online: ESP menjawab sinkronisasi dengan versi yang sama -> synced true.
    const online = doorFixture({ command: (url, opt) => ({ ver: Number(/^V=(\d+)/.exec(String(opt.body))[1]) }) });
    await online.online();
    const ok = await online.request('post', '/api/door/config', { openSec: 7 });
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.synced, true);

    // Offline: nilai tetap tersimpan di server, tetapi tidak boleh mengklaim synced.
    const offline = doorFixture();
    const saved = await offline.request('post', '/api/door/config', { openSec: 8 });
    assert.equal(saved.body.success, true);
    assert.equal(saved.body.synced, false);
    assert.equal(offline.api.snapshot().openSec, 8);
});

test('esp8266: hapus kartu melaporkan apakah perangkat sudah mengonfirmasi', async () => {
    const card = [{ uid: 'AA11BB22', name: 'Budi', added: 1, last: null }];
    const echoVer = (url, opt) => ({ ver: Number(/^V=(\d+)/.exec(String(opt.body))[1]) });

    // Online: ESP menjawab sinkronisasi dengan versi yang sama -> synced true.
    const online = doorFixture({ db: { cards: card.map(c => ({ ...c })) }, command: echoVer });
    await online.online();
    const ok = await online.request('delete', '/api/door/cards/AA11BB22', null, { uid: 'AA11BB22' });
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.synced, true);
    assert.equal(ok.body.message, T('door.cardDeleted'));
    assert.equal(online.api.snapshot().cards.length, 0);

    // Offline: kartu tetap terhapus di server, tetapi tidak boleh mengklaim sudah
    // diterima perangkat (kartu masih bisa membuka pintu sampai sinkronisasi berhasil).
    const offline = doorFixture({ db: { cards: card.map(c => ({ ...c })) } });
    const pending = await offline.request('delete', '/api/door/cards/AA11BB22', null, { uid: 'AA11BB22' });
    assert.equal(pending.body.success, true);
    assert.equal(pending.body.synced, false);
    assert.equal(pending.body.message, T('door.cardDeletedPending'));
    assert.equal(offline.api.snapshot().cards.length, 0);

    // Kartu yang tidak ada tetap 404 dan tidak mengubah apa pun.
    const missing = await offline.request('delete', '/api/door/cards/CC33DD44', null, { uid: 'CC33DD44' });
    assert.equal(missing.code, 404);
    assert.equal(missing.body.success, false);
});

// ---------------------------------------------------------------------------
// auth: batas sesi per perangkat
// ---------------------------------------------------------------------------
test('auth: sesi mobile per perangkat dibatasi (token lama dipensiunkan)', () => {
    const dir = tmpDir();
    const auth = createAuth({ env: envFrom({ MOBILE_MAX_SESSIONS_PER_DEVICE: '2' }), dataDir: dir });
    const first = auth.issueMobileSession({ deviceId: 'ndlx-dev-0001' });
    const second = auth.issueMobileSession({ deviceId: 'ndlx-dev-0001' });
    assert.equal(auth.mobileSessionCount('ndlx-dev-0001'), 2);

    const third = auth.issueMobileSession({ deviceId: 'ndlx-dev-0001' });
    assert.equal(auth.mobileSessionCount('ndlx-dev-0001'), 2, 'batas tidak boleh terlampaui');
    assert.equal(auth.resolve({ headers: { authorization: `Bearer ${first.token}` } }).ok, false, 'token tertua dipensiunkan');
    assert.equal(auth.resolve({ headers: { authorization: `Bearer ${second.token}` } }).ok, true);
    assert.equal(auth.resolve({ headers: { authorization: `Bearer ${third.token}` } }).ok, true);

    // Perangkat lain tidak terpengaruh.
    auth.issueMobileSession({ deviceId: 'ndlx-dev-0002' });
    assert.equal(auth.mobileSessionCount('ndlx-dev-0002'), 1);
    auth.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// updater: perbandingan versi
// ---------------------------------------------------------------------------
function updaterFixture(counts, { revParseFails = false } = {}) {
    const dir = tmpDir();
    const calls = [];
    const git = async args => {
        calls.push(args.join(' '));
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            if (revParseFails) throw new Error('not a git repository');
            return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
        }
        if (args[0] === 'fetch') return '';
        if (args[0] === 'rev-parse') return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
        if (args[0] === 'rev-list') return counts + '\n';
        if (args[0] === 'log') return '';
        throw new Error('unexpected git args: ' + args.join(' '));
    };
    const up = createUpdater({
        env: envFrom({ UPDATE_CHECK_ENABLED: 'true' }),
        file: path.join(dir, 'update-state.json'),
        rootDir: dir, git, notify: null, broadcast: null, log: () => { }
    });
    return { up, calls, dir };
}

test('update: repo lokal yang lebih baru dari origin bukan "update tersedia"', async () => {
    const ahead = updaterFixture('2\t0');
    const st = await ahead.up.check({ reason: 'test' });
    assert.equal(st.updateAvailable, false);
    assert.equal(st.aheadCount, 2);
    assert.equal(st.behindCount, 0);
    fs.rmSync(ahead.dir, { recursive: true, force: true });

    const behind = updaterFixture('0\t3');
    const st2 = await behind.up.check({ reason: 'test' });
    assert.equal(st2.updateAvailable, true);
    assert.equal(st2.aheadCount, 0);
    assert.equal(st2.behindCount, 3);
    fs.rmSync(behind.dir, { recursive: true, force: true });
});

test('update: git lama tanpa rev-list --left-right tetap memakai perbandingan commit', async () => {
    const dir = tmpDir();
    const git = async args => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
        if (args[0] === 'fetch') return '';
        if (args[0] === 'rev-parse') return 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n';
        if (args[0] === 'rev-list') throw new Error('unknown option');
        if (args[0] === 'log') return '';
        throw new Error('unexpected');
    };
    const up = createUpdater({
        env: envFrom({}), file: path.join(dir, 'update-state.json'), rootDir: dir,
        git, notify: null, broadcast: null, log: () => { }
    });
    const st = await up.check({ reason: 'test' });
    assert.equal(st.updateAvailable, true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// setup: kunci rahasia tidak dikirim sebelum login
// ---------------------------------------------------------------------------
function setupFixture({ authed = false, adminPassword = '' } = {}) {
    const routes = {}, applied = [];
    process.env.ADMIN_PASSWORD = adminPassword;
    const app = { get: (u, f) => { routes['GET ' + u] = f; }, post: (u, f) => { routes['POST ' + u] = f; } };
    const settings = {
        snapshot: () => ({
            esp32: { ip: '192.168.1.50', port: 80, apiKey: 'SECRET-ESP32-KEY', pollMs: 1000, labels: '' },
            door: { ip: '192.168.1.60', port: 80, apiKey: 'SECRET-DOOR-KEY', enrollSec: 30, pollMs: 1000, notifyOpen: false, notifyUnknown: false },
            telegram: { alerts: true, token: '123456:SECRET-TELEGRAM-TOKEN', chatId: '@admin' },
            ai: { enabled: true, apiKey: 'SECRET-GEMINI-KEY', model: 'gemini-3.5-flash-lite' },
            server: { port: 3000, sessionHours: 24, storageFolder: 'upload', otaMaxMB: 4, otaTimeoutS: 240, otaWaitS: 60 },
            monitor: {},
            info: { port: 3000, ips: ['192.168.1.10'], lang: 'id', version: '1.2.0', node: 'v22', setupDone: !!adminPassword, setupRequired: !adminPassword, username: 'admin', uptime: 1, envFile: '.env' }
        }),
        apply: arg => { applied.push(arg); return { changed: [], groups: Object.keys(arg) }; }
    };
    const auth = { isAuthed: () => authed, createSession() { } };
    const device = { reload() { } };
    const setup = createSetup({
        app, saveEnv: () => { }, settings, esp32: device, door: device,
        telegram: { restart() { }, welcome: async () => true }, ai: { reload() { }, start() { }, cfg: () => ({}) },
        auth, startDevices: () => { }
    });
    return {
        setup, applied,
        async get(url) { const res = response(); await routes['GET ' + url]({}, res); return res; },
        async post(url, body) { const res = response(); await routes['POST ' + url]({ body }, res); return res; }
    };
}

test('setup: /api/setup/status tidak membocorkan kunci API/token sebelum login', async () => {
    const f = setupFixture({ authed: false, adminPassword: '' });
    const r = await f.get('/api/setup/status');
    const raw = JSON.stringify(r.body);
    for (const secret of ['SECRET-ESP32-KEY', 'SECRET-DOOR-KEY', 'SECRET-TELEGRAM-TOKEN', 'SECRET-GEMINI-KEY']) {
        assert.ok(!raw.includes(secret), `rahasia ${secret} tidak boleh dikirim`);
    }
    assert.equal(r.body.esp32.hasKey, true, 'penanda hasKey tetap membantu halaman setup');
    assert.equal(r.body.door.hasKey, true);
    assert.equal(r.body.telegram.hasToken, true);
    assert.equal(r.body.ai.hasKey, true);
    delete process.env.ADMIN_PASSWORD;
});

test('setup: sesi dashboard yang login tetap melihat nilai tersimpan', async () => {
    const f = setupFixture({ authed: true, adminPassword: 'rahasia-lama-123' });
    const r = await f.get('/api/setup/status');
    assert.equal(r.body.esp32.apiKey, 'SECRET-ESP32-KEY');
    assert.equal(r.body.telegram.token, '123456:SECRET-TELEGRAM-TOKEN');
    delete process.env.ADMIN_PASSWORD;
});

test('setup: kunci yang dikosongkan tidak menghapus kunci yang sudah tersimpan', async () => {
    const f = setupFixture({ authed: false, adminPassword: '' });
    const r = await f.post('/api/setup/device', { device: 'esp32', ip: '192.168.1.50', port: 80, apiKey: '' });
    assert.equal(r.body.success, true);
    const esp = f.applied.find(a => a.esp32);
    assert.ok(esp, 'pengaturan tetap diperbarui');
    assert.equal(esp.esp32.apiKey, undefined, 'kunci kosong tidak dikirim ke .env');

    const tg = await f.post('/api/setup/telegram', { token: '', chatId: '@admin', alerts: true });
    assert.equal(tg.body.success, true);
    const tel = f.applied.find(a => a.telegram);
    assert.equal(tel.telegram.token, undefined);

    const typed = await f.post('/api/setup/device', { device: 'esp32', ip: '192.168.1.50', port: 80, apiKey: 'KUNCI-BARU-123' });
    assert.equal(typed.body.success, true);
    assert.equal(f.applied.filter(a => a.esp32).at(-1).esp32.apiKey, 'KUNCI-BARU-123');
    delete process.env.ADMIN_PASSWORD;
});
