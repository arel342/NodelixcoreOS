// Isolated tests: verifikasi kontrol relay ESP32 dan keluaran pendamping Relay 1 & 2 (GPIO 23 & GPIO 22, aktif HIGH).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');
const fwstate = require('../fwstate');

const response = () => ({
    code: 200, body: null,
    status(n) { this.code = n; return this; },
    json(j) { this.body = j; return this; }
});

function esp32Fixture(env = {}) {
    const routes = {}, messages = [], notes = [], requests = [];
    const state = {
        relays: [
            { id: 1, name: 'Relay 1 & 2', pin: 26, on: 0 },
            { id: 2, name: 'Relay 3', pin: 27, on: 0 },
            { id: 3, name: 'Relay 4', pin: 32, on: 0 }
        ]
    };
    const auxState = () => {
        const ax = !!state.relays[0].on;
        return { relay: 1, on_pin: 23, off_pin: 22, on: ax ? 1 : 0, off: ax ? 0 : 1 };
    };
    const context = {
        module: { exports: {} }, __dirname: root, console, AbortSignal,
        setTimeout: () => 1, clearTimeout: () => { },
        require: n => n === './lang' ? T : n === './fwstate' ? fwstate : require(n),
        process: { env: { ESP32_IP: '192.168.1.50', ESP32_PORT: '80', ESP32_API_KEY: 'kunci-esp32', LANGUAGE: 'id', ...env } },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            const u = new URL(url);
            if (u.pathname === '/api/data') {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        ok: true, device: 'esp32-plts', fw: '1.4.0', ip: '192.168.1.50', rssi: -55, uptime: 120, heap: 200000,
                        battery: [{ id: 's3', pin: 39, en: 1, ratio: 4.3, mv: 2800, v: 12.04 }],
                        current: { pin: 34, irms: 0.5, ipk: 0.7, mean_mv: 1650, clip: 0, n: 800 },
                        relays: state.relays.map(r => ({ ...r })),
                        dht: { pin: 4, ok: 1, t: 28.5, h: 65.0, age: 1, err: 0 },
                        aux: auxState()
                    })
                };
            }
            if (u.pathname === '/api/relay') {
                const ch = u.searchParams.get('ch');
                const st = u.searchParams.get('state') === '1' ? 1 : 0;
                if (ch === 'all') {
                    state.relays.forEach(r => { r.on = st; });
                } else {
                    const idx = Number(ch) - 1;
                    state.relays[idx].on = st;
                }
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        ok: true,
                        relays: state.relays.map(r => ({ ...r })),
                        aux: auxState()
                    })
                };
            }
            throw new Error('unexpected URL ' + url);
        }
    };
    vm.runInNewContext(source('esp32.js'), context);
    const app = { get: (u, f) => { routes['GET ' + u] = f; }, post: (u, f) => { routes['POST ' + u] = f; } };
    const api = context.module.exports({ app, broadcast: m => messages.push(m), notify: m => notes.push(m) });
    return {
        api, routes, messages, notes, requests, state,
        get(url) { const res = response(); routes['GET ' + url]({}, res); return res; },
        async post(url, body) {
            const res = response();
            await routes['POST ' + url]({ body }, res);
            for (let i = 0; i < 50 && !res.body; i++) await new Promise(r => setImmediate(r));
            return res;
        }
    };
}

test('firmware ESP32: pendamping Relay 1 & 2 memakai GPIO 23 (ON) & GPIO 22 (OFF) aktif HIGH', () => {
    const ino = source('frimware/esp32 server sensor.ino');
    assert.match(ino, /#define\s+PIN_AUX_ON\s+23\b/);
    assert.match(ino, /#define\s+PIN_AUX_OFF\s+22\b/);
    assert.match(ino, /#define\s+AUX_ACTIVE_LOW\s+0\b/);
    assert.match(ino, /#define\s+AUX_RELAY_IDX\s+0\b/);
    // Simulasi logika setAux(relayOn) dari firmware dengan AUX_ACTIVE_LOW = 0
    const AUX_ACTIVE_LOW = 0;
    const setAux = relayOn => ({
        gpio23: (relayOn === !AUX_ACTIVE_LOW) ? 'HIGH' : 'LOW',
        gpio22: (!relayOn === !AUX_ACTIVE_LOW) ? 'HIGH' : 'LOW'
    });
    // Relay 1 & 2 ON -> GPIO 23 ON (HIGH), GPIO 22 OFF (LOW)
    assert.deepEqual(setAux(true), { gpio23: 'HIGH', gpio22: 'LOW' });
    // Relay 1 & 2 OFF -> GPIO 22 ON (HIGH), GPIO 23 OFF (LOW)
    assert.deepEqual(setAux(false), { gpio23: 'LOW', gpio22: 'HIGH' });
});

test('esp32: status awal Relay 1 & 2 OFF -> GPIO 22 ON dan GPIO 23 OFF, saat ON -> GPIO 23 ON dan GPIO 22 OFF', async () => {
    const f = esp32Fixture({ RELAY_LABELS: 'Relay 1' });
    f.api.start();
    await new Promise(r => setImmediate(r));

    // Saat Relay 1 & 2 OFF: GPIO 22 ON (1), GPIO 23 OFF (0), nama bawaan "Relay 1 & 2" tetap utuh
    let snap = f.api.snapshot();
    assert.equal(snap.relays[0].name, 'Relay 1 & 2');
    assert.equal(snap.relays[0].on, false);
    assert.deepEqual({ ...snap.aux }, { relay: 1, on_pin: 23, off_pin: 22, on: 0, off: 1 });

    // Nyalakan Relay 1 & 2 -> GPIO 23 ON (1), GPIO 22 OFF (0)
    await f.api.setRelay('1&2', true);
    snap = f.api.snapshot();
    assert.equal(snap.relays[0].on, true);
    assert.deepEqual({ ...snap.aux }, { relay: 1, on_pin: 23, off_pin: 22, on: 1, off: 0 });

    // Matikan Relay 1 & 2 -> GPIO 22 ON (1), GPIO 23 OFF (0)
    await f.api.setRelay(1, false);
    snap = f.api.snapshot();
    assert.equal(snap.relays[0].on, false);
    assert.deepEqual({ ...snap.aux }, { relay: 1, on_pin: 23, off_pin: 22, on: 0, off: 1 });
});

test('esp32: POST /api/esp32/relay menerima kanal 1..3, 1&2, 4 (Relay 4), dan all', async () => {
    const f = esp32Fixture();
    f.api.start();
    await new Promise(r => setImmediate(r));

    const r1 = await f.post('/api/esp32/relay', { id: '1&2', state: true });
    assert.equal(r1.code, 200);
    assert.equal(r1.body.success, true);
    assert.equal(r1.body.aux.on_pin, 23);
    assert.equal(r1.body.aux.off_pin, 22);
    assert.equal(r1.body.aux.on, 1);
    assert.equal(r1.body.aux.off, 0);

    // Relay 3 dipetakan ke kanal 2 ESP32 (GPIO 27, aktif LOW -> LOW saat ON)
    const r3 = await f.post('/api/esp32/relay', { id: 3, state: true });
    assert.equal(r3.code, 200);
    assert.equal(r3.body.relays[1].id, 3);
    assert.equal(r3.body.relays[1].pin, 27);
    assert.equal(r3.body.relays[1].name, 'Relay 3');
    assert.equal(r3.body.relays[1].on, true);
    assert.equal(r3.body.relays[2].on, false); // Relay 4 (GPIO 32) tidak ikut menyala saat Relay 3 dinyalakan

    // Relay 3 juga bisa dikontrol lewat nama/alias AI ("Relay 3", "r3", "gpio 27")
    await f.api.setRelay('Relay 3', false);
    assert.equal(f.api.snapshot().relays[1].on, false);
    await f.api.setRelay('gpio 27', true);
    assert.equal(f.api.snapshot().relays[1].on, true);

    // Relay 4 dipetakan ke kanal 3 ESP32 (GPIO 32)
    const r4 = await f.post('/api/esp32/relay', { id: 4, state: true });
    assert.equal(r4.code, 200);
    assert.equal(r4.body.relays[2].id, 4);
    assert.equal(r4.body.relays[2].pin, 32);
    assert.equal(r4.body.relays[2].on, true);

    // Matikan semua relay -> GPIO 22 kembali ON, GPIO 23 OFF
    const allOff = await f.post('/api/esp32/relay', { id: 'all', state: false });
    assert.equal(allOff.code, 200);
    assert.equal(allOff.body.relays.every(r => !r.on), true);
    assert.equal(allOff.body.aux.on, 0);
    assert.equal(allOff.body.aux.off, 1);

    // Kanal tidak valid ditolak 400
    const bad = await f.post('/api/esp32/relay', { id: 9, state: true });
    assert.equal(bad.code, 400);
    assert.equal(bad.body.success, false);
});

test('esp32: RELAY_LABELS generik tidak menyembunyikan atau menggeser Relay 3 (GPIO 27)', async () => {
    for (const rawLabels of ['Relay 1, Relay 2', 'Relay 1, Relay 2, Relay 3', 'Relay 1, Relay 2, Relay 3, Relay 4']) {
        const f = esp32Fixture({ RELAY_LABELS: rawLabels });
        f.api.start();
        await new Promise(r => setImmediate(r));
        const rels = f.api.snapshot().relays;
        assert.deepEqual(
            rels.map(r => ({ id: r.id, ch: r.ch, name: r.name, pin: r.pin })),
            [
                { id: 1, ch: 1, name: 'Relay 1 & 2', pin: 26 },
                { id: 3, ch: 2, name: 'Relay 3', pin: 27 },
                { id: 4, ch: 3, name: 'Relay 4', pin: 32 }
            ]
        );
    }
});
