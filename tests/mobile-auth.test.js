// ============================================================================
// tests/mobile-auth.test.js — autentikasi ECDSA P-256 untuk aplikasi Android.
//
// Uji HTTP & WebSocket sungguhan (port acak di 127.0.0.1), tanpa perangkat keras:
//   • register (wajib password admin, validasi PEM/kurva, tolak private key)
//   • challenge (nonce 32 byte, sekali pakai, punya masa berlaku)
//   • verify (SHA256withECDSA DER Base64, kanonik sama dengan Android)
//   • anti-replay, tanda tangan salah, timestamp basi, challenge kedaluwarsa
//   • Bearer di REST & WebSocket, cookie `sid` lama tetap berfungsi
//   • logout, refresh, pencabutan perangkat, sesi tahan restart
//   • token tidak boleh lewat query string
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const WebSocket = require('ws');

const createAuth = require('../auth');
const createMobileAuth = require('../mobile-auth');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'rahasia-admin-123';
const DEVICE_ID = 'ndlx-550e8400-e29b-41d4-a716-446655440000';

// ---------- Alat kriptografi (meniru Android Keystore) ----------
const newKeyPair = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicPem = pair => pair.publicKey.export({ type: 'spki', format: 'pem' });

// String kanonik HARUS identik dengan SignatureManager.kt di aplikasi Android.
const canonical = (deviceId, challengeId, nonce, timestamp, origin) => [
    'NODELIXCOREOS-AUTH-V1',
    deviceId.trim(),
    challengeId.trim(),
    nonce.trim(),
    String(timestamp),
    origin.trim().replace(/\/+$/, '').toLowerCase()
].join('|');

const signDer = (privateKey, payload) =>
    crypto.sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
const signP1363 = (privateKey, payload) =>
    crypto.sign('sha256', Buffer.from(payload, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

// ---------- Server uji (Express + ws, tanpa modul perangkat) ----------
async function startServer({ dataDir, envExtra = {} } = {}) {
    const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-mobile-'));
    const envMap = {
        ADMIN_USERNAME,
        ADMIN_PASSWORD,
        SESSION_TTL_HOURS: '1',
        MOBILE_SESSION_TTL_HOURS: '24',
        ...envExtra
    };
    const env = (k, d) => (envMap[k] === undefined || envMap[k] === '' ? d : envMap[k]);
    const { createLimiter } = require('../auth');

    const app = express();
    app.use(express.json());

    const auth = createAuth({ env, dataDir: dir, log: () => { } });
    const passwordLimiter = createLimiter({ max: 5, blockMs: 5 * 60 * 1000 });
    // Sama seperti server.js: timing-safe + batas 5 percobaan/5 menit per IP.
    const verifyAdminPassword = (req, res) => {
        const lim = passwordLimiter.check(req.ip);
        if (lim.blocked) { res.status(429).json({ success: false, message: 'tooMany' }); return false; }
        const p = (req.body || {}).password;
        if (typeof p !== 'string' || !auth.same(p, env('ADMIN_PASSWORD', ''))) {
            passwordLimiter.fail(req.ip);
            res.status(403).json({ success: false, message: 'wrong password' });
            return false;
        }
        passwordLimiter.reset(req.ip);
        return true;
    };

    const mobile = createMobileAuth({ app, env, auth, dataDir: dir, verifyAdminPassword, log: () => { } });

    app.post('/api/login', (req, res) => {
        const { username = '', password = '' } = req.body || {};
        if (!(auth.same(username, env('ADMIN_USERNAME', 'admin')) & auth.same(password, env('ADMIN_PASSWORD', '')))) {
            return res.status(401).json({ success: false, message: 'wrong' });
        }
        auth.createSession(res);
        res.json({ success: true });
    });
    app.post('/api/logout', (req, res) => {
        const sid = auth.sidOf(req);
        if (sid) auth.destroyWebSession(sid);
        res.json({ success: true });
    });
    app.get('/api/protected', auth.requireAuth, (req, res) =>
        res.json({ success: true, kind: req.auth.kind, deviceId: req.auth.deviceId || null }));

    const server = http.createServer(app);
    const wss = new WebSocket.Server({ noServer: true });
    auth.setRevokeHandler(evt => {
        for (const ws of wss.clients) {
            const a = ws.auth;
            if (!a) continue;
            const match = evt.kind === 'mobile' && a.kind === 'mobile'
                ? ((evt.tokenHash && a.tokenHash === evt.tokenHash) || (evt.deviceId && a.deviceId === evt.deviceId))
                : (evt.kind === 'web' && a.kind === 'web' && evt.sid === a.sid);
            if (match) { try { ws.close(4403, 'session revoked'); } catch { } }
        }
    });
    server.on('upgrade', (req, socket, head) => {
        const r = auth.resolve(req);
        if (!r.ok) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
        wss.handleUpgrade(req, socket, head, ws => { ws.auth = r; wss.emit('connection', ws, req); });
    });
    wss.on('connection', ws => { ws.send(JSON.stringify({ type: 'SENSOR', data: { online: false } })); });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const wsBase = `ws://127.0.0.1:${server.address().port}`;

    return {
        base, wsBase, dir, auth, mobile, envMap,
        async close() {
            for (const ws of wss.clients) { try { ws.terminate(); } catch { } }
            wss.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            auth.stop();
            mobile.stop();
        }
    };
}

const json = async (url, opts = {}) => {
    const r = await fetch(url, opts);
    let body = null;
    try { body = await r.json(); } catch { }
    return { status: r.status, body, headers: r.headers };
};
const post = (url, body, token) => json(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
});

async function register(cfg, pair, deviceId = DEVICE_ID, overrides = {}) {
    return post(`${cfg.base}/api/mobile/auth/register`, {
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
        deviceId,
        deviceName: 'Pixel Test',
        androidVersion: 'Android 15 (API 35)',
        appVersion: '1.0.0',
        publicKeyPem: publicPem(pair),
        ...overrides
    });
}

// Menjalankan alur penuh: register -> challenge -> tanda tangan -> verify.
async function loginWithDevice(cfg, pair, deviceId = DEVICE_ID) {
    const reg = await register(cfg, pair, deviceId);
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const ts = Date.now();
    const payload = canonical(deviceId, ch.body.challengeId, ch.body.nonce, ts, cfg.base);
    const ver = await post(`${cfg.base}/api/mobile/auth/verify`, {
        deviceId,
        challengeId: ch.body.challengeId,
        timestamp: ts,
        signatureBase64: signDer(pair.privateKey, payload)
    });
    return { reg, challenge: ch.body, verify: ver };
}

// ---------- Register ----------
test('register: password admin wajib dan validasi public key ketat', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const noAuth = await register(cfg, pair, DEVICE_ID, { password: 'salah-sekali' });
        assert.equal(noAuth.status, 403, JSON.stringify(noAuth.body));
        assert.equal(noAuth.body.success, false);
        assert.ok(!noAuth.body.sessionToken);

        // Public key bukan EC P-256 / bukan SPKI / private key -> 400.
        const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
        const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'pem' });
        for (const pem of [rsa, p384, 'bukan-pem', '']) {
            const r = await register(cfg, pair, DEVICE_ID, { publicKeyPem: pem });
            assert.equal(r.status, 400, `pem ${String(pem).slice(0, 20)} harus ditolak`);
            assert.equal(r.body.code, 'bad_public_key');
        }
        const priv = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        const withPriv = await register(cfg, pair, DEVICE_ID, { publicKeyPem: priv });
        assert.equal(withPriv.status, 400);

        // deviceId aneh ditolak.
        for (const id of ['', 'x', 'has space', 'a|b|c|||', 'z'.repeat(200)]) {
            const r = await register(cfg, pair, id);
            assert.equal(r.status, 400, `deviceId ${id} harus ditolak`);
        }

        const ok = await register(cfg, pair);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.success, true);
        assert.equal(ok.body.deviceId, DEVICE_ID);
        assert.match(ok.body.sessionToken, /^[a-f0-9]{64}$/);
        assert.equal(ok.body.accessToken, ok.body.sessionToken, 'alias accessToken untuk aplikasi');
        assert.equal(ok.body.tokenType, 'Bearer');
        assert.ok(ok.body.expiresAt > Date.now());
        assert.match(ok.body.publicKeyFingerprint, /^SHA256:([0-9A-F]{2}:)+[0-9A-F]{2}$/);
    } finally { await cfg.close(); }
});

test('register: sesi dari password admin langsung bisa dipakai Bearer, dan PEM tidak bocor', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const reg = await register(cfg, pair);
        const token = reg.body.sessionToken;

        const prot = await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(prot.status, 200);
        assert.equal(prot.body.kind, 'mobile');
        assert.equal(prot.body.deviceId, DEVICE_ID);

        const list = await json(`${cfg.base}/api/mobile/devices/registered`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(list.status, 200);
        assert.equal(list.body.devices.length, 1);
        assert.equal(list.body.devices[0].isCurrentDevice, true);
        assert.equal(list.body.devices[0].status, 'ACTIVE');
        assert.ok(!JSON.stringify(list.body).includes('BEGIN PUBLIC KEY'), 'public key tidak dikirim ke klien');
        assert.ok(!JSON.stringify(list.body).includes(token), 'token tidak dikirim di daftar perangkat');
    } finally { await cfg.close(); }
});

test('register: sesi dashboard boleh mendaftarkan perangkat, sesi Bearer butuh password', async () => {
    const cfg = await startServer();
    try {
        // Sesi dashboard (cookie) -> boleh tanpa password.
        const login = await post(`${cfg.base}/api/login`, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
        const cookie = String(login.headers.get('set-cookie')).split(';')[0];
        const a = newKeyPair();
        const viaCookie = await json(`${cfg.base}/api/mobile/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ deviceId: 'ndlx-via-dashboard-01', publicKeyPem: publicPem(a) })
        });
        assert.equal(viaCookie.status, 200, JSON.stringify(viaCookie.body));

        // Sesi Bearer perangkat lain tidak boleh mendaftarkan perangkat baru tanpa password.
        const b = newKeyPair();
        const { verify } = await loginWithDevice(cfg, b, 'ndlx-first-device-0001');
        const token = verify.body.sessionToken;
        const viaBearer = await post(`${cfg.base}/api/mobile/auth/register`, {
            deviceId: 'ndlx-second-device-002', publicKeyPem: publicPem(newKeyPair())
        }, token);
        assert.equal(viaBearer.status, 403);
        assert.equal(viaBearer.body.code, 'admin_credentials_required');

        // Dengan password admin tetap boleh (mis. menambah HP kedua dari aplikasi).
        const withPassword = await post(`${cfg.base}/api/mobile/auth/register`, {
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD,
            deviceId: 'ndlx-second-device-002',
            publicKeyPem: publicPem(newKeyPair())
        }, token);
        assert.equal(withPassword.status, 200, JSON.stringify(withPassword.body));
    } finally { await cfg.close(); }
});

// ---------- Challenge & verify ----------
test('challenge: nonce 32 byte acak, TTL 60 detik, satu aktif per perangkat', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        await register(cfg, pair);

        const a = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        assert.equal(a.status, 200, JSON.stringify(a.body));
        assert.equal(Buffer.from(a.body.nonce, 'base64').length, 32);
        assert.match(a.body.challengeId, /^chl_[a-f0-9]{24}$/);
        assert.ok(a.body.expiresAt - a.body.issuedAt <= 60_000);
        assert.equal(a.body.algorithm, 'ECDSA_P256_SHA256');
        assert.ok(a.body.serverOrigin.startsWith('http://127.0.0.1:'));

        const b = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        assert.notEqual(b.body.challengeId, a.body.challengeId);
        assert.notEqual(b.body.nonce, a.body.nonce);

        // Perangkat tidak dikenal: 403 (bukan 404) supaya aplikasi tidak salah fallback.
        const unknown = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: 'ndlx-tidak-ada-0001' });
        assert.equal(unknown.status, 403);
        assert.equal(unknown.body.code, 'device_not_registered');
    } finally { await cfg.close(); }
});

test('verify: tanda tangan DER Base64 yang benar menerbitkan sessionToken', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        assert.equal(verify.status, 200, JSON.stringify(verify.body));
        assert.equal(verify.body.success, true);
        assert.equal(verify.body.message, 'Authentication successful');
        assert.match(verify.body.sessionToken, /^[a-f0-9]{64}$/);
        assert.equal(verify.body.accessToken, verify.body.sessionToken);
        assert.equal(verify.body.username, ADMIN_USERNAME);
        assert.ok(verify.body.expiresAt > Date.now());

        const prot = await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${verify.body.sessionToken}` } });
        assert.equal(prot.status, 200);
        assert.equal(prot.body.deviceId, DEVICE_ID);
    } finally { await cfg.close(); }
});

test('verify: challenge sekali pakai (replay ditolak)', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        await register(cfg, pair);
        const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts = Date.now();
        const payload = canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, cfg.base);
        const body = {
            deviceId: DEVICE_ID,
            challengeId: ch.body.challengeId,
            timestamp: ts,
            signatureBase64: signDer(pair.privateKey, payload)
        };
        const first = await post(`${cfg.base}/api/mobile/auth/verify`, body);
        assert.equal(first.status, 200, JSON.stringify(first.body));

        const replay = await post(`${cfg.base}/api/mobile/auth/verify`, body);
        assert.equal(replay.status, 401);
        assert.equal(replay.body.code, 'challenge_invalid');
        assert.ok(!replay.body.sessionToken);
    } finally { await cfg.close(); }
});

test('verify: tanda tangan salah, origin salah, timestamp basi, dan kunci lain ditolak', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const other = newKeyPair();
        await register(cfg, pair);

        const issue = () => post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });

        // 1. Ditandatangani kunci lain.
        let ch = await issue();
        let ts = Date.now();
        let sig = signDer(other.privateKey, canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, cfg.base));
        let r = await post(`${cfg.base}/api/mobile/auth/verify`, { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: sig });
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'invalid_signature');

        // 2. Origin berbeda (domain separation).
        ch = await issue();
        ts = Date.now();
        sig = signDer(pair.privateKey, canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, 'https://evil.example'));
        r = await post(`${cfg.base}/api/mobile/auth/verify`, { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: sig });
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'invalid_signature');

        // 3. Timestamp di luar batas 60 detik.
        ch = await issue();
        ts = Date.now() - 5 * 60 * 1000;
        sig = signDer(pair.privateKey, canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, cfg.base));
        r = await post(`${cfg.base}/api/mobile/auth/verify`, { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: sig });
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'timestamp_out_of_range');

        // 4. Challenge milik perangkat lain tidak bisa dipakai.
        const otherId = 'ndlx-other-device-0002';
        await register(cfg, other, otherId);
        ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: otherId });
        ts = Date.now();
        sig = signDer(other.privateKey, canonical(otherId, ch.body.challengeId, ch.body.nonce, ts, cfg.base));
        r = await post(`${cfg.base}/api/mobile/auth/verify`, { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: sig });
        assert.equal(r.status, 401);

        // 5. Body tidak lengkap / format salah -> 400.
        for (const body of [
            {},
            { deviceId: DEVICE_ID },
            { deviceId: DEVICE_ID, challengeId: 'chl_zzz', timestamp: ts, signatureBase64: 'AAAA' },
            { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: 'x', signatureBase64: 'AAAA' },
            { deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: '!!!bukan-base64!!!' }
        ]) {
            const bad = await post(`${cfg.base}/api/mobile/auth/verify`, body);
            assert.equal(bad.status, 400, JSON.stringify(body));
            assert.equal(bad.body.success, false);
        }
    } finally { await cfg.close(); }
});

test('verify: challenge kedaluwarsa ditolak meski tanda tangan benar', async () => {
    const cfg = await startServer({ envExtra: { MOBILE_CHALLENGE_TTL_MS: '20' } });
    try {
        const pair = newKeyPair();
        await register(cfg, pair);
        const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts = Date.now();
        const payload = canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, cfg.base);
        await new Promise(r => setTimeout(r, 60));
        const r = await post(`${cfg.base}/api/mobile/auth/verify`, {
            deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, signatureBase64: signDer(pair.privateKey, payload)
        });
        assert.equal(r.status, 401);
        assert.equal(r.body.code, 'challenge_expired');
    } finally { await cfg.close(); }
});

test('verify: menerima alias field `signature` dan format r||s (P1363)', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        await register(cfg, pair);

        const ch1 = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts1 = Date.now();
        const r1 = await post(`${cfg.base}/api/mobile/auth/verify`, {
            deviceId: DEVICE_ID, challengeId: ch1.body.challengeId, timestamp: ts1,
            signature: signDer(pair.privateKey, canonical(DEVICE_ID, ch1.body.challengeId, ch1.body.nonce, ts1, cfg.base))
        });
        assert.equal(r1.status, 200, JSON.stringify(r1.body));

        const ch2 = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts2 = Date.now();
        const r2 = await post(`${cfg.base}/api/mobile/auth/verify`, {
            deviceId: DEVICE_ID, challengeId: ch2.body.challengeId, timestamp: ts2,
            signatureBase64: signP1363(pair.privateKey, canonical(DEVICE_ID, ch2.body.challengeId, ch2.body.nonce, ts2, cfg.base))
        });
        assert.equal(r2.status, 200, JSON.stringify(r2.body));
    } finally { await cfg.close(); }
});

test('verify: reverse proxy origin harus dikonfigurasi di server, bukan dipercaya dari klien', async () => {
    const origin = 'https://nodelix.example:8443';
    const cfg = await startServer({ envExtra: { MOBILE_AUTH_SERVER_ORIGIN: origin } });
    try {
        const pair = newKeyPair();
        await register(cfg, pair);
        const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts = Date.now();
        const origin = 'https://nodelix.example:8443';
        const r = await post(`${cfg.base}/api/mobile/auth/verify`, {
            deviceId: DEVICE_ID, challengeId: ch.body.challengeId, timestamp: ts, serverOrigin: origin + '/',
            signatureBase64: signDer(pair.privateKey, canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, origin))
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally { await cfg.close(); }
});

// ---------- Sesi, logout, refresh, pencabutan ----------
test('session info & logout: token dicabut dan tidak berlaku lagi', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const token = verify.body.sessionToken;

        const info = await json(`${cfg.base}/api/mobile/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(info.status, 200);
        assert.equal(info.body.authenticated, true);
        assert.equal(info.body.deviceId, DEVICE_ID);
        assert.equal(info.body.deviceStatus, 'ACTIVE');
        assert.equal(info.body.username, ADMIN_USERNAME);

        const out = await post(`${cfg.base}/api/mobile/auth/logout`, {}, token);
        assert.equal(out.status, 200);
        assert.equal(out.body.success, true);
        assert.equal(out.body.revoked, true);

        assert.equal((await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
        assert.equal((await json(`${cfg.base}/api/mobile/auth/session`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);

        // logout bersifat idempoten
        const again = await post(`${cfg.base}/api/mobile/auth/logout`, {}, token);
        assert.equal(again.status, 200);
        assert.equal(again.body.revoked, false);
    } finally { await cfg.close(); }
});

test('refresh: token baru diterbitkan, token lama langsung mati', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const old = verify.body.sessionToken;
        const r = await post(`${cfg.base}/api/mobile/auth/refresh`, {}, old);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(r.body.sessionToken, /^[a-f0-9]{64}$/);
        assert.notEqual(r.body.sessionToken, old);
        assert.equal(r.body.rotated, true);
        assert.equal((await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${old}` } })).status, 401);
        assert.equal((await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${r.body.sessionToken}` } })).status, 200);
        assert.equal((await post(`${cfg.base}/api/mobile/auth/refresh`, {})).status, 401);
    } finally { await cfg.close(); }
});

test('revoke: perangkat dicabut -> semua sesi mati, challenge berikutnya ditolak', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const token = verify.body.sessionToken;

        const del = await json(`${cfg.base}/api/mobile/devices/registered/${DEVICE_ID}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(del.status, 200, JSON.stringify(del.body));
        assert.equal(del.body.status, 'REVOKED');
        // register + verify masing-masing menerbitkan sesi, keduanya dicabut.
        assert.equal(del.body.sessionsRevoked, 2);

        assert.equal((await json(`${cfg.base}/api/protected`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);

        const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        assert.equal(ch.status, 403);
        assert.equal(ch.body.code, 'device_revoked');

        // Daftar perangkat (perlu sesi) menandai status REVOKED.
        const login = await post(`${cfg.base}/api/login`, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
        assert.equal(login.status, 200);
        const cookie = String(login.headers.get('set-cookie')).split(';')[0];
        const list = await json(`${cfg.base}/api/mobile/devices/registered`, { headers: { Cookie: cookie } });
        assert.equal(list.status, 200);
        assert.equal(list.body.devices[0].status, 'REVOKED');
        // Pencabutan tanpa sesi sah ditolak; metode yang tidak didukung -> 405 JSON.
        assert.equal((await json(`${cfg.base}/api/mobile/devices/registered/ndlx-x`, { method: 'DELETE', headers: { Authorization: 'Bearer x' } })).status, 401);
        assert.equal((await json(`${cfg.base}/api/mobile/devices/registered`, { method: 'DELETE' })).status, 405);
    } finally { await cfg.close(); }
});

test('sesi mobile bertahan setelah restart server (berkas data yang sama)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-restart-'));
    const first = await startServer({ dataDir: dir });
    const pair = newKeyPair();
    const { verify } = await loginWithDevice(first, pair);
    const token = verify.body.sessionToken;
    await first.close();

    const second = await startServer({ dataDir: dir });
    try {
        const prot = await json(`${second.base}/api/protected`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(prot.status, 200, 'Bearer harus tetap berlaku setelah restart');
        const devices = await json(`${second.base}/api/mobile/devices/registered`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(devices.body.devices.length, 1);
        assert.equal(devices.body.devices[0].deviceId, DEVICE_ID);
    } finally { await second.close(); }
});

test('token tidak boleh dikirim lewat query string', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const token = verify.body.sessionToken;
        const r = await json(`${cfg.base}/api/protected?token=${token}`);
        assert.equal(r.status, 400);
        const r2 = await json(`${cfg.base}/api/mobile/auth/session?access_token=${token}`);
        assert.equal(r2.status, 400);
    } finally { await cfg.close(); }
});

// ---------- WebSocket ----------
function connect(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { headers });
        const first = { ws, frame: null, closeCode: null };
        ws.on('message', m => { if (first.frame === null) { first.frame = JSON.parse(String(m)); resolve(first); } });
        ws.on('unexpected-response', (_, res) => resolve({ ...first, status: res.statusCode }));
        ws.on('error', e => {
            if (e.message && /401/.test(e.message)) return resolve({ ...first, status: 401 });
            reject(e);
        });
        ws.on('open', () => setTimeout(() => resolve(first), 300));
        ws.on('close', code => { first.closeCode = code; });
    });
}

test('websocket: cookie sid lama tetap bisa terhubung dan menerima event SENSOR', async () => {
    const cfg = await startServer();
    try {
        const login = await post(`${cfg.base}/api/login`, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
        const sid = String(login.headers.get('set-cookie')).split(';')[0];
        const c = await connect(cfg.wsBase, { Cookie: sid });
        assert.equal(c.frame.type, 'SENSOR');
        c.ws.close();
    } finally { await cfg.close(); }
});

test('websocket: Bearer mobile diterima, tanpa kredensial ditolak 401', async () => {
    const cfg = await startServer();
    try {
        const none = await connect(cfg.wsBase);
        assert.equal(none.status, 401, 'koneksi tanpa kredensial harus 401');

        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const c = await connect(cfg.wsBase, { Authorization: `Bearer ${verify.body.sessionToken}` });
        assert.equal(c.frame.type, 'SENSOR');
        c.ws.close();
    } finally { await cfg.close(); }
});

test('websocket: sesi dicabut -> koneksi diputus (4403)', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        const { verify } = await loginWithDevice(cfg, pair);
        const token = verify.body.sessionToken;
        const c = await connect(cfg.wsBase, { Authorization: `Bearer ${token}` });
        const closed = new Promise(resolve => c.ws.on('close', code => resolve(code)));
        await post(`${cfg.base}/api/mobile/auth/logout`, {}, token);
        const code = await Promise.race([closed, new Promise(r => setTimeout(() => r('timeout'), 2000))]);
        assert.equal(code, 4403, 'koneksi harus ditutup setelah sesi dicabut');
    } finally { await cfg.close(); }
});

// ---------- Integrasi server.js ----------
test('server.js: upgrade WebSocket memakai auth.resolve dan menyimpan identitas sesi', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(src, /server\.on\('upgrade'[\s\S]{0,400}auth\.resolve\(req\)/);
    assert.match(src, /ws\.auth = r/);
    assert.match(src, /auth\.revalidate\(ws\.auth\)/);
    assert.match(src, /require\('\.\/mobile-auth'\)/);
    // Tidak boleh ada token di query string pada jalur WebSocket.
    assert.ok(!/upgrade[\s\S]{0,300}query\.token/.test(src));
    // Cookie `sid` lama tetap dipakai (requireAuth dari auth.js).
    assert.match(src, /const \{ sidOf, createSession, keepOnly, requireAuth, isAuthed, bearerOf \} = auth;/);
});


test('challenge: X-Forwarded-Host palsu tidak memperluas origin tepercaya', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        await register(cfg, pair);
        const ch = await json(`${cfg.base}/api/mobile/auth/challenge`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Forwarded-Host': 'attacker.example',
                'X-Forwarded-Proto': 'https'
            },
            body: JSON.stringify({ deviceId: DEVICE_ID })
        });
        assert.equal(ch.status, 200, JSON.stringify(ch.body));
        assert.ok(!JSON.stringify(ch.body).includes('attacker.example'));
    } finally { await cfg.close(); }
});

test('verify: serverOrigin yang hanya diklaim klien ditolak', async () => {
    const cfg = await startServer();
    try {
        const pair = newKeyPair();
        await register(cfg, pair);
        const ch = await post(`${cfg.base}/api/mobile/auth/challenge`, { deviceId: DEVICE_ID });
        const ts = Date.now();
        const untrusted = 'https://attacker.example';
        const result = await post(`${cfg.base}/api/mobile/auth/verify`, {
            deviceId: DEVICE_ID,
            challengeId: ch.body.challengeId,
            timestamp: ts,
            serverOrigin: untrusted,
            signatureBase64: signDer(pair.privateKey, canonical(DEVICE_ID, ch.body.challengeId, ch.body.nonce, ts, untrusted))
        });
        assert.equal(result.status, 401, JSON.stringify(result.body));
    } finally { await cfg.close(); }
});


test('websocket: pencabutan semua sesi mobile menutup seluruh koneksi (4403)', async () => {
    const cfg = await startServer();
    try {
        const pairA = newKeyPair();
        const pairB = newKeyPair();
        const loginA = await loginWithDevice(cfg, pairA, 'ndlx-ws-revoke-all-a');
        const loginB = await loginWithDevice(cfg, pairB, 'ndlx-ws-revoke-all-b');
        const a = await connect(cfg.wsBase, { Authorization: `Bearer ${loginA.verify.body.sessionToken}` });
        const b = await connect(cfg.wsBase, { Authorization: `Bearer ${loginB.verify.body.sessionToken}` });
        const closedA = new Promise(resolve => a.ws.on('close', code => resolve(code)));
        const closedB = new Promise(resolve => b.ws.on('close', code => resolve(code)));
        assert.equal(cfg.auth.revokeAllMobileSessions('admin_password_changed'), 2);
        const [codeA, codeB] = await Promise.all([
            Promise.race([closedA, new Promise(r => setTimeout(() => r('timeout'), 2000))]),
            Promise.race([closedB, new Promise(r => setTimeout(() => r('timeout'), 2000))])
        ]);
        assert.equal(codeA, 4403);
        assert.equal(codeB, 4403);
    } finally { await cfg.close(); }
});
