'use strict';
// ============================================================================
// auth.js — SATU tempat untuk semua pemeriksaan sesi.
//
// Ada dua jenis sesi yang sah, keduanya diperiksa di sini:
//   1. Dashboard web  : cookie `sid` (tetap seperti sebelumnya, disimpan di memori).
//   2. Aplikasi mobile: `Authorization: Bearer <token>` (token opaque 32 byte,
//      yang DISIMPAN HANYA sebagai hash SHA-256 di data/mobile-sessions.json,
//      sehingga sesi mobile tetap berlaku setelah server/Termux restart).
//
// Modul ini TIDAK menyimpan password perangkat dan TIDAK menerbitkan token untuk
// perangkat yang belum terdaftar. Pendaftaran perangkat + verifikasi tanda tangan
// ECDSA ada di mobile-auth.js; modul itu memakai `issueMobileSession()` di sini.
//
// Catatan keamanan:
//   - Tidak ada token di URL/query string (ditolak secara eksplisit).
//   - Token tidak pernah ditulis ke log: yang dicatat hanya hash pendek/ID perangkat.
//   - Perbandingan password memakai timingSafeEqual (lihat same()).
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest();
const sha256hex = v => crypto.createHash('sha256').update(String(v)).digest('hex');
// Perbandingan waktu-tetap: kedua sisi selalu di-hash 32 byte lebih dulu.
const same = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

const SID_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

const HOUR = 3600 * 1000;

// Penulisan berkas sesi: tulis ke file sementara lalu rename (atomik), hak akses 600.
function atomicWrite(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* filesystem tanpa izin unix */ }
    fs.renameSync(tmp, file);
}

// Pembatas percobaan (login, register, challenge, verify). Sama semantik dengan
// penghitung lama di server.js: N percobaan gagal -> diblokir selama blockMs.
function createLimiter({ max = 5, blockMs = 5 * 60 * 1000, maxEntries = 5000, clock = Date.now } = {}) {
    const map = new Map();   // key -> { n, until }
    const bump = key => {
        const e = map.get(key) || { n: 0, until: 0 };
        e.n++;
        if (e.n >= max) { e.n = 0; e.until = clock() + blockMs; }
        map.set(key, e);
        // Batas jumlah kunci supaya IP/ID palsu tidak menghabiskan memori.
        if (map.size > maxEntries) map.delete(map.keys().next().value);
        return e;
    };
    return {
        check(key) {
            const e = map.get(key);
            if (!e || !e.until) return { blocked: false, retryAfter: 0 };
            if (e.until > clock()) return { blocked: true, retryAfter: Math.ceil((e.until - clock()) / 1000) };
            map.delete(key);   // blokir sudah lewat
            return { blocked: false, retryAfter: 0 };
        },
        fail: bump,                        // percobaan gagal (login/verifikasi)
        hit: bump,                         // pembatas jumlah permintaan
        reset(key) { map.delete(key); },
        clear() { map.clear(); },
        size: () => map.size
    };
}

module.exports = function createAuth({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]),
    dataDir = path.join(__dirname, 'data'),
    onRevoke = () => { },
    log = () => { },
    clock = Date.now
} = {}) {
    const N = (k, d) => { const v = parseFloat(env(k, '')); return Number.isFinite(v) ? v : d; };

    const webTtlMs = Math.max(1, N('SESSION_TTL_HOURS', 12)) * HOUR;
    // Sesi mobile lebih panjang karena aplikasi memakai kunci perangkat (tanpa password
    // tersimpan). Dicabut kapan saja lewat logout atau pencabutan perangkat.
    const mobileTtlMs = Math.max(1, N('MOBILE_SESSION_TTL_HOURS', 720)) * HOUR;
    const FILE = path.join(dataDir, 'mobile-sessions.json');
    const LAST_USED_GRANULARITY = 60 * 1000;   // batasi penulisan berkas saat token dipakai
    // Batas sesi per perangkat. Setiap login biometrik menerbitkan token baru; tanpa
    // batas, sesi lama yang tidak dipakai lagi menumpuk sampai TTL 720 jam.
    const maxSessionsPerDevice = () => {
        const v = Math.floor(N('MOBILE_MAX_SESSIONS_PER_DEVICE', 10));
        return v >= 1 ? Math.min(v, 100) : 10;
    };

    // ---------- Sesi web (cookie sid) ----------
    const sessions = new Map();          // sid -> { expiresAt, createdAt }
    let revokeHandler = onRevoke;

    // ---------- Sesi mobile (bearer, persisten, disimpan sebagai hash) ----------
    // mobile: tokenHash -> { deviceId, username, createdAt, expiresAt, lastUsedAt }
    let mobile = Object.create(null);
    let mobileDirty = false;
    let saveTimer = null;

    function loadMobile() {
        try {
            const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            const list = raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
            const now = clock();
            let dropped = 0;
            for (const [hash, s] of Object.entries(list)) {
                if (!TOKEN_RE.test(hash)) { dropped++; continue; }
                if (!s || typeof s !== 'object') { dropped++; continue; }
                if (!(Number(s.expiresAt) > now)) { dropped++; continue; }        // kedaluwarsa -> buang
                if (typeof s.deviceId !== 'string' || !s.deviceId) { dropped++; continue; }
                mobile[hash] = {
                    deviceId: s.deviceId,
                    username: typeof s.username === 'string' && s.username ? s.username : 'admin',
                    createdAt: Number(s.createdAt) || now,
                    expiresAt: Number(s.expiresAt),
                    lastUsedAt: Number(s.lastUsedAt) || Number(s.createdAt) || now
                };
            }
            if (dropped) { mobileDirty = true; scheduleSave(); }
        } catch (e) {
            if (e && e.code !== 'ENOENT') log(`[Auth] berkas sesi mobile tidak bisa dibaca (${e.code || e.message}); mulai kosong.`);
            mobile = Object.create(null);
        }
    }

    function serializeMobile() {
        const list = {};
        for (const [hash, s] of Object.entries(mobile)) {
            list[hash] = {
                deviceId: s.deviceId,
                username: s.username,
                createdAt: s.createdAt,
                expiresAt: s.expiresAt,
                lastUsedAt: s.lastUsedAt
            };
        }
        return JSON.stringify({ ver: 1, sessions: list });
    }

    function flush({ throwOnError = false } = {}) {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!mobileDirty) return true;
        try {
            atomicWrite(FILE, serializeMobile());
            mobileDirty = false;
            return true;
        } catch (e) {
            log(`[Auth] gagal menyimpan sesi mobile: ${e.code || e.message}`);
            if (throwOnError) throw e;
            return false;
        }
    }

    function scheduleSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250);
        if (saveTimer.unref) saveTimer.unref();
    }

    loadMobile();

    // ---------- Cookie & header ----------
    const sidOf = req => {
        const raw = String((req && req.headers && req.headers.cookie) || '');
        const m = /(?:^|;\s*)sid=([A-Za-z0-9]+)/.exec(raw);
        return m && SID_RE.test(m[1]) ? m[1] : '';
    };

    const bearerOf = req => {
        const raw = String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
        const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(raw);
        return m ? m[1] : '';
    };

    // Tolak token yang dikirim lewat URL (kebocoran ke log/riwayat/proxy).
    const TOKEN_QUERY_KEYS = ['token', 'sessiontoken', 'session_token', 'access_token', 'accesstoken', 'bearer', 'authorization'];
    function tokenInQuery(req) {
        const q = (req && req.query) || {};
        for (const k of Object.keys(q)) if (TOKEN_QUERY_KEYS.includes(String(k).toLowerCase())) return k;
        return '';
    }

    // ---------- Sesi web ----------
    function createSession(res, { secure = false } = {}) {
        const sid = crypto.randomBytes(32).toString('hex');
        sessions.set(sid, { expiresAt: clock() + webTtlMs, createdAt: clock() });
        if (res && typeof res.setHeader === 'function') {
            const secureAttr = secure ? '; Secure' : '';
            res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(webTtlMs / 1000)}${secureAttr}`);
        }
        return sid;
    }

    function webSession(sid) {
        if (!sid) return null;
        const e = sessions.get(sid);
        if (!e) return null;
        if (e.expiresAt < clock()) { sessions.delete(sid); return null; }
        return e;
    }

    function destroyWebSession(sid) {
        if (!sid || !sessions.delete(sid)) return false;
        safeRevoke({ kind: 'web', sid });
        return true;
    }

    function clearWebSessions() {
        const dropped = [...sessions.keys()];
        sessions.clear();
        // WebSocket milik sesi yang diputus ikut ditutup seketika.
        for (const sid of dropped) safeRevoke({ kind: 'web', sid });
    }

    // Setelah password diganti: sesi web lain diputuskan, sesi yang sedang dipakai tetap jalan.
    function keepOnly(req) {
        const keep = sidOf(req);
        for (const k of [...sessions.keys()]) {
            if (k === keep) continue;
            sessions.delete(k);
            safeRevoke({ kind: 'web', sid: k });
        }
        return keep;
    }

    // ---------- Sesi mobile ----------
    function issueMobileSession({ deviceId, username = 'admin', ttlMs } = {}) {
        if (!deviceId) throw new Error('deviceId wajib untuk sesi mobile');
        const token = crypto.randomBytes(32).toString('hex');   // 64 karakter hex (opaque)
        const hash = sha256hex(token);
        const now = clock();
        const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : mobileTtlMs;
        mobile[hash] = { deviceId, username, createdAt: now, expiresAt: now + ttl, lastUsedAt: now };
        // Sesi paling lama milik perangkat yang sama dipensiunkan bila melewati batas
        // (sesi baru tetap yang dipakai aplikasi; token lama tidak menggantung selamanya).
        pruneDeviceSessions(deviceId);
        mobileDirty = true;
        flush();   // sesi baru harus langsung tahan restart
        return { token, tokenHash: hash, expiresAt: mobile[hash].expiresAt, deviceId, username };
    }

    function pruneDeviceSessions(deviceId) {
        const limit = maxSessionsPerDevice();
        const mine = Object.entries(mobile).filter(([, s]) => s.deviceId === deviceId);
        if (mine.length <= limit) return 0;
        mine.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
        let dropped = 0;
        for (const [hash, s] of mine.slice(0, mine.length - limit)) {
            delete mobile[hash];
            dropped++;
            safeRevoke({ kind: 'mobile', deviceId: s.deviceId, tokenHash: hash, reason: 'session_limit' });
        }
        return dropped;
    }

    function mobileSession(token) {
        if (!token || !TOKEN_RE.test(token)) return null;
        const hash = sha256hex(token);
        const s = mobile[hash];
        if (!s) return null;
        const now = clock();
        if (!(s.expiresAt > now)) {
            delete mobile[hash];
            mobileDirty = true;
            scheduleSave();
            safeRevoke({ kind: 'mobile', deviceId: s.deviceId, tokenHash: hash, reason: 'expired' });
            return null;
        }
        if (now - (s.lastUsedAt || 0) > LAST_USED_GRANULARITY) {
            s.lastUsedAt = now;
            mobileDirty = true;
            scheduleSave();
        }
        return { ...s, tokenHash: hash };
    }

    function revokeToken(token) {
        if (!token || !TOKEN_RE.test(token)) return false;
        const hash = sha256hex(token);
        const s = mobile[hash];
        if (!s) return false;
        delete mobile[hash];
        mobileDirty = true;
        flush();
        safeRevoke({ kind: 'mobile', deviceId: s.deviceId, tokenHash: hash, reason: 'logout' });
        return true;
    }

    function revokeDeviceSessions(deviceId, reason = 'device_revoked') {
        let n = 0;
        for (const [hash, s] of Object.entries(mobile)) {
            if (s.deviceId !== deviceId) continue;
            delete mobile[hash];
            n++;
            safeRevoke({ kind: 'mobile', deviceId, tokenHash: hash, reason });
        }
        if (n) { mobileDirty = true; flush(); }
        return n;
    }

    // Perpanjang sesi (rotasi token): token lama dicabut, token baru diterbitkan.
    function refreshMobileSession(token) {
        const s = mobileSession(token);
        if (!s) return null;
        const next = issueMobileSession({ deviceId: s.deviceId, username: s.username });
        revokeToken(token);
        return next;
    }

    function mobileSessionCount(deviceId) {
        let n = 0;
        for (const s of Object.values(mobile)) if (!deviceId || s.deviceId === deviceId) n++;
        return n;
    }

    // Cabut semua sesi Bearer setelah perubahan/reset password admin.
    // Persist dilakukan sebelum event WebSocket dikirim dan sebelum pemanggil
    // menganggap operasi berhasil. Jika disk gagal, token ditolak di memori
    // dan error diteruskan agar endpoint tidak melaporkan sukses.
    function revokeAllMobileSessions(reason = 'admin_password_changed') {
        const dropped = Object.entries(mobile);
        if (!dropped.length) return 0;
        for (const [hash] of dropped) delete mobile[hash];
        mobileDirty = true;
        flush({ throwOnError: true });
        for (const [hash, s] of dropped) {
            safeRevoke({ kind: 'mobile', deviceId: s.deviceId, tokenHash: hash, reason });
        }
        log(`[Auth] seluruh sesi mobile dicabut: ${dropped.length} (reason=${String(reason).slice(0, 64)})`);
        return dropped.length;
    }

    function safeRevoke(evt) {
        try { revokeHandler(evt); } catch (e) { log(`[Auth] handler pencabutan gagal: ${e.message}`); }
    }

    // ---------- Pemeriksaan terpusat ----------
    // Hasil: { ok, kind:'web'|'mobile', sid?, deviceId?, username?, expiresAt?, tokenHash? }
    function resolve(req) {
        const token = bearerOf(req);
        if (token) {
            const s = mobileSession(token);
            if (s) {
                // Token mentah sengaja TIDAK dimasukkan ke hasil: hanya hash-nya, supaya
                // identitas sesi aman disimpan di objek permintaan/koneksi.
                return {
                    ok: true, kind: 'mobile', deviceId: s.deviceId, username: s.username,
                    expiresAt: s.expiresAt, tokenHash: s.tokenHash
                };
            }
            // Bearer dikirim tapi tidak sah: jangan diam-diam turun ke cookie,
            // kecuali cookie web masih sah (aplikasi bisa menyimpan keduanya).
            const sid = sidOf(req);
            const w = webSession(sid);
            if (w) return { ok: true, kind: 'web', sid, username: env('ADMIN_USERNAME', 'admin'), expiresAt: w.expiresAt };
            return { ok: false, reason: 'invalid_token' };
        }
        const sid = sidOf(req);
        const w = webSession(sid);
        if (w) return { ok: true, kind: 'web', sid, username: env('ADMIN_USERNAME', 'admin'), expiresAt: w.expiresAt };
        return { ok: false, reason: sid ? 'expired' : 'missing' };
    }

    function isAuthed(req) { return resolve(req).ok; }

    // Validasi ulang sesi yang sudah terhubung (WebSocket) tanpa membaca cookie lagi.
    function revalidate(sess) {
        if (!sess) return false;
        if (sess.kind === 'web') return !!webSession(sess.sid);
        if (sess.kind === 'mobile') {
            const s = mobile[sess.tokenHash];
            if (!s) return false;
            if (!(s.expiresAt > clock())) { delete mobile[sess.tokenHash]; mobileDirty = true; scheduleSave(); return false; }
            return s.deviceId === sess.deviceId;
        }
        return false;
    }

    function requireAuth(req, res, next) {
        const blocked = tokenInQuery(req);
        if (blocked) {
            return res.status(400).json({
                success: false,
                error: 'Session token tidak boleh dikirim lewat URL. Gunakan header Authorization: Bearer.',
                message: 'Session token must not be sent in the URL. Use the Authorization header.'
            });
        }
        const r = resolve(req);
        if (!r.ok) {
            if (r.reason === 'invalid_token' || bearerOf(req)) {
                res.setHeader('WWW-Authenticate', 'Bearer realm="nodelixcoreos"');
            }
            return res.status(401).json({
                success: false,
                error: 'Silakan login terlebih dahulu.',
                message: 'Authentication required.'
            });
        }
        req.auth = r;
        next();
    }

    function setRevokeHandler(fn) {
        if (typeof fn === 'function') revokeHandler = fn;
    }

    // ---------- Pembersihan berkala ----------
    const sweeper = setInterval(() => {
        const now = clock();
        for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
        let changed = false;
        for (const [hash, s] of Object.entries(mobile)) {
            if (!(s.expiresAt > now)) { delete mobile[hash]; changed = true; }
        }
        if (changed) { mobileDirty = true; scheduleSave(); }
    }, 10 * 60 * 1000);
    if (sweeper.unref) sweeper.unref();

    return {
        // web
        sessions,
        sidOf, bearerOf, createSession, webSession, destroyWebSession, clearWebSessions, keepOnly,
        get webTtlMs() { return webTtlMs; },
        // mobile
        issueMobileSession, revokeToken, revokeDeviceSessions, revokeAllMobileSessions, refreshMobileSession,
        mobileSessionCount,
        get mobileTtlMs() { return mobileTtlMs; },
        mobileSessionsFile: FILE,
        // shared
        same, sha256hex, resolve, isAuthed, revalidate, requireAuth, tokenInQuery,
        setRevokeHandler, flush,
        stop() { clearInterval(sweeper); flush(); }
    };
};

module.exports.createLimiter = createLimiter;
module.exports.same = same;
module.exports.sha256hex = sha256hex;
