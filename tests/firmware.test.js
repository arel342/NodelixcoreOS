// Isolated tests: no hardware, no running server, no real .bin upload.
// Modul firmware.js dijalankan di vm dengan multer & fetch palsu supaya alur OTA bisa diuji.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');
const fwstate = require('../fwstate');

const BIN = 'esp8266 lock door.ino.bin';
// Gambar firmware ESP: byte awal 0xE9
const img = (extra = 0x00) => Buffer.concat([Buffer.from([0xE9, 0x03, 0x02, 0x20]), Buffer.alloc(32, extra)]);
const response = () => ({
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(j) { this.body = j; return this; }
});
// multer() -> { single() }; req.file/req.body diisi langsung seperti hasil parse multipart
const fakeMulter = Object.assign(
    () => ({
        single: () => (req, res, cb) => { req.file = req.__file; req.body = req.__body || {}; cb(null); }
    }),
    { memoryStorage: () => ({}) }
);

// Modul firmware.js + route GET/POST-nya, dengan fetch yang mencatat permintaan (atau fetch gagal)
function fixture(env = {}, fetchImpl) {
    const routes = {}, requests = [], messages = [], notes = [];
    fwstate.set('esp8266', null); fwstate.set('esp32', null);
    const context = {
        module: { exports: {} }, __dirname: root, console, AbortSignal, FormData, Blob, setTimeout, clearTimeout,
        require: n => n === 'multer' ? fakeMulter : n === './lang' ? T : n === './fwstate' ? fwstate : require(n),
        process: { env: { DOOR_IP: 'door.test', DOOR_API_KEY: 'kunci-pintu', ESP32_IP: 'esp32.test', ESP32_API_KEY: 'kunci-esp32', LANGUAGE: 'id', ...env } },
        fetch: fetchImpl || (async (url, options) => {
            requests.push({ url, options });
            const data = url.endsWith('/api/ota') ? { ok: true, device: 'esp8266-door' } : { fw: '1.2', ver: 3, events: [], boot: 9, enroll: 0 };
            return { ok: true, status: 200, json: async () => data };
        })
    };
    vm.runInNewContext(source('firmware.js'), context);
    const mod = context.module.exports;
    const app = { get: (url, fn) => { routes['GET ' + url] = fn; }, post: (url, fn) => { routes['POST ' + url] = fn; } };
    const api = mod({
        app, broadcast: m => messages.push(m), notify: m => notes.push(m),
        door: { snapshot: () => ({ online: true, configured: true, esp: { ip: '192.168.11.60', fw: '1.1', rssi: -60 } }) },
        esp32: { snapshot: () => ({ online: false, esp: null }) }
    });
    return {
        api, mod, requests, messages, notes, busy: () => fwstate.isBusy(),
        async get(url, params = {}) { const res = response(); await routes['GET ' + url]({ params }, res); return res; },
        // Handler flash bersifat async (menunggu ESP), jadi tunggu sampai res.json() dipanggil
        async post(url, req) {
            const res = response();
            const done = routes['POST ' + url](req, res);
            if (done && done.then) await done;
            for (let i = 0; i < 400 && !res.body; i++) await new Promise(r => setTimeout(r, 25));
            return res;
        },
        // permintaan OTA yang sudah lengkap (seperti hasil upload web)
        req(device = 'esp8266', file = { originalname: BIN, buffer: img() }) {
            file.size = file.size || file.buffer.length;
            return { __file: file, __body: { device } };
        }
    };
}

test('checkFile: hanya .bin berisi gambar firmware ESP yang diterima', () => {
    const { mod } = fixture();
    assert.equal(mod.checkFile(BIN, img()).ok, true);
    assert.equal(mod.checkFile('firmware.bin', img()).ok, true);

    const ext = mod.checkFile('esp8266 lock door.ino.elf', img());
    assert.equal(ext.ok, false);
    assert.equal(ext.code, 'ext');                       // peringatan: bukan .bin
    assert.match(ext.message, /\.bin/);

    const isi = mod.checkFile(BIN, Buffer.from('bukan firmware esp sama sekali'));
    assert.equal(isi.ok, false);
    assert.equal(isi.code, 'image');                     // .bin tapi bukan gambar ESP (header 0xE9 tidak ada)
    assert.match(isi.message, /0xE9/);

    assert.equal(mod.checkFile('kosong.bin', Buffer.alloc(0)).code, 'image');
});

test('isDevice: hanya esp8266 & esp32 yang boleh diupdate', () => {
    const { mod } = fixture();
    assert.equal(mod.isDevice('esp8266'), true);
    assert.equal(mod.isDevice('esp32'), true);
    assert.equal(mod.isDevice('esp32-plts'), false);
    assert.equal(mod.isDevice(''), false);
});

test('GET /api/firmware: status kedua ESP + pengaturan ukuran', async () => {
    const f = fixture();
    const res = await f.get('/api/firmware');
    assert.equal(res.code, 200);
    assert.equal(res.body.devices.length, 2);
    const pintu = res.body.devices.find(d => d.key === 'esp8266');
    assert.equal(pintu.online, true);
    assert.equal(pintu.fw, '1.1');
    assert.equal(pintu.host, 'door.test');
    const monitor = res.body.devices.find(d => d.key === 'esp32');
    assert.equal(monitor.online, false);
    assert.equal(monitor.fw, '');
    assert.equal(res.body.maxMB, 4);
    assert.equal(res.body.busy, false);
});

test('POST /api/firmware/flash: file bukan .bin ditolak dengan peringatan', async () => {
    const f = fixture();
    const res = await f.post('/api/firmware/flash', f.req('esp8266', { originalname: 'firmware.elf', buffer: img() }));
    assert.equal(res.code, 400);
    assert.equal(res.body.code, 'ext');
    assert.match(res.body.error, /bukan \.bin/i);
    assert.equal(f.requests.length, 0);                  // tidak ada yang dikirim ke ESP
});

test('POST /api/firmware/flash: .bin yang isinya bukan firmware ESP ditolak', async () => {
    const f = fixture();
    const buf = Buffer.from('MZ bukan gambar esp');
    const res = await f.post('/api/firmware/flash', f.req('esp32', { originalname: BIN, buffer: buf }));
    assert.equal(res.code, 400);
    assert.equal(res.body.code, 'image');
    assert.equal(f.requests.length, 0);
});

test('POST /api/firmware/flash: perangkat tidak dikenal / tanpa IP', async () => {
    const f = fixture();
    const salah = await f.post('/api/firmware/flash', f.req('esp8285'));
    assert.equal(salah.code, 400);
    assert.match(salah.body.error, /tidak dikenal/i);

    const g = fixture({ DOOR_IP: '' });
    const tanpaIp = await g.post('/api/firmware/flash', g.req('esp8266'));
    assert.equal(tanpaIp.code, 502);
    assert.match(tanpaIp.body.message, /DOOR_IP/);
});

test('POST /api/firmware/flash: .bin yang benar dikirim ke ESP dan versi baru dibaca', async () => {
    const f = fixture();
    const res = await f.post('/api/firmware/flash', f.req('esp8266', { originalname: BIN, buffer: img(0xAB) }));

    assert.equal(res.code, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.device, 'esp8266');
    assert.equal(res.body.fw, '1.2');                    // dibaca dari /api/status setelah ESP restart
    assert.match(res.body.message, /berhasil/i);

    const ota = f.requests.find(r => r.url.endsWith('/api/ota'));
    assert.equal(ota.url, 'http://door.test:80/api/ota');
    assert.equal(ota.options.method, 'POST');
    assert.equal(ota.options.headers['X-API-Key'], 'kunci-pintu');
    assert.ok(ota.options.body instanceof FormData);     // multipart (dibaca library Update di ESP)
    assert.ok(f.requests.some(r => r.url.endsWith('/api/status')));

    // Web dikabari tiap tahap supaya bilah kemajuan berjalan; penanda sibuk dibersihkan lagi
    const phases = f.messages.filter(m => m.type === 'FW').map(m => m.data.phase);
    assert.deepEqual([...new Set(phases)], ['send', 'reboot', 'done']);
    assert.equal(f.messages[0].data.device, 'esp8266');
    assert.equal(f.busy(), false);
    // Notifikasi Telegram ikut dikirim (TELEGRAM_ALERTS tidak dimatikan)
    assert.equal(f.notes.length, 1);
});

test('POST /api/firmware/flash: update lain yang sedang jalan ditolak', async () => {
    const f = fixture();
    fwstate.set('esp32', { startedAt: Date.now() });
    try {
        const res = await f.post('/api/firmware/flash', f.req('esp8266'));
        assert.equal(res.code, 409);
        assert.equal(f.requests.length, 0);
    } finally { fwstate.set('esp32', null); }
});

test('POST /api/firmware/flash: ESP tidak menjawab -> gagal, penanda sibuk dibersihkan', async () => {
    const f = fixture({}, async () => { throw new Error('EHOSTUNREACH'); });
    const res = await f.post('/api/firmware/flash', f.req('esp8266'));
    assert.equal(res.code, 502);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /EHOSTUNREACH/);
    assert.equal(fwstate.isBusy(), false);
    assert.equal(f.notes.length, 1);                     // Telegram diberi tahu kegagalannya
    assert.match(f.notes[0], /gagal|failed/i);
});
