// ============================================================================
// executor.js — satu pengelola eksekusi perintah untuk terminal web DAN AI.
//
// Sebelumnya terminal web (terminal.js) dan skill `run_command` (ai.js) memakai
// dua jalur berbeda: AI selalu memakai /bin/sh, tidak memeriksa TERMINAL_ENABLED,
// dan tidak mengikuti folder kerja/batas/timeout/pembatalan milik terminal.
// Modul ini menyatukan semuanya:
//   • TERMINAL_ENABLED diperiksa SETIAP kali perintah akan dijalankan.
//   • Shell dipilih seperti terminal.js: TERMINAL_SHELL, $PREFIX/bin/bash (Termux),
//     $PREFIX/bin/sh, $SHELL, /bin/bash, /bin/sh, /system/bin/sh.
//   • Folder kerja, panjang perintah, batas output, timeout, dan jumlah proses
//     bersamaan diterapkan di satu tempat.
//   • Proses dijalankan sebagai pemimpin grup (detached) sehingga pembatalan,
//     timeout, atau shutdown mematikan juga anak-cucunya (ping, sleep, sh -c, ...).
//   • Pekerjaan yang masih berjalan dihentikan terkendali (SIGTERM lalu SIGKILL)
//     ketika terminal dinonaktifkan.
//   • Variabel environment rahasia disaring. Ini BUKAN sandbox: proses masih
//     berjalan dengan hak akses user Node dan bisa membaca file yang diizinkan OS.
//
// Dipakai oleh:
//   terminal.js  -> start/get/input/kill/info (terminal web, output di-poll)
//   ai.js        -> execute() (skill run_command menunggu hasil akhir)
// ============================================================================
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('./lang');

const MAX_INPUT = 4096;                 // panjang satu kiriman stdin (terminal web)
const KEEP_DONE_MS = 10 * 60 * 1000;    // job selesai disimpan ±10 menit
const MAX_JOBS_KEPT = 40;
const KILL_GRACE_MS = 2000;             // SIGTERM -> SIGKILL
const ESCALATE_MS = 1500;               // jaring pengaman bila 'close' tidak datang

// Kode escape ANSI (warna, kursor, judul jendela) dibuang supaya output bersih.
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Variabel rahasia aplikasi (password admin, token Telegram, API key) tidak diwariskan.
const SECRET = /(PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET)/i;

class ExecError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'ExecError';
        this.code = code;
        this.status = status || 400;
    }
}

function childEnv(env) {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!SECRET.test(k) && k !== 'ADMIN_USERNAME') out[k] = v;
    }
    // Variabel dari pembungkus tes/alternatif bisa ditambahkan lewat env().
    for (const k of ['LANGUAGE']) {
        const v = env(k, '');
        if (v) out[k] = v;
    }
    out.TERM = 'dumb';
    out.NO_COLOR = '1';
    out.PAGER = 'cat';
    out.GIT_PAGER = 'cat';
    return out;
}

// Cari file di PATH (untuk TERMINAL_SHELL=bash, bukan jalur absolut).
function whichFile(name) {
    if (!name || name.includes('/')) return '';
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
        const p = path.join(d, name);
        try { if (fs.statSync(p).isFile()) return p; } catch { }
    }
    return '';
}

// Urutan sama dengan terminal.js lama, ditambah dukungan nama shell di PATH.
function pickShell(env) {
    const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
    const configured = String(env('TERMINAL_SHELL', '') || '').trim();
    const list = [
        configured,
        prefix + '/bin/bash',
        prefix + '/bin/sh',
        process.env.SHELL,
        '/bin/bash',
        '/bin/sh',
        '/system/bin/sh'
    ];
    for (const cand of list) {
        if (!cand) continue;
        const p = cand.includes('/') ? cand : whichFile(cand);
        if (!p) continue;
        try { if (fs.statSync(p).isFile()) return p; } catch { }
    }
    return 'sh';
}

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function homeDir(env) {
    const configured = String(env('TERMINAL_CWD', '') || '').trim();
    if (configured) return isDir(configured) ? configured : '/';
    const h = process.env.HOME || os.homedir() || '/';
    return isDir(h) ? h : '/';
}

function num(env, key, def, min) {
    const raw = env(key, '');
    const n = Number(raw === '' ? def : raw);
    return Number.isFinite(n) && n >= min ? n : def;
}

function boolValue(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return true;
    return !/^(false|0|no|off)$/.test(s);
}

module.exports = function createExecutor({ env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k], log = console.log } = {}) {
    const jobs = new Map();
    let seq = 0;

    const enabled = () => boolValue(env('TERMINAL_ENABLED', 'true'));

    function limits() {
        return {
            shell: pickShell(env),
            home: homeDir(env),
            // 0 = tanpa batas waktu (tetap bisa dibatalkan manual)
            timeoutMs: Math.round(num(env, 'TERMINAL_TIMEOUT_S', 300, 0) * 1000),
            maxOutput: Math.round(num(env, 'TERMINAL_MAX_OUTPUT_KB', 512, 16) * 1024),
            maxJobs: Math.max(1, Math.floor(num(env, 'TERMINAL_MAX_JOBS', 4, 1))),
            maxCmd: Math.max(64, Math.floor(num(env, 'TERMINAL_MAX_CMD', 10000, 64)))
        };
    }

    const running = () => [...jobs.values()].filter(j => !j.done);

    function killTree(job, sig) {
        const pid = job.child && job.child.pid;
        if (!pid) return;
        // detached: true -> job memimpin grup proses; -pid mematikan seluruh grup.
        try { process.kill(-pid, sig); return; } catch { }
        try { job.child.kill(sig); } catch { }
    }

    function killJob(job, force, reason) {
        if (!job || job.done) return;
        if (reason && !job.killedBy) job.killedBy = reason;
        const sig = force ? 'SIGKILL' : 'SIGTERM';
        killTree(job, sig);
        if (!force) {
            if (!job.killTimer) {
                job.killTimer = setTimeout(() => {
                    if (!job.done) killJob(job, true, reason);
                }, KILL_GRACE_MS);
                if (job.killTimer.unref) job.killTimer.unref();
            }
            // Jaring pengaman: jangan menggantung walau 'close' tidak pernah datang
            // (mis. proses anak menahan pipa).
            setTimeout(() => { if (job.done) return; killTree(job, 'SIGKILL'); finishJob(job); }, ESCALATE_MS + KILL_GRACE_MS).unref?.();
        }
    }

    function addChunk(job, s, data) {
        if (!data) return;
        let d = String(data).replace(ANSI, '');
        if (!d) return;
        job.chunks.push({ i: ++job.seq, s, d });
        job.size += d.length;
        const max = job.maxOutput;
        while (job.size > max && job.chunks.length > 1) {
            job.size -= job.chunks.shift().d.length;
            job.truncated = true;
        }
        // Satu potongan raksasa juga harus dipotong
        if (job.size > max) {
            const first = job.chunks[0];
            if (first) {
                first.d = first.d.slice(-max);
                job.chunks = [first];
                job.size = first.d.length;
                job.truncated = true;
            }
        }
    }

    function outputOf(job, stream) {
        return job.chunks.filter(c => !stream || c.s === stream).map(c => c.d).join('');
    }

    function finishJob(job) {
        if (!job || job.finished) return;
        job.finished = true;
        clearTimeout(job.limitTimer);
        clearTimeout(job.killTimer);
        const p = String(job.cwdOut || '').trim().split('\n').pop();
        if (p && path.isAbsolute(p) && isDir(p)) job.newCwd = p;
        job.done = true;
        job.doneAt = Date.now();
        job.ms = job.doneAt - job.startedAt;
        job.truncated = job.truncated || job.size >= job.maxOutput;
        for (const s of (job.child ? job.child.stdio : [])) { try { s && s.destroy(); } catch { } }
        const result = {
            jobId: job.id,
            ok: !job.timedOut && !job.cancelled && job.code === 0,
            code: job.code,
            signal: job.signal,
            output: outputOf(job, 'o'),
            stderr: outputOf(job, 'e'),
            timedOut: !!job.timedOut,
            cancelled: !!job.cancelled,
            truncated: !!job.truncated,
            killedBy: job.killedBy || null,
            ms: job.ms,
            cwd: job.newCwd
        };
        job.result = result;
        for (const fn of job.waiters) { try { fn(result); } catch { } }
        job.waiters.length = 0;
    }

    function resolveCwd(cwd) {
        const base = limits().home;
        if (typeof cwd === 'string' && cwd && path.isAbsolute(cwd) && isDir(cwd)) return cwd;
        return base;
    }

    function start(opts = {}) {
        const l = limits();
        if (!enabled()) throw new ExecError(T('term.disabled'), 'TERMINAL_DISABLED', 403);
        const cmd = String(opts.cmd == null ? '' : opts.cmd).replace(/\r\n?/g, '\n');
        if (!cmd.trim()) throw new ExecError(T('term.empty'), 'EMPTY_COMMAND', 400);
        if (cmd.length > l.maxCmd) throw new ExecError(T('term.tooLong'), 'COMMAND_TOO_LONG', 400);
        if (cmd.includes('\0')) throw new ExecError(T('term.tooLong'), 'COMMAND_INVALID', 400);
        if (running().length >= l.maxJobs) throw new ExecError(T('term.busy'), 'TOO_MANY_JOBS', 429);

        const cwd = resolveCwd(opts.cwd);
        const interactive = opts.interactive !== false;
        const job = {
            id: (++seq).toString(36) + crypto.randomBytes(4).toString('hex'),
            cmd,
            cwd,
            owner: String(opts.owner || '-'),
            channel: String(opts.channel || 'web'),
            startedAt: Date.now(),
            chunks: [], seq: 0, size: 0, truncated: false,
            done: false, finished: false, code: null, signal: null,
            timedOut: false, cancelled: false, killedBy: null,
            newCwd: cwd, cwdOut: '', waiters: [],
            maxOutput: opts.maxOutput == null ? l.maxOutput : Math.max(1024, Math.floor(opts.maxOutput)),
            onData: typeof opts.onData === 'function' ? opts.onData : null
        };

        // fd 3 dipakai shell untuk melaporkan folder akhir (cd terasa seperti terminal).
        const script = cmd + '\n__s8rc=$?\npwd >&3 2>/dev/null\nexit $__s8rc\n';
        const child = spawn(l.shell, ['-c', script], {
            cwd,
            env: childEnv(env),
            detached: true,
            stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe']
        });
        job.child = child;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        if (child.stdio[3]) child.stdio[3].setEncoding('utf8');
        child.stdout.on('data', d => { addChunk(job, 'o', d); if (job.onData) job.onData('o', d); });
        child.stderr.on('data', d => { addChunk(job, 'e', d); if (job.onData) job.onData('e', d); });
        if (child.stdio[3]) child.stdio[3].on('data', d => { job.cwdOut = (job.cwdOut + d).slice(-4096); });
        if (child.stdin) child.stdin.on('error', () => { });

        child.on('error', e => { job.code = job.code == null ? -1 : job.code; addChunk(job, 'e', e.message + '\n'); finishJob(job); });
        child.on('exit', (code, signal) => {
            job.code = code;
            job.signal = signal;
            // Perintah latar belakang bisa menahan pipa; beri jeda singkat.
            setTimeout(() => finishJob(job), 300).unref?.();
        });
        child.on('close', () => finishJob(job));

        if (opts.timeoutMs === 0) {
            // tanpa batas
        } else {
            const limit = opts.timeoutMs == null ? l.timeoutMs : Math.max(0, Number(opts.timeoutMs));
            if (limit > 0) job.limitTimer = setTimeout(() => {
                if (job.done) return;
                job.timedOut = true;
                addChunk(job, 'e', '\n' + T('term.timeout', { s: Math.round(limit / 1000) }) + '\n');
                killJob(job, false, 'timeout');
            }, limit);
        }

        job.cancel = () => { if (!job.done) { job.cancelled = true; killJob(job, false, 'cancelled'); } };
        jobs.set(job.id, job);
        log(`[Executor] ${job.channel}/${job.owner}: ${cmd.replace(/\s+/g, ' ').slice(0, 160)}`);

        // Buang job lama yang sudah selesai bila tumpukan memanjang.
        if (jobs.size > MAX_JOBS_KEPT) {
            const done = [...jobs.values()].filter(j => j.done).sort((a, b) => a.doneAt - b.doneAt);
            while (jobs.size > MAX_JOBS_KEPT && done.length) jobs.delete(done.shift().id);
        }
        return job;
    }

    function execute(opts = {}) {
        return new Promise(resolve => {
            let job;
            try {
                job = start({ ...opts, interactive: opts.interactive === true });
            } catch (e) {
                resolve({
                    ok: false, code: null, signal: null, output: '', stderr: '',
                    timedOut: false, cancelled: false, truncated: false,
                    error: e.message, errorCode: e.code || 'EXEC_FAILED'
                });
                return;
            }
            let settled = false;
            const done = result => { if (settled) return; settled = true; if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort); resolve(result); };
            job.waiters.push(done);
            const onAbort = () => {
                job.cancelled = true;
                job.killedBy = 'cancelled';
                killJob(job, false, 'cancelled');
            };
            if (opts.signal) {
                if (opts.signal.aborted) onAbort();
                else opts.signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    function input(id, data) {
        const job = jobs.get(String(id || ''));
        if (!job) throw new ExecError(T('term.noJob'), 'JOB_NOT_FOUND', 404);
        if (!enabled()) throw new ExecError(T('term.disabled'), 'TERMINAL_DISABLED', 403);
        const s = String(data == null ? '' : data);
        if (s.length > MAX_INPUT) throw new ExecError(T('term.tooLong'), 'INPUT_TOO_LONG', 400);
        if (job.done || !job.child.stdin || !job.child.stdin.writable) throw new ExecError(T('term.finished'), 'JOB_FINISHED', 409);
        job.child.stdin.write(s + '\n');
        return true;
    }

    function kill(id, force) {
        const job = jobs.get(String(id || ''));
        if (!job) throw new ExecError(T('term.noJob'), 'JOB_NOT_FOUND', 404);
        if (!job.done) { job.killedBy = job.killedBy || 'killed'; killJob(job, !!force, 'killed'); }
        return job;
    }

    // Hentikan semua pekerjaan. Dipakai saat fitur dimatikan, logout massal, atau shutdown.
    function killAll(reason = 'shutdown') {
        for (const j of running()) {
            if (reason === 'disabled') j.cancelled = true;
            j.killedBy = reason;
            killJob(j, false, reason);
        }
    }

    function get(id) { return jobs.get(String(id || '')) || null; }

    function info() {
        const l = limits();
        let user = '';
        try { user = os.userInfo().username; } catch { }
        return {
            enabled: enabled(),
            shell: l.shell,
            shellName: path.basename(l.shell),
            home: l.home,
            user,
            host: os.hostname(),
            timeout: Math.round(l.timeoutMs / 1000),
            maxOutputKB: Math.round(l.maxOutput / 1024),
            maxJobs: l.maxJobs,
            maxCmd: l.maxCmd,
            running: running().map(j => ({ id: j.id, cmd: j.cmd, cwd: j.cwd, channel: j.channel, startedAt: j.startedAt }))
        };
    }

    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [id, j] of jobs) if (j.done && now - (j.doneAt || now) > KEEP_DONE_MS) jobs.delete(id);
    }, 60000);
    if (sweeper.unref) sweeper.unref();

    return {
        enabled, limits, start, execute, input, kill, killAll, get, info,
        running,
        jobs,
        shell: () => pickShell(env),
        home: () => homeDir(env),
        stopSweeper: () => clearInterval(sweeper)
    };
};

module.exports.ExecError = ExecError;
module.exports.pickShell = pickShell;
module.exports.childEnv = childEnv;
module.exports.ANSI = ANSI;
