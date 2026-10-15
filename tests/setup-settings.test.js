// Isolated tests: tanpa hardware, tanpa server berjalan, tanpa menulis .env.
// Menguji dua modul baru: settings.js (pengaturan lewat web) dan setup.js (setup awal).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');

const response = () => ({ code: 200, body: null, status(n) { this.code = n; return this; }, json(j) { this.body = j; return this; } });

// Muat modul di dalam vm dengan app/saveEnv/modul palsu, lalu kembalikan route yang terdaftar.
function fixture(file, { env = {}, deps = {}, fetchImpl } = {}) {
    const routes = {}, writes = {}, calls = { reload: [], restart: 0, sessions: 0 };
    const app = { get: (u, f) => { routes['GET ' + u] = f; }, post: (u, f) => { routes['POST ' + u] = f; } };
    const saveEnv = (k, v) => { writes[k] = v; };
    const make = extra => ({
        app, saveEnv, esp32: { reload: () => calls.reload.push('esp32') }, door: { reload: () => calls.reload.push('door') },
        telegram: { restart: () => calls.restart++, test: async () => ({ ok: true }) },
        // Sama seperti server.js: verify() yang gagal sudah mengirim 403 sendiri.
        auth: {
            isAuthed: () => false,
            verify: (req, res) => { res.status(403).json({ success: false, message: T('auth.wrong') }); return false; },
            createSession: () => calls.sessions++, keepOnly() { }
        },
        settings: { snapshot: () => ({ info: {} }), apply: () => { } },
        startDevices: () => calls.startDevices = (calls.startDevices || 0) + 1,
        ...extra
    });
    const context = {
        module: { exports: {} }, __dirname: root, console,
        require: n => n === './lang' ? T : require(n),
        process: { env: { LANGUAGE: 'id', ...env } },
        fetch: fetchImpl || (async () => { throw new Error('fetch tidak dipakai di test ini'); }),
        AbortSignal, setTimeout, clearTimeout
    };
    vm.runInNewContext(source(file), context);
    const api = context.module.exports(make(deps));
    const ctx = { routes, writes, calls, api, deps };
    ctx.post = (url, body) => { const res = response(); routes['POST ' + url]({ body: body || {}, headers: {}, ip: '127.0.0.1' }, res); return res; };
    ctx.get = url => { const res = response(); routes['GET ' + url]({ body: {}, headers: {}, ip: '127.0.0.1' }, res); return res; };
    return ctx;
}

// ---------- settings.js ----------

test('settings: GET /api/settings mengembalikan nilai bawaan', () => {
    const s = fixture('settings.js', { env: { ESP32_IP: '192.168.1.50', ESP32_API_KEY: 'kunci-esp32', TELEGRAM_ALERTS: 'true' } });
    const r = s.get('/api/settings');
    assert.equal(r.code, 200);
    assert.equal(r.body.esp32.ip, '192.168.1.50');
    assert.equal(r.body.esp32.port, 80);
    assert.equal(r.body.esp32.apiKey, 'kunci-esp32');
    assert.equal(r.body.door.port, 80);
    assert.equal(r.body.telegram.alerts, true);
    assert.equal(r.body.info.setupRequired, true, 'belum ada ADMIN_PASSWORD -> setup dianggap belum selesai');
    assert.ok(Array.isArray(r.body.info.ips), 'alamat IP server dilaporkan ke halaman');
});

test('settings: alamat perangkat harus IPv4/host yang masuk akal', () => {
    const s = fixture('settings.js');
    for (const ip of ['999.1.1.1', '1.2.3', '192.168.1', 'alamat salah', 'a b']) {
        const r = s.post('/api/settings', { esp32: { ip } });
        assert.equal(r.code, 400, `"${ip}" seharusnya ditolak`);
        assert.equal(r.body.success, false);
    }
    assert.deepEqual(s.writes, {}, 'tidak ada yang ditulis kalau ada nilai salah');
});

test('settings: port, kunci API, angka, dan chat ID divalidasi', () => {
    const s = fixture('settings.js');
    assert.equal(s.post('/api/settings', { esp32: { port: 0 } }).code, 400);
    assert.equal(s.post('/api/settings', { esp32: { port: 70000 } }).code, 400);
    assert.equal(s.post('/api/settings', { esp32: { apiKey: 'kunci ada spasi' } }).code, 400);
    assert.equal(s.post('/api/settings', { esp32: { apiKey: 'x'.repeat(65) } }).code, 400);
    assert.equal(s.post('/api/settings', { monitor: { iWarn: 'bukan angka' } }).code, 400);
    assert.equal(s.post('/api/settings', { monitor: { cellVMax: 99 } }).code, 400);
    assert.equal(s.post('/api/settings', { telegram: { chatId: 'bukan id' } }).code, 400);
    assert.equal(s.post('/api/settings', { telegram: { chatId: '12345' } }).code, 200);
    assert.equal(s.post('/api/settings', { telegram: { chatId: '@nama_admin' } }).code, 200);
    assert.deepEqual(s.writes, { TELEGRAM_CHAT_ID: '@nama_admin' });
});

test('settings: menyimpan nilai valid + memuat ulang modul terkait', () => {
    const s = fixture('settings.js', { env: { ESP32_POLL_MS: '1000', DOOR_IP: '' } });
    const r = s.post('/api/settings', {
        esp32: { ip: '192.168.11.50', port: 8080, pollMs: 2000, labels: 'Relay 1, Relay 2' },
        door: { ip: 'esp8266-pintu.local', enrollSec: 15, notifyOpen: true },
        telegram: { alerts: false, chatId: '123456789' }
    });
    assert.equal(r.code, 200);
    assert.deepEqual(s.writes, {
        ESP32_IP: '192.168.11.50', ESP32_PORT: '8080', ESP32_POLL_MS: '2000', RELAY_LABELS: 'Relay 1, Relay 2',
        DOOR_IP: 'esp8266-pintu.local', DOOR_ENROLL_SECONDS: '15', DOOR_NOTIFY_OPEN: 'true',
        TELEGRAM_ALERTS: 'false', TELEGRAM_CHAT_ID: '123456789'
    });
    assert.deepEqual(s.calls.reload, ['esp32', 'door']);
    assert.equal(s.calls.restart, 1);
    assert.deepEqual(Array.from(r.body.groups).sort(), ['door', 'esp32', 'telegram']);
});

test('settings: mengosongkan IP mematikan pemantauan perangkat itu', () => {
    const s = fixture('settings.js', { env: { ESP32_IP: '192.168.1.50' } });
    const r = s.post('/api/settings', { esp32: { ip: '' } });
    assert.equal(r.code, 200);
    assert.equal(s.writes.ESP32_IP, '');
    assert.deepEqual(s.calls.reload, ['esp32']);
});

test('settings: ubah akun butuh password lama, password baru minimal 8 karakter', () => {
    const denied = fixture('settings.js', { env: { ADMIN_PASSWORD: 'rahasia123' } });
    assert.equal(denied.post('/api/settings/account', { username: 'admin' }).code, 403, 'auth.verify menolak -> 403');
    assert.deepEqual(denied.writes, {});

    const s = fixture('settings.js', {
        env: { ADMIN_PASSWORD: 'rahasia123' },
        deps: { auth: { isAuthed: () => true, verify: () => true, createSession() { }, keepOnly: () => (s.calls.keepOnly = true) } }
    });
    assert.equal(s.post('/api/settings/account', { username: 'x' }).code, 400, 'username terlalu pendek');
    assert.equal(s.post('/api/settings/account', { newPassword: 'pendek', confirmPassword: 'pendek' }).code, 400);
    assert.equal(s.post('/api/settings/account', { newPassword: 'rahasia456', confirmPassword: 'beda' }).code, 400);
    assert.deepEqual(s.writes, {});
    assert.equal(s.post('/api/settings/account', { username: 'arel', newPassword: 'rahasia456', confirmPassword: 'rahasia456' }).code, 200);
    assert.equal(s.writes.ADMIN_USERNAME, 'arel');
    assert.equal(s.writes.ADMIN_PASSWORD, 'rahasia456');
    assert.equal(s.calls.keepOnly, true, 'sesi lain diputus setelah password diganti');
});

test('settings: uji koneksi perangkat melaporkan versi firmware', async () => {
    const s = fixture('settings.js', {
        env: { ESP32_IP: '192.168.1.50', ESP32_API_KEY: 'kunci' },
        fetchImpl: async url => {
            assert.equal(url, 'http://192.168.1.50:80/api/data');
            return { ok: true, status: 200, text: async () => JSON.stringify({ fw: '1.3', ip: '192.168.1.50', rssi: -60 }) };
        }
    });
    const res = response();
    await s.routes['POST /api/settings/device/test']({ body: { device: 'esp32' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.fw, '1.3');
    assert.match(res.body.message, /1\.3/);
});

test('settings: perangkat tanpa IP dan perangkat tak dikenal ditolak rapi', () => {
    const s = fixture('settings.js');
    assert.equal(s.post('/api/settings/device/test', { device: 'esp32' }).code, 400);
    assert.equal(s.post('/api/settings/device/portal', { device: 'esp32' }).code, 400);
    assert.equal(s.post('/api/settings/device/test', { device: 'tv' }).code, 400);
});

test('settings: kunci API perangkat dipakai di header X-API-Key', async () => {
    let seen = null;
    const s = fixture('settings.js', {
        env: { DOOR_IP: '192.168.1.60', DOOR_API_KEY: 'kunci-pintu' },
        fetchImpl: async (url, opt) => { seen = { url, opt }; throw new Error('perangkat mati'); }
    });
    const res = response();
    await s.routes['POST /api/settings/device/portal']({ body: { device: 'esp8266' } }, res);
    assert.equal(seen.url, 'http://192.168.1.60:80/api/portal');
    assert.equal(seen.opt.headers['X-API-Key'], 'kunci-pintu');
    assert.equal(res.code, 502, 'perangkat tidak menjawab -> pesan jelas, bukan crash');
    assert.match(res.body.message, /tidak menjawab|Gagal/i);
});

// ---------- setup.js ----------

// setup.js memakai settings.js yang asli: validasi IP/port dan penulisan .env diuji sungguhan.
function setupFixture({ env = {}, deps = {} } = {}) {
    const st = fixture('settings.js', { env });
    const s = fixture('setup.js', { env, deps: { settings: st.api, ...deps } });
    s.st = st;
    return s;
}

test('setup: status terbuka sebelum ada akun, sisanya terkunci setelah akun dibuat', () => {
    const s = setupFixture();
    const st = s.get('/api/setup/status');
    assert.equal(st.body.required, true);
    assert.equal(st.body.authed, false);
    assert.equal(st.body.account.hasPassword, false);
    assert.ok(st.body.server.port > 0);
    assert.equal(st.body.server.ips.length > 0, true, 'alamat server ditampilkan di langkah 2');
    assert.equal(st.body.esp32.ip, '', 'sebelum diisi, kolom perangkat kosong');
    assert.equal(st.body.esp32.port, 80);

    // Setelah akun ada dan belum login, API setup lain harus menolak
    const done = setupFixture({ env: { ADMIN_PASSWORD: 'rahasia123' } });
    const locked = done.post('/api/setup/device', { device: 'esp32', ip: '192.168.1.9' });
    assert.equal(locked.code, 403);
    assert.equal(locked.body.success, false);
});

test('setup: akun admin divalidasi lalu langsung membuat sesi login', () => {
    const s = setupFixture();
    assert.equal(s.post('/api/setup/account', { username: 'ab', password: 'rahasia123', confirmPassword: 'rahasia123' }).code, 400);
    assert.equal(s.post('/api/setup/account', { username: 'admin', password: 'pendek', confirmPassword: 'pendek' }).code, 400);
    assert.equal(s.post('/api/setup/account', { username: 'admin', password: 'rahasia123', confirmPassword: 'beda' }).code, 400);
    assert.deepEqual(s.writes, {}, 'tidak ada yang ditulis kalau belum valid');

    const ok = s.post('/api/setup/account', { username: 'admin', password: 'rahasia123', confirmPassword: 'rahasia123' });
    assert.equal(ok.code, 200);
    assert.equal(s.writes.ADMIN_USERNAME, 'admin');
    assert.equal(s.writes.ADMIN_PASSWORD, 'rahasia123');
    assert.equal(s.calls.sessions, 1, 'langsung login supaya langkah ESP32/Telegram boleh dilanjutkan');
});

test('setup: langkah ESP32/ESP8266 memakai validator settings.js', () => {
    const s = setupFixture();
    const bad = s.post('/api/setup/device', { device: 'esp32', ip: '999.1.1.1' });
    assert.equal(bad.code, 400);
    const badPort = s.post('/api/setup/device', { device: 'esp8266', port: 0 });
    assert.equal(badPort.code, 400);
    assert.equal(s.post('/api/setup/device', { device: 'tv' }).code, 400);

    const ok = s.post('/api/setup/device', { device: 'esp8266', ip: '192.168.11.60', port: 80, apiKey: 'nlx-pintu' });
    assert.equal(ok.code, 200);
    assert.deepEqual(s.st.writes, { DOOR_IP: '192.168.11.60', DOOR_API_KEY: 'nlx-pintu' });
    assert.deepEqual(s.calls.reload, ['door'], 'perangkat yang baru diisi IP langsung dicoba dihubungi');
});

test('setup: selesai hanya boleh setelah ada akun, lalu menjalankan layanan perangkat', () => {
    const s = setupFixture({ env: { ADMIN_PASSWORD: 'rahasia123' }, deps: { auth: { isAuthed: () => true, verify: () => true, createSession: () => s.calls.sessions++ } } });
    const res = response();
    s.routes['POST /api/setup/finish']({ body: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(s.writes.SETUP_DONE, '1');
    assert.equal(s.calls.startDevices, 1);
    assert.equal(res.body.redirect, '/');
});

test('setup: sebelum akun dibuat, siapa pun yang membuka halaman boleh mengisi', () => {
    const s = setupFixture();
    assert.equal(s.post('/api/setup/telegram', { alerts: true, chatId: '123456789' }).code, 200);
    assert.equal(s.st.writes.TELEGRAM_CHAT_ID, '123456789');
    assert.equal(s.calls.restart, 1, 'bot Telegram dimuat ulang dengan nilai baru');
});

// ---------- Langkah AI Agent (kunci API Gemini) di setup awal ----------

// Fake modul AI: menyimpan nilai terakhir + mencatat reload, seperti ai.js aslinya.
function aiStub(saved = {}) {
    const st = { enabled: true, apiKey: saved.apiKey || '', model: saved.model || 'gemini-1.5-flash', reloads: 0, tested: [] };
    return Object.assign(st, {
        cfg: () => ({ enabled: st.enabled, apiKey: st.apiKey, model: st.model }),
        reload: () => { st.reloads++; },
        start: () => true,
        testKey: async o => { st.tested.push(o); if (!String(o.apiKey || st.apiKey).trim()) { const e = new Error('kunci kosong'); e.status = 400; throw e; } return 'OK'; }
    });
}

test('setup: langkah AI menulis kunci + model Gemini ke .env lewat kelompok ai', () => {
    const ai = aiStub();
    const s = setupFixture({ deps: { ai } });
    const r = s.post('/api/setup/ai', { enabled: true, apiKey: 'AIzaDemoKey123', model: 'gemini-2.5-flash' });
    assert.equal(r.code, 200);
    assert.equal(r.body.success, true);
    assert.match(r.body.message, /Gemini/i, 'pesan sukses menyebut kunci Gemini, bukan sekadar "Pengaturan disimpan"');
    assert.equal(s.st.writes.GEMINI_API_KEY, 'AIzaDemoKey123');
    assert.equal(s.st.writes.GEMINI_MODEL, 'gemini-2.5-flash');
    assert.deepEqual(Array.from(r.body.changed).sort(), ['GEMINI_API_KEY', 'GEMINI_MODEL'], 'hanya kunci + model yang berubah');
    assert.ok(r.body.ai && typeof r.body.ai.hasKey === 'boolean', 'halaman menerima status kunci terbaru');
    assert.equal(ai.reloads, 1, 'modul AI dimuat ulang supaya nilai baru langsung dipakai');
});

test('setup: nama route lama /api/setup/gemini tetap berfungsi', () => {
    const ai = aiStub();
    const s = setupFixture({ deps: { ai } });
    const r = s.post('/api/setup/gemini', { apiKey: 'AIzaLama123' });
    assert.equal(r.code, 200);
    assert.equal(s.st.writes.GEMINI_API_KEY, 'AIzaLama123');
});

test('setup: kolom kunci yang dikosongkan tidak menghapus kunci yang sudah tersimpan', () => {
    const ai = aiStub({ apiKey: 'AIzaSudahTersimpan' });
    const s = setupFixture({ env: { GEMINI_API_KEY: 'AIzaSudahTersimpan' }, deps: { ai } });
    const r = s.post('/api/setup/ai', { apiKey: '   ', model: 'gemini-2.5-flash' });
    assert.equal(r.code, 200);
    assert.notEqual(s.st.writes.GEMINI_API_KEY, '', 'kunci tidak boleh ditulis kosong');
    assert.equal(s.st.writes.GEMINI_MODEL, 'gemini-2.5-flash', 'model tetap disimpan');
    assert.equal(r.body.ai.hasKey, true);
});

test('setup: hanya mengirim status tanpa nilai baru tidak menulis apa pun', () => {
    const ai = aiStub({ apiKey: 'AIzaAda' });
    const s = setupFixture({ env: { GEMINI_API_KEY: 'AIzaAda' }, deps: { ai } });
    const r = s.post('/api/setup/ai', { apiKey: '' });
    assert.equal(r.code, 200);
    assert.deepEqual(s.st.writes, {}, 'langkah yang dilewati tidak mengubah .env');
    assert.equal(ai.reloads, 0);
});

test('setup: kunci Gemini yang tidak valid ditolak dengan pesan jelas', () => {
    const s = setupFixture({ deps: { ai: aiStub() } });
    assert.equal(s.post('/api/setup/ai', { apiKey: 'kunci ada spasi' }).code, 400);
    assert.equal(s.post('/api/setup/ai', { apiKey: 'x'.repeat(65) }).code, 400);
    assert.deepEqual(s.st.writes, {});
});

test('setup: uji kunci memakai kunci yang diketik, tanpa menyimpannya', async () => {
    const ai = aiStub();
    const s = setupFixture({ deps: { ai } });
    const res = response();
    await s.routes['POST /api/setup/ai/test']({ body: { apiKey: 'AIzaBaru', model: 'gemini-2.5-flash' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.reply, 'OK');
    assert.equal(ai.tested.length, 1, 'satu kali panggilan ke Gemini');
    assert.equal(ai.tested[0].apiKey, 'AIzaBaru', 'kunci yang diuji = yang diketik, bukan yang tersimpan');
    assert.equal(ai.tested[0].model, 'gemini-2.5-flash');
    assert.deepEqual(s.st.writes, {}, 'menguji kunci tidak menulis .env');
});

test('setup: uji kunci tanpa modul AI dan tanpa kunci dilaporkan rapi', async () => {
    const noModule = setupFixture();
    const a = response();
    await noModule.routes['POST /api/setup/ai/test']({ body: { apiKey: 'AIzaBaru' } }, a);
    assert.equal(a.code, 501);
    assert.equal(a.body.success, false);

    const empty = setupFixture({ deps: { ai: aiStub() } });
    const b = response();
    await empty.routes['POST /api/setup/ai/test']({ body: {} }, b);
    assert.equal(b.code, 400, 'belum ada kunci sama sekali -> 400, bukan 502');
    assert.equal(b.body.success, false);
});

test('setup: status awal membuka kunci yang tersimpan, halaman lain tetap aman', () => {
    const ai = aiStub({ apiKey: 'AIzaSudahTersimpan', model: 'gemini-2.5-flash' });
    const s = setupFixture({ env: { GEMINI_API_KEY: 'AIzaSudahTersimpan', GEMINI_MODEL: 'gemini-2.5-flash' }, deps: { ai } });
    const st = s.get('/api/setup/status');
    assert.equal(st.body.ai.hasKey, true);
    assert.equal(st.body.ai.model, 'gemini-2.5-flash');

    // akun sudah ada + belum login -> kunci disembunyikan dan langkah AI terkunci
    const locked = setupFixture({ env: { ADMIN_PASSWORD: 'rahasia123', GEMINI_API_KEY: 'AIzaRahasia' }, deps: { ai } });
    const l = locked.get('/api/setup/status');
    assert.equal(l.body.ai.apiKey, '', 'kunci tidak dikirim ke pengunjung yang belum login');
    assert.equal(l.body.ai.hasKey, true, 'keberadaan kunci tetap dilaporkan supaya kolom diberi petunjuk');
    assert.equal(locked.post('/api/setup/ai', { apiKey: 'AIzaPencokok' }).code, 403);
});
