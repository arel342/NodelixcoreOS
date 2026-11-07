// ============================================================================
// tests/updater.test.js — pemeriksa update GitHub (deteksi + notifikasi saja).
//
// Semua pengujian memakai git & Telegram PALSU: tidak ada jaringan, tidak ada
// repositori sungguhan, tidak ada berkas aplikasi yang disentuh. Status disimpan
// di folder sementara.
//
// Yang diuji:
//   • tidak ada update / ada commit baru
//   • notifikasi Telegram terkirim sekali per commit (tidak berulang tiap 12 jam,
//     tidak berulang setelah server restart)
//   • Telegram gagal / melempar error -> status "pending", dicoba ulang, lalu terkirim
//   • GitHub tidak tersedia / bukan repo git / rate limit -> server tetap jalan
//   • pemeriksaan tidak pernah tumpang tindih & hanya `git fetch` (tanpa `git pull`)
//   • jadwal 12 jam + pembersihan timer saat shutdown
//   • status tersimpan dibaca tanpa akses GitHub (login banyak perangkat)
//   • isi state bebas kredensial & escape HTML/Markdown untuk pesan Telegram
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const createUpdater = require(path.join(root, 'updater'));

const envFrom = obj => (k, d) => (obj[k] === undefined || obj[k] === '' ? d : obj[k]);
const sha = ch => String(ch).repeat(40).slice(0, 40);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-upd-')), 'update-state.json');
const gitErr = msg => Object.assign(new Error(msg), { stderr: msg });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Tunggu sampai kondisi terpenuhi (untuk pekerjaan yang berjalan di latar belakang)
async function until(cond, ms = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await sleep(5);
    }
    return false;
}

// Git palsu: perilakunya diatur lewat objek kontrol supaya tiap skenario bisa diuji.
function makeGit({ head = sha('a'), remote = sha('b'), commits = [], failHead = '', failFetch = '', failRemote = '', logDelay = 0 } = {}) {
    const git = {
        head, remote, commits, failHead, failFetch, failRemote, logDelay,
        calls: [],
        async run(args) {
            git.calls.push(args.join(' '));
            const cmd = args[0];
            if (cmd === 'rev-parse') {
                if (args[1] === 'HEAD') {
                    if (git.failHead) throw gitErr(git.failHead);
                    return git.head + '\n';
                }
                if (String(args[1]).startsWith('origin/')) {
                    if (git.failRemote) throw gitErr(git.failRemote);
                    return git.remote + '\n';
                }
            }
            if (cmd === 'fetch') {
                if (git.failFetch) throw gitErr(git.failFetch);
                return '';
            }
            if (cmd === 'log') {
                if (git.logDelay) await sleep(git.logDelay);
                return git.commits.map(c => [c.hash, c.hash.slice(0, 7), c.author || 'dev', c.date || '2026-10-31T10:00:00+07:00', c.subject || ''].join('\x1f')).join('\n') + (git.commits.length ? '\n' : '');
            }
            throw new Error('perintah git tidak terduga: ' + args.join(' '));
        },
        commandArgs: () => git.calls.map(c => c.split(' ')[0])
    };
    return git;
}

function makeNotifier({ ok = true, throws = false } = {}) {
    const sent = [];
    const ctl = {
        sent, ok, throws,
        async notify(text, opts) {
            sent.push({ text, opts });
            if (ctl.throws) throw new Error('Telegram mati');
            return ctl.ok;
        }
    };
    return ctl;
}

function makeUpdater({ git, notifier, file, extraEnv = {}, app = null, now = () => clock.now(), timers, dashboardUrl = '' } = {}) {
    const broadcasts = [];
    const u = createUpdater({
        app,
        env: envFrom({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42', ...extraEnv }),
        file: file || tmpFile(),
        git: git ? git.run : makeGit().run,
        notify: notifier ? notifier.notify : makeNotifier().notify,
        broadcast: m => broadcasts.push(m),
        dashboardUrl,
        log() { },
        now,
        timers
    });
    return { u, broadcasts };
}

const clock = { t: Date.parse('2026-11-01T00:00:00Z'), now() { return this.t; } };

// Fake timer untuk menguji penjadwalan tanpa menunggu 12 jam.
function fakeTimers() {
    const map = new Map();
    let id = 0;
    const api = {
        setTimeout(fn, ms) { const i = ++id; map.set(i, { fn, ms, kind: 'timeout' }); return i; },
        clearTimeout(i) { map.delete(i); },
        setInterval(fn, ms) { const i = ++id; map.set(i, { fn, ms, kind: 'interval' }); return i; },
        clearInterval(i) { map.delete(i); },
        list: () => [...map.entries()],
        fire(i) { const e = map.get(i); if (e && e.kind === 'timeout') map.delete(i); return e ? e.fn() : null; }
    };
    return api;
}

// ---------- 1. Tidak ada update ----------
test('update: tidak ada update -> status bersih, tanpa notifikasi', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('a') });
    const notifier = makeNotifier();
    const file = tmpFile();
    const { u } = makeUpdater({ git, notifier, file });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.updateAvailable, false);
    assert.equal(v.latestCommit, sha('a'));
    assert.equal(v.installedCommit, sha('a'));
    assert.equal(v.commits.length, 0);
    assert.equal(notifier.sent.length, 0);
    assert.ok(git.calls.includes('fetch --quiet origin main'), 'harus memakai git fetch');
    assert.equal(git.commandArgs().filter(c => c === 'pull').length, 0, 'tidak boleh git pull');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).updateAvailable, false);
});

// ---------- 2 & 3. Commit baru + notifikasi berhasil ----------
test('update: commit baru -> satu notifikasi Telegram berisi commit terpasang/terbaru', async () => {
    const git = makeGit({
        head: sha('a'), remote: sha('b'),
        commits: [{ hash: sha('b'), subject: 'Improved dashboard and system stability' }]
    });
    const notifier = makeNotifier();
    const { u, broadcasts } = makeUpdater({ git, notifier, dashboardUrl: 'http://192.168.1.20:3000' });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.updateAvailable, true);
    assert.equal(v.installedShort, 'aaaaaaa');
    assert.equal(v.latestShort, 'bbbbbbb');
    assert.equal(v.latestCommitInfo.subject, 'Improved dashboard and system stability');
    assert.equal(v.notifyStatus, 'sent');
    assert.equal(v.pendingNotify, false);
    assert.ok(v.lastNotifiedAt, 'waktu notifikasi tersimpan');
    assert.equal(notifier.sent.length, 1);

    const msg = notifier.sent[0].text;
    assert.match(msg, /NODELIXCOREOS/);
    assert.match(msg, /aaaaaaa/);
    assert.match(msg, /bbbbbbb/);
    assert.match(msg, /Improved dashboard and system stability/);
    assert.match(msg, /https:\/\/github\.com\/arel342\/NodelixcoreOS/);
    assert.match(msg, /http:\/\/192\.168\.1\.20:3000\/#update/);
    assert.match(msg, /Terdeteksi: 2026-11-01 00:00 UTC/);
    assert.deepEqual(notifier.sent[0].opts, {}, 'tanpa parse_mode = teks biasa');

    // Status disiarkan ke dashboard
    assert.ok(broadcasts.some(b => b.type === 'UPDATE' && b.data.updateAvailable === true));
});

// ---------- 4. Duplicate prevention ----------
test('update: notifikasi hanya sekali per commit (tanpa kirim ulang tiap pemeriksaan)', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const file = tmpFile();
    const { u } = makeUpdater({ git, notifier, file });

    await u.check({ reason: 'startup' });
    clock.t += 12 * 3600 * 1000;
    await u.check({ reason: 'interval' });
    clock.t += 12 * 3600 * 1000;
    const v = await u.check({ reason: 'interval' });

    assert.equal(notifier.sent.length, 1, 'commit yang sama tidak dinotifikasi ulang');
    assert.equal(v.updateAvailable, true);

    // Restart: instance baru membaca state yang sama -> tetap tidak kirim ulang
    const notifier2 = makeNotifier();
    const { u: u2 } = makeUpdater({ git, notifier: notifier2, file });
    const v2 = await u2.check({ reason: 'startup' });
    assert.equal(notifier2.sent.length, 0, 'restart tidak boleh mengirim notifikasi duplikat');
    assert.equal(v2.updateAvailable, true);
});

test('update: commit berikutnya memicu notifikasi baru', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'satu' }] });
    const notifier = makeNotifier();
    const { u } = makeUpdater({ git, notifier });

    await u.check({ reason: 'startup' });
    assert.equal(notifier.sent.length, 1);

    git.remote = sha('c');
    git.commits = [{ hash: sha('c'), subject: 'dua' }];
    const v = await u.check({ reason: 'interval' });
    assert.equal(notifier.sent.length, 2);
    assert.match(notifier.sent[1].text, /ccccccc/);
    assert.equal(v.lastNotifiedCommit, sha('c'));
});

// ---------- 5. Telegram gagal lalu dicoba ulang ----------
test('update: Telegram gagal -> status pending, retry berhasil tanpa duplikat', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier({ ok: false });
    const file = tmpFile();
    const { u } = makeUpdater({ git, notifier, file });

    const v1 = await u.check({ reason: 'startup' });
    assert.equal(v1.notifyStatus, 'pending');
    assert.equal(v1.pendingNotify, true);
    assert.equal(v1.updateAvailable, true, 'update tetap tersedia walau Telegram gagal');
    assert.equal(notifier.sent.length, 1);

    notifier.ok = true;
    const ok = await u.retryPendingNotification();
    assert.equal(ok, true);
    const v2 = u.view();
    assert.equal(v2.notifyStatus, 'sent');
    assert.equal(v2.pendingNotify, false);
    assert.equal(notifier.sent.length, 2);

    // Retry berikutnya tidak mengirim apa pun lagi
    await u.retryPendingNotification();
    assert.equal(notifier.sent.length, 2);
});

test('update: Telegram melempar error tidak membuat proses berhenti', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier({ throws: true });
    const { u } = makeUpdater({ git, notifier });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.updateAvailable, true);
    assert.equal(v.notifyStatus, 'pending');
    assert.equal(v.lastNotifiedAt, null);
});

test('update: Telegram belum diisi -> status unconfigured, tidak ada request jaringan', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const { u } = makeUpdater({ git, notifier, extraEnv: { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' } });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.updateAvailable, true);
    assert.equal(v.notifyStatus, 'unconfigured');
    assert.equal(notifier.sent.length, 0);
    assert.equal(v.telegram, false);

    // Setelah token diisi, retry mengirim dan menandai terkirim
    const { u: u2 } = makeUpdater({ git, notifier, file: tmpFile() });
    await u2.check({ reason: 'startup' });
    assert.equal(notifier.sent.length, 1);
});

// ---------- 6. GitHub gagal ----------
test('update: GitHub tidak tersedia -> error dicatat, status update dipertahankan', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const { u } = makeUpdater({ git, notifier });

    await u.check({ reason: 'startup' });
    assert.equal(notifier.sent.length, 1);

    git.failFetch = 'fatal: unable to access https://github.com/arel342/NodelixcoreOS: Could not resolve host: github.com';
    const v = await u.check({ reason: 'interval' });
    assert.equal(v.lastCheckError, 'network');
    assert.equal(v.updateAvailable, true, 'status terakhir tetap dipakai');
    assert.equal(v.latestCommit, sha('b'));
    assert.equal(notifier.sent.length, 1, 'tidak ada notifikasi baru saat gagal');
});

test('update: folder bukan repositori git -> error not_repo, server tetap jalan', async () => {
    const git = makeGit({ failHead: 'fatal: not a git repository (or any of the parent directories): .git' });
    const notifier = makeNotifier();
    const { u } = makeUpdater({ git, notifier });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.lastCheckError, 'not_repo');
    assert.equal(notifier.sent.length, 0);
    assert.equal(v.updateAvailable, false);
});

test('update: rate limit GitHub -> pemeriksaan berikutnya ditunda (backoff)', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), failFetch: 'remote: rate limit exceeded (HTTP 429)' });
    const { u } = makeUpdater({ git, notifier: makeNotifier() });

    const v = await u.check({ reason: 'startup' });
    assert.equal(v.lastCheckError, 'rate_limited');

    const callsAfterFail = git.calls.length;
    await u.check({ reason: 'interval' });          // masih dalam masa backoff
    assert.equal(git.calls.length, callsAfterFail, 'tidak menyentuh GitHub selama backoff');

    u._resetManualRate();
    await u.check({ reason: 'manual' });
    assert.ok(git.calls.length > callsAfterFail);
});

// ---------- 7. Non-overlap ----------
test('update: pemeriksaan tidak tumpang tindih (satu git fetch untuk dua permintaan)', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }], logDelay: 40 });
    const notifier = makeNotifier();
    const { u } = makeUpdater({ git, notifier });

    const [v1, v2] = await Promise.all([
        u.check({ reason: 'interval' }),
        u.check({ reason: 'manual' })
    ]);
    assert.equal(v1.latestCommit, v2.latestCommit);
    assert.equal(git.calls.filter(c => c.startsWith('fetch')).length, 1);
    assert.equal(notifier.sent.length, 1);
});

// ---------- 8. Penjadwal 12 jam ----------
test('update: penjadwal default 12 jam dan timer dibersihkan saat shutdown', async () => {
    const timers = fakeTimers();
    const git = makeGit({ head: sha('a'), remote: sha('a') });
    const { u } = makeUpdater({ git, notifier: makeNotifier(), timers, extraEnv: { UPDATE_CHECK_START_DELAY_MS: '50' } });

    assert.equal(u.timing().intervalMs, 43200000, 'UPDATE_CHECK_INTERVAL default 43.200.000 ms');

    assert.equal(u.start(), true);
    assert.equal(u.start(), false, 'start() kedua tidak menggandakan timer');

    const list = timers.list();
    const intervals = list.filter(([, e]) => e.kind === 'interval').map(([, e]) => e.ms);
    assert.ok(intervals.includes(43200000), 'interval 12 jam terdaftar');
    assert.deepEqual(list.filter(([, e]) => e.kind === 'timeout').map(([, e]) => e.ms), [50]);

    // Timer pemeriksaan pertama dijalankan -> satu pemeriksaan
    const firstTimer = list.find(([, e]) => e.kind === 'timeout');
    timers.fire(firstTimer[0]);
    assert.ok(await until(() => !u.isChecking()), 'pemeriksaan pertama selesai');
    assert.equal(git.calls.filter(c => c.startsWith('fetch')).length, 1);

    // Interval berikutnya -> satu pemeriksaan lagi
    const every = list.find(([, e]) => e.kind === 'interval' && e.ms === 43200000);
    timers.fire(every[0]);
    assert.ok(await until(() => !u.isChecking()), 'pemeriksaan berkala selesai');
    assert.equal(git.calls.filter(c => c.startsWith('fetch')).length, 2);

    u.stop();
    assert.equal(timers.list().length, 0, 'semua timer dibersihkan saat shutdown');

    // Setelah stop, memicu timer lama tidak melakukan apa pun
    const before = git.calls.length;
    timers.fire(every[0]);
    await sleep(20);
    assert.equal(git.calls.length, before, 'timer yang sudah dibersihkan tidak melakukan apa pun');
});

test('update: pemeriksaan dimatikan lewat UPDATE_CHECK_ENABLED=false', async () => {
    const timers = fakeTimers();
    const git = makeGit();
    const { u } = makeUpdater({ git, notifier: makeNotifier(), timers, extraEnv: { UPDATE_CHECK_ENABLED: 'false' } });

    u.start();
    assert.equal(timers.list().length, 0, 'tidak ada timer saat fitur dimatikan');
    const v = await u.check({ reason: 'startup' });
    assert.equal(v.enabled, false);
    assert.equal(git.calls.length, 0, 'tidak ada akses git saat dimatikan');
});

// ---------- 9. Status tersimpan dibaca tanpa GitHub (login perangkat) ----------
test('update: status login banyak perangkat dibaca tanpa request GitHub', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const file = tmpFile();
    const app = makeApp();
    const { u } = makeUpdater({ git, notifier: makeNotifier(), file, app });

    await u.check({ reason: 'startup' });            // satu-satunya akses git
    const callsAfterCheck = git.calls.length;

    // Tiga perangkat login (masing-masing meminta status dashboard)
    const res = [1, 2, 3].map(() => {
        const r = fakeRes();
        app.routes['GET /api/update/status']({}, r);
        return r.body;
    });
    for (const b of res) {
        assert.equal(b.success, true);
        assert.equal(b.updateAvailable, true);
        assert.equal(b.installedShort, 'aaaaaaa');
        assert.equal(b.latestShort, 'bbbbbbb');
    }
    assert.equal(git.calls.length, callsAfterCheck, 'login tidak boleh memicu pemeriksaan GitHub');

    // State di disk juga tetap ada setelah restart
    const { u: u2 } = makeUpdater({ git, notifier: makeNotifier(), file });
    const v = await u2.check({ reason: 'startup' });
    assert.equal(v.updateAvailable, true);
});

// ---------- 10. Route ----------
function makeApp() {
    const routes = {};
    const app = {
        get: (u, fn) => { routes['GET ' + u] = fn; },
        post: (u, fn) => { routes['POST ' + u] = fn; },
        routes
    };
    return app;
}
function fakeRes() {
    return {
        code: 200, body: null,
        status(n) { this.code = n; return this; },
        json(j) { this.body = j; return this; }
    };
}

test('update: route cek manual & notifikasi hanya tersedia untuk sesi login (didaftarkan di server.js)', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    // server.js memakai gerbang deny-by-default: semua /api wajib login kecuali yang
    // tercantum di PUBLIC_API. /api/update tidak boleh ada di daftar publik itu.
    const gate = server.match(/const PUBLIC_API = \[([\s\S]*?)\];/);
    assert.ok(gate, 'server.js harus punya daftar PUBLIC_API (deny-by-default untuk /api)');
    assert.ok(!/api\\?\/update/.test(gate[1]), 'route /api/update tidak boleh masuk daftar publik');
    assert.ok(/PUBLIC_API\.some\(rx => rx\.test\(p\)\)[\s\S]{0,200}requireAuth\(req, res, next\)/.test(server),
        'endpoint /api di luar PUBLIC_API harus melewati requireAuth');
    assert.ok(!/\/api\/update\/(install|apply|pull)/.test(server + fs.readFileSync(path.join(root, 'updater.js'), 'utf8')),
        'tidak boleh ada route yang memasang update');
});

test('update: cek manual mengakses git, dibatasi 30 detik, dan mengembalikan status', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const app = makeApp();
    const { u } = makeUpdater({ git, notifier, app });

    const before = git.calls.length;
    const r1 = fakeRes();
    await app.routes['POST /api/update/check']({ body: {} }, r1);
    assert.equal(r1.body.success, true);
    assert.equal(r1.body.updateAvailable, true);
    assert.ok(git.calls.length > before);
    assert.equal(notifier.sent.length, 1);

    const r2 = fakeRes();
    await app.routes['POST /api/update/check']({ body: {} }, r2);
    assert.equal(r2.code, 429, 'cek manual kedua dalam 30 detik ditolak');
    assert.equal(notifier.sent.length, 1);
});

test('update: route notifikasi mengirim ulang notifikasi tertunda', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier({ ok: false });
    const app = makeApp();
    const { u } = makeUpdater({ git, notifier, app });
    await u.check({ reason: 'startup' });

    notifier.ok = true;
    const r = fakeRes();
    await app.routes['POST /api/update/notify']({ body: {} }, r);
    assert.equal(r.body.success, true);
    assert.equal(r.body.notifyStatus, 'sent');
    assert.equal(notifier.sent.length, 2);
});

test('update: route notifikasi tidak mengklaim gagal bila commit sudah dinotifikasi', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const app = makeApp();
    const { u } = makeUpdater({ git, notifier, app });
    await u.check({ reason: 'startup' });

    const r = fakeRes();
    await app.routes['POST /api/update/notify']({ body: {} }, r);
    assert.equal(r.body.success, false);
    assert.equal(notifier.sent.length, 1, 'tidak ada pengiriman ganda');
    assert.match(r.body.message, /Tidak ada update/, 'pesan menjelaskan tidak ada yang perlu dikirim');
});

test('update: TELEGRAM_ALERTS=false -> status disabled, tanpa request Telegram', async () => {
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: 'fix' }] });
    const notifier = makeNotifier();
    const app = makeApp();
    const { u } = makeUpdater({ git, notifier, app, extraEnv: { TELEGRAM_ALERTS: 'false' } });
    const v = await u.check({ reason: 'startup' });
    assert.equal(v.notifyStatus, 'disabled');
    assert.equal(notifier.sent.length, 0);

    const r = fakeRes();
    await app.routes['POST /api/update/notify']({ body: {} }, r);
    assert.match(r.body.message, /dimatikan/);
});

// ---------- 11. Keamanan isi pesan & state ----------
test('update: pesan Telegram di-escape sesuai parse_mode dan tidak dieksekusi', async () => {
    const evil = '<b>x</b>\nrm -rf / $(touch pwned) `whoami` _*[]';
    const git = makeGit({ head: sha('a'), remote: sha('b'), commits: [{ hash: sha('b'), subject: evil }] });
    const notifier = makeNotifier();
    const file = tmpFile();
    const { u } = makeUpdater({ git, notifier, file, extraEnv: { TELEGRAM_PARSE_MODE: 'html' } });

    await u.check({ reason: 'startup' });
    const msg = notifier.sent[0].text;
    assert.equal(notifier.sent[0].opts.parse_mode, 'html');
    assert.ok(!msg.includes('<b>x</b>'), 'HTML dari commit tidak boleh lolos mentah');
    assert.match(msg, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.ok(!/\nrm -rf/.test(msg), 'baris baru dari pesan commit dibuang');

    // Pesan commit tidak pernah dijalankan sebagai perintah shell
    assert.equal(fs.existsSync(path.join(root, 'pwned')), false);
    assert.ok(git.calls.every(c => !c.includes('rm -rf')), 'pesan commit tidak masuk ke argumen git');

    // Pesan pendek tetap aman dan tidak membawa markup liar
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!/TOKEN|API_KEY|PASSWORD|CHAT_ID|SECRET/i.test(JSON.stringify(st)), 'state tidak memuat kredensial');
});

test('update: data commit dari disk divalidasi sebelum ditampilkan', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
        ver: 1,
        installedCommit: 'a'.repeat(40),
        latestCommit: 'b'.repeat(40),
        updateAvailable: true,
        commits: [
            { hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'ok', author: 'dev', date: '2026-10-31T10:00:00+07:00' },
            { hash: 'bukan-hash', subject: '<script>alert(1)</script>' },
            { hash: 'c'.repeat(40), subject: 'baris\nbaru\u0000kontrol', author: 'x'.repeat(200) }
        ],
        repoUrl: 'javascript:alert(1)'
    }));

    const { u } = makeUpdater({ file });
    const v = u.view();
    assert.equal(v.commits.length, 2, 'commit dengan hash tidak valid dibuang');
    assert.equal(v.repoUrl, 'https://github.com/arel342/NodelixcoreOS', 'URL repo tidak valid diganti default');
    const third = v.commits[1];
    assert.ok(!/[\u0000-\u001f]/.test(third.subject), 'karakter kontrol dibuang');
    assert.ok(third.author.length <= 60);
});

test('update: dashboard memuat notifikasi update (lencana, kartu, popup, skrip)', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'public', 'update.js'), 'utf8');
    for (const id of ['update-badge', 'update-banner', 'modal-update', 'upd-modal-current', 'upd-modal-latest', 'upd-modal-list']) {
        assert.ok(html.includes(`id="${id}"`), 'elemen ' + id + ' harus ada di dashboard');
    }
    assert.match(html, /<script src="update.js"><\/script>/);
    assert.match(html, /data\.type === 'UPDATE'/);
    assert.match(html, /updateOnLogin\(\)/);
    assert.match(js, /\/api\/update\/status/, 'login membaca status tersimpan');
    assert.match(js, /window\.updateOnLogin = \(\) => load\(\{ login: true \}\)/, 'login hanya membaca status tersimpan');
    assert.match(js, /git pull origin main/, 'perintah pemasangan manual ditampilkan, bukan dijalankan');
});
