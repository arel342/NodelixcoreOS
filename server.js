const express = require('express');
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
    // Tulis ke berkas sementara lalu rename (atomik), dan batasi hak akses: .env berisi
    // password admin, token Telegram, serta kunci API Gemini.
    const tmp = `${ENV_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, txt, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* filesystem tanpa izin unix */ }
    fs.renameSync(tmp, ENV_FILE);
    process.env[key] = value;   // langsung dipakai proses yang berjalan
}
// Catatan: konfigurasi GEMINI_MODEL milik pengguna TIDAK ditulis ulang otomatis.
// Model yang tidak tersedia dilaporkan apa adanya (fallback hanya bila dikonfigurasi).

const app = express();
// Default HTTP/WS untuk LAN tepercaya; HTTPS/WSS opsional melalui TLS_ENABLED=true.
const tls = require('./tls');
// Upload/kompres besar tidak boleh terpotong timeout bawaan Node
// Batas waktu request tetap aktif; dapat dinaikkan untuk upload besar, maksimum 1 jam.
const boundedMs = (key, fallback, min, max) => {
    const n = Number(env(key, fallback));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const boundedInt = (key, fallback, min, max) => boundedMs(key, fallback, min, max);
const REQUEST_TIMEOUT = boundedMs('REQUEST_TIMEOUT_MS', 900000, 30000, 3600000);
const HEADERS_TIMEOUT = Math.min(boundedMs('HEADERS_TIMEOUT_MS', 60000, 10000, 120000), REQUEST_TIMEOUT);
const KEEP_ALIVE_TIMEOUT = boundedMs('KEEP_ALIVE_TIMEOUT_MS', 5000, 1000, 30000);
let server;
try {
    server = tls.createServer(app, {
        requestTimeout: REQUEST_TIMEOUT,
        headersTimeout: HEADERS_TIMEOUT,
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT
    });
} catch (e) {
    console.error('[TLS] Gagal memuat sertifikat:', e.message);
    console.error('       Jalankan: npm run gen-certs  (membuat Private CA lokal + sertifikat server)');
    console.error('       Untuk HTTP di LAN tepercaya: TLS_ENABLED=false TLS_ALLOW_HTTP=true npm start');
    process.exit(1);
}
const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
const PORT = +env('PORT', 3000);
const storage = require('./storage');   // penyimpanan file di flash disk (lewat su)
const T = require('./lang');            // pesan server sesuai bahasa aktif (LANGUAGE di .env)

// ================= SESSION & AUTH (terpusat: cookie web + Bearer mobile) =================
// Semua pemeriksaan sesi ada di auth.js. Cookie `sid` untuk dashboard tetap seperti
// sebelumnya (di memori), sedangkan sesi mobile memakai token Bearer yang disimpan
// sebagai hash di data/mobile-sessions.json sehingga tidak hilang saat server restart.
const authMod = require('./auth');
const auth = authMod({ env, dataDir: path.join(__dirname, 'data'), log: m => console.log(m) });
const { createLimiter, same } = authMod;
const { sidOf, createSession, keepOnly, requireAuth, isAuthed, bearerOf } = auth;
const loginLimiter = createLimiter({ max: 5, blockMs: 5 * 60 * 1000 });
// Batas umum API per IP per endpoint (antisipasi scanning/bot): default 120 req/menit.
const apiLimiter = createLimiter({ max: boundedInt('RATE_LIMIT_API_MAX', 120, 10, 600), blockMs: 60 * 1000 });

setInterval(auth.flush, 60000).unref();

// ================= PENCATATAN AUDIT KEAMANAN =================
// security-log.js mencatat peristiwa keamanan (login, register, revok, denied,
// WS auth fail, traversal, command) ke data/security.log (JSON Lines, dirotasi).
// TIDAK MENCATAT password/token/kunci.
const { createSecurityLog } = require('./security-log');
const secLog = createSecurityLog({ quiet: true });
secLog.flush().catch(() => { });

// ================= HEADER KEAMANAN =================
// Server ini memang boleh berjalan lewat HTTP di LAN (Termux). Header di bawah bukan
// pengganti HTTPS; lihat README bagian Keamanan untuk risiko jaringan.
app.disable('x-powered-by');
// Hanya percayai alamat proxy yang dinyatakan eksplisit (IP/CIDR/keyword Express).
// TRUST_PROXY=true sengaja tidak diterima karena mempercayai semua hop membuka spoofing.
const trustedProxyEntries = String(env('TRUST_PROXY', '')).split(',').map(v => v.trim()).filter(Boolean);
if (trustedProxyEntries.length && trustedProxyEntries.some(v => v.toLowerCase() !== 'true' && v.toLowerCase() !== 'false')) {
    app.set('trust proxy', trustedProxyEntries.filter(v => !['true', 'false'].includes(v.toLowerCase())));
} else if (trustedProxyEntries.some(v => v.toLowerCase() === 'true')) {
    console.warn('[Security] TRUST_PROXY=true tidak aman dan diabaikan; gunakan daftar IP/CIDR proxy tepercaya.');
}
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    // Dashboard tidak boleh dibingkai situs lain (anti clickjacking). Bisa dimatikan
    // lewat ALLOW_IFRAME=true kalau memang perlu ditempel di halaman lain.
    if (String(env('ALLOW_IFRAME', 'false')).toLowerCase() !== 'true') {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    }
    // HSTS hanya untuk respons HTTPS, bukan HTTP.
    if (req.secure) {
        res.setHeader('Strict-Transport-Security', `max-age=${+env('HSTS_MAX_AGE', 15552000)}; includeSubDomains`);
    }
    next();
});

// Tolak token yang dikirim lewat URL (bocor ke log proxy, riwayat, dsb).
app.use('/api', (req, res, next) => {
    const key = auth.tokenInQuery(req);
    if (!key) return next();
    res.status(400).json({
        success: false,
        error: 'Token sesi tidak boleh dikirim lewat URL. Gunakan header Authorization: Bearer.',
        message: 'Session tokens must not be sent in the URL.'
    });
});

// Proteksi CSRF untuk aksi yang mengubah data: permintaan bercookie `sid` yang membawa
// header Origin dari host lain ditolak. Aplikasi Android (OkHttp) tidak mengirim Origin,
// dan dashboard selalu same-origin, jadi keduanya tidak terpengaruh.
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // Bearer tidak dikirim otomatis oleh browser, jadi tidak bisa dipicu lintas situs.
    if (bearerOf(req)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();                    // aplikasi native/proxy tanpa Origin
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch { host = ''; }
    const expected = [
        req.headers.host
    ].map(v => String(v || '').split(',')[0].trim().toLowerCase()).filter(Boolean);
    // Origin tambahan yang sengaja dipercaya (reverse proxy yang mengubah Host).
    const trusted = String(env('TRUSTED_ORIGINS', '')).split(',')
        .map(o => o.trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean);
    const normalized = String(origin).trim().toLowerCase().replace(/\/+$/, '');
    if (host && (expected.includes(host) || trusted.includes(normalized) || trusted.includes(host))) return next();
    res.status(403).json({
        success: false,
        error: 'Permintaan lintas situs ditolak (CSRF).',
        message: 'Cross-site request rejected (CSRF).'
    });
});

// ================= TELEGRAM =================
// Notifikasi Telegram bersama (dipakai ESP32, pintu, OTA, dan pemeriksa update GitHub).
// opts.parse_mode hanya dikirim bila pemanggil memintanya (default teks biasa), jadi
// pesan lama yang berisi karakter khusus tetap tampil apa adanya.
async function notify(text, opts = {}) {
    const tok = env('TELEGRAM_BOT_TOKEN'), chat = env('TELEGRAM_CHAT_ID');
    if (!tok || !chat) return false;
    try {
        const body = { chat_id: chat, text: String(text == null ? '' : text) };
        if (opts && opts.parse_mode) body.parse_mode = String(opts.parse_mode);
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
        });
        return (await r.json()).ok === true;
    } catch { return false; }
}

// ================= WEBSOCKET =================
// Autentikasi dilakukan SEBELUM upgrade diterima, memakai auth.js:
//   - dashboard : cookie `sid`
//   - mobile    : header `Authorization: Bearer <token>` (tidak pernah lewat query string)
// Sesi yang dicabut/kedaluwarsa langsung memutus koneksinya (lihat WS_CLOSE_REVOKED).
const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_REVOKED = 4403;
const WS_CLOSE_GOING_AWAY = 1001;      // standar: server berhenti, klien boleh menyambung ulang
function broadcast(obj) {
    const msg = JSON.stringify(obj);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// Tutup koneksi milik sesi/perangkat yang baru dicabut.
function closeSocketsFor(evt) {
    if (!evt) return;
    for (const ws of wss.clients) {
        const a = ws.auth;
        if (!a) continue;
        let match = false;
        if (evt.kind === 'mobile' && a.kind === 'mobile') {
            match = (evt.tokenHash && a.tokenHash === evt.tokenHash) || (evt.deviceId && a.deviceId === evt.deviceId);
        } else if (evt.kind === 'web' && a.kind === 'web') {
            match = evt.sid && a.sid === evt.sid;
        }
        if (!match) continue;
        try { ws.close(WS_CLOSE_REVOKED, 'session revoked'); } catch { }
        const t = setTimeout(() => { try { ws.terminate(); } catch { } }, 2000);
        if (t.unref) t.unref();
    }
}
auth.setRevokeHandler(closeSocketsFor);

// HTTP memakai server langsung; HTTPS memakai http.Server internal yang
// memarser request dari socket TLS. Pasang upgrade pada penerima HTTP yang benar.
const upgradeServer = server.httpServer || server;
upgradeServer.on('upgrade', (req, socket, head) => {
    // Socket mentah setelah upgrade menjadi tanggung jawab kita: tanpa listener 'error',
    // klien yang memutus koneksi di tengah handshake (ECONNRESET/EPIPE) akan melempar
    // exception tak tertangani yang mematikan seluruh server.
    socket.on('error', () => { try { socket.destroy(); } catch { } });

    const r = auth.resolve(req);
    if (!r.ok) {
        secLog.wsAuthFail(String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'), r.reason || 'no_auth');
        const body = '{"success":false,"message":"Authentication required."}';
        try {
            socket.write(
                'HTTP/1.1 401 Unauthorized\r\n' +
                'Connection: close\r\n' +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` + body
            );
        } catch { /* klien sudah pergi */ }
        return socket.destroy();
    }
    const clientIp = String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
    const maxWsTotal = boundedMs('WS_MAX_CONNECTIONS', 100, 1, 1000);
    const maxWsPerIp = boundedMs('WS_MAX_CONNECTIONS_PER_IP', 5, 1, 100);
    const maxWsPerDevice = boundedMs('WS_MAX_CONNECTIONS_PER_DEVICE', 3, 1, 50);
    const totalForIp = [...wss.clients].filter(ws => ws.clientIp === clientIp).length;
    const totalForDevice = r.kind === 'mobile'
        ? [...wss.clients].filter(ws => ws.auth && ws.auth.kind === 'mobile' && ws.auth.deviceId === r.deviceId).length
        : 0;
    if (wss.clients.size >= maxWsTotal || totalForIp >= maxWsPerIp || totalForDevice >= maxWsPerDevice) {
        try { socket.write('HTTP/1.1 429 Too Many Requests\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n'); } catch { }
        return socket.destroy();
    }
    try {
        wss.handleUpgrade(req, socket, head, ws => {
            // Frame yang tidak sah (mis. MASK tidak diset, UTF-8 rusak, payload terlalu
            // besar) memicu event 'error' pada objek WebSocket. Tanpa listener, ws
            // melemparnya sebagai uncaughtException dan proses server berhenti.
            ws.on('error', e => {
                const msg = String((e && (e.message || e.code)) || 'error').replace(/[\r\n]+/g, ' ').slice(0, 120);
                console.warn('[WebSocket] koneksi bermasalah:', msg);
            });
            ws.auth = r;                       // identitas sesi disimpan per koneksi
            ws.clientIp = clientIp;
            ws.isAlive = true;
            wss.emit('connection', ws, req);
        });
    } catch (e) {
        console.warn('[WebSocket] upgrade ditolak:', String(e && e.message).slice(0, 120));
        try { socket.destroy(); } catch { }
    }
});

// Periksa ulang sesi tiap 30 detik: token kedaluwarsa / perangkat dicabut -> putus.
const wsWatch = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.auth) { try { ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthenticated'); } catch { } continue; }
        if (!auth.revalidate(ws.auth)) {
            try { ws.close(WS_CLOSE_REVOKED, 'session expired'); } catch { }
            const t = setTimeout(() => { try { ws.terminate(); } catch { } }, 1000);
            if (t.unref) t.unref();
        }
    }
}, 30000);
if (wsWatch.unref) wsWatch.unref();

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

app.use(express.json({ limit: env('JSON_BODY_LIMIT', '512kb') }));
// Bahasa aktif boleh dibaca & diganti sebelum login: dipakai halaman login dan halaman
// setup awal (dua-duanya harus bisa berganti bahasa walau belum ada akun).
app.get('/api/settings/lang', (req, res) => res.json({ lang: env('LANGUAGE', 'id') }));
app.post('/api/settings/lang', (req, res) => {
    const l = String((req.body || {}).lang || '');
    if (!T.DICT[l]) return res.status(400).json({ success: false, message: T('set.badLang') });
    saveEnv('LANGUAGE', l);
    res.json({ success: true, message: T('set.saved') });
});
// Semua API data, file, perangkat, dan /uploads wajib login (halaman login di /public
// tetap terbuka). Daftar PUBLIC_API di bawah adalah SATU-SATUNYA pengecualian; endpoint
// /api lain tanpa sesi sah langsung ditolak 401. Sebelumnya daftar rute yang dilindungi
// ditulis manual, sehingga rute yang lupa didaftarkan (atau ditambah di kemudian hari)
// otomatis terbuka tanpa login.
const PUBLIC_API = [
    /^\/api\/login$/, /^\/api\/logout$/, /^\/api\/session$/,
    /^\/api\/settings\/lang$/,               // halaman login & setup memilih bahasa sebelum login
    /^\/api\/setup(\/|$)/,                    // wizard awal (setiap route menjaga dirinya sendiri)
    /^\/api\/mobile(\/|$)/,                   // mobile-auth.js memakai Bearer sendiri (401/403 internal)
    /^\/api\/request-otp$/, /^\/api\/verify-otp$/, /^\/api\/reset-password$/   // pulihkan akun
];
app.use((req, res, next) => {
    const p = req.path;
    // /uploads wajib login (terpisah dari gerbang /api).
    if (p === '/uploads' || p.startsWith('/uploads/')) {
        const denied = requireAuth(req, res, next);
        if (denied && res.statusCode === 401) secLog.apiDenied(req.ip, p, 'uploads_no_auth');
        return denied;
    }
    if (p !== '/api' && !p.startsWith('/api/')) return next();
    // Rate limit umum per IP per endpoint (tidak berlaku untuk endpoint publik
    // yang sudah punya limiter sendiri: login/otp).
    if (!/^\/api\/(login|request-otp|verify-otp|reset-password)$/.test(p)) {
        const lim = apiLimiter.check(req.ip + '|' + p);
        if (lim.blocked) {
            secLog.rateLimited(req.ip, p);
            return res.status(429).json({ success: false, message: T('auth.tooMany') });
        }
        apiLimiter.hit(req.ip + '|' + p);
    }
    if (PUBLIC_API.some(rx => rx.test(p))) return next();
    const denied = requireAuth(req, res, next);
    if (denied && (res.statusCode === 401 || res.statusCode === 400)) secLog.apiDenied(req.ip, p, 'api_no_auth');
    return denied;
});

app.use(express.static(path.join(__dirname, 'public')));

// ================= API AUTH =================
// Batas percobaan login: 5 kali salah -> 429 selama 5 menit per IP (perilaku lama).
app.post('/api/login', (req, res) => {
    const lim = loginLimiter.check(req.ip);
    if (lim.blocked) return res.status(429).json({ success: false, message: T('auth.tooMany') });

    const { username = '', password = '' } = req.body || {};
    const ok = same(username, env('ADMIN_USERNAME', 'admin')) & same(password, env('ADMIN_PASSWORD'));
    if (!ok || !env('ADMIN_PASSWORD')) {
        loginLimiter.fail(req.ip);
        secLog.loginFail(req.ip, String(username).slice(0, 32) || '-', 'wrong_credentials');
        return res.status(401).json({ success: false, message: T('auth.wrong') });
    }
    loginLimiter.reset(req.ip);
    secLog.loginSuccess(req.ip, String(username).slice(0, 32));
    createSession(res, { secure: !!req.secure });
    res.json({ success: true, message: T('auth.loginOk') });
});

// Info sesi: `authenticated` tetap seperti sebelumnya; field tambahan hanya informasi.
app.get('/api/session', (req, res) => {
    const r = auth.resolve(req);
    res.json({
        authenticated: r.ok,
        method: r.ok ? r.kind : null,
        deviceId: r.ok && r.deviceId ? r.deviceId : null,
        expiresAt: r.ok && r.expiresAt ? r.expiresAt : null
    });
});

app.post('/api/logout', (req, res) => {
    const sid = sidOf(req);
    if (sid) auth.destroyWebSession(sid);          // sesi web ini saja (mobile punya endpoint sendiri)
    const token = bearerOf(req);
    if (token) auth.revokeToken(token);            // izinkan logout mobile lewat jalur lama juga
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ success: true });
});

// ---- Reset password: OTP Telegram -> token sekali pakai -> ganti password ----
// Route ini memang publik (dipakai layar login aplikasi & halaman login web), jadi
// pembatasannya dilakukan di sini: maksimal 3 permintaan OTP per 5 menit per IP supaya
// chat Telegram admin tidak bisa dibanjiri dan tidak ada OTP yang saling menimpa terus.
let otp = null, resetTok = null;
const otpLimiter = createLimiter({ max: 3, blockMs: 5 * 60 * 1000 });
const noStoreRes = res => res.setHeader('Cache-Control', 'no-store');

app.post('/api/request-otp', async (req, res) => {
    noStoreRes(res);
    if (!env('TELEGRAM_BOT_TOKEN') || !env('TELEGRAM_CHAT_ID'))
        return res.status(400).json({ success: false, message: T('otp.noTelegram') });
    const lim = otpLimiter.check(req.ip);
    if (lim.blocked) return res.status(429).json({ success: false, message: T('otp.wait') });
    if (otp && Date.now() - otp.sent < 60000)
        return res.status(429).json({ success: false, message: T('otp.wait') });
    otpLimiter.hit(req.ip);        // hitung permintaan (bukan percobaan kode salah)

    const code = String(crypto.randomInt(100000, 1000000));
    if (!(await notify(T('otp.tgMsg', { code }))))
        return res.status(500).json({ success: false, message: T('otp.sendFail') });
    otp = { code, sent: Date.now(), exp: Date.now() + 600000, tries: 0 };
    res.json({ success: true, message: T('otp.sent') });
});

app.post('/api/verify-otp', (req, res) => {
    noStoreRes(res);                       // token reset tidak boleh tersimpan di cache/proxy
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
    noStoreRes(res);
    const { newPassword, confirmPassword, token } = req.body || {};
    if (!resetTok || resetTok.exp < Date.now() || !same(token || '', resetTok.t))
        return res.status(403).json({ success: false, message: T('reset.invalid') });
    if (!newPassword || newPassword.length < 8 || /[\r\n]/.test(newPassword))
        return res.status(400).json({ success: false, message: T('reset.tooShort') });
    if (newPassword !== confirmPassword)
        return res.status(400).json({ success: false, message: T('reset.mismatch') });

    saveEnv('ADMIN_PASSWORD', newPassword);
    resetTok = null;
    auth.clearWebSessions();   // sesi dashboard lama tidak berlaku lagi
    res.json({ success: true, message: T('reset.ok') });
});

// Verifikasi ulang password login dashboard (kartu admin pintu + ubah akun dari web).
// Percobaan salah dibatasi 5x per 5 menit per IP, sama seperti /api/login.
// true = password benar; kalau salah, respons error sudah dikirim dan hasilnya false.
function verifyDashboardPassword(req, res) {
    const lim = loginLimiter.check(req.ip);
    if (lim.blocked) {
        res.status(429).json({ success: false, message: T('auth.tooMany') });
        return false;
    }
    const password = (req.body || {}).password;
    if (typeof password !== 'string' || !env('ADMIN_PASSWORD') || !same(password, env('ADMIN_PASSWORD'))) {
        loginLimiter.fail(req.ip);
        res.status(403).json({ success: false, message: T('door.adminPasswordWrong') });
        return false;
    }
    loginLimiter.reset(req.ip);
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
// revokeAllMobileSessions wajib ada: settings.js & setup.js memanggilnya saat password
// admin diganti. Tanpa ini, ganti password dari web gagal (TypeError -> HTTP 500).
const authDeps = {
    isAuthed, verify: verifyDashboardPassword, createSession, keepOnly, resolve: auth.resolve,
    revokeAllMobileSessions: reason => auth.revokeAllMobileSessions(reason)
};
const ai = require('./ai')({
    app, saveEnv, esp32, door, telegram: null, terminal: terminalMod, executor, auth: authDeps,
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

// ================= UPDATE GITHUB (deteksi + notifikasi, TANPA pemasangan otomatis) =================
// Tiap UPDATE_CHECK_INTERVAL (default 12 jam) modul ini menjalankan `git fetch origin`,
// membandingkan commit terpasang dengan origin/main, lalu mengirim SATU notifikasi
// Telegram per commit baru (lewat notify() di atas, bot yang sama) dan menyiarkan status
// ke dashboard (WebSocket {type:'UPDATE'} + /api/update/status). `git pull` tidak pernah
// dijalankan dari sini: pemasangan update tetap tindakan manual administrator.
function lanBaseUrl() {
    const ips = Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address))
        .map(i => i.address);
    return `${tls.scheme()}://${ips[0] || 'localhost'}:${env('PORT', 3000)}`;
}
const updater = require('./updater')({
    app, env, broadcast, notify, rootDir: __dirname,
    dashboardUrl: () => lanBaseUrl(),
    log: console.log
});

// ================= JADWAL & OTOMASI =================
const scheduler = require('./scheduler')({
    env, registry, sensorHistory, notify, log: console.log
});
skillDeps.scheduler = scheduler;

// ================= PENGATURAN LEWAT WEB (tab Pengaturan) =================
// Semua nilai .env penting bisa diubah dari browser: IP/port/kunci API ESP32 & ESP8266,
// Telegram, batas alarm monitoring, sampai akun admin. Tidak perlu mengedit .env di Termux.
const settings = require('./settings')({ app, saveEnv, esp32, door, telegram, ai, auth: authDeps });

// ================= MOBILE AUTH (ECDSA P-256 + Bearer token) =================
// Endpoint /api/mobile/* menambah dukungan aplikasi Android tanpa mengubah jalur web:
// registrasi perangkat (wajib password admin), challenge 32 byte sekali pakai, verifikasi
// tanda tangan SHA256withECDSA, sesi Bearer yang tahan restart, dan pencabutan perangkat.
const mobileAuth = require('./mobile-auth')({
    app, env, auth, dataDir: path.join(__dirname, 'data'),
    verifyAdminPassword: verifyDashboardPassword,
    onEvent: (event, details) => { try { secLog.write(event, details); } catch { } },
    log: m => console.log(m)
});

// ================= SETUP AWAL (halaman /setup.html) =================
require('./setup')({ app, saveEnv, settings, esp32, door, telegram, ai, auth: authDeps, startDevices });

wss.on('connection', ws => {
    broadcast({ type: 'DEVICE_COUNT', count: wss.clients.size });
    ws.send(JSON.stringify({ type: 'SENSOR', data: esp32.snapshot() }));
    ws.send(JSON.stringify({ type: 'DOOR', data: door.snapshot() }));
    // Snapshot CPU/RAM terakhir langsung dikirim supaya tab Sistem tidak kosong
    // menunggu siklus polling berikutnya.
    try { const snap = system.snapshot(); if (snap) ws.send(JSON.stringify({ type: 'SYSTEM', data: snap })); } catch { }
    // Status update tersimpan dikirim ke setiap perangkat yang terhubung — tanpa
    // menyentuh GitHub, jadi login/muat ulang dashboard tidak memicu pemeriksaan baru.
    try { ws.send(JSON.stringify({ type: 'UPDATE', data: updater.view() })); } catch { }
    ws.on('close', () => broadcast({ type: 'DEVICE_COUNT', count: wss.clients.size }));
});

// ================= FILE MANAGER (flash disk lewat su) =================
// Semua file/folder ada di <STORAGE_DEVICE>/<STORAGE_FOLDER>; satu flash disk terpasang dideteksi otomatis.
// Folder "upload" dibuat otomatis kalau belum ada; kalau sudah ada, dipakai apa adanya.
const uploadMaxMb = Number(env('UPLOAD_MAX_MB', 2048));
const uploadLimitBytes = Number.isFinite(uploadMaxMb) && uploadMaxMb > 0 ? Math.floor(uploadMaxMb * 1024 * 1024) : undefined;
const upload = multer({
    storage: storage.engine(),
    limits: { ...(uploadLimitBytes ? { fileSize: uploadLimitBytes } : {}), files: 1, fields: 20, parts: 21, fieldSize: 64 * 1024 }
});
const maxConcurrentUploads = boundedMs('UPLOAD_MAX_CONCURRENT', 2, 1, 8);
let activeUploads = 0;
function uploadGate(req, res, next) {
    if (activeUploads >= maxConcurrentUploads) {
        return res.status(429).json({ error: 'Server sedang menangani upload lain. Coba lagi.' });
    }
    activeUploads++;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        activeUploads = Math.max(0, activeUploads - 1);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
}
const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
        // Log upaya path traversal / akses ditolak ke audit keamanan.
        if (e && (e.code === 'PATH_DENIED' || e.code === 'PATH_ESCAPE' || /traversal|keluar dari folder/i.test(e.message || ''))) {
            secLog.pathTraversal(req.ip, req.path, String(e.message || '').slice(0, 80));
        }
        if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); else res.destroy();
    }
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

app.get('/api/download', wrap((req, res) => storage.send(res, req.query.path || '', { zip: req.query.zip === '1', req })));

// Kompres file/folder menjadi .zip di folder yang sama (hasil tersimpan di flash disk)
app.post('/api/compress', wrap(async (req, res) => {
    const b = req.body || {}, name = storage.cleanName(b.name);
    if (!name) return res.status(400).json({ error: T('st.badName') });
    const out = await storage.compress((b.dir ? b.dir + '/' : '') + name);
    res.json({ success: true, name: out });
}));
app.use('/uploads', wrap((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).set('Allow', 'GET, HEAD').end();
    let rel;
    try { rel = decodeURIComponent(req.path); }
    catch { return res.status(400).json({ error: 'URL file tidak valid.' }); }
    return storage.send(res, rel, { inline: true, req });
}));

app.post('/api/upload', uploadGate, (req, res) => {
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
    telegram.start().then(() => telegram.welcome()).catch(e => console.error('[Telegram]', e.message));
    try { if (ai && typeof ai.start === 'function') ai.start(); } catch (e) { console.error('[AI]', e.message); }
    // Jadwal & otomasi dimulai setelah layanan perangkat hidup; kebijakan jadwal
    // terlewat diterapkan di scheduler.bootstrap() (default: dilewati).
    scheduler.start().catch(e => console.error('[Jadwal]', e.message));
    // Pemeriksa update GitHub: sekali saat mulai (dengan jeda & timeout), lalu tiap 12 jam.
    try { updater.start(); } catch (e) { console.error('[Update]', e.message); }
}

// Simpan state ke disk (dipakai saat berhenti maupun setelah kesalahan tak terduga).
function flushState() {
    try { sensorHistory.save(); } catch { }
    try { ai && ai.history && ai.history.save(); } catch { }
    try { auth.flush(); } catch { }              // sesi mobile (hash) ke disk
    try { mobileAuth.flush(); } catch { }        // daftar perangkat mobile ke disk
}

// Hentikan SEMUA yang berjalan lalu simpan state (dipakai SIGINT/SIGTERM dan process.exit).
// Sebelumnya hanya scheduler/updater/executor yang dihentikan: siklus polling ESP32,
// pintu, sistem, dan Telegram masih hidup (bisa memulai permintaan HTTP baru saat
// proses sedang mati), koneksi WebSocket dashboard tidak pernah ditutup, dan soket
// pendengar tidak pernah ditutup.
let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    try { clearInterval(wsWatch); } catch { }        // pemeriksa sesi WS
    try { esp32.stop(); } catch { }
    try { door.stop(); } catch { }
    try { system.stop(); } catch { }
    try { telegram.stop(); } catch { }
    try { scheduler.stop(); } catch { }
    try { updater.stop(); } catch { }
    try { executor.killAll('shutdown'); } catch { }
    try { sensorHistory.stop(); } catch { }
    try { confirm.stop(); } catch { }
    flushState();
    try { auth.stop(); } catch { }                   // sesi mobile + sweeper
    try { mobileAuth.stop(); } catch { }             // daftar perangkat mobile
    // Tutup dashboard/klien WebSocket dengan kode "going away" supaya aplikasi tahu
    // harus menyambung ulang, bukan menganggap frame-nya rusak.
    for (const ws of wss.clients) {
        try { ws.close(WS_CLOSE_GOING_AWAY, 'server shutdown'); } catch { }
        try { ws.terminate(); } catch { }
    }
    try { server.close(); } catch { }
    try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch { }
}
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shutdown(); process.exit(130); });

// ================= JARING PENGAMAN PROSES =================
// Di Termux tidak ada supervisor: satu promise yang ditolak tanpa penanganan tidak
// boleh mematikan pemantauan ESP32/pintu (Node 22 menghentikan proses bila tidak
// ditangani). Kesalahan dicatat TANPA stack trace dan tanpa isi permintaan, lalu
// state penting disimpan; proses tetap hidup supaya layanan rumah tidak ikut mati.
function logProcessError(label, err) {
    const msg = err && err.message ? err.message : String(err == null ? '' : err);
    const clean = msg.replace(/[\r\n]+/g, ' ').slice(0, 300);
    console.error(label, clean || 'tanpa pesan');
}
process.on('unhandledRejection', reason => {
    logProcessError('[Jaring] promise ditolak tanpa penanganan:', reason);
    flushState();
});
process.on('uncaughtException', err => {
    logProcessError('[Jaring] exception tak tertangani:', err);
    flushState();
});

// ================= PENUTUP ROUTE =================
// API tak dikenal -> JSON 404 (bukan halaman HTML) supaya aplikasi bisa membedakan
// "server lama tanpa endpoint" dari "endpoint ada tapi salah metode".
app.use('/api', (req, res) => res.status(404).json({
    success: false,
    error: T('st.notFound') || 'Endpoint tidak ditemukan.',
    message: 'Not found'
}));

// Penanganan error terakhir: tidak pernah mengirim stack trace / detail internal ke klien.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err && (err.status || err.statusCode)) || 500;
    const type = err && err.type;
    let message = 'Permintaan tidak valid.';
    if (type === 'entity.too.large') message = 'Isi permintaan terlalu besar.';
    else if (type === 'entity.parse.failed') message = 'JSON tidak valid.';
    else if (status < 500 && err && typeof err.message === 'string' && err.message) message = err.message;
    if (status >= 500) console.error('[HTTP]', (err && err.message) || 'internal error');
    if (String(req.path || '').startsWith('/api/')) {
        return res.status(status).json({
            success: false,
            error: status >= 500 ? 'Kesalahan server internal.' : message,
            message: status >= 500 ? 'Internal server error.' : message
        });
    }
    res.status(status).type('text/plain').send(status >= 500 ? 'Internal Server Error' : 'Bad Request');
});

function printBanner() {
    const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address)
        .sort((a, b) => (/^169\.254\./.test(a) ? 1 : 0) - (/^169\.254\./.test(b) ? 1 : 0));   // alamat link-local paling belakang
    const list = ips.length ? ips : ['localhost'];
    const port = env('PORT', 3000);
    const scheme = tls.scheme();
    console.log('=================================');
    if (!tls.isEnabled()) {
        console.log('[TLS] ⚠ Server berjalan HTTP PLAINTEXT (TLS_ENABLED=false + TLS_ALLOW_HTTP=true).');
        console.log('[TLS]   Gunakan hanya di LAN tepercaya; jangan ekspos HTTP ke internet.');
    } else {
        const d = tls.describe();
        if (d.ready) {
            console.log(`[TLS] HTTPS aktif. Masa berlaku sertifikat: ${d.certExpires} (${d.certDaysLeft} hari).`);
            if (d.ca) console.log(`[TLS] CA root: ${d.ca.subject.replace(/\n/g, ' / ')} [fingerprint ${d.ca.fingerprint}]`);
            console.log(`[TLS] Sebar root-ca.crt ke Android/browser dan percayai (lihat docs/HTTPS-LOCAL.md).`);
        } else {
            console.log('[TLS] ⚠ ' + (d.message || 'Sertifikat belum siap.'));
        }
    }
    if (setupRequired()) {
        list.forEach(ip => console.log(`Setup awal: ${scheme}://${ip}:${port}/setup.html`));
        console.log('- Buka alamat itu di HP/PC (satu WiFi dengan Termux).');
        console.log('- Di halaman setup: buat username & password, isi IP/port/kunci API ESP32');
        console.log('  dan ESP8266, isi bot Telegram, lalu isi kunci API Gemini (untuk /ai).');
        console.log('  Semua nilai di atas ditulis otomatis ke .env.');
        console.log('- Setelah selesai, dashboard bisa dibuka di ' + scheme + '://' + list[0] + ':' + port);
    } else {
        list.forEach(ip => console.log(`Server aktif: ${scheme}://${ip}:${port}`));
    }
    console.log(`ESP32       : http://${env('ESP32_IP', '(belum diisi)')}:${env('ESP32_PORT', 80)}`);
    console.log(`Pintu RFID  : http://${env('DOOR_IP', '(belum diisi)')}:${env('DOOR_PORT', 80)}`);
    console.log(`AI Agent    : ${env('GEMINI_API_KEY') ? 'kunci Gemini terisi (model ' + env('GEMINI_MODEL', 'gemini-3.5-flash-lite') + ')' : 'GEMINI_API_KEY kosong - isi lewat setup awal atau tab Pengaturan'}`);
    storage.status().then(st => console.log(st.ready ? `Penyimpanan : ${st.root} (siap, mode ${st.mode})` : `PENYIMPANAN BELUM SIAP: ${st.message}`));
    console.log('=================================');
}

// ================= VALIDASI KONFIGURASI KEAMANAN DI STARTUP =================
// Tolak konfigurasi yang membahayakan keamanan sebelum server mulai mendengarkan.
function validateSecurityConfig() {
    const errors = [];

    // 1. Gunakan konfigurasi transport yang sama dengan pembuatan server.
    const tlsEnabled = tls.isEnabled();
    if (!tlsEnabled && !tls.allowHttp()) {
        errors.push('TLS_ENABLED=false tetapi TLS_ALLOW_HTTP tidak aktif — server tidak boleh berjalan HTTP terbuka tanpa perlindungan.');
    }

    // 2. Password admin harus cukup panjang.
    const pwd = env('ADMIN_PASSWORD', '');
    if (pwd && pwd.length < 8) {
        errors.push('ADMIN_PASSWORD terlalu pendek (minimal 8 karakter).');
    }

    // 3. TRUST_PROXY=true tidak boleh dipakai (membuka spoofing).
    if (String(env('TRUST_PROXY', '')).toLowerCase() === 'true') {
        errors.push('TRUST_PROXY=true tidak aman dan akan diabaikan. Gunakan daftar IP/CIDR proxy tepercaya.');
    }

    // 4. SESSION_TTL tidak boleh terlalu panjang tanpa batas.
    const ttl = Number(env('SESSION_TTL_HOURS', '12'));
    if (Number.isFinite(ttl) && ttl > 720) {
        errors.push('SESSION_TTL_HOURS=' + ttl + ' terlalu panjang (maks 720 jam / 30 hari).');
    }

    // 5. MOBILE_SESSION_TTL tidak boleh terlalu panjang.
    const mTtl = Number(env('MOBILE_SESSION_TTL_HOURS', '720'));
    if (Number.isFinite(mTtl) && mTtl > 720) {
        errors.push('MOBILE_SESSION_TTL_HOURS=' + mTtl + ' terlalu panjang (maks 720 jam / 30 hari).');
    }

    // 6. TLS_ALLOW_NO_SAN harus eksplisit true (tidak direkomendasikan).
    if (String(env('TLS_ALLOW_NO_SAN', 'false')).toLowerCase() === 'true') {
        console.warn('[Security] TLS_ALLOW_NO_SAN=true — sertifikat tanpa SAN diizinkan (tidak direkomendasikan).');
    }

    if (errors.length) {
        console.error('[Security] Validasi konfigurasi gagal:');
        for (const e of errors) console.error('  - ' + e);
        throw new Error('Konfigurasi keamanan tidak valid. Perbaiki .env sebelum menjalankan server.');
    }
    if (tlsEnabled) {
        console.log('[Security] Validasi konfigurasi keamanan: OK (TLS aktif, password admin memenuhi syarat).');
    }
}

try { validateSecurityConfig(); }
catch (e) {
    console.error(e.message);
    process.exit(1);
}

setWebEnabled(true).then(() => {
    webRunning = true;
    printBanner();
    if (setupRequired()) console.log('[Setup] ' + T('setup.startLog'));
    else startDevices();
}).catch(e => {
    console.error('[Web] Gagal menjalankan server:', e.message);
    // Petunjuk langsung untuk penyebab paling sering: port sudah dipakai server lama.
    if (e && e.code === 'EADDRINUSE') {
        console.error(`[Web] Port ${PORT} sedang dipakai proses lain (server lama masih berjalan?).`);
        console.error('[Web] Hentikan proses lama: pkill -f "node server.js"');
        console.error(`[Web] Cek pemakai port: ss -ltnp 2>/dev/null | grep ${PORT}`);
        console.error('[Web] Atau ganti port di .env, mis. PORT=3001, lalu jalankan ulang.');
    } else if (e && e.code === 'EACCES') {
        console.error(`[Web] Tidak berhak memakai port ${PORT} (port < 1024 butuh root). Gunakan PORT >= 1024.`);
    }
    console.error('[Web] Periksa lingkungan dengan: npm run doctor');
    process.exitCode = 1;
});
