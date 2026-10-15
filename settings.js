// ============================================================================
// settings.js — Pengaturan lewat web (tab Pengaturan), tanpa mengedit .env di Termux.
//
// Tujuan: setelah setup awal di browser, semua nilai penting diubah dari halaman web —
// IP/port/kunci API ESP32 & ESP8266 (pintu RFID), token + chat ID Telegram, kunci API
// Gemini untuk AI Agent, batas alarm monitoring baterai/arus, sampai akun admin. Nilai
// disimpan ke .env (saveEnv dari server.js) dan langsung dipakai proses yang sedang
// berjalan, jadi tidak perlu restart aplikasi. Perangkat yang sebelumnya belum diisi
// IP-nya otomatis mulai dipantau; kunci Gemini yang baru diisi langsung dipakai /ai.
//
// Kelompok "ai" ({ enabled, apiKey, model }) adalah kelompok yang sama yang dipakai
// langkah AI Agent di halaman setup awal (setup.js), sehingga keduanya menulis
// AI_AGENT_ENABLED / GEMINI_API_KEY / GEMINI_MODEL dengan validasi yang sama.
//
// Route di bawah ini sudah dilindungi login di server.js (lihat daftar requireAuth):
//   GET  /api/settings               -> seluruh nilai pengaturan + info server
//   POST /api/settings               -> simpan sebagian pengaturan { esp32:{...}, ai:{...} }
//   POST /api/settings/account       -> ubah username / password admin (butuh password lama)
//   POST /api/settings/telegram/test -> kirim pesan uji ke Telegram
//   POST /api/settings/device/test   -> uji koneksi ke ESP32 / ESP8266
//   POST /api/settings/device/push   -> kirim WiFi + IP + kunci API baru ke ESP (tanpa colok USB)
//   POST /api/settings/device/portal -> minta ESP masuk mode setup (WiFi sendiri + halaman web)
// ============================================================================
const T = require('./lang');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const bool = v => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on');

// ---------- Validasi nilai ----------
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;     // alamat IP atau nama host
const KEY_RE = /^[!-~]{1,64}$/;                          // kunci API/token: tanpa spasi & baris baru
const CHAT_RE = /^(-?\d{4,20}|@[A-Za-z0-9_]{4,32})$/;    // chat ID Telegram atau @username
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIpv4 = v => { const m = IPV4_RE.exec(String(v || '')); return !!m && m.slice(1).every(x => +x <= 255); };

const bad = m => { const e = new Error(m); e.status = 400; return e; };

// Alamat perangkat: IPv4 (ketat, mis. 999.1.1.1 ditolak) atau nama host (mis. esp32.local)
const vHost = (v, k) => {
    v = String(v == null ? '' : v).trim();
    if (!v) return '';
    if (/^[0-9.]+$/.test(v)) {                    // hanya angka & titik -> wajib IPv4 yang benar
        if (!isIpv4(v)) throw bad(T('set.badIp', { k }));
        return v;
    }
    if (!HOST_RE.test(v)) throw bad(T('set.badIp', { k }));
    return v;
};
const vPort = (v, k) => { const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad(T('set.badPort', { k })); return String(n); };
const vKey = (v, k) => { v = String(v == null ? '' : v).trim(); if (!v) return ''; if (!KEY_RE.test(v)) throw bad(T('set.badKey', { k })); return v; };
const vText = (v, max, k) => { const s = String(v == null ? '' : v); if (s.length > max || /[\r\n]/.test(s)) throw bad(T('set.badText', { k, max })); return s.trim(); };
const vNum = (min, max, k) => v => { const n = parseFloat(v); if (!Number.isFinite(n) || n < min || n > max) throw bad(T('set.badNum', { k, min, max })); return String(n); };
const vChat = v => { v = String(v == null ? '' : v).trim(); if (!v) return ''; if (!CHAT_RE.test(v)) throw bad(T('set.badChat')); return v; };
const vTok = v => { v = String(v == null ? '' : v).trim(); if (!v) return ''; if (!KEY_RE.test(v) || v.length < 8) throw bad(T('set.badKey', { k: 'TELEGRAM_BOT_TOKEN' })); return v; };
const vBool = v => bool(v) ? 'true' : 'false';
const DEFAULT_AI_MODEL = 'gemini-3.5-flash-lite';
const RETIRED_AI_MODEL_RE = /^gemini-(1\.\d|2\.\d|pro(-vision)?)(-[a-z0-9.-]+)?$/i;
const normAiModel = v => { const s = String(v == null ? '' : v).trim().replace(/^models\//i, ''); return (!s || RETIRED_AI_MODEL_RE.test(s)) ? DEFAULT_AI_MODEL : s; };

// ---------- Daftar nilai yang boleh diubah dari web ----------
// env  : nama variabel di .env      get : nilai sekarang      set : validasi + nilai baru
const FIELDS = {
    esp32: {
        ip: { env: 'ESP32_IP', get: () => E('ESP32_IP', ''), set: v => vHost(v, 'ESP32_IP') },
        port: { env: 'ESP32_PORT', get: () => N('ESP32_PORT', 80), set: v => vPort(v, 'ESP32_PORT') },
        apiKey: { env: 'ESP32_API_KEY', get: () => E('ESP32_API_KEY', ''), set: v => vKey(v, 'ESP32_API_KEY') },
        pollMs: { env: 'ESP32_POLL_MS', get: () => N('ESP32_POLL_MS', 1000), set: vNum(200, 60000, 'ESP32_POLL_MS') },
        labels: { env: 'RELAY_LABELS', get: () => E('RELAY_LABELS', ''), set: v => vText(v, 120, 'RELAY_LABELS') }
    },
    door: {
        ip: { env: 'DOOR_IP', get: () => E('DOOR_IP', ''), set: v => vHost(v, 'DOOR_IP') },
        port: { env: 'DOOR_PORT', get: () => N('DOOR_PORT', 80), set: v => vPort(v, 'DOOR_PORT') },
        apiKey: { env: 'DOOR_API_KEY', get: () => E('DOOR_API_KEY', ''), set: v => vKey(v, 'DOOR_API_KEY') },
        enrollSec: { env: 'DOOR_ENROLL_SECONDS', get: () => N('DOOR_ENROLL_SECONDS', 30), set: vNum(5, 300, 'DOOR_ENROLL_SECONDS') },
        pollMs: { env: 'DOOR_POLL_MS', get: () => N('DOOR_POLL_MS', 1000), set: vNum(200, 60000, 'DOOR_POLL_MS') },
        notifyOpen: { env: 'DOOR_NOTIFY_OPEN', get: () => E('DOOR_NOTIFY_OPEN', 'false') === 'true', set: vBool },
        notifyUnknown: { env: 'DOOR_NOTIFY_UNKNOWN', get: () => E('DOOR_NOTIFY_UNKNOWN', 'false') === 'true', set: vBool }
    },
    telegram: {
        alerts: { env: 'TELEGRAM_ALERTS', get: () => E('TELEGRAM_ALERTS', 'true') !== 'false', set: vBool },
        token: { env: 'TELEGRAM_BOT_TOKEN', get: () => E('TELEGRAM_BOT_TOKEN', ''), set: vTok },
        chatId: { env: 'TELEGRAM_CHAT_ID', get: () => E('TELEGRAM_CHAT_ID', ''), set: vChat }
    },
    ai: {
        enabled: { env: 'AI_AGENT_ENABLED', get: () => E('AI_AGENT_ENABLED', 'true') !== 'false', set: vBool },
        apiKey: { env: 'GEMINI_API_KEY', get: () => E('GEMINI_API_KEY', ''), set: v => vKey(v, 'GEMINI_API_KEY') },
        model: { env: 'GEMINI_MODEL', raw: () => E('GEMINI_MODEL', ''), get: () => normAiModel(E('GEMINI_MODEL', DEFAULT_AI_MODEL)), set: v => normAiModel(vText(v, 64, 'GEMINI_MODEL')) }
    },
    server: {
        port: { env: 'PORT', get: () => N('PORT', 3000), set: v => vPort(v, 'PORT') },
        sessionHours: { env: 'SESSION_TTL_HOURS', get: () => N('SESSION_TTL_HOURS', 24), set: vNum(1, 720, 'SESSION_TTL_HOURS') },
        storageFolder: { env: 'STORAGE_FOLDER', get: () => E('STORAGE_FOLDER', 'upload'), set: v => { const s = vText(v, 40, 'STORAGE_FOLDER').replace(/[\\/]/g, ''); if (!s) throw bad(T('set.badText', { k: 'STORAGE_FOLDER', max: 40 })); return s; } },
        otaMaxMB: { env: 'OTA_MAX_MB', get: () => N('OTA_MAX_MB', 4), set: vNum(1, 32, 'OTA_MAX_MB') },
        otaTimeoutS: { env: 'OTA_TIMEOUT_S', get: () => N('OTA_TIMEOUT_S', 240), set: vNum(30, 1800, 'OTA_TIMEOUT_S') },
        otaWaitS: { env: 'OTA_WAIT_S', get: () => N('OTA_WAIT_S', 60), set: vNum(10, 600, 'OTA_WAIT_S') }
    },
    monitor: {
        iWarn: { env: 'I_WARN_A', get: () => N('I_WARN_A', 5), set: vNum(0.1, 100, 'I_WARN_A') },
        cellVMax: { env: 'CELL_V_MAX', get: () => N('CELL_V_MAX', 4.25), set: vNum(3, 5, 'CELL_V_MAX') },
        cellVCrit: { env: 'CELL_V_CRIT', get: () => N('CELL_V_CRIT', 3.2), set: vNum(2, 4, 'CELL_V_CRIT') },
        cellVLow: { env: 'CELL_V_LOW', get: () => N('CELL_V_LOW', 3.4), set: vNum(2, 5, 'CELL_V_LOW') },
        cellDeltaWarn: { env: 'CELL_DELTA_WARN', get: () => N('CELL_DELTA_WARN', 0.1), set: vNum(0, 2, 'CELL_DELTA_WARN') },
        iDeadband: { env: 'I_DEADBAND_A', get: () => N('I_DEADBAND_A', 0.05), set: vNum(0, 5, 'I_DEADBAND_A') },
        acVoltage: { env: 'AC_VOLTAGE_NOMINAL', get: () => N('AC_VOLTAGE_NOMINAL', 220), set: vNum(50, 500, 'AC_VOLTAGE_NOMINAL') },
        acPowerFactor: { env: 'AC_POWER_FACTOR', get: () => N('AC_POWER_FACTOR', 0.8), set: vNum(0.1, 1, 'AC_POWER_FACTOR') }
    }
};
const GROUPS = Object.keys(FIELDS);

// Alamat perangkat + nama .ino / SSID WiFi mode setup (untuk tombol di web)
const DEVICES = {
    esp32: { ipKey: 'ESP32_IP', portKey: 'ESP32_PORT', keyKey: 'ESP32_API_KEY', status: '/api/data', ap: 'Nodelix-ESP32' },
    esp8266: { ipKey: 'DOOR_IP', portKey: 'DOOR_PORT', keyKey: 'DOOR_API_KEY', status: '/api/status', ap: 'Nodelix-DOOR' }
};
const devKey = d => Object.keys(DEVICES).includes(d) ? d : null;

const safeJson = async r => { try { return await r.json(); } catch { return null; } };

module.exports = ({ app, saveEnv, esp32, door, telegram, ai, auth }) => {
    // ---------- Baca / tulis pengaturan ----------
    const readGroup = g => {
        const out = {};
        for (const [name, f] of Object.entries(FIELDS[g])) out[name] = f.get();
        return out;
    };

    // Terapkan { esp32:{...}, door:{...} } -> .env. Hanya field yang dikirim yang diubah.
    // Semua nilai divalidasi dulu, jadi tidak ada .env setengah tersimpan kalau ada yang salah.
    function apply(body) {
        const plan = [], groups = new Set();
        for (const g of GROUPS) {
            const part = body && body[g];
            if (!part || typeof part !== 'object') continue;
            for (const [name, value] of Object.entries(part)) {
                const f = FIELDS[g][name];
                if (!f) continue;                                   // field tak dikenal -> abaikan
                const next = f.set(value);
                const cur = f.raw ? f.raw() : f.get();
                if (String(cur) !== String(next)) plan.push({ env: f.env, value: next });
                groups.add(g);
            }
        }
        for (const p of plan) saveEnv(p.env, p.value);
        // Pemantauan perangkat mengikuti nilai baru (langsung, tanpa restart server).
        // Kalau salah satu modul gagal, nilai yang sudah tersimpan tetap dipertahankan.
        const restart = (name, fn) => { try { fn(); } catch (e) { console.error(`[Setelan] gagal memuat ulang ${name}:`, e.message); } };
        if (groups.has('esp32')) restart('ESP32', () => esp32.reload());
        if (groups.has('door')) restart('pintu', () => door.reload());
        if (groups.has('telegram')) restart('Telegram', () => telegram.restart());
        if (groups.has('ai') && ai && typeof ai.reload === 'function') restart('AI', () => ai.reload());
        return { changed: plan.map(p => p.env), groups: [...groups] };
    }

    function snapshot() {
        const out = {};
        for (const g of GROUPS) out[g] = readGroup(g);
        out.info = {
            port: N('PORT', 3000),
            ips: ips(),
            lang: E('LANGUAGE', 'id'),
            version: version(),
            node: process.version,
            setupDone: !!E('ADMIN_PASSWORD', ''),
            setupRequired: !E('ADMIN_PASSWORD', ''),
            username: E('ADMIN_USERNAME', 'admin'),
            uptime: Math.floor(typeof process.uptime === 'function' ? process.uptime() : 0),
            envFile: '.env'
        };
        return out;
    }

    function ips() {
        try {
            const os = require('os');
            const list = Object.values(os.networkInterfaces()).flat()
                .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
                .sort((a, b) => (/^169\.254\./.test(a) ? 1 : 0) - (/^169\.254\./.test(b) ? 1 : 0));   // link-local paling belakang
            return list.length ? list : ['127.0.0.1'];
        } catch { return ['127.0.0.1']; }
    }
    function version() { try { return require('./package.json').version || ''; } catch { return ''; } }

    // ---------- Route ----------
    app.get('/api/settings', (req, res) => res.json(snapshot()));

    app.post('/api/settings', (req, res) => {
        try {
            const r = apply(req.body || {});
            res.json({ success: true, message: T('set.ok'), ...r });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });

    // ---------- Akun admin ----------
    app.post('/api/settings/account', (req, res) => {
        if (!auth.verify(req, res)) return;                          // password lama wajib benar (+ batas percobaan)
        const { username, newPassword, confirmPassword } = req.body || {};
        const u = String(username == null ? '' : username).trim();
        if (u && !/^[^\s]{3,32}$/.test(u)) return res.status(400).json({ success: false, message: T('set.userBad') });

        if (newPassword || confirmPassword) {
            if (String(newPassword || '').length < 8 || /[\r\n]/.test(String(newPassword))) return res.status(400).json({ success: false, message: T('set.pwShort') });
            if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: T('set.pwMismatch') });
            saveEnv('ADMIN_PASSWORD', String(newPassword));
            auth.keepOnly(req);                                      // sesi lain diputuskan demi keamanan
        }
        if (u) saveEnv('ADMIN_USERNAME', u);
        res.json({ success: true, message: T('set.acctOk') });
    });

    // ---------- Telegram ----------
    app.post('/api/settings/telegram/test', async (req, res) => {
        if (!E('TELEGRAM_BOT_TOKEN', '')) return res.status(400).json({ success: false, message: T('set.tgNoToken') });
        const r = await telegram.test('🔔 Pesan uji dari NodelixcoreOS. Bot Telegram siap dipakai.');
        if (r.ok) return res.json({ success: true, message: T('set.tgTestOk') });
        res.status(502).json({ success: false, message: T('set.tgTestFail', { e: r.error }) });
    });

    // ---------- ESP32 / ESP8266 ----------
    const target = d => {
        const key = devKey(d);
        if (!key) throw bad(T('set.devUnknown'));
        const ip = E(DEVICES[key].ipKey, '');
        if (!ip) throw bad(T('set.devNoIp', { k: DEVICES[key].ipKey }));
        return { key, ip, port: N(DEVICES[key].portKey, 80), apiKey: E(DEVICES[key].keyKey, ''), dev: key === 'esp32' ? T('fw.dev32') : T('fw.dev8266') };
    };

    async function callDevice(t, path, opt = {}) {
        const headers = { 'X-API-Key': t.apiKey };
        if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
        const r = await fetch(`http://${t.ip}:${t.port}${path}`, {
            method: opt.method || 'GET', headers, body: opt.body,
            signal: AbortSignal.timeout(opt.timeout || 8000)
        });
        const text = await r.text();
        let j = {}; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
        if (!r.ok) throw new Error(j.error || j.message || ('HTTP ' + r.status));
        return j;
    }

    app.post('/api/settings/device/test', async (req, res) => {
        let t;
        try { t = target((req.body || {}).device); }
        catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message }); }
        try {
            const j = await callDevice(t, DEVICES[t.key].status, { timeout: 5000 });
            res.json({ success: true, message: T('set.devOk', { dev: t.dev, fw: j.fw || '-' }), device: t.key, fw: j.fw || '', ip: j.ip || '', rssi: j.rssi });
        } catch (e) {
            res.status(502).json({ success: false, message: T('set.devFail', { dev: t.dev, e: e.message }) });
        }
    });

    // Kirim WiFi / IP / kunci API baru ke ESP. Kunci yang dipakai untuk autentikasi adalah
    // kunci yang masih ada di perangkat (deviceKey), sehingga rotasi kunci API pun aman.
    app.post('/api/settings/device/push', async (req, res) => {
        const b = req.body || {};
        let t;
        try { t = target(b.device); }
        catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message }); }

        const body = {};
        try {
            if (b.ssid != null && String(b.ssid).trim() !== '') body.ssid = vText(b.ssid, 32, 'SSID');
            if (b.pass != null && String(b.pass) !== '') body.pass = vText(b.pass, 63, 'WIFI_PASS');
            if (b.dhcp != null) body.dhcp = bool(b.dhcp) ? 1 : 0;
            if (b.dhcp != null && !bool(b.dhcp)) {
                // IP statis: IP, gateway, dan netmask wajib; DNS boleh kosong (ikut gateway)
                for (const [k, name, wajib] of [['ip', 'IP', true], ['gw', 'GW', true], ['mask', 'MASK', true], ['dns', 'DNS', false]]) {
                    const v = String(b[k] == null ? '' : b[k]).trim();
                    if (!v) { if (!wajib) continue; throw bad(T('set.badIp', { k: name })); }
                    if (!isIpv4(v)) throw bad(T('set.badIp', { k: name }));
                    body[k] = v;
                }
                if (!body.dns) body.dns = body.gw;
            }
            if (b.apiKey != null && String(b.apiKey).trim() !== '') body.api_key = vKey(b.apiKey, t.key === 'esp32' ? 'ESP32_API_KEY' : 'DOOR_API_KEY');
            if (b.openSec != null && t.key === 'esp8266') { const s = parseInt(b.openSec, 10); if (!(s >= 0 && s <= 10)) throw bad(T('set.badNum', { k: 'openSec', min: 0, max: 10 })); body.open_sec = s; }
        } catch (e) {
            return res.status(e.status || 400).json({ success: false, message: e.message });
        }
        if (!Object.keys(body).length) return res.status(400).json({ success: false, message: T('set.badBody') });

        const deviceKey = String(b.deviceKey || '').trim() || t.apiKey;   // kunci lama yang masih ada di perangkat
        try {
            const r = await fetch(`http://${t.ip}:${t.port}/api/config`, {
                method: 'POST', headers: { 'X-API-Key': deviceKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
            });
            const j = await safeJson(r);
            if (!r.ok || !(j && j.ok)) {
                // 401 = kunci di perangkat berbeda dengan yang dikirim
                const msg = r.status === 401 ? T('set.pushUnauthorized') : ((j && (j.error || j.message)) || ('HTTP ' + r.status));
                throw new Error(msg);
            }
            res.json({ success: true, message: T('set.pushOk', { dev: t.dev }), device: t.key, saved: (j && j.saved) || '' });
        } catch (e) {
            res.status(502).json({ success: false, message: T('set.pushFail', { dev: t.dev, e: e.message }) });
        }
    });

    // Minta ESP masuk mode setup: perangkat menyalakan WiFi sendiri + halaman pengaturan.
    app.post('/api/settings/device/portal', async (req, res) => {
        let t;
        try { t = target((req.body || {}).device); }
        catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message }); }
        try {
            await callDevice(t, '/api/portal', { method: 'POST', body: '{}', timeout: 5000 });
            res.json({ success: true, message: T('set.portalOk', { dev: t.dev, ssid: DEVICES[t.key].ap }) });
        } catch (e) {
            res.status(502).json({ success: false, message: T('set.portalFail', { dev: t.dev, e: e.message }) });
        }
    });

    return { snapshot, apply, readGroup, ips, FIELDS, DEVICES };
};
