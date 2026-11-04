'use strict';
// ============================================================================
// mobile-auth.js — autentikasi aplikasi Android NodelixcoreOS Mobile.
//
// Kontrak (kompatibel dengan aplikasi `com.nodelix.coreos`):
//   POST   /api/mobile/auth/register   { username, password, deviceId, deviceName,
//                                        androidVersion, appVersion, publicKeyPem }
//   POST   /api/mobile/auth/challenge  { deviceId }
//   POST   /api/mobile/auth/verify     { deviceId, challengeId, timestamp,
//                                        signatureBase64 }     (alias: signature)
//   GET    /api/mobile/auth/session
//   POST   /api/mobile/auth/logout
//   POST   /api/mobile/auth/refresh
//   GET    /api/mobile/devices/registered
//   DELETE /api/mobile/devices/registered/:deviceId
//   POST   /api/mobile/devices/register   (alias register perangkat)
//
// Kriptografi:
//   - Kunci perangkat: ECDSA P-256 (prime256v1) X.509 SPKI `-----BEGIN PUBLIC KEY-----`.
//     Hanya PUBLIC key yang diterima & disimpan; private key tidak pernah dikirim/diminta.
//   - Tanda tangan: SHA256withECDSA, format ASN.1 DER (default Android Keystore),
//     dikirim Base64. Format mentah r||s 64 byte (JOSE/P1363) juga diterima.
//   - Pesan yang ditandatangani (UTF-8, persis seperti SignatureManager di Android):
//       NODELIXCOREOS-AUTH-V1|<deviceId>|<challengeId>|<nonceBase64>|<timestamp>|<origin>
//     `<origin>` = base URL server seperti yang diketik di aplikasi (skema://host:port),
//     huruf kecil, tanpa garis miring di akhir.
//   - Challenge sekali pakai, berbatas waktu, terikat ke perangkat.
//
// Keamanan:
//   - Registrasi perangkat hanya boleh dengan password admin (atau sesi dashboard yang
//     sudah login). Tidak ada jalur yang menerima public key tanpa otorisasi.
//   - Dilindungi pembatas percobaan per IP dan per perangkat.
//   - Endpoint mobile SELALU 4xx eksplisit (bukan 404) saat perangkat tidak dikenal,
//     supaya aplikasi tidak salah menyimpulkan "server belum mendukung mobile API".
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOMAIN = 'NODELIXCOREOS-AUTH-V1';
const ALGORITHM = 'ECDSA_P256_SHA256';
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const PEM_BEGIN = '-----BEGIN PUBLIC KEY-----';
const PEM_END = '-----END PUBLIC KEY-----';

const HOUR = 3600 * 1000;

function normOrigin(v) {
    const s = String(v == null ? '' : v).trim().replace(/\/+$/, '').toLowerCase();
    if (!s || s.includes('|')) return '';
    try {
        const u = new URL(s);
        if (!['http:', 'https:'].includes(u.protocol) || !u.hostname ||
            u.username || u.password || u.pathname !== '/' || u.search || u.hash) return '';
        // URL.origin memberi normalisasi host/port dan menolak authority ambigu.
        return u.origin.toLowerCase();
    } catch { return ''; }
}

// Pesan kanonik — urutan & pemisah HARUS sama dengan Android (SignatureManager).
function canonicalPayload({ deviceId, challengeId, nonce, timestamp, origin }) {
    return [
        DOMAIN,
        String(deviceId).trim(),
        String(challengeId).trim(),
        String(nonce).trim(),
        String(timestamp),
        normOrigin(origin)
    ].join('|');
}

function fingerprintOf(der) {
    const hex = crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
    return 'SHA256:' + hex.match(/.{2}|./g).join(':');
}

// Validasi ketat public key perangkat: SPKI PEM, EC, kurva P-256.
function parseDevicePublicKey(pem) {
    if (typeof pem !== 'string') return { ok: false, reason: 'publicKeyPem harus string PEM.' };
    const text = pem.replace(/\r\n/g, '\n').trim();
    if (text.length > 4096) return { ok: false, reason: 'publicKeyPem terlalu panjang.' };
    if (/PRIVATE KEY/.test(text)) return { ok: false, reason: 'Jangan pernah mengirim private key. Server hanya menerima public key.' };
    if (!text.startsWith(PEM_BEGIN) || !text.endsWith(PEM_END)) {
        return { ok: false, reason: 'publicKeyPem harus PEM SPKI (-----BEGIN PUBLIC KEY-----).' };
    }
    let key;
    try {
        key = crypto.createPublicKey({ key: text, format: 'pem', type: 'spki' });
    } catch {
        return { ok: false, reason: 'publicKeyPem tidak bisa dibaca sebagai kunci publik.' };
    }
    if (key.asymmetricKeyType !== 'ec') return { ok: false, reason: 'Kunci perangkat harus ECDSA (bukan RSA/Ed25519).' };
    const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
    if (curve && curve !== 'prime256v1' && curve !== 'secp256r1') {
        return { ok: false, reason: `Kurva ${curve} tidak didukung. Gunakan P-256 (prime256v1).` };
    }
    let der;
    try { der = key.export({ type: 'spki', format: 'der' }); }
    catch { return { ok: false, reason: 'Kunci publik tidak bisa diekspor ulang.' }; }
    return {
        ok: true,
        keyObject: key,
        pem: text,
        fingerprint: fingerprintOf(der),
        algorithm: ALGORITHM
    };
}

function decodeSignature(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().replace(/\s+/g, '');
    if (!s || s.length > 2048) return null;
    if (/^[0-9a-fA-F]+$/.test(s) && (s.length === 128 || (s.length >= 140 && s.length <= 144))) {
        return Buffer.from(s, 'hex');     // DER atau r||s dalam bentuk hex
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    const buf = Buffer.from(s, 'base64');
    return buf.length ? buf : null;
}

// Verifikasi tanda tangan: DER dulu (format Android Keystore), lalu r||s mentah.
function verifySignature(keyObject, payload, signature) {
    try {
        if (crypto.verify('sha256', payload, { key: keyObject, dsaEncoding: 'der' }, signature)) return 'der';
    } catch { /* coba format lain di bawah */ }
    if (signature.length === 64) {
        try {
            if (crypto.verify('sha256', payload, { key: keyObject, dsaEncoding: 'ieee-p1363' }, signature)) return 'p1363';
        } catch { /* tanda tangan tidak sah */ }
    }
    return '';
}

function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* abaikan */ }
    fs.renameSync(tmp, file);
}

module.exports = function createMobileAuth({
    app,
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]),
    auth,
    dataDir = path.join(__dirname, 'data'),
    log = () => { },
    verifyAdminPassword = null,     // dari server.js: cek password admin + batas percobaan
    clock = Date.now
} = {}) {
    if (!app) throw new Error('mobile-auth: app wajib');
    if (!auth) throw new Error('mobile-auth: modul auth wajib');

    const N = (k, d) => { const v = parseFloat(env(k, '')); return Number.isFinite(v) ? v : d; };
    const enabled = () => String(env('MOBILE_AUTH_ENABLED', 'true')).toLowerCase() !== 'false';
    const challengeTtlMs = Math.max(5, N('MOBILE_CHALLENGE_TTL_MS', 60000));
    const skewMs = Math.max(1000, N('MOBILE_CHALLENGE_SKEW_MS', 60000));
    const maxPending = Math.max(50, N('MOBILE_MAX_PENDING_CHALLENGES', 2000));
    const FILE = path.join(dataDir, 'mobile-devices.json');

    // ---------- Penyimpanan perangkat terdaftar ----------
    let devices = Object.create(null);   // deviceId -> record
    let saveTimer = null, dirty = false;

    function loadDevices() {
        try {
            const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            const list = raw && raw.devices && typeof raw.devices === 'object' ? raw.devices : {};
            for (const [id, d] of Object.entries(list)) {
                if (!DEVICE_ID_RE.test(id) || !d || typeof d !== 'object') continue;
                if (typeof d.publicKeyPem !== 'string' || !d.publicKeyPem.startsWith(PEM_BEGIN)) continue;
                devices[id] = {
                    deviceId: id,
                    deviceName: typeof d.deviceName === 'string' ? d.deviceName.slice(0, 80) : '',
                    androidVersion: typeof d.androidVersion === 'string' ? d.androidVersion.slice(0, 80) : '',
                    appVersion: typeof d.appVersion === 'string' ? d.appVersion.slice(0, 40) : '',
                    publicKeyPem: d.publicKeyPem,
                    publicKeyFingerprint: typeof d.publicKeyFingerprint === 'string' ? d.publicKeyFingerprint : '',
                    algorithm: typeof d.algorithm === 'string' ? d.algorithm : ALGORITHM,
                    registeredAt: Number(d.registeredAt) || 0,
                    lastSeenAt: Number(d.lastSeenAt) || null,
                    status: d.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
                    revokedAt: Number(d.revokedAt) || null
                };
            }
        } catch (e) {
            if (e && e.code !== 'ENOENT') log(`[Mobile] data perangkat tidak bisa dibaca (${e.code || e.message}); mulai kosong.`);
            devices = Object.create(null);
        }
    }

    function flushDevices() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (!dirty) return;
        try {
            atomicWrite(FILE, JSON.stringify({ ver: 1, devices }, null, 1));
            dirty = false;
        } catch (e) { log(`[Mobile] gagal menyimpan data perangkat: ${e.code || e.message}`); }
    }

    function saveDevices() {
        dirty = true;
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; flushDevices(); }, 200);
        if (saveTimer.unref) saveTimer.unref();
    }

    loadDevices();

    // ---------- Challenge sekali pakai ----------
    const challenges = new Map();    // challengeId -> { deviceId, nonce, issuedAt, expiresAt, origins, used }
    const challengeByDevice = new Map();  // deviceId -> challengeId (satu challenge aktif per perangkat)

    function dropChallenge(id) {
        const c = challenges.get(id);
        if (!c) return;
        challenges.delete(id);
        if (challengeByDevice.get(c.deviceId) === id) challengeByDevice.delete(c.deviceId);
    }

    function sweepChallenges() {
        const now = clock();
        for (const [id, c] of challenges) if (!(c.expiresAt > now)) dropChallenge(id);
    }

    const sweeper = setInterval(sweepChallenges, 30000);
    if (sweeper.unref) sweeper.unref();

    // ---------- Pembatas percobaan ----------
    const createLimiter = require('./auth').createLimiter;
    const regLimitIp = createLimiter({ max: 10, blockMs: 5 * 60 * 1000 });
    const challengeLimitIp = createLimiter({ max: 30, blockMs: 5 * 60 * 1000 });
    const challengeLimitDevice = createLimiter({ max: 12, blockMs: 5 * 60 * 1000 });
    const verifyLimitIp = createLimiter({ max: 20, blockMs: 5 * 60 * 1000 });
    const verifyLimitDevice = createLimiter({ max: 10, blockMs: 5 * 60 * 1000 });

    // ---------- Origin server ----------
    // Aplikasi menandatangani `profile.baseUrl()` (skema://host:port yang diketik admin).
    // Server tidak tahu tulisan persisnya, jadi kandidat disusun dari header permintaan
    // (Host / X-Forwarded-Host / X-Forwarded-Proto) + override MOBILE_AUTH_SERVER_ORIGIN.
    function requestOrigins(req) {
        const out = new Set();
        for (const o of String(env('MOBILE_AUTH_SERVER_ORIGIN', '')).split(',')) {
            const n = normOrigin(o);
            if (n) out.add(n);
        }
        // Header X-Forwarded-* tidak pernah menjadi sumber kepercayaan di sini:
        // nilainya dapat dipalsukan oleh klien kecuali proxy benar-benar dikonfigurasi.
        // Untuk TLS offload gunakan MOBILE_AUTH_SERVER_ORIGIN secara eksplisit.
        const host = String((req.headers && req.headers.host) || '').split(',')[0].trim();
        if (host) {
            const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
            for (const p of new Set([proto, 'http', 'https'])) {
                const n = normOrigin(`${p}://${host}`);
                if (n) out.add(n);
            }
        }
        return [...out];
    }

    // ---------- Util respons ----------
    const noStore = res => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
    };
    const fail = (res, status, code, message, extra = {}) => {
        noStore(res);
        return res.status(status).json({ success: false, ok: false, code, message, ...extra });
    };
    // Format sesi standar (sessionToken) + alias kompatibilitas aplikasi (accessToken).
    const sessionPayload = (sess, message) => ({
        success: true,
        ok: true,
        sessionToken: sess.token,
        accessToken: sess.token,       // alias kompatibilitas NodelixcoreOS Mobile
        tokenType: 'Bearer',
        expiresAt: sess.expiresAt,
        deviceId: sess.deviceId,
        username: sess.username,
        message
    });

    const isAdminSession = req => {
        const r = auth.resolve(req);
        return r.ok ? r : null;
    };

    // ---------- Register ----------
    function handleRegister(req, res) {
        if (!enabled()) return fail(res, 404, 'mobile_auth_disabled', 'Mobile authentication is disabled on this server.');
        if (!env('ADMIN_PASSWORD')) return fail(res, 409, 'setup_required', 'Server setup is not finished yet.');
        if (auth.tokenInQuery(req)) return fail(res, 400, 'token_in_url', 'Session tokens must not be sent in the URL.');

        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const deviceId = String(body.deviceId == null ? '' : body.deviceId).trim();
        if (!DEVICE_ID_RE.test(deviceId)) return fail(res, 400, 'bad_device_id', 'deviceId tidak valid.');

        const key = parseDevicePublicKey(body.publicKeyPem);
        if (!key.ok) return fail(res, 400, 'bad_public_key', key.reason);

        // Otorisasi: sesi DASHBOARD yang sudah login ATAU password admin.
        // Sesi Bearer mobile sengaja TIDAK boleh mendaftarkan perangkat baru tanpa
        // password admin, supaya token yang bocor tidak bisa "mengawinkan" HP lain.
        const session = isAdminSession(req);
        const webSessionOk = !!session && session.kind === 'web';
        if (!webSessionOk) {
            const ip = req.ip || 'unknown';
            const lim = regLimitIp.check(ip);
            if (lim.blocked) return fail(res, 429, 'too_many_attempts', 'Terlalu banyak percobaan registrasi. Coba lagi nanti.', { retryAfter: lim.retryAfter });

            const username = String(body.username == null ? '' : body.username).trim();
            const password = body.password;
            const userOk = username.length > 0 && auth.same(username, env('ADMIN_USERNAME', 'admin'));
            if (typeof password !== 'string' || !password || !userOk) {
                regLimitIp.fail(ip);
                return fail(res, 403, 'admin_credentials_required', 'Registrasi perangkat memerlukan username & password admin yang benar.');
            }
            if (typeof verifyAdminPassword === 'function') {
                // Memakai pemeriksaan password admin yang sama dengan dashboard (timing-safe
                // + batas 5 percobaan/5 menit per IP); fungsi ini mengirim respons sendiri.
                if (!verifyAdminPassword(req, res)) return;
            } else if (!auth.same(password, env('ADMIN_PASSWORD', ''))) {
                regLimitIp.fail(ip);
                return fail(res, 403, 'admin_credentials_required', 'Registrasi perangkat memerlukan username & password admin yang benar.');
            }
        }
        regLimitIp.reset(req.ip || 'unknown');

        const now = clock();
        const prev = devices[deviceId];
        const record = {
            deviceId,
            deviceName: cleanLabel(body.deviceName, 80),
            androidVersion: cleanLabel(body.androidVersion, 80),
            appVersion: cleanLabel(body.appVersion, 40),
            publicKeyPem: key.pem,
            publicKeyFingerprint: key.fingerprint,
            algorithm: ALGORITHM,
            registeredAt: prev && prev.registeredAt ? prev.registeredAt : now,
            lastSeenAt: now,
            status: 'ACTIVE',
            revokedAt: null
        };
        devices[deviceId] = record;
        saveDevices();

        // Satu perangkat = satu sesi aktif. Sesi lama (kunci lama) langsung dicabut.
        const revoked = auth.revokeDeviceSessions(deviceId, 're_registered');
        const sess = auth.issueMobileSession({ deviceId, username: env('ADMIN_USERNAME', 'admin') });

        noStore(res);
        log(`[Mobile] perangkat terdaftar: ${deviceId} (${record.deviceName || 'tanpa nama'}), sesi lama dicabut: ${revoked}`);
        return res.json({
            ...sessionPayload(sess, 'Device registered'),
            status: 'ACTIVE',
            registeredAt: record.registeredAt,
            publicKeyFingerprint: record.publicKeyFingerprint,
            algorithm: ALGORITHM,
            sessionsRevoked: revoked
        });
    }

    // ---------- Challenge ----------
    function handleChallenge(req, res) {
        if (!enabled()) return fail(res, 404, 'mobile_auth_disabled', 'Mobile authentication is disabled on this server.');
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const deviceId = String(body.deviceId == null ? '' : body.deviceId).trim();
        if (!DEVICE_ID_RE.test(deviceId)) return fail(res, 400, 'bad_device_id', 'deviceId tidak valid.');

        const ip = req.ip || 'unknown';
        const limIp = challengeLimitIp.check(ip);
        if (limIp.blocked) return fail(res, 429, 'too_many_attempts', 'Terlalu banyak permintaan challenge.', { retryAfter: limIp.retryAfter });
        const limDev = challengeLimitDevice.check(deviceId);
        if (limDev.blocked) return fail(res, 429, 'too_many_attempts', 'Terlalu banyak permintaan challenge untuk perangkat ini.', { retryAfter: limDev.retryAfter });
        challengeLimitIp.hit(ip);
        challengeLimitDevice.hit(deviceId);

        const dev = devices[deviceId];
        // 403 (bukan 404) supaya aplikasi tidak mengira server belum mendukung mobile API.
        if (!dev) return fail(res, 403, 'device_not_registered', 'Perangkat belum terdaftar. Login dengan password admin terlebih dahulu.');
        if (dev.status !== 'ACTIVE') return fail(res, 403, 'device_revoked', 'Perangkat ini sudah dicabut. Daftarkan ulang dengan password admin.');

        // Satu challenge aktif per perangkat: yang lama dibuang.
        const oldId = challengeByDevice.get(deviceId);
        if (oldId) dropChallenge(oldId);
        sweepChallenges();
        if (challenges.size > maxPending) {           // jaga memori tetap wajar
            const oldest = challenges.keys().next().value;
            if (oldest) dropChallenge(oldest);
        }

        const now = clock();
        const challengeId = 'chl_' + crypto.randomBytes(12).toString('hex');
        const nonce = crypto.randomBytes(32).toString('base64');
        const origins = requestOrigins(req);
        const rec = { deviceId, nonce, issuedAt: now, expiresAt: now + challengeTtlMs, origins, used: false };
        challenges.set(challengeId, rec);
        challengeByDevice.set(deviceId, challengeId);

        noStore(res);
        return res.json({
            success: true,
            ok: true,
            challengeId,
            nonce,
            issuedAt: now,
            expiresAt: rec.expiresAt,
            serverOrigin: origins[0] || '',
            originCandidates: origins.length,
            algorithm: ALGORITHM,
            ttlMs: challengeTtlMs,
            message: 'Challenge issued'
        });
    }

    // ---------- Verify ----------
    function handleVerify(req, res) {
        if (!enabled()) return fail(res, 404, 'mobile_auth_disabled', 'Mobile authentication is disabled on this server.');
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const deviceId = String(body.deviceId == null ? '' : body.deviceId).trim();
        const challengeId = String(body.challengeId == null ? '' : body.challengeId).trim();
        const rawSig = body.signatureBase64 != null ? body.signatureBase64 : body.signature;
        const timestamp = Number(body.timestamp);

        const ip = req.ip || 'unknown';
        const limIp = verifyLimitIp.check(ip);
        if (limIp.blocked) return fail(res, 429, 'too_many_attempts', 'Terlalu banyak percobaan verifikasi.', { retryAfter: limIp.retryAfter });
        const limDev = verifyLimitDevice.check(deviceId || ip);
        if (limDev.blocked) return fail(res, 429, 'too_many_attempts', 'Terlalu banyak percobaan verifikasi untuk perangkat ini.', { retryAfter: limDev.retryAfter });

        if (!DEVICE_ID_RE.test(deviceId)) return fail(res, 400, 'bad_device_id', 'deviceId tidak valid.');
        if (!/^chl_[a-f0-9]{24}$/.test(challengeId)) return fail(res, 400, 'bad_challenge_id', 'challengeId tidak valid.');
        if (!Number.isFinite(timestamp) || timestamp <= 0) return fail(res, 400, 'bad_timestamp', 'timestamp harus epoch milidetik.');
        const signature = decodeSignature(rawSig);
        if (!signature) return fail(res, 400, 'bad_signature', 'signatureBase64 tidak valid (harus Base64 DER SHA256withECDSA).');

        const challenge = challenges.get(challengeId);
        if (!challenge || challenge.deviceId !== deviceId) {
            verifyLimitIp.fail(ip); verifyLimitDevice.fail(deviceId);
            return fail(res, 401, 'challenge_invalid', 'Challenge tidak dikenal atau bukan milik perangkat ini.');
        }
        // Anti-replay: challenge dihapus sebelum verifikasi apa pun. Satu challenge = satu percobaan.
        challenge.used = true;
        dropChallenge(challengeId);

        const now = clock();
        if (!(challenge.expiresAt > now)) return fail(res, 401, 'challenge_expired', 'Challenge sudah kedaluwarsa. Minta challenge baru.');
        if (Math.abs(now - timestamp) > skewMs) return fail(res, 401, 'timestamp_out_of_range', 'Timestamp di luar batas waktu yang diizinkan.');
        if (timestamp < challenge.issuedAt - skewMs) return fail(res, 401, 'timestamp_out_of_range', 'Timestamp mendahului challenge.');

        const dev = devices[deviceId];
        if (!dev) return fail(res, 403, 'device_not_registered', 'Perangkat tidak terdaftar.');
        if (dev.status !== 'ACTIVE') return fail(res, 403, 'device_revoked', 'Perangkat sudah dicabut.');

        const parsed = parseDevicePublicKey(dev.publicKeyPem);
        if (!parsed.ok) return fail(res, 500, 'device_key_invalid', 'Kunci perangkat tersimpan tidak valid. Daftarkan ulang perangkat.');

        const origins = [];
        const push = o => { const n = normOrigin(o); if (n && !origins.includes(n)) origins.push(n); };
        if (body.serverOrigin != null) push(body.serverOrigin);
        (challenge.origins || []).forEach(push);
        requestOrigins(req).forEach(push);
        if (!origins.length) return fail(res, 500, 'origin_unavailable', 'Tidak bisa menentukan origin server untuk verifikasi.');

        let matchedOrigin = '';
        for (const origin of origins) {
            const payload = Buffer.from(canonicalPayload({ deviceId, challengeId, nonce: challenge.nonce, timestamp, origin }), 'utf8');
            if (verifySignature(parsed.keyObject, payload, signature)) { matchedOrigin = origin; break; }
        }
        if (!matchedOrigin) {
            verifyLimitIp.fail(ip); verifyLimitDevice.fail(deviceId);
            return fail(res, 401, 'invalid_signature', 'Tanda tangan tidak cocok dengan kunci perangkat terdaftar.');
        }

        verifyLimitIp.reset(ip);
        verifyLimitDevice.reset(deviceId);

        dev.lastSeenAt = now;
        saveDevices();

        const sess = auth.issueMobileSession({ deviceId, username: env('ADMIN_USERNAME', 'admin') });
        noStore(res);
        log(`[Mobile] login ECDSA berhasil: ${deviceId} (origin ${matchedOrigin})`);
        return res.json({
            ...sessionPayload(sess, 'Authentication successful'),
            origin: matchedOrigin
        });
    }

    // ---------- Sesi mobile ----------
    function handleSessionInfo(req, res) {
        const r = auth.resolve(req);
        if (!r.ok) {
            noStore(res);
            return res.status(401).json({
                success: false, authenticated: false, message: 'Not authenticated or session expired.'
            });
        }
        const dev = r.deviceId ? devices[r.deviceId] : null;
        noStore(res);
        return res.json({
            success: true,
            authenticated: true,
            method: r.kind,
            deviceId: r.deviceId || null,
            deviceStatus: dev ? dev.status : null,
            deviceName: dev ? dev.deviceName : null,
            publicKeyFingerprint: dev ? dev.publicKeyFingerprint : null,
            username: r.username || env('ADMIN_USERNAME', 'admin'),
            expiresAt: r.expiresAt || null
        });
    }

    function handleLogout(req, res) {
        const token = auth.bearerOf(req);
        const revoked = token ? auth.revokeToken(token) : false;
        noStore(res);
        return res.json({ success: true, revoked, message: revoked ? 'Logged out' : 'No active mobile session' });
    }

    function handleRefresh(req, res) {
        const token = auth.bearerOf(req);
        if (!token) { res.setHeader('WWW-Authenticate', 'Bearer realm="nodelixcoreos"'); return fail(res, 401, 'auth_required', 'Bearer token diperlukan.'); }
        const sess = auth.refreshMobileSession(token);
        if (!sess) { res.setHeader('WWW-Authenticate', 'Bearer realm="nodelixcoreos"'); return fail(res, 401, 'invalid_token', 'Sesi tidak valid atau sudah kedaluwarsa.'); }
        const dev = devices[sess.deviceId];
        if (dev) { dev.lastSeenAt = clock(); saveDevices(); }
        noStore(res);
        return res.json({ ...sessionPayload(sess, 'Session refreshed'), rotated: true });
    }

    // ---------- Manajemen perangkat (admin) ----------
    const publicDevice = (d, currentDeviceId) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        androidVersion: d.androidVersion,
        appVersion: d.appVersion,
        publicKeyFingerprint: d.publicKeyFingerprint,
        algorithm: d.algorithm,
        registeredAt: d.registeredAt,
        lastSeenAt: d.lastSeenAt || null,
        status: d.status,
        revokedAt: d.revokedAt || null,
        sessions: auth.mobileSessionCount(d.deviceId),
        isCurrentDevice: d.deviceId === currentDeviceId
    });

    function handleListDevices(req, res) {
        const r = auth.resolve(req);
        if (!r.ok) { res.setHeader('WWW-Authenticate', 'Bearer realm="nodelixcoreos"'); return fail(res, 401, 'auth_required', 'Authentication required.'); }
        const list = Object.values(devices)
            .sort((a, b) => (b.registeredAt || 0) - (a.registeredAt || 0))
            .map(d => publicDevice(d, r.deviceId));
        noStore(res);
        return res.json({ success: true, devices: list, count: list.length });
    }

    function handleRevokeDevice(req, res) {
        const r = auth.resolve(req);
        if (!r.ok) { res.setHeader('WWW-Authenticate', 'Bearer realm="nodelixcoreos"'); return fail(res, 401, 'auth_required', 'Authentication required.'); }
        const deviceId = String(req.params.deviceId || '').trim();
        if (!DEVICE_ID_RE.test(deviceId)) return fail(res, 400, 'bad_device_id', 'deviceId tidak valid.');
        const dev = devices[deviceId];
        if (!dev) return fail(res, 404, 'device_not_found', 'Perangkat tidak terdaftar.');

        const wasActive = dev.status === 'ACTIVE';
        dev.status = 'REVOKED';
        dev.revokedAt = clock();
        saveDevices();
        const sessionsRevoked = auth.revokeDeviceSessions(deviceId, 'device_revoked');
        // Hapus juga challenge yang belum dipakai milik perangkat ini.
        for (const [id, c] of challenges) if (c.deviceId === deviceId) dropChallenge(id);

        noStore(res);
        log(`[Mobile] perangkat dicabut: ${deviceId} (sesi dicabut: ${sessionsRevoked})`);
        return res.json({
            success: true,
            deviceId,
            status: 'REVOKED',
            revokedAt: dev.revokedAt,
            sessionsRevoked,
            alreadyRevoked: !wasActive,
            message: 'Device revoked'
        });
    }

    function cleanLabel(v, max) {
        const s = String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
        return s.slice(0, max);
    }

    // ---------- Route ----------
    if (!enabled()) {
        // Server yang sengaja mematikan mobile auth: 404 supaya aplikasi memakai mode
        // kompatibilitas cookie (perilaku yang memang dirancang di NodelixcoreOS Mobile).
        const off = (req, res) => fail(res, 404, 'mobile_auth_disabled', 'Mobile authentication is disabled on this server.');
        for (const p of ['/api/mobile/auth/register', '/api/mobile/auth/challenge', '/api/mobile/auth/verify',
            '/api/mobile/auth/session', '/api/mobile/auth/logout', '/api/mobile/auth/refresh',
            '/api/mobile/devices/registered', '/api/mobile/devices/register']) {
            app.all(p, off);
        }
        app.use('/api/mobile', off);
    } else {
        // Token di URL selalu ditolak (bisa bocor ke log proxy/riwayat browser).
        app.use('/api/mobile', (req, res, next) => {
            if (!auth.tokenInQuery(req)) return next();
            return fail(res, 400, 'token_in_url', 'Session token tidak boleh dikirim lewat URL. Gunakan header Authorization: Bearer.');
        });
        app.post('/api/mobile/auth/register', handleRegister);
        app.post('/api/mobile/devices/register', handleRegister);     // alias eksplisit
        app.post('/api/mobile/auth/challenge', handleChallenge);
        app.post('/api/mobile/auth/verify', handleVerify);
        app.get('/api/mobile/auth/session', handleSessionInfo);
        app.post('/api/mobile/auth/logout', handleLogout);
        app.post('/api/mobile/auth/refresh', handleRefresh);
        app.get('/api/mobile/devices/registered', handleListDevices);
        app.delete('/api/mobile/devices/registered/:deviceId', handleRevokeDevice);
        // Metode lain pada jalur mobile: 405 yang jelas (bukan HTML 404 bawaan Express).
        app.all('/api/mobile/*splat', (req, res) => fail(res, 405, 'method_not_allowed', 'Metode HTTP tidak didukung untuk endpoint mobile ini.'));
    }

    return {
        devices: () => Object.values(devices).map(d => publicDevice(d, null)),
        deviceCount: () => Object.keys(devices).length,
        pendingChallenges: () => challenges.size,
        flush: () => { flushDevices(); },
        stop() { clearInterval(sweeper); flushDevices(); },
        // dipakai pengujian & modul lain (tanpa akses ke private key — memang tidak ada)
        _internal: { challenges, canonicalPayload, parseDevicePublicKey, verifySignature, decodeSignature, normOrigin }
    };
};
