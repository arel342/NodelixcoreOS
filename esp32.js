const fs = require('fs');
const path = require('path');
const T = require('./lang');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

// Kurva tegangan -> SoC per sel Li-ion 4.2 V (kondisi istirahat).
// Hanya estimasi: tegangan turun saat ada beban dan naik saat charging.
const SOC = [[3.0, 0], [3.45, 5], [3.68, 10], [3.74, 20], [3.77, 30], [3.79, 40], [3.82, 50], [3.87, 60], [3.92, 70], [3.98, 80], [4.06, 90], [4.2, 100]];
function soc(v) {
    if (v <= SOC[0][0]) return 0;
    for (let i = 1; i < SOC.length; i++) {
        if (v <= SOC[i][0]) {
            const a = SOC[i - 1], b = SOC[i];
            return a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]);
        }
    }
    return 100;
}

const defaults = () => ({
    taps: { s1: { gain: 1, offset: 0 }, s2: { gain: 1, offset: 0 }, s3: { gain: 1, offset: 0 } },
    i: { floor: 0, gain: 1 }   // floor = noise arus saat tanpa beban (A), gain = faktor skala arus
});

module.exports = ({ app, broadcast, notify }) => {
    // ---------- Kalibrasi (disimpan di data/calibration.json) ----------
    const CAL_FILE = path.join(__dirname, 'data', 'calibration.json');
    let cal = defaults();
    try {
        const j = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        cal = { taps: { ...cal.taps, ...j.taps }, i: { ...cal.i, ...j.i } };
    } catch { }
    const saveCal = () => {
        fs.mkdirSync(path.dirname(CAL_FILE), { recursive: true });
        fs.writeFileSync(CAL_FILE, JSON.stringify(cal, null, 2));
    };

    let raw = null, online = false, everOnline = false, fails = 0, lastOk = 0, zeroing = null, timer = null;
    const hist = [], cnt = {}, act = {}, lastMsg = {};
    const labels = E('RELAY_LABELS', '').split(',').map(s => s.trim());
    const base = () => `http://${E('ESP32_IP', '')}:${N('ESP32_PORT', 80)}`;

    async function call(p, method = 'GET') {
        const r = await fetch(base() + p, { method, headers: { 'X-API-Key': E('ESP32_API_KEY', '') }, signal: AbortSignal.timeout(2500) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    // ---------- Hitung nilai terkoreksi ----------
    function compute() {
        if (!raw) return null;
        const t = {};
        raw.battery.forEach(b => {
            if (b.en) { const c = cal.taps[b.id]; t[b.id] = { raw: b.v, v: b.v * c.gain + c.offset }; }
        });

        let cells = null, mode = 'pack';
        if (t.s1 && t.s2 && t.s3) { cells = [t.s1.v, t.s2.v - t.s1.v, t.s3.v - t.s2.v]; mode = 'cells'; }   // 3 tap terpasang: tegangan per sel
        else if (t.s3) cells = Array(3).fill(t.s3.v / 3);                                                     // hanya pack: rata-rata sel

        let battery = null;
        if (cells) {
            const socs = cells.map(soc), avg = socs.reduce((a, b) => a + b, 0) / 3;
            const lo = Math.min(...cells), hi = Math.max(...cells);
            let statusKey = 'normal', level = 'ok';
            if (hi > N('CELL_V_MAX', 4.25)) { statusKey = 'high'; level = 'bad'; }
            else if (lo < N('CELL_V_CRIT', 3.2)) { statusKey = 'crit'; level = 'bad'; }
            else if (lo < N('CELL_V_LOW', 3.4) || avg < 20) { statusKey = 'low'; level = 'warn'; }
            else if (avg >= 95) statusKey = 'full';
            battery = {
                mode, pack: t.s3.v, cells, socs, soc: avg, min: lo, max: hi, delta: hi - lo,
                status: T('bat.' + statusKey), statusKey, level,
                raw: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.raw]))
            };
        }

        // Arus: kurangi noise (kuadrat), kalikan gain, lalu dead-band
        const c = raw.current;
        let i = Math.sqrt(Math.max(0, c.irms ** 2 - cal.i.floor ** 2)) * cal.i.gain;
        if (i < N('I_DEADBAND_A', 0.05)) i = 0;
        const current = { a: i, peak: c.ipk * cal.i.gain, clip: !!c.clip, va: i * N('AC_VOLTAGE_NOMINAL', 220) * N('AC_POWER_FACTOR', 1) };
        return { battery, current };
    }

    // ---------- Alarm (butuh 3 pembacaan berturut-turut, notifikasi Telegram maks 1x / 5 menit per jenis) ----------
    function note(text, key) {
        console.log('[ESP32]', text);
        if (E('TELEGRAM_ALERTS', 'true') === 'false') return;
        if (key && lastMsg[key] && Date.now() - lastMsg[key] < 300000) return;
        if (key) lastMsg[key] = Date.now();
        notify(text);
    }
    // Alarm menyimpan key + variabel (v) supaya web bisa menampilkan pesan dalam bahasa yang dipilih
    function chk(key, cond, k, v, level = 'warn') {
        cnt[key] = cond ? (cnt[key] || 0) + 1 : 0;
        if (cnt[key] >= 3 && !act[key]) { act[key] = { k, v, level }; note('⚠️ ' + T('esp.alert.' + k, v), key); }
        else if (act[key] && cond) { act[key].k = k; act[key].v = v; }
        else if (act[key] && !cond) { note(T('esp.tgRecover') + T('esp.alert.' + act[key].k, act[key].v), key + '_ok'); delete act[key]; }
    }
    function evaluate(c) {
        const b = c.battery;
        if (b) {
            chk('crit', b.min < N('CELL_V_CRIT', 3.2), 'crit', { v: b.min.toFixed(2) }, 'crit');
            chk('low', b.min < N('CELL_V_LOW', 3.4) && b.min >= N('CELL_V_CRIT', 3.2), 'low', { v: b.min.toFixed(2) });
            chk('high', b.max > N('CELL_V_MAX', 4.25), 'high', { v: b.max.toFixed(2) }, 'crit');
            if (b.mode === 'cells') chk('delta', b.delta > N('CELL_DELTA_WARN', 0.1), 'delta', { v: b.delta.toFixed(2) });
        }
        chk('amp', c.current.a > N('I_WARN_A', 5), 'amp', { a: c.current.a.toFixed(2) });
        chk('clip', c.current.clip, 'clip', {}, 'crit');
    }

    // ---------- DHT11 (suhu & kelembapan) ----------
    // Firmware lama belum mengirim "dht" -> null (web menampilkan petunjuk, bukan error).
    function dhtOf(j) {
        const d = j && j.dht;
        if (!d) return null;
        const ok = !!d.ok && Number.isFinite(d.t) && Number.isFinite(d.h);
        return { ok, t: ok ? d.t : null, h: ok ? d.h : null, pin: d.pin, age: d.age, err: d.err };
    }

    // ---------- Snapshot untuk dashboard ----------
    function snapshot() {
        const c = compute() || {};
        return {
            online, lastOk, fails,
            esp: raw && { ip: raw.ip, rssi: raw.rssi, uptime: raw.uptime, fw: raw.fw, heap: raw.heap },
            battery: c.battery || null,
            current: c.current || null,
            dht: dhtOf(raw),
            aux: (raw && raw.aux) || null,   // GPIO pendamping Relay 1 & 2 (GPIO 12 = ON, GPIO 13 = OFF)
            relays: (raw ? raw.relays : []).map((r, i) => ({ ...r, name: labels[i] || r.name })),
            alerts: Object.entries(act).map(([key, a]) => ({ key, ...a })),
            cal, zeroing: !!zeroing,
            limits: { iWarn: N('I_WARN_A', 5) }
        };
    }
    const push = () => broadcast({ type: 'SENSOR', data: snapshot() });

    function ingest(j) {
        raw = j; fails = 0; lastOk = Date.now();
        if (!online) {
            online = true;
            if (everOnline) note(T('esp.tgBack'), 'online');
            everOnline = true;
        }
        if (zeroing) {   // kalibrasi nol: abaikan 5 pembacaan awal (filter masih menyesuaikan), rata-ratakan 5 berikutnya
            zeroing.push(j.current.irms);
            if (zeroing.length >= 10) {
                cal.i.floor = zeroing.slice(5).reduce((a, b) => a + b, 0) / 5;
                zeroing = null; saveCal();
            }
        }
        const c = compute();
        if (c) {
            const d = dhtOf(j);
            hist.push({ t: Date.now(), v: c.battery ? c.battery.pack : null, i: c.current.a, tc: d ? d.t : null, h: d ? d.h : null });
            if (hist.length > 300) hist.shift();
            evaluate(c);
        }
        push();
    }

    async function poll() {
        try { ingest(await call('/api/data')); }
        catch (e) {
            fails++;
            if (fails >= N('ESP32_OFFLINE_AFTER', 3) && online) { online = false; note(T('esp.tgOff', { e: e.message }), 'offline'); }
            push();
        }
        timer = setTimeout(poll, N('ESP32_POLL_MS', 1000));
    }

    // ---------- Routes (semua sudah dilindungi login di server.js) ----------
    app.get('/api/esp32/status', (req, res) => res.json({ ...snapshot(), history: hist }));

    async function setRelay(id, state) {
        const ch = id === 'all' ? 'all' : parseInt(id, 10);
        const max = raw ? raw.relays.length : 3;
        if (ch !== 'all' && !(ch >= 1 && ch <= max)) throw new Error(T('esp.badChannel'));
        const j = await call(`/api/relay?ch=${ch}&state=${state ? 1 : 0}`, 'POST');
        if (raw && j.relays) raw.relays = j.relays;
        push();
    }

    app.post('/api/esp32/relay', async (req, res) => {
        const { id, state } = req.body || {};
        if (state !== true && state !== false && state !== 0 && state !== 1) return res.status(400).json({ success: false, message: T('esp.badChannel') });
        setRelay(id, !!state).then(() => res.json({ success: true }))
            .catch(e => res.status(e.message === T('esp.badChannel') ? 400 : 502).json({ success: false, message: e.message === T('esp.badChannel') ? e.message : T('esp.noResp', { e: e.message }) }));
    });

    app.post('/api/esp32/calibrate', (req, res) => {
        const { type, id, actual } = req.body || {};
        const a = parseFloat(actual);
        const bad = m => res.status(400).json({ success: false, message: m });
        const okGain = g => g >= 0.5 && g <= 2;

        if (type === 'tap') {
            const b = raw && raw.battery.find(x => x.id === id && x.en);
            if (!b || !(a > 0) || !(b.v > 0)) return bad(T('esp.calNoData'));
            if (!okGain(a / b.v)) return bad(T('esp.calBigDiff'));
            cal.taps[id] = { gain: a / b.v, offset: 0 };
        } else if (type === 'i-zero') {
            if (!online) return bad(T('esp.offline'));
            zeroing = [];
            push();
            return res.json({ success: true, message: T('esp.zeroing') });
        } else if (type === 'i-gain') {
            const cur = raw && Math.sqrt(Math.max(0, raw.current.irms ** 2 - cal.i.floor ** 2));
            if (!cur || cur < 0.2 || !(a > 0)) return bad(T('esp.calSmall'));
            if (!okGain(a / cur)) return bad(T('esp.calBigDiff2'));
            cal.i.gain = a / cur;
        } else if (type === 'reset') {
            cal = defaults();
        } else return bad(T('esp.calUnknown'));

        saveCal(); push();
        res.json({ success: true, message: T('esp.calSaved') });
    });

    return {
        snapshot,
        setRelay,
        start() { if (!E('ESP32_IP', '')) console.log('[ESP32] ESP32_IP belum diisi di .env'); poll(); },
        stop() { clearTimeout(timer); }
    };
};
