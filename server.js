const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ================= .env (tanpa dependency tambahan) =================
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}
const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];

function saveEnv(key, value) {
    let txt = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    if (re.test(txt)) txt = txt.replace(re, () => `${key}=${value}`);
    else txt = txt.replace(/\s*$/, '') + (txt.trim() ? '\n' : '') + `${key}=${value}\n`;
    fs.writeFileSync(ENV_FILE, txt);
    process.env[key] = value;   // langsung dipakai proses yang berjalan
}
// Catatan: konfigurasi GEMINI_MODEL milik pengguna TIDAK ditulis ulang otomatis.
// Model yang tidak tersedia dilaporkan apa adanya (fallback hanya bila dikonfigurasi).

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
// Upload/kompres besar tidak boleh terpotong timeout bawaan Node
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
const PORT = +env('PORT', 3000);
const storage = require('./storage');   // penyimpanan file di flash disk (lewat su)
const T = require('./lang');            // pesan server sesuai bahasa aktif (LANGUAGE di .env)

// ================= SESSION & AUTH =================
const sessions = new Map(); // sid -> waktu kedaluwarsa
const TTL = +env('SESSION_TTL_HOURS', 12) * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function isAuthed(req) {
    const exp = sessions.get(sidOf(req));
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(sidOf(req)); return false; }
    return true;
}
const sidOf = req => {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    return m ? m[1] : '';
};
// Buat sesi login baru (dipakai /api/login dan setelah setup awal selesai)
function createSession(res) {
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, Date.now() + TTL);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(TTL / 1000)}`);
    return sid;
}
// Setelah password diganti: sesi lain diputuskan, sesi yang sedang dipakai tetap jalan
function keepOnly(req) {
    const keep = sidOf(req);
    for (const k of [...sessions.keys()]) if (k !== keep) sessions.delete(k);
}
const requireAuth = (req, res, next) => isAuthed(req) ? next() : res.status(401).json({ error: T('auth.notLoggedIn') });
setInterval(() => { for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k); }, 600000).unref();

// ================= TELEGRAM =================
async function notify(text) {
    const tok = env('TELEGRAM_BOT_TOKEN'), chat = env('TELEGRAM_CHAT_ID');
    if (!tok || !chat) return false;
    try {
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(8000)
        });
        return (await r.json()).ok === true;
    } catch { return false; }
}

// ================= WEBSOCKET =================
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

server.on('upgrade', (req, socket, head) => {
    if (!isAuthed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// ================= MIDDLEWARE =================
// ================= SETUP AWAL (wizard di browser) =================
// Selama ADMIN_PASSWORD belum ada (mis. .env masih kosong), pengunjung diarahkan ke
// /setup.html dan API lain ditutup: belum ada akun untuk login, dan halaman setup ini
// yang membuat akun admin + pengaturan ESP32/ESP8266/Telegram.
const setupRequired = () => !env('ADMIN_PASSWORD');
app.get('/', (req, res, next) => setupRequired() ? res.redirect('/setup.html') : next());
app.use((req, res, next) => {
    if (!setupRequired()) return next();
    if (req.path === '/api/settings/lang' || req.path === '/setup.html' || req.path.startsWith('/api/setup/')) return next();
    if (req.path.startsWith('/api/')) return res.status(409).json({ error: T('setup.notDone'), setup: true, redirect: '/setup.html' });
    next();
});

app.use(express.json());
// Bahasa aktif boleh dibaca & diganti sebelum login: dipakai halaman login dan halaman
// setup awal (dua-duanya harus bisa berganti bahasa walau belum ada akun).
app.get('/api/settings/lang', (req, res) => res.json({ lang: env('LANGUAGE', 'id') }));
app.post('/api/settings/lang', (req, res) => {
    const l = String((req.body || {}).lang || '');
    if (!T.DICT[l]) return res.status(400).json({ success: false, message: T('set.badLang') });
    saveEnv('LANGUAGE', l);
    res.json({ success: true, message: T('set.saved') });
});
// Semua API data, file, dan ESP32 wajib login (halaman login di /public tetap terbuka)
app.use(['/api/files', '/api/create-folder', '/api/download', '/api/upload', '/api/rename', '/api/paste', '/api/storage', '/api/compress', '/api/esp32', '/api/door', '/api/firmware', '/api/system', '/api/settings', '/api/terminal', '/api/ai', '/uploads'], requireAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ================= API AUTH =================
const fails = new Map(); // ip -> { n, until }

app.post('/api/login', (req, res) => {
    const f = fails.get(req.ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) return res.status(429).json({ success: false, message: T('auth.tooMany') });

    const { username = '', password = '' } = req.body || {};
    const ok = same(username, env('ADMIN_USERNAME', 'admin')) & same(password, env('ADMIN_PASSWORD'));
    if (!ok || !env('ADMIN_PASSWORD')) {
        f.n++;
        if (f.n >= 5) { f.n = 0; f.until = Date.now() + 5 * 60 * 1000; }
        fails.set(req.ip, f);
        return res.status(401).json({ success: false, message: T('auth.wrong') });
    }
    fails.delete(req.ip);
    createSession(res);
    res.json({ success: true, message: T('auth.loginOk') });
});

app.get('/api/session', (req, res) => res.json({ authenticated: isAuthed(req) }));

app.post('/api/logout', (req, res) => {
    const sid = sidOf(req);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
});

// ---- Reset password: OTP Telegram -> token sekali pakai -> ganti password ----
let otp = null, resetTok = null;

app.post('/api/request-otp', async (req, res) => {
    if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_CHAT_ID'))
        return res.status(400).json({ success: false, message: T('otp.noTelegram') });
    if (otp && Date.now() - otp.sent < 60000)
        return res.status(429).json({ success: false, message: T('otp.wait') });

    const code = String(crypto.randomInt(100000, 1000000));
    if (!(await notify(T('otp.tgMsg', { code }))))
        return res.status(500).json({ success: false, message: T('otp.sendFail') });
    otp = { code, sent: Date.now(), exp: Date.now() + 600000, tries: 0 };
    res.json({ success: true, message: T('otp.sent') });
});

app.post('/api/verify-otp', (req, res) => {
    const code = String((req.body || {}).code || '').trim();
    if (!otp || otp.exp < Date.now() || otp.tries >= 5)
        return res.status(400).json({ success: false, message: T('otp.expired') });
    otp.tries++;
    if (!same(code, otp.code)) return res.status(400).json({ success: false, message: T('otp.wrong') });
    otp = null;
    resetTok = { t: crypto.randomBytes(24).toString('hex'), exp: Date.now() + 600000 };
    res.json({ success: true, message: T('otp.ok'), token: resetTok.t });
});

app.post('/api/reset-password', (req, res) => {
    const { newPassword, confirmPassword, token } = req.body || {};
    if (!resetTok || resetTok.exp < Date.now() || !same(token || '', resetTok.t))
        return res.status(403).json({ success: false, message: T('reset.invalid') });
    if (!newPassword || newPassword.length < 8 || /[\r\n]/.test(newPassword))
        return res.status(400).json({ success: false, message: T('reset.tooShort') });
    if (newPassword !== confirmPassword)
        return res.status(400).json({ success: false, message: T('reset.mismatch') });

    saveEnv('ADMIN_PASSWORD', newPassword);
    resetTok = null;
    sessions.clear();
    res.json({ success: true, message: T('reset.ok') });
});

// Verifikasi ulang password login dashboard (kartu admin pintu + ubah akun dari web).
// Percobaan salah dibatasi 5x per 5 menit per IP, sama seperti /api/login.
// true = password benar; kalau salah, respons error sudah dikirim dan hasilnya false.
function verifyDashboardPassword(req, res) {
    const f = fails.get(req.ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) {
        res.status(429).json({ success: false, message: T('auth.tooMany') });
        return false;
    }
    const password = (req.body || {}).password;
    if (typeof password !== 'string' || !env('ADMIN_PASSWORD') || !same(password, env('ADMIN_PASSWORD'))) {
        f.n++;
        if (f.n >= 5) { f.n = 0; f.until = Date.now() + 5 * 60 * 1000; }
        fails.set(req.ip, f);
        res.status(403).json({ success: false, message: T('door.adminPasswordWrong') });
        return false;
    }
    fails.delete(req.ip);
    return true;
}

// ================= ESP32 MONITOR =================
const sensorHistory = require('./sensor-history')({ env });
const esp32 = require('./esp32')({ app, broadcast, notify, sensorHistory });
// ================= PINTU RFID (ESP8266) =================
const door = require('./door')({ app, broadcast, notify, verifyDashboardPassword });
// ================= UPDATE FIRMWARE ESP (file .bin -> ESP8266 / ESP32) =================
const firmware = require('./firmware')({ app, broadcast, notify, esp32, door });
// ================= MONITOR SISTEM (CPU/RAM/flash disk) =================
const system = require('./system')({ app, broadcast });

// ================= EKSEKUSI & KEAMANAN BERSAMA =================
// Satu executor untuk terminal web + AI, satu set lock untuk perangkat, satu
// penyimpanan konfirmasi, satu catatan audit, dan satu riwayat sensor.
let webRunning = false, servicesStarted = false;
const executor = require('./executor')({ env });
const locks = require('./locks').createLocks();
const confirm = require('./confirm')({ env });
const audit = require('./audit')({ env });
const optional = require('./optional-features')({ env, storage });

// Objek dependensi DIPAKAI BERSAMA oleh registry, AI, penjadwal, dan Telegram.
const skillDeps = {
    esp32, door, storage, system, telegram: null, executor, locks, confirm, audit,
    sensorHistory, scheduler: null, optional,
    diagnostics: null,
    isWebEnabled: () => webRunning
};
const diagnostics = require('./diagnostics')({ deps: skillDeps, env });
skillDeps.diagnostics = diagnostics;

// ================= REGISTRY SKILL (satu sumber untuk AI) =================
const registry = require('./skills-registry')({ deps: skillDeps, env });

// ================= TERMINAL COMMAND (Pengaturan > Terminal) =================
const terminalMod = require('./terminal')({ app, saveEnv, executor });

function setWebEnabled(enabled) {
    if (enabled) return new Promise((resolve, reject) => {
        if (server.listening) { webRunning = true; return resolve(true); }
        const onError = e => { server.off('error', onError); reject(e); };
        server.once('error', onError);
        server.listen(PORT, '0.0.0.0', () => {
            server.off('error', onError);
            webRunning = true;
            console.log(`[Web] Server aktif kembali di port ${PORT}.`);
            resolve(true);
        });
    });
    if (!server.listening) { webRunning = false; return Promise.resolve(false); }
    wss.clients.forEach(ws => ws.terminate());
    return new Promise((resolve, reject) => {
        server.close(e => {
            webRunning = false;
            if (e) return reject(e);
            console.log('[Web] HTTP dan WebSocket dimatikan melalui Telegram; layanan perangkat tetap aktif.');
            resolve(false);
        });
        if (server.closeAllConnections) server.closeAllConnections();
    });
}

// ================= AI AGENT =================
// ai.js adalah implementasi utama. Alias agent.js/ai-agent.js/ai_agent.js/gemini.js
// hanya me-re-export modul ini.
const auth = { isAuthed, verify: verifyDashboardPassword, createSession, keepOnly };
const ai = require('./ai')({
    app, saveEnv, esp32, door, telegram: null, terminal: terminalMod, executor, auth,
    broadcast, notify, registry, confirm, audit, sensorHistory, optional,
    storage, system, locks, diagnostics, deps: skillDeps,
    isWebEnabled: () => webRunning
});

// ================= TELEGRAM =================
const telegram = require('./telegram')({
    esp32, door, setWebEnabled, isWebEnabled: () => webRunning, ai,
    locks, optional, storage
});
skillDeps.telegram = telegram;
if (ai && typeof ai.setTelegram === 'function') ai.setTelegram(telegram);

// ================= JADWAL & OTOMASI =================
const scheduler = require('./scheduler')({
    env, registry, sensorHistory, notify, log: console.log
});
skillDeps.scheduler = scheduler;

// ================= PENGATURAN LEWAT WEB (tab Pengaturan) =================
// Semua nilai .env penting bisa diubah dari browser: IP/port/kunci API ESP32 & ESP8266,
// Telegram, batas alarm monitoring, sampai akun admin. Tidak perlu mengedit .env di Termux.
const settings = require('./settings')({ app, saveEnv, esp32, door, telegram, ai, auth });

// ================= SETUP AWAL (halaman /setup.html) =================
require('./setup')({ app, saveEnv, settings, esp32, door, telegram, ai, auth, startDevices });

wss.on('connection', ws => {
    broadcast({ type: 'DEVICE_COUNT', count: wss.clients.size });
    ws.send(JSON.stringify({ type: 'SENSOR', data: esp32.snapshot() }));
    ws.send(JSON.stringify({ type: 'DOOR', data: door.snapshot() }));
    ws.on('close', () => broadcast({ type: 'DEVICE_COUNT', count: wss.clients.size }));
});

// ================= FILE MANAGER (flash disk lewat su) =================
// Semua file/folder ada di <STORAGE_DEVICE>/<STORAGE_FOLDER>; satu flash disk terpasang dideteksi otomatis.
// Folder "upload" dibuat otomatis kalau belum ada; kalau sudah ada, dipakai apa adanya.
const upload = multer({ storage: storage.engine() });
const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); else res.destroy(); }
};

app.get('/api/storage/status', wrap(async (req, res) => res.json(await storage.status())));

app.get('/api/files', wrap(async (req, res) => {
    const rel = req.query.dir || '';
    res.json({ currentDir: rel, files: await storage.list(rel) });
}));

app.post('/api/create-folder', wrap(async (req, res) => {
    const b = req.body || {}, name = storage.cleanName(b.folderName);
    if (!name) return res.status(400).json({ error: T('st.badFolderName') });
    await storage.mkdir(b.dir || '', name);
    res.json({ success: true });
}));

app.get('/api/download', wrap((req, res) => storage.send(res, req.query.path || '', { zip: req.query.zip === '1' })));

// Kompres file/folder menjadi .zip di folder yang sama (hasil tersimpan di flash disk)
app.post('/api/compress', wrap(async (req, res) => {
    const b = req.body || {}, name = storage.cleanName(b.name);
    if (!name) return res.status(400).json({ error: T('st.badName') });
    const out = await storage.compress((b.dir ? b.dir + '/' : '') + name);
    res.json({ success: true, name: out });
}));
app.use('/uploads', wrap((req, res) => storage.send(res, decodeURIComponent(req.path), { inline: true })));

app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, err => {
        if (err) return res.status(err.status || 500).json({ error: err.message || T('st.uploadFail') });
        if (!req.file) return res.status(400).json({ error: T('st.noFile') });
        res.json({ success: true, name: req.file.filename, size: req.file.size });
    });
});

app.post('/api/rename', wrap(async (req, res) => {
    const b = req.body || {}, a = storage.cleanName(b.oldName), n = storage.cleanName(b.newName);
    if (!a || !n) return res.status(400).json({ error: 'Nama tidak valid' });
    await storage.rename(b.dir || '', a, n);
    res.json({ success: true });
}));

app.post('/api/paste', wrap(async (req, res) => {
    const b = req.body || {};
    await storage.paste(b.action, b.sourceDir || '', b.targetDir || '', b.items);
    res.json({ success: true });
}));

app.delete('/api/files', wrap(async (req, res) => {
    await storage.remove(req.query.path || '');
    res.json({ success: true });
}));

// Layanan perangkat baru dijalankan setelah setup awal selesai (atau langsung kalau .env
// sudah lengkap). Pengaturan yang diubah dari web memakai esp32.reload()/door.reload()/
// telegram.restart(), jadi tidak perlu memulai ulang server.
function startDevices() {
    if (servicesStarted) return;
    servicesStarted = true;
    esp32.start();
    door.start();
    system.start();
    telegram.start().then(() => telegram.welcome());
    try { if (ai && typeof ai.start === 'function') ai.start(); } catch (e) { console.error('[AI]', e.message); }
    // Jadwal & otomasi dimulai setelah layanan perangkat hidup; kebijakan jadwal
    // terlewat diterapkan di scheduler.bootstrap() (default: dilewati).
    scheduler.start().catch(e => console.error('[Jadwal]', e.message));
}

// Simpan state dan hentikan proses anak dengan rapi saat server berhenti.
let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { scheduler.stop(); } catch { }
    try { executor.killAll('shutdown'); } catch { }
    try { sensorHistory.save(); } catch { }
    try { ai && ai.history && ai.history.save(); } catch { }
}
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(130); });

function printBanner() {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
        .sort((a, b) => (/^169\.254\./.test(a) ? 1 : 0) - (/^169\.254\./.test(b) ? 1 : 0));   // alamat link-local paling belakang
    const list = ips.length ? ips : ['localhost'];
    const port = env('PORT', 3000);
    console.log('=================================');
    if (setupRequired()) {
        list.forEach(ip => console.log(`Setup awal: http://${ip}:${port}/setup.html`));
        console.log('- Buka alamat itu di HP/PC (satu WiFi dengan Termux).');
        console.log('- Di halaman setup: buat username & password, isi IP/port/kunci API ESP32');
        console.log('  dan ESP8266, isi bot Telegram, lalu isi kunci API Gemini (untuk /ai).');
        console.log('  Semua nilai di atas ditulis otomatis ke .env.');
        console.log('- Setelah selesai, dashboard bisa dibuka di http://' + list[0] + ':' + port);
    } else {
        list.forEach(ip => console.log(`Server aktif: http://${ip}:${port}`));
    }
    console.log(`ESP32       : http://${env('ESP32_IP', '(belum diisi)')}:${env('ESP32_PORT', 80)}`);
    console.log(`Pintu RFID  : http://${env('DOOR_IP', '(belum diisi)')}:${env('DOOR_PORT', 80)}`);
    console.log(`AI Agent    : ${env('GEMINI_API_KEY') ? 'kunci Gemini terisi (model ' + env('GEMINI_MODEL', 'gemini-3.5-flash-lite') + ')' : 'GEMINI_API_KEY kosong - isi lewat setup awal atau tab Pengaturan'}`);
    storage.status().then(st => console.log(st.ready ? `Penyimpanan : ${st.root} (siap, mode ${st.mode})` : `PENYIMPANAN BELUM SIAP: ${st.message}`));
    console.log('=================================');
}

setWebEnabled(true).then(() => {
    webRunning = true;
    printBanner();
    if (setupRequired()) console.log('[Setup] ' + T('setup.startLog'));
    else startDevices();
}).catch(e => {
    console.error('[Web] Gagal menjalankan server:', e.message);
    process.exitCode = 1;
});
