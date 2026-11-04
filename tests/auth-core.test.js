// ============================================================================
// tests/auth-core.test.js — inti sesi terpusat (auth.js), tanpa jaringan:
//   • limiter percobaan (5 salah -> blokir) & pemulihan setelah blokir
//   • sesi web: pembuatan, kedaluwarsa, keepOnly
//   • sesi mobile: token opaque, disimpan HANYA sebagai hash, kedaluwarsa,
//     rotasi (refresh), pencabutan per token dan per perangkat, tahan restart
//   • resolve(): Bearer diutamakan, cookie tetap berfungsi, token di URL ditolak
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createAuth = require('../auth');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-auth-'));
const dir = name => {
    const d = path.join(TMP, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
};

function makeAuth({ dataDir, envExtra = {}, clock } = {}) {
    const envMap = { SESSION_TTL_HOURS: '1', MOBILE_SESSION_TTL_HOURS: '24', ...envExtra };
    const env = (k, d) => (envMap[k] === undefined || envMap[k] === '' ? d : envMap[k]);
    const events = [];
    const auth = createAuth({
        env,
        dataDir: dataDir || dir('default'),
        onRevoke: e => events.push(e),
        log: () => { },
        clock
    });
    return { auth, env, events, envMap };
}

const req = (headers = {}, query = {}) => ({ headers, query, ip: 'test' });
const res = () => ({
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; }
});

// ---------- Limiter ----------
test('limiter: 5 percobaan salah memblokir, diblokir sampai jendela berakhir', () => {
    let now = 0;
    const limiter = createAuth.createLimiter({ max: 5, blockMs: 60_000, clock: () => now });
    for (let i = 0; i < 4; i++) { limiter.fail('ip'); assert.equal(limiter.check('ip').blocked, false); }
    limiter.fail('ip');                                    // percobaan ke-5
    assert.equal(limiter.check('ip').blocked, true);
    assert.equal(limiter.check('other').blocked, false);   // IP lain tidak terpengaruh
    now += 59_000;
    assert.equal(limiter.check('ip').blocked, true);
    now += 2_000;
    assert.equal(limiter.check('ip').blocked, false);      // blokir habis
});

test('limiter: reset menghapus hitungan dan memori dibatasi', () => {
    const limiter = createAuth.createLimiter({ max: 3, maxEntries: 10, blockMs: 1000 });
    limiter.fail('a'); limiter.fail('a');
    limiter.reset('a');
    limiter.fail('a'); limiter.fail('a');
    assert.equal(limiter.check('a').blocked, false);
    for (let i = 0; i < 50; i++) limiter.hit('k' + i);
    assert.ok(limiter.size() <= 11, 'jumlah kunci harus dibatasi');
});

// ---------- Sesi web ----------
test('web: createSession mengirim cookie HttpOnly dan sesi dikenali', () => {
    const { auth } = makeAuth();
    const r = res();
    const sid = auth.createSession(r);
    assert.match(sid, /^[a-f0-9]{64}$/);
    assert.match(r.getHeader('set-cookie'), /^sid=[a-f0-9]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=3600$/);
    const s = auth.resolve(req({ cookie: `sid=${sid}` }));
    assert.equal(s.ok, true);
    assert.equal(s.kind, 'web');
    auth.stop();
});

test('web: sesi kedaluwarsa ditolak dan dibersihkan', () => {
    let now = 1_000_000;
    const { auth } = makeAuth({ clock: () => now });
    const r = res();
    const sid = auth.createSession(r);
    assert.equal(auth.resolve(req({ cookie: `sid=${sid}` })).ok, true);
    now += 3_700_000;                      // 1 jam + 100 detik
    assert.equal(auth.resolve(req({ cookie: `sid=${sid}` })).ok, false);
    assert.equal(auth.sessions.size, 0);
    auth.stop();
});

test('web: keepOnly mempertahankan sesi yang sedang dipakai dan memutus yang lain', () => {
    const { auth } = makeAuth();
    const keep = auth.createSession(res());
    auth.createSession(res());
    auth.createSession(res());
    assert.equal(auth.sessions.size, 3);
    auth.keepOnly(req({ cookie: `sid=${keep}` }));
    assert.equal(auth.sessions.size, 1);
    assert.equal(auth.resolve(req({ cookie: `sid=${keep}` })).ok, true);
    auth.stop();
});

test('web: logout hanya memutus sesi yang diminta', () => {
    const { auth, events } = makeAuth();
    const sid = auth.createSession(res());
    const other = auth.createSession(res());
    assert.equal(auth.destroyWebSession(sid), true);
    assert.equal(auth.resolve(req({ cookie: `sid=${sid}` })).ok, false);
    assert.equal(auth.resolve(req({ cookie: `sid=${other}` })).ok, true);
    assert.equal(events.filter(e => e.kind === 'web').length, 1);
    auth.stop();
});

// ---------- Sesi mobile ----------
test('mobile: token 64 hex, hanya hash yang disimpan di disk, sesi tahan restart', () => {
    const dataDir = dir('mobile-persist');
    const a1 = makeAuth({ dataDir });
    const sess = a1.auth.issueMobileSession({ deviceId: 'ndlx-test-0001', username: 'admin' });
    assert.match(sess.token, /^[a-f0-9]{64}$/);
    assert.ok(sess.expiresAt > Date.now());

    const raw = fs.readFileSync(path.join(dataDir, 'mobile-sessions.json'), 'utf8');
    assert.ok(!raw.includes(sess.token), 'token mentah tidak boleh ada di berkas');
    assert.ok(raw.includes(createAuth.sha256hex(sess.token)), 'hash token harus tersimpan');
    assert.match(raw, /"deviceId":"ndlx-test-0001"/);
    a1.auth.stop();

    // "restart": modul baru membaca berkas yang sama.
    const a2 = makeAuth({ dataDir });
    const r = a2.auth.resolve(req({ authorization: `Bearer ${sess.token}` }));
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'mobile');
    assert.equal(r.deviceId, 'ndlx-test-0001');
    a2.auth.stop();
});

test('mobile: sesi kedaluwarsa ditolak dan dibuang dari disk', () => {
    const dataDir = dir('mobile-expire');
    let now = 5_000_000;
    const { auth } = makeAuth({ dataDir, clock: () => now });
    const sess = auth.issueMobileSession({ deviceId: 'ndlx-exp', ttlMs: 1000 });
    assert.equal(auth.resolve(req({ authorization: `Bearer ${sess.token}` })).ok, true);
    now += 5_000;
    assert.equal(auth.resolve(req({ authorization: `Bearer ${sess.token}` })).ok, false);
    auth.stop();

    const again = makeAuth({ dataDir, clock: () => now });
    assert.equal(again.auth.resolve(req({ authorization: `Bearer ${sess.token}` })).ok, false);
    again.auth.stop();
});

test('mobile: logout mencabut token dan memicu event pencabutan', () => {
    const { auth, events } = makeAuth();
    const sess = auth.issueMobileSession({ deviceId: 'ndlx-logout' });
    assert.equal(auth.revokeToken(sess.token), true);
    assert.equal(auth.resolve(req({ authorization: `Bearer ${sess.token}` })).ok, false);
    assert.ok(events.some(e => e.kind === 'mobile' && e.tokenHash === createAuth.sha256hex(sess.token)));
    assert.equal(auth.revokeToken(sess.token), false, 'pencabutan kedua tidak berefek');
    auth.stop();
});

test('mobile: refresh merotasi token (token lama tidak berlaku)', () => {
    const { auth } = makeAuth();
    const first = auth.issueMobileSession({ deviceId: 'ndlx-rotate' });
    const next = auth.refreshMobileSession(first.token);
    assert.ok(next && next.token && next.token !== first.token);
    assert.equal(auth.resolve(req({ authorization: `Bearer ${first.token}` })).ok, false);
    assert.equal(auth.resolve(req({ authorization: `Bearer ${next.token}` })).ok, true);
    auth.stop();
});

test('mobile: pencabutan perangkat memutus semua sesinya', () => {
    const { auth } = makeAuth();
    const a = auth.issueMobileSession({ deviceId: 'ndlx-dev-a' });
    const b = auth.issueMobileSession({ deviceId: 'ndlx-dev-b' });
    assert.equal(auth.revokeDeviceSessions('ndlx-dev-a'), 1);
    assert.equal(auth.resolve(req({ authorization: `Bearer ${a.token}` })).ok, false);
    assert.equal(auth.resolve(req({ authorization: `Bearer ${b.token}` })).ok, true);
    auth.stop();
});

// ---------- resolve / header ----------
test('resolve: Bearer diutamakan, cookie tetap jalan, token di URL ditolak', () => {
    const { auth } = makeAuth();
    const sid = auth.createSession(res());
    const cookie = `sid=${sid}`;
    assert.equal(auth.resolve(req({ cookie })).kind, 'web');

    const sess = auth.issueMobileSession({ deviceId: 'ndlx-bearer' });
    const both = auth.resolve(req({ cookie, authorization: `Bearer ${sess.token}` }));
    assert.equal(both.kind, 'mobile');

    // Bearer tidak sah + cookie sah -> tetap dianggap sesi web (bukan error).
    const mixed = auth.resolve(req({ cookie, authorization: 'Bearer ' + 'f'.repeat(64) }));
    assert.equal(mixed.ok, true);
    assert.equal(mixed.kind, 'web');

    // Bearer tidak sah tanpa cookie -> ditolak.
    assert.equal(auth.resolve(req({ authorization: 'Bearer ' + 'f'.repeat(64) })).ok, false);
    // Format token aneh tidak pernah dianggap sah.
    assert.equal(auth.resolve(req({ authorization: 'Bearer abc' })).ok, false);

    assert.equal(auth.tokenInQuery({ headers: {}, query: { token: 'x' } }), 'token');
    assert.equal(auth.tokenInQuery({ headers: {}, query: { dir: 'a' } }), '');

    // requireAuth mengirim 401 JSON dan header WWW-Authenticate untuk Bearer tidak sah.
    const r = res();
    r.status = function (n) { this.code = n; return this; };
    r.json = function (j) { this.body = j; return this; };
    let called = false;
    auth.requireAuth(req({ authorization: 'Bearer ' + 'e'.repeat(64) }), r, () => { called = true; });
    assert.equal(called, false);
    assert.equal(r.code, 401);
    assert.equal(r.body.success, false);
    assert.match(r.getHeader('www-authenticate'), /^Bearer/);
    auth.stop();
});

test('resolve: token yang dikirim lewat query ditolak oleh requireAuth', () => {
    const { auth } = makeAuth();
    const r = res();
    r.status = function (n) { this.code = n; return this; };
    r.json = function (j) { this.body = j; return this; };
    let called = false;
    auth.requireAuth(req({}, { token: 'abc' }), r, () => { called = true; });
    assert.equal(called, false);
    assert.equal(r.code, 400);
    auth.stop();
});

test('file sesi mobile tidak bisa dibaca orang lain (mode 600) dan tidak menulis .tmp tertinggal', () => {
    const dataDir = dir('mobile-mode');
    const { auth } = makeAuth({ dataDir });
    auth.issueMobileSession({ deviceId: 'ndlx-mode' });
    const file = path.join(dataDir, 'mobile-sessions.json');
    const st = fs.statSync(file);
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
    const left = fs.readdirSync(dataDir).filter(n => n.includes('.tmp'));
    assert.deepEqual(left, []);
    auth.stop();
});


test('mobile: revokeAllMobileSessions persists revocation and is idempotent across restart', () => {
    const dataDir = dir('mobile-revoke-all');
    const first = makeAuth({ dataDir });
    const a = first.auth.issueMobileSession({ deviceId: 'ndlx-revoke-a' });
    const b = first.auth.issueMobileSession({ deviceId: 'ndlx-revoke-b' });
    assert.equal(first.auth.revokeAllMobileSessions('admin_password_changed'), 2);
    assert.equal(first.auth.revokeAllMobileSessions('admin_password_changed'), 0);
    assert.equal(first.auth.resolve(req({ authorization: `Bearer ${a.token}` })).ok, false);
    assert.equal(first.auth.resolve(req({ authorization: `Bearer ${b.token}` })).ok, false);
    assert.equal(first.events.filter(e => e.kind === 'mobile' && e.reason === 'admin_password_changed').length, 2);
    first.auth.stop();

    const restarted = makeAuth({ dataDir });
    assert.equal(restarted.auth.resolve(req({ authorization: `Bearer ${a.token}` })).ok, false);
    assert.equal(restarted.auth.resolve(req({ authorization: `Bearer ${b.token}` })).ok, false);
    restarted.auth.stop();
});
