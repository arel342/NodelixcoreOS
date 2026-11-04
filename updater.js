// ============================================================================
// updater.js — deteksi update GitHub untuk NodelixcoreOS (HANYA deteksi + notifikasi).
//
// Modul ini TIDAK PERNAH memasang update. Ia hanya:
//   1. menjalankan `git fetch origin` (tanpa `git pull`), membaca `origin/<branch>`,
//   2. membandingkannya dengan commit yang sedang terpasang (`git rev-parse HEAD`),
//   3. menyimpan statusnya ke data/update-state.json (atomik),
//   4. mengirim SATU notifikasi Telegram per commit baru (lewat `notify` milik server.js,
//      jadi bot Telegram yang sama dipakai — tidak ada bot kedua),
//   5. menyiarkan status ke dashboard lewat WebSocket {type:'UPDATE'} dan endpoint
//      GET /api/update/status (dibaca saat admin/perangkat login, tanpa request GitHub).
//
// Pemasangan tetap tindakan manual administrator (mis. `git pull origin main` di Termux).
//
// Jadwal: sekali saat server mulai (UPDATE_CHECK_START_DELAY_MS), lalu tiap
// UPDATE_CHECK_INTERVAL (default 43.200.000 ms = 12 jam). Pemeriksaan tidak pernah
// tumpang tindih, tidak pernah membuat server berhenti, dan timer dibersihkan saat
// shutdown lewat stop().
//
// Status yang disimpan (data/update-state.json) TIDAK memuat token/kunci apa pun.
//
// Route (semuanya sudah dilindungi login di server.js lewat daftar requireAuth):
//   GET  /api/update/status   -> status tersimpan (tanpa akses GitHub)
//   POST /api/update/check    -> cek manual oleh administrator (GitHub diakses di sini)
//   POST /api/update/notify   -> kirim ulang notifikasi Telegram yang tertunda
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const T = require('./lang');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const DEFAULT_REPO = 'arel342/NodelixcoreOS';
const DEFAULT_BRANCH = 'main';
const DEFAULT_REPO_URL = 'https://github.com/arel342/NodelixcoreOS';
const DEFAULT_INTERVAL_MS = 43200000;              // 12 jam
const MIN_INTERVAL_MS = 60000;                     // jangan pernah lebih cepat dari 1 menit
const MAX_INTERVAL_MS = 7 * 24 * 3600 * 1000;
const MAX_SUBJECT = 200;
const MAX_COMMITS = 20;
const NOTIFIED_KEEP = 40;                          // riwayat commit yang sudah dinotifikasi
const MAX_NOTIFY_ATTEMPTS = 20;                    // batas percobaan ulang Telegram (tidak spam selamanya)

const HASH_RE = /^[0-9a-f]{7,40}$/i;
const isHash = h => HASH_RE.test(String(h == null ? '' : h).trim());
const shortHash = h => isHash(h) ? String(h).trim().slice(0, 7) : '';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

// Teks dari GitHub (pesan commit, nama penulis, pesan error git) TIDAK PERNAH dieksekusi
// sebagai perintah: semua keluaran git dibaca sebagai data, karakter kontrol dibuang,
// panjang dibatasi, dan isinya di-escape sesuai parse mode Telegram.
function cleanText(v, max) {
    return String(v == null ? '' : v)
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function htmlEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Escape untuk parse_mode Telegram yang dikonfigurasi. Default (tanpa parse mode) =
// teks biasa, jadi tidak ada markup yang bisa disalahartikan.
function escapeFor(mode, s) {
    const text = String(s == null ? '' : s);
    if (mode === 'html') return htmlEscape(text);
    if (mode === 'markdownv2') return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => '\\' + c);
    if (mode === 'markdown') return text.replace(/[_*`[\]\\]/g, c => '\\' + c);
    return text;
}

function classifyGitError(e) {
    const raw = String((e && (e.stderr || e.message)) || '');
    if (/rate limit|too many requests|secondary rate|abuse detection|http 429|\b429\b/i.test(raw)) return 'rate_limited';
    if (/could not resolve host|network is unreachable|unable to access|connection (refused|reset|timed out)|timed out|timeout|temporary failure in name resolution|no route to host|ssl|does not appear to be a git repository|could not read from remote repository|unable to connect/i.test(raw)) return 'network';
    if (/not a git repository|not a git repo|does not have any commits/i.test(raw)) return 'not_repo';
    if (/permission denied|authentication failed|could not read username|repository not found/i.test(raw)) return 'auth';
    return 'git_error';
}

// Penjalan git bawaan: execFile tanpa shell, jadi argumen (termasuk pesan commit) tidak
// pernah ditafsirkan oleh shell. Batas waktu mematikan proses bila jaringan menggantung.
function defaultGit(rootDir) {
    return (args, timeoutMs) => new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd: rootDir,
            timeout: Math.max(1000, timeoutMs || 15000),
            killSignal: 'SIGKILL',
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
        }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(cleanText(stderr, 300) || err.message || 'git error');
                e.stderr = String(stderr || '');
                e.exitCode = err.code;
                e.timedOut = !!err.killed;
                return reject(e);
            }
            resolve(String(stdout == null ? '' : stdout));
        });
    });
}

function emptyState() {
    return {
        ver: 1,
        repo: DEFAULT_REPO,
        branch: DEFAULT_BRANCH,
        repoUrl: DEFAULT_REPO_URL,
        installedCommit: '',
        latestCommit: '',
        updateAvailable: false,
        aheadCount: 0,          // commit lokal yang belum ada di origin (divergen)
        behindCount: 0,         // commit origin yang belum terpasang (dasar updateAvailable)
        detectedAt: null,
        lastCheckedAt: null,
        lastCheckOkAt: null,
        lastCheckError: '',
        lastCheckErrorDetail: '',
        lastCheckReason: '',
        lastNotifiedCommit: '',
        notifiedCommits: [],
        commits: [],
        notifyStatus: 'none',
        pendingNotify: false,
        notifyAttempts: 0,
        lastNotifyError: '',
        lastNotifiedAt: null
    };
}

// ============================================================================
// Inti: dibuat dengan dependensi yang bisa diganti supaya bisa diuji tanpa jaringan.
//   env        : pembaca env (k, default)
//   file       : lokasi data/update-state.json
//   git        : async (args[], timeoutMs) -> stdout (throw bila gagal)
//   notify     : async (text, opts) -> true bila terkirim
//   broadcast  : (obj) => void (WebSocket)
//   now        : () => epoch ms
//   timers     : { setTimeout, clearTimeout, setInterval, clearInterval }
// ============================================================================
function createUpdater({
    app = null,
    env = E,
    file = path.join(__dirname, 'data', 'update-state.json'),
    rootDir = __dirname,
    git = defaultGit(rootDir),
    notify = null,
    broadcast = null,
    dashboardUrl = '',
    log = console.log,
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
    onChange = null
} = {}) {
    const intervalMs = () => clamp(Number(env('UPDATE_CHECK_INTERVAL', DEFAULT_INTERVAL_MS)) || DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    const startDelayMs = () => clamp(Number(env('UPDATE_CHECK_START_DELAY_MS', 15000) || 0), 0, 3600000);
    const retryMs = () => clamp(Number(env('UPDATE_NOTIFY_RETRY_MS', 900000)) || 900000, 30000, 24 * 3600 * 1000);
    const gitTimeoutMs = () => clamp(N('UPDATE_GIT_TIMEOUT_MS', 15000), 1000, 300000);
    const fetchTimeoutMs = () => clamp(N('UPDATE_FETCH_TIMEOUT_MS', 60000), 1000, 600000);
    const rateBackoffMs = () => clamp(N('UPDATE_RATE_LIMIT_BACKOFF_MS', 3600000), 60000, 24 * 3600 * 1000);
    const enabled = () => String(env('UPDATE_CHECK_ENABLED', 'true')) !== 'false';
    const repoName = () => REPO_RE.test(String(env('UPDATE_REPO', DEFAULT_REPO))) ? String(env('UPDATE_REPO', DEFAULT_REPO)) : DEFAULT_REPO;
    const branchName = () => BRANCH_RE.test(String(env('UPDATE_BRANCH', DEFAULT_BRANCH))) ? String(env('UPDATE_BRANCH', DEFAULT_BRANCH)) : DEFAULT_BRANCH;
    const repoUrl = () => String(env('UPDATE_REPO_URL', 'https://github.com/' + repoName()) || DEFAULT_REPO_URL);
    const parseMode = () => String(env('TELEGRAM_PARSE_MODE', '')).trim().toLowerCase();
    const tgOn = () => String(env('TELEGRAM_ALERTS', 'true')) !== 'false';
    const tgConfigured = () => !!(env('TELEGRAM_BOT_TOKEN', '') && env('TELEGRAM_CHAT_ID', ''));

    let state = load();
    let writeChain = Promise.resolve();
    let inFlight = null;
    let started = false;
    let blockedUntil = 0;
    let lastManualAt = 0;
    let timersList = [];

    // ---------- Persistensi atomik (tmp + rename), seperti scheduler.js ----------
    function load() {
        const base = emptyState();
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!raw || typeof raw !== 'object') return base;
            const s = { ...base };
            for (const k of Object.keys(base)) if (raw[k] !== undefined) s[k] = raw[k];
            // Semua nilai dari disk divalidasi ulang: berkas bisa saja disunting manual.
            s.installedCommit = isHash(s.installedCommit) ? String(s.installedCommit).toLowerCase() : '';
            s.latestCommit = isHash(s.latestCommit) ? String(s.latestCommit).toLowerCase() : '';
            s.lastNotifiedCommit = isHash(s.lastNotifiedCommit) ? String(s.lastNotifiedCommit).toLowerCase() : '';
            s.repo = REPO_RE.test(String(s.repo)) ? String(s.repo) : DEFAULT_REPO;
            s.branch = BRANCH_RE.test(String(s.branch)) ? String(s.branch) : DEFAULT_BRANCH;
            s.repoUrl = /^https?:\/\/[^\s"'<>]{3,200}$/.test(String(s.repoUrl)) ? String(s.repoUrl) : DEFAULT_REPO_URL;
            s.notifiedCommits = Array.isArray(s.notifiedCommits)
                ? s.notifiedCommits.map(h => isHash(h) ? String(h).toLowerCase() : '').filter(Boolean).slice(-NOTIFIED_KEEP)
                : [];
            s.commits = Array.isArray(s.commits) ? s.commits.map(normCommit).filter(Boolean).slice(0, MAX_COMMITS) : [];
            s.updateAvailable = s.updateAvailable === true;
            s.aheadCount = Number.isFinite(+s.aheadCount) && +s.aheadCount > 0 ? Math.min(+s.aheadCount, 100000) : 0;
            s.behindCount = Number.isFinite(+s.behindCount) && +s.behindCount > 0 ? Math.min(+s.behindCount, 100000) : 0;
            s.pendingNotify = s.pendingNotify === true;
            s.notifyStatus = String(s.notifyStatus || 'none');
            s.notifyAttempts = Number.isFinite(+s.notifyAttempts) ? Math.max(0, +s.notifyAttempts) : 0;
            s.lastCheckError = cleanText(s.lastCheckError, 40);
            s.lastCheckErrorDetail = cleanText(s.lastCheckErrorDetail, 200);
            return s;
        } catch { return base; }
    }

    function normCommit(c) {
        if (!c || typeof c !== 'object' || !isHash(c.hash)) return null;
        return {
            hash: String(c.hash).toLowerCase(),
            short: shortHash(c.short && isHash(c.short) ? c.short : c.hash),
            subject: cleanText(c.subject, MAX_SUBJECT) || T('upd.noSubject'),
            author: cleanText(c.author, 60),
            date: /^\d{4}-\d{2}-\d{2}T[0-9:.+-]{2,20}$/.test(String(c.date)) ? String(c.date) : ''
        };
    }

    function save() {
        const payload = JSON.stringify(state, null, 1);
        writeChain = writeChain.then(async () => {
            try {
                await fs.promises.mkdir(path.dirname(file), { recursive: true });
                const tmp = file + '.tmp';
                await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
                await fs.promises.rename(tmp, file);
            } catch (e) {
                log('[Update] gagal menyimpan status: ' + e.message);
            }
        });
        return writeChain;
    }

    // ---------- Tampilan status untuk dashboard (tanpa rahasia) ----------
    function view() {
        const statuses = ['none', 'sent', 'pending', 'unconfigured', 'disabled', 'failed'];
        return {
            enabled: enabled(),
            repo: repoName(),
            branch: branchName(),
            repoUrl: repoUrl(),
            installedCommit: state.installedCommit || '',
            installedShort: shortHash(state.installedCommit),
            latestCommit: state.latestCommit || '',
            latestShort: shortHash(state.latestCommit),
            updateAvailable: !!state.updateAvailable && !!state.latestCommit,
            aheadCount: state.aheadCount || 0,
            behindCount: state.behindCount || 0,
            detectedAt: state.detectedAt || null,
            lastCheckedAt: state.lastCheckedAt || null,
            lastCheckOkAt: state.lastCheckOkAt || null,
            lastCheckError: state.lastCheckError || '',
            lastCheckErrorDetail: state.lastCheckErrorDetail || '',
            commits: (state.commits || []).map(c => ({ ...c })),
            latestCommitInfo: state.commits && state.commits[0] ? { ...state.commits[0] } : null,
            notifyStatus: statuses.includes(state.notifyStatus) ? state.notifyStatus : 'none',
            pendingNotify: !!state.pendingNotify,
            lastNotifiedCommit: state.lastNotifiedCommit || '',
            lastNotifiedAt: state.lastNotifiedAt || null,
            intervalMs: intervalMs(),
            telegram: tgConfigured()
        };
    }

    function emit() {
        const data = view();
        if (broadcast) { try { broadcast({ type: 'UPDATE', data }); } catch { } }
        if (onChange) { try { onChange(data); } catch { } }
        return data;
    }

    // ---------- Pesan Telegram ----------
    function detectedLabel(ts) {
        try { return new Date(ts || now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
        catch { return '-'; }
    }

    // Tautan dashboard untuk pesan Telegram: UPDATE_DASHBOARD_URL, atau alamat LAN yang
    // dihitung server.js (dashboardUrl), atau dikosongkan bila tidak bisa dipastikan.
    function dashboardLink() {
        let raw = String(env('UPDATE_DASHBOARD_URL', '') || '').trim();
        if (!raw) {
            try { raw = String(typeof dashboardUrl === 'function' ? dashboardUrl() : dashboardUrl || '').trim(); }
            catch { raw = ''; }
        }
        if (!/^https?:\/\/[^\s"'<>]{3,300}$/.test(raw)) return '';
        return raw.replace(/#.*$/, '').replace(/\/+$/, '') + '/#update';
    }

    function buildMessage(ts) {
        const mode = parseMode();
        const esc = s => escapeFor(mode, s);
        const code = h => mode === 'html' ? `<code>${esc(h)}</code>`
            : (mode === 'markdown' || mode === 'markdownv2') ? '`' + esc(h) + '`'
                : esc(h);
        const link = s => mode === 'html' ? `<a href="${esc(s)}">${esc(s)}</a>` : esc(s);
        const subject = (state.commits && state.commits[0] && state.commits[0].subject) || T('upd.noSubject');
        const lines = [
            T('upd.tgTitle'),
            '',
            T('upd.tgBody'),
            '',
            T('upd.tgInstalled', { c: code(shortHash(state.installedCommit) || '-') }),
            T('upd.tgAvailable', { c: code(shortHash(state.latestCommit) || '-') }),
            '',
            T('upd.tgChanges', { m: esc(subject) }),
            '',
            T('upd.tgSource', { u: link(repoUrl()) })
        ];
        const dash = dashboardLink();
        if (dash) lines.push(T('upd.tgDashboard', { u: link(dash) }));
        lines.push(T('upd.tgDetected', { t: esc(detectedLabel(ts)) }), '', T('upd.tgFooter'));
        return lines.join('\n');
    }

    function notifyOpts() {
        const mode = parseMode();
        return mode === 'html' || mode === 'markdown' || mode === 'markdownv2' ? { parse_mode: mode } : {};
    }

    const alreadyNotified = hash => !!hash && (state.lastNotifiedCommit === hash || (state.notifiedCommits || []).includes(hash));

    function rememberNotified(hash) {
        if (!isHash(hash)) return;
        const h = String(hash).toLowerCase();
        state.lastNotifiedCommit = h;
        const list = (state.notifiedCommits || []).filter(x => x !== h);
        list.push(h);
        state.notifiedCommits = list.slice(-NOTIFIED_KEEP);
    }

    // Satu notifikasi per commit baru. Kegagalan Telegram menyimpan status "pending"
    // (dicoba ulang oleh retry timer / pemeriksaan berikutnya), bukan menghilangkan notifikasi.
    async function deliverNotification({ force = false } = {}) {
        if (!state.updateAvailable || !state.latestCommit) return false;
        if (!force && alreadyNotified(state.latestCommit)) return false;
        if (force && state.notifyStatus === 'sent' && alreadyNotified(state.latestCommit)) return false;

        if (!tgOn()) {
            state.notifyStatus = 'disabled';
            state.pendingNotify = false;
            await save();
            return false;
        }
        if (!tgConfigured() || typeof notify !== 'function') {
            state.notifyStatus = 'unconfigured';
            state.pendingNotify = true;      // dicoba lagi saat Telegram diisi/diaktifkan
            await save();
            return false;
        }
        if (state.notifyStatus === 'failed' && !force) return false;
        if (state.notifyStatus === 'failed' && force) { state.notifyStatus = 'pending'; state.notifyAttempts = 0; }

        const text = buildMessage(state.detectedAt || now());
        let ok = false;
        try {
            ok = (await notify(text, notifyOpts())) === true;
        } catch (e) {
            ok = false;
            state.lastNotifyError = cleanText(e && e.message, 120);
            log('[Update] notifikasi Telegram gagal: ' + cleanText(e && e.message, 120));
        }

        if (ok) {
            rememberNotified(state.latestCommit);
            state.notifyStatus = 'sent';
            state.pendingNotify = false;
            state.notifyAttempts = 0;
            state.lastNotifyError = '';
            state.lastNotifiedAt = now();
        } else {
            state.notifyAttempts = (state.notifyAttempts || 0) + 1;
            const dead = state.notifyAttempts >= MAX_NOTIFY_ATTEMPTS;
            state.notifyStatus = dead ? 'failed' : 'pending';
            state.pendingNotify = !dead;
            if (!state.lastNotifyError) state.lastNotifyError = 'telegram';
        }
        await save();
        emit();
        return ok;
    }

    async function retryPendingNotification() {
        if (!state.pendingNotify) return false;
        if (!tgOn() || !tgConfigured()) return false;     // belum dikonfigurasi: tidak ada request jaringan
        return deliverNotification({ force: true });
    }

    // ---------- Pemeriksaan GitHub ----------
    async function readCommits(installed, branch) {
        const out = await git([
            'log', '--no-color', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s',
            '-n', String(MAX_COMMITS), `${installed}..origin/${branch}`
        ], gitTimeoutMs());
        const list = [];
        for (const line of String(out || '').split(/\r?\n/)) {
            if (!line.trim()) continue;
            const parts = line.split('\x1f');
            const c = normCommit({
                hash: parts[0], short: parts[1], author: parts[2], date: parts[3],
                subject: parts.slice(4).join(' ')
            });
            if (c) list.push(c);
        }
        return list;
    }

    async function runCheck(reason) {
        if (blockedUntil > now()) {
            log('[Update] pemeriksaan dilewati sampai ' + new Date(blockedUntil).toISOString() + ' (rate limit GitHub).');
            return view();
        }

        const repo = repoName(), branch = branchName();
        let installed = '';
        try {
            installed = String(await git(['rev-parse', 'HEAD'], gitTimeoutMs())).trim();
        } catch (e) {
            const code = classifyGitError(e);
            state.lastCheckedAt = now();
            state.lastCheckError = code === 'not_repo' ? 'not_repo' : code;
            state.lastCheckErrorDetail = cleanText(e && (e.stderr || e.message), 200);
            state.lastCheckReason = reason;
            await save();
            emit();
            log('[Update] commit terpasang tidak bisa dibaca: ' + state.lastCheckError);
            return view();
        }

        if (!isHash(installed)) {
            state.lastCheckedAt = now();
            state.lastCheckError = 'git_error';
            state.lastCheckErrorDetail = 'rev-parse HEAD bukan hash yang valid';
            state.lastCheckReason = reason;
            await save();
            emit();
            return view();
        }
        installed = installed.toLowerCase();

        // `git fetch origin` saja: TIDAK ada `git pull`, jadi file aplikasi tidak berubah.
        let latest = '';
        try {
            await git(['fetch', '--quiet', 'origin', branch], fetchTimeoutMs());
            latest = String(await git(['rev-parse', `origin/${branch}`], gitTimeoutMs())).trim();
        } catch (e) {
            const code = classifyGitError(e);
            state.lastCheckedAt = now();
            state.lastCheckError = code;
            state.lastCheckErrorDetail = cleanText(e && (e.stderr || e.message), 200);
            state.lastCheckReason = reason;
            if (code === 'rate_limited') blockedUntil = now() + rateBackoffMs();
            await save();
            emit();
            log('[Update] cek update gagal (' + code + '): server tetap berjalan normal.');
            return view();
        }

        if (!isHash(latest)) {
            state.lastCheckedAt = now();
            state.lastCheckError = 'git_error';
            state.lastCheckErrorDetail = `origin/${branch} bukan hash yang valid`;
            state.lastCheckReason = reason;
            await save();
            emit();
            return view();
        }
        latest = latest.toLowerCase();

        // Perbandingan versi memakai hitungan commit, bukan sekadar "hash berbeda":
        // repo yang punya commit lokal lebih baru dari origin BUKAN update tersedia.
        let ahead = 0, behind = 0;
        try {
            const counts = String(await git(['rev-list', '--left-right', '--count', `${installed}...origin/${branch}`], gitTimeoutMs())).trim();
            const m = /^(\d+)\s+(\d+)$/.exec(counts);
            if (m) { ahead = Number(m[1]) || 0; behind = Number(m[2]) || 0; }
            else behind = installed === latest ? 0 : 1;
        } catch {
            // git lama / ref tidak lengkap: jatuh ke perbandingan commit seperti sebelumnya.
            behind = installed === latest ? 0 : 1;
        }

        const before = { available: state.updateAvailable, latest: state.latestCommit };
        state.repo = repo;
        state.branch = branch;
        state.repoUrl = repoUrl();
        state.installedCommit = installed;
        state.latestCommit = latest;
        state.aheadCount = ahead;
        state.behindCount = behind;
        state.updateAvailable = behind > 0;
        state.lastCheckedAt = now();
        state.lastCheckOkAt = state.lastCheckedAt;
        state.lastCheckError = '';
        state.lastCheckErrorDetail = '';
        state.lastCheckReason = reason;

        if (state.updateAvailable) {
            try { state.commits = await readCommits(installed, branch); }
            catch (e) { state.commits = state.commits || []; }
            if (!state.detectedAt || before.latest !== latest) state.detectedAt = now();
            // Commit baru: izinkan percobaan notifikasi lagi (bahkan setelah status failed).
            if (before.latest !== latest && !alreadyNotified(latest)) {
                state.notifyAttempts = 0;
                state.notifyStatus = 'pending';
                state.pendingNotify = true;
                state.lastNotifyError = '';
            }
        } else {
            state.commits = [];
            state.detectedAt = null;
            state.pendingNotify = false;
            if (state.notifyStatus === 'pending') state.notifyStatus = 'none';
        }
        await save();

        // Notifikasi hanya bila ada commit baru yang belum pernah dinotifikasi.
        if (state.updateAvailable && !alreadyNotified(latest)) {
            try { await deliverNotification(); } catch (e) { log('[Update] notifikasi gagal: ' + cleanText(e && e.message, 120)); }
        }
        emit();
        log(`[Update] ${reason}: terpasang ${shortHash(installed)} · terbaru ${shortHash(latest)} · ` +
            (state.updateAvailable ? 'UPDATE TERSEDIA' : 'sudah versi terbaru') + (state.lastCheckError ? ` (${state.lastCheckError})` : ''));
        return view();
    }

    function check(opts = {}) {
        const reason = typeof opts === 'string' ? opts : (opts.reason || 'manual');
        if (!enabled()) return Promise.resolve(view());
        if (inFlight) return inFlight;                 // tidak pernah tumpang tindih
        inFlight = runCheck(reason)
            .catch(e => { log('[Update] pemeriksaan gagal: ' + cleanText(e && e.message, 160)); return view(); })
            .finally(() => { inFlight = null; });
        return inFlight;
    }

    // ---------- Penjadwal (12 jam, non-overlap, dibersihkan saat shutdown) ----------
    function remember(t) {
        const h = t;
        if (h && typeof h.unref === 'function') h.unref();
        timersList.push(h);
        return h;
    }

    function start() {
        if (started) return false;
        if (!enabled()) {
            log('[Update] pemeriksaan GitHub dimatikan (UPDATE_CHECK_ENABLED=false).');
            return false;
        }
        started = true;
        const first = remember(timers.setTimeout(() => {
            check({ reason: 'startup' }).catch(() => { });
        }, startDelayMs()));
        const every = remember(timers.setInterval(() => {
            check({ reason: 'interval' }).catch(() => { });
        }, intervalMs()));
        const retry = remember(timers.setInterval(() => {
            retryPendingNotification().catch(() => { });
        }, retryMs()));
        const ms = intervalMs();
        const everyLabel = ms >= 3600000 ? `${Math.round(ms / 3600000)} jam` : `${Math.round(ms / 60000)} menit`;
        log(`[Update] pemeriksaan GitHub aktif: tiap ${everyLabel} (${repoName()}@${branchName()}).`);
        void first; void every; void retry;
        return true;
    }

    function stop() {
        started = false;
        for (const h of timersList) {
            try { timers.clearTimeout(h); } catch { }
            try { timers.clearInterval(h); } catch { }
        }
        timersList = [];
    }

    // ---------- Route web (login sudah diperiksa di server.js) ----------
    if (app) {
        app.get('/api/update/status', (req, res) => res.json({ success: true, ...view() }));

        app.post('/api/update/check', async (req, res) => {
            if (!enabled()) return res.status(409).json({ success: false, message: T('upd.disabled'), ...view() });
            if (inFlight) return res.status(409).json({ success: false, message: T('upd.busy'), ...view() });
            if (now() - lastManualAt < 30000) return res.status(429).json({ success: false, message: T('upd.tooSoon'), ...view() });
            lastManualAt = now();
            const data = await check({ reason: 'manual' });
            const errorKey = { not_repo: 'upd.notRepo', network: 'upd.network', rate_limited: 'upd.rateLimited',
                git_error: 'upd.gitError', auth: 'upd.gitError' }[data.lastCheckError] || '';
            res.json({
                success: true,
                message: errorKey ? T(errorKey) : (data.updateAvailable ? T('upd.updateFound', { c: data.latestShort }) : T('upd.noUpdate')),
                ...data
            });
        });

        app.post('/api/update/notify', async (req, res) => {
            if (!state.updateAvailable) return res.json({ success: false, message: T('upd.notifyNone'), ...view() });
            const already = alreadyNotified(state.latestCommit);
            const ok = await deliverNotification({ force: true });
            let message = T('upd.notifyFail');
            if (ok) message = T('upd.notifySent');
            else if (already) message = T('upd.notifyNone');
            else if (!tgOn()) message = T('upd.notifyOff');
            else if (!tgConfigured()) message = T('upd.noTelegram');
            res.json({ success: ok, message, ...view() });
        });
    }

    return {
        start, stop, check,
        view,
        state: () => JSON.parse(JSON.stringify(state)),
        retryPendingNotification,
        deliverNotification,
        isEnabled: enabled,
        isChecking: () => !!inFlight,
        timing: () => ({ intervalMs: intervalMs(), startDelayMs: startDelayMs(), retryMs: retryMs(), rateBackoffMs: rateBackoffMs() }),
        lastManualAt: () => lastManualAt,
        _resetManualRate: () => { lastManualAt = 0; blockedUntil = 0; },
        _buildMessage: buildMessage,
        _escape: escapeFor
    };
}

module.exports = createUpdater;
module.exports.createUpdater = createUpdater;
module.exports.defaultGit = defaultGit;
module.exports.classifyGitError = classifyGitError;
module.exports.escapeFor = escapeFor;
module.exports.shortHash = shortHash;
module.exports.isHash = isHash;
module.exports.DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
