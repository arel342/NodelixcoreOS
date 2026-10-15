// ============================================================================
// setup.js — Setup awal lewat browser (halaman /setup.html).
//
// Alur yang diharapkan (sesuai panduan di halaman setup):
//   1. Buat username + password admin  ->  ADMIN_USERNAME / ADMIN_PASSWORD di .env
//   2. (otomatis) Tampilkan alamat web server: IP Termux + port
//   3. Isi port + kunci API ESP32      ->  ESP32_IP / ESP32_PORT / ESP32_API_KEY
//   4. Isi port + kunci API ESP8266    ->  DOOR_IP / DOOR_PORT / DOOR_API_KEY
//   5. Isi bot Telegram (opsional)     ->  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
//   6. Selesai: layanan perangkat dijalankan, admin langsung login otomatis.
//
// Sebelum langkah 1 selesai (ADMIN_PASSWORD masih kosong) seluruh isi API ini terbuka,
// karena memang belum ada akun untuk login. Setelah itu semua route di sini hanya bisa
// dipakai admin yang sudah login (dipakai tombol "Jalankan panduan setup lagi").
// ============================================================================
const T = require('./lang');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

module.exports = ({ app, saveEnv, settings, esp32, door, telegram, ai, auth, startDevices }) => {
    const required = () => !E('ADMIN_PASSWORD', '');
    const allowed = req => required() || auth.isAuthed(req);

    // Nilai yang dikirim ke halaman setup. Kunci API/token disembunyikan sebelum login.
    function state(req) {
        const authed = auth.isAuthed(req);
        const s = settings.snapshot();
        const hide = !authed && !required();
        return {
            required: required(),
            authed,
            server: { port: s.info.port, ips: s.info.ips, lang: s.info.lang, version: s.info.version, node: s.info.node, env: s.info.envFile },
            account: { username: s.info.username, hasPassword: s.info.setupDone },
            esp32: { ip: s.esp32.ip, port: s.esp32.port, apiKey: hide ? '' : s.esp32.apiKey },
            door: { ip: s.door.ip, port: s.door.port, apiKey: hide ? '' : s.door.apiKey, enrollSec: s.door.enrollSec },
            telegram: { alerts: s.telegram.alerts, token: hide ? '' : s.telegram.token, chatId: hide ? '' : s.telegram.chatId },
            ai: { enabled: s.ai ? s.ai.enabled : true, apiKey: hide ? '' : (s.ai ? s.ai.apiKey : ''), model: s.ai ? s.ai.model : 'gemini-1.5-flash' },
            language: E('LANGUAGE', 'id')
        };
    }

    app.get('/api/setup/status', (req, res) => res.json(state(req)));

    const guard = (req, res) => {
        if (allowed(req)) return true;
        res.status(403).json({ success: false, message: T('setup.locked') });
        return false;
    };

    // Langkah 1 — akun admin
    app.post('/api/setup/account', (req, res) => {
        if (!guard(req, res)) return;
        const b = req.body || {};
        const username = String(b.username == null ? '' : b.username).trim();
        const password = String(b.password == null ? '' : b.password);
        if (!/^\S{3,32}$/.test(username)) return res.status(400).json({ success: false, message: T('setup.userBad') });
        if (password.length < 8 || /[\r\n]/.test(password)) return res.status(400).json({ success: false, message: T('setup.pwShort') });
        if (password !== String(b.confirmPassword == null ? '' : b.confirmPassword))
            return res.status(400).json({ success: false, message: T('setup.pwMismatch') });

        saveEnv('ADMIN_USERNAME', username);
        saveEnv('ADMIN_PASSWORD', password);
        // Langsung buat sesi login: langkah berikutnya (ESP32/ESP8266/Telegram) jadi
        // terautentikasi, dan halaman setup tertutup untuk orang lain begitu akun ada.
        auth.createSession(res);
        res.json({ success: true, message: T('set.acctOk') });
    });

    // Langkah 2 — server/web (port web + folder penyimpanan). Nilai IP ditampilkan, bukan diisi.
    app.post('/api/setup/server', (req, res) => {
        if (!guard(req, res)) return;
        try {
            settings.apply({ server: (req.body || {}).server || {} });
            res.json({ success: true, message: T('set.ok'), restart: true });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });

    // Langkah 3 & 4 — ESP32 / ESP8266
    app.post('/api/setup/device', (req, res) => {
        if (!guard(req, res)) return;
        const b = req.body || {};
        const d = String(b.device || '');
        if (d !== 'esp32' && d !== 'esp8266') return res.status(400).json({ success: false, message: T('set.devUnknown') });
        const part = d === 'esp32'
            ? { ip: b.ip, port: b.port, apiKey: b.apiKey }
            : { ip: b.ip, port: b.port, apiKey: b.apiKey, enrollSec: b.enrollSec };
        Object.keys(part).forEach(k => part[k] === undefined && delete part[k]);
        try {
            settings.apply({ [d === 'esp32' ? 'esp32' : 'door']: part });
            // Perangkat yang baru diisi IP-nya langsung dicoba dihubungi
            (d === 'esp32' ? esp32 : door).reload();
            res.json({ success: true, message: T('set.ok') });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });

    // Langkah 5 — Telegram
    app.post('/api/setup/telegram', (req, res) => {
        if (!guard(req, res)) return;
        const b = req.body || {};
        const part = {};
        for (const k of ['alerts', 'token', 'chatId']) if (b[k] !== undefined) part[k] = b[k];
        try {
            settings.apply({ telegram: part });
            telegram.restart();
            res.json({ success: true, message: T('set.ok') });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });

    // Langkah AI Agent (Gemini) — opsional
    app.post('/api/setup/ai', (req, res) => {
        if (!guard(req, res)) return;
        const b = req.body || {};
        const part = {};
        for (const k of ['enabled', 'apiKey', 'model']) if (b[k] !== undefined) part[k] = b[k];
        try {
            settings.apply({ ai: part });
            if (ai && typeof ai.reload === 'function') ai.reload();
            res.json({ success: true, message: T('set.ok') });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });
    app.post('/api/setup/gemini', (req, res) => {
        if (!guard(req, res)) return;
        const b = req.body || {};
        const part = {};
        for (const k of ['enabled', 'apiKey', 'model']) if (b[k] !== undefined) part[k] = b[k];
        try {
            settings.apply({ ai: part });
            if (ai && typeof ai.reload === 'function') ai.reload();
            res.json({ success: true, message: T('set.ok') });
        } catch (e) {
            res.status(e.status || 400).json({ success: false, message: e.message || T('set.badBody') });
        }
    });

    // Langkah 6 — selesai: aktifkan layanan perangkat, tandai setup selesai, login otomatis
    app.post('/api/setup/finish', async (req, res) => {
        if (!guard(req, res)) return;
        if (!E('ADMIN_PASSWORD', '')) return res.status(400).json({ success: false, message: T('setup.needAccount') });

        if (E('SETUP_DONE', '') !== '1') saveEnv('SETUP_DONE', '1');
        try { startDevices(); } catch (e) { console.error('[Setup]', e.message); }
        try { if (ai && typeof ai.start === 'function') ai.start(); } catch (e) { console.error('[Setup]', e.message); }
        try { await telegram.welcome(); } catch { }
        auth.createSession(res);                                   // langsung masuk dashboard tanpa login ulang
        res.json({ success: true, message: T('setup.ok'), redirect: '/' });
    });

    return { required, state: req => state(req) };
};
