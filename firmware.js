// Update firmware ESP8266 (pintu RFID) & ESP32 (monitor PLTS) memakai file .bin — OTA lewat jaringan.
//
// Alur:
//   1. File .bin dipilih di web (tab Update Firmware) atau di menu Termux (`node update-fw.js`).
//   2. Server memeriksa file: ekstensi harus .bin, isinya harus gambar firmware ESP (byte awal 0xE9).
//      Kalau bukan .bin, permintaan ditolak dan web menampilkan peringatan.
//   3. Server mengirim file itu ke ESP: POST /api/ota (multipart) dengan header X-API-Key.
//   4. Firmware ESP menulis flash lewat library Update, menjawab hasilnya, lalu restart sendiri.
//   5. Server menunggu ESP hidup lagi dan membaca versi firmware barunya.
//
// Route (semua sudah dilindungi login di server.js):
//   GET  /api/firmware        -> daftar perangkat, status online, versi firmware, batas ukuran
//   POST /api/firmware/flash  -> multipart: device=esp8266|esp32, file=<firmware>.bin
//
// Pengaturan opsional di .env:
//   OTA_MAX_MB=4        ukuran maksimal file .bin yang diterima web (MB)
//   OTA_TIMEOUT_S=240   batas waktu mengirim firmware ke ESP (detik)
//   OTA_WAIT_S=60       batas waktu menunggu ESP hidup lagi setelah restart (detik)
const multer = require('multer');
const T = require('./lang');
const fwstate = require('./fwstate');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

// Gambar firmware ESP8266 dan ESP32 sama-sama dimulai dengan byte 0xE9 (magic image header).
const IMG_MAGIC = 0xE9;
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');

// Perangkat yang bisa diupdate: cara mengambil status & alamatnya di .env
const DEVICES = {
    esp8266: { ip: 'DOOR_IP', port: 'DOOR_PORT', key: 'DOOR_API_KEY', status: '/api/status', name: () => T('fw.dev8266') },
    esp32: { ip: 'ESP32_IP', port: 'ESP32_PORT', key: 'ESP32_API_KEY', status: '/api/data', name: () => T('fw.dev32') }
};
const DEV_KEYS = Object.keys(DEVICES);
const isDevice = d => DEV_KEYS.includes(d);
const maxBytes = () => Math.max(1, N('OTA_MAX_MB', 4)) * 1024 * 1024;

// Pemeriksaan file sebelum dikirim ke ESP. Hasil: { ok } atau { ok:false, code:'ext'|'image', message }
function checkFile(name, buf) {
    const n = String(name || '').trim();
    if (!/\.bin$/i.test(n)) return { ok: false, code: 'ext', message: T('fw.notBin') };
    if (!buf || buf.length < 16) return { ok: false, code: 'image', message: T('fw.notImage') };
    if (buf[0] !== IMG_MAGIC) return { ok: false, code: 'image', message: T('fw.notImage', { h: ' (' + hex(buf.subarray(0, 4)) + ')' }) };
    return { ok: true };
}

const addr = device => `http://${E(DEVICES[device].ip, '')}:${N(DEVICES[device].port, 80)}`;
const apiKey = device => E(DEVICES[device].key, '');
const devName = device => DEVICES[device].name();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Baca status perangkat (dipakai untuk menunggu ESP hidup lagi & mengambil versi firmware)
async function readStatus(device, timeoutMs = 2500) {
    const r = await fetch(addr(device) + DEVICES[device].status, {
        headers: { 'X-API-Key': apiKey(device) }, signal: AbortSignal.timeout(timeoutMs)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
}

// ----- Kirim file firmware ke ESP (dipakai web & menu Termux) -----
// device: 'esp8266' | 'esp32'   buf: isi file .bin   opt.onPhase({phase, message})
// Hasil: { fw, ms, waited }  ->  fw = versi firmware yang dilaporkan perangkat setelah restart
async function flash(device, buf, opt = {}) {
    if (!isDevice(device)) throw new Error(T('fw.badDevice'));
    if (!E(DEVICES[device].ip, '')) throw new Error(T('fw.noIp', { k: DEVICES[device].ip }));
    const say = p => { if (opt.onPhase) opt.onPhase(p); };
    const started = Date.now();

    say({ phase: 'send', message: T('fw.sending', { dev: devName(device) }) });
    const fd = new FormData();
    fd.append('firmware', new Blob([buf], { type: 'application/octet-stream' }), `firmware-${device}.bin`);
    let j = {};
    try {
        const r = await fetch(addr(device) + '/api/ota', {
            method: 'POST',
            headers: { 'X-API-Key': apiKey(device) },
            body: fd,
            signal: AbortSignal.timeout(N('OTA_TIMEOUT_S', 240) * 1000)
        });
        j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok !== true) throw new Error(j.error || j.message || ('HTTP ' + r.status));
    } catch (e) {
        const msg = /abort|timeout/i.test(e.name + ' ' + e.message)
            ? T('fw.timeout', { s: N('OTA_TIMEOUT_S', 240) })
            : T('fw.espFail', { e: e.message });
        throw new Error(msg);
    }

    // ESP menjawab "ok" -> firmware sudah ditulis, perangkat restart sendiri. Tunggu sampai hidup lagi.
    say({ phase: 'reboot', message: T('fw.reboot', { dev: devName(device) }) });
    const limit = N('OTA_WAIT_S', 60) * 1000;
    const until = Date.now() + limit;
    let fw = '', waited = 0;
    while (Date.now() < until) {
        await sleep(1500);
        try {
            const s = await readStatus(device);
            fw = (s && s.fw) || '';
            waited = Date.now() - started;
            break;
        } catch { /* masih restart, coba lagi */ }
    }
    const out = { fw, ms: Date.now() - started, waited: Math.round(waited / 1000) };
    if (!fw) out.warning = T('fw.noreboot', { dev: devName(device), s: Math.round(limit / 1000) });
    say({ phase: 'done', message: out.warning || T('fw.doneMsg', { dev: devName(device) }), ...out });
    return out;
}

// ================= Bagian web (Express) =================
// esp32 & door: modul perangkat dari server.js, dipakai untuk membaca status online & versi firmware
module.exports = ({ app, broadcast, notify, esp32, door }) => {
    const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: maxBytes() } });
    const tgOn = () => E('TELEGRAM_ALERTS', 'true') !== 'false';
    let last = null;   // hasil update terakhir, ditampilkan lagi saat tab dibuka

    const say = data => broadcast({ type: 'FW', data: { ...data, at: Date.now() } });

    function status(device) {
        const s = device === 'esp8266' ? door.snapshot() : esp32.snapshot();
        const esp = s.esp || {};
        return {
            key: device, label: devName(device),
            host: E(DEVICES[device].ip, ''), port: N(DEVICES[device].port, 80),
            configured: device === 'esp8266' ? !!s.configured : !!E('ESP32_IP', ''),
            online: !!s.online, fw: esp.fw || '', ip: esp.ip || '', rssi: esp.rssi, uptime: esp.uptime,
            updating: fwstate.isBusy(device)
        };
    }

    app.get('/api/firmware', (req, res) => res.json({
        devices: DEV_KEYS.map(status),
        maxMB: N('OTA_MAX_MB', 4),
        busy: fwstate.isBusy(),
        busyDevice: DEV_KEYS.find(k => fwstate.isBusy(k)) || '',
        last
    }));

    app.post('/api/firmware/flash', (req, res) => {
        upload.single('file')(req, res, async err => {
            if (err) {
                const big = err.code === 'LIMIT_FILE_SIZE';
                return res.status(big ? 413 : 400).json({ error: big ? T('fw.tooBig', { m: N('OTA_MAX_MB', 4) }) : (err.message || T('fw.uploadFail')) });
            }
            const device = String((req.body || {}).device || '');
            if (!isDevice(device)) return res.status(400).json({ error: T('fw.badDevice') });
            if (!req.file) return res.status(400).json({ error: T('fw.noFile') });
            // Peringatan file bukan .bin / bukan gambar firmware ESP
            const chk = checkFile(req.file.originalname, req.file.buffer);
            if (!chk.ok) return res.status(400).json({ error: chk.message, code: chk.code });
            if (fwstate.isBusy()) return res.status(409).json({ error: T('fw.busy') });

            const dev = devName(device);
            fwstate.set(device, { startedAt: Date.now(), by: 'web', size: req.file.size });
            say({ device, phase: 'send', message: T('fw.sending', { dev }) });
            try {
                const out = await flash(device, req.file.buffer, {
                    onPhase: p => say({ device, ...p })     // 'send' -> 'reboot' -> 'done'
                });
                last = { at: Date.now(), device, ok: true, fw: out.fw, ms: out.ms, size: req.file.size };
                const msg = T('fw.ok', { dev, fw: out.fw ? T('fw.okFw', { fw: out.fw }) : '' }) + (out.warning ? ' ' + out.warning : '');
                if (tgOn()) notify(T('fw.tgOk', { dev, fw: out.fw ? T('fw.okFw', { fw: out.fw }) : '' }));
                res.json({ success: true, message: msg, device, fw: out.fw, ms: out.ms, warning: out.warning || '' });
            } catch (e) {
                last = { at: Date.now(), device, ok: false, error: e.message, size: req.file.size };
                say({ device, phase: 'error', message: T('fw.failMsg', { dev }) + ' ' + e.message });
                if (tgOn()) notify(T('fw.tgFail', { dev, e: e.message }));
                res.status(502).json({ success: false, message: e.message, device });
            } finally {
                fwstate.set(device, null);
            }
        });
    });

    return { list: () => DEV_KEYS.map(status), flash, checkFile, isDevice, maxBytes };
};

module.exports.flash = flash;         // dipakai menu Termux (update-fw.js)
module.exports.checkFile = checkFile;
module.exports.isDevice = isDevice;
module.exports.DEVICES = DEVICES;
module.exports.maxBytes = maxBytes;
