// Shell root persisten untuk Android ber-root (Magisk / KernelSU / APatch).
//
// Kenapa: Android 8+ (termasuk Android 13) memblokir /proc/stat untuk aplikasi biasa
// (Termux), sehingga CPU hanya bisa dibaca lewat root. Memanggil `su -c ...` tiap 2
// detik memunculkan toast "Superuser granted" terus-menerus, memenuhi log superuser,
// dan memboroskan baterai. Modul ini membuka `su` SATU KALI lalu mengirim perintah
// lewat stdin dan membaca hasilnya sampai penanda akhir.
//
// - Tidak pernah memblokir pemanggil saat izin root belum diberikan (dialog Magisk):
//   ready() bernilai false sampai probe pertama berhasil; pemanggil memakai fallback.
// - Jika shell persisten gagal berulang kali, beralih ke mode sekali-jalan (`su -c`).
// - Semua proses su dimatikan oleh close().
const { spawn: nodeSpawn } = require('child_process');
const crypto = require('crypto');

const MAX_OUT = 256 * 1024;

function createRootShell({
    bin = 'su',
    spawn = nodeSpawn,
    probeTimeoutMs = 60000,     // waktu untuk menyetujui dialog izin root
    execTimeoutMs = 4000,
    persistentFailMax = 3,
    oneShotRetryMs = 600000,    // dalam mode su -c, coba shell persisten lagi tiap 10 menit
    log = () => { }
} = {}) {
    let child = null;
    let buf = '';
    let queue = [];              // { cmd, resolve, timer, marker }
    let current = null;
    let state = 'idle';          // idle | starting | ready | dead
    let persistentFails = 0;
    let oneShot = false;         // true = shell persisten tidak didukung, pakai su -c
    let oneShotOk = false;
    let retryAt = 0;
    let closed = false;
    let startPromise = null;

    function killChild() {
        const c = child;
        child = null;
        if (!c) return;
        try { c.stdin.end(); } catch { }
        try { c.kill('SIGKILL'); } catch { }
    }

    function failAll() {
        const pending = (current ? [current] : []).concat(queue);
        current = null;
        queue = [];
        for (const job of pending) { clearTimeout(job.timer); job.resolve(null); }
    }

    function onDead(reason) {
        if (state === 'dead' && !child) return;
        log(`[RootShell] shell root berhenti: ${reason}`);
        killChild();
        state = 'dead';
        buf = '';
        failAll();
        if (++persistentFails >= persistentFailMax) {
            if (!oneShot) log('[RootShell] shell persisten tidak stabil; beralih ke mode su -c');
            oneShot = true;
            retryAt = Date.now() + oneShotRetryMs;
        } else retryAt = Date.now() + 1000;
    }

    function pump() {
        if (current || !queue.length || !child || state === 'dead') return;
        current = queue.shift();
        const marker = '__NDLX_' + crypto.randomBytes(6).toString('hex') + '__';
        current.marker = marker;
        current.timer = setTimeout(() => onDead('timeout'), current.timeoutMs);
        try {
            // Simpan exit code perintah SEBELUM echo; baris kosong menjamin penanda ada di baris sendiri.
            child.stdin.write(`${current.cmd}\n__ndlx_rc=$?; echo; echo ${marker} $__ndlx_rc\n`);
        } catch (e) { onDead('write: ' + e.message); }
    }

    function onData(chunk) {
        buf += chunk;
        if (buf.length > MAX_OUT) return onDead('output terlalu besar');
        if (!current) { buf = ''; return; }
        const idx = buf.indexOf(current.marker);
        if (idx < 0) return;
        const eol = buf.indexOf('\n', idx);
        if (eol < 0) return;
        const code = Number(buf.slice(idx + current.marker.length, eol).trim());
        // Buang baris kosong tambahan yang kita sisipkan sebelum penanda.
        const out = buf.slice(0, idx).replace(/\n$/, '').replace(/\n$/, '');
        buf = buf.slice(eol + 1);
        const job = current;
        current = null;
        clearTimeout(job.timer);
        job.resolve(code === 0 ? out : null);
        pump();
    }

    function spawnShell() {
        state = 'starting';
        buf = '';
        let c;
        try { c = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] }); }
        catch (e) { onDead('spawn: ' + e.message); return Promise.resolve(false); }
        child = c;
        c.stdout.setEncoding('utf8');
        c.stdout.on('data', d => { if (child === c) onData(d); });
        c.stdin.on('error', () => { });
        c.on('error', e => { if (child === c) onDead('error: ' + e.message); });
        c.on('exit', code => { if (child === c) onDead('exit ' + code); });
        // Probe: pastikan shell benar-benar menjalankan perintah dan bisa membaca /proc/stat.
        return new Promise(resolve => {
            queue.unshift({ cmd: "grep -c '^cpu' /proc/stat", timeoutMs: probeTimeoutMs, resolve: out => resolve(out != null && Number(out) > 0) });
            pump();
        }).then(ok => {
            if (child !== c) return false;
            if (!ok) { onDead('probe gagal'); return false; }
            state = 'ready';
            persistentFails = 0;
            log('[RootShell] shell root persisten siap');
            return true;
        });
    }

    // Mode cadangan: satu proses `su -c` per perintah.
    function execOneShot(cmd, timeoutMs) {
        return new Promise(resolve => {
            let out = '', settled = false, c;
            const finish = v => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
            const t = setTimeout(() => { try { c && c.kill('SIGKILL'); } catch { } finish(null); }, timeoutMs);
            try { c = spawn(bin, ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); }
            catch { return finish(null); }
            c.stdout.setEncoding('utf8');
            c.stdout.on('data', d => { if (out.length < MAX_OUT) out += d; });
            c.on('error', () => finish(null));
            c.on('close', code => finish(code === 0 ? out.replace(/\n$/, '') : null));
        }).then(out => { oneShotOk = out != null; return out; });
    }

    // Mulai shell di latar belakang (tidak menunggu dialog izin root).
    function warmUp() {
        if (closed || oneShot || state === 'ready' || state === 'starting' || Date.now() < retryAt) return startPromise;
        startPromise = spawnShell().finally(() => { startPromise = null; });
        return startPromise;
    }

    return {
        // true jika perintah bisa langsung dijalankan tanpa menunggu.
        ready: () => !closed && (state === 'ready' || (oneShot && oneShotOk)),
        mode: () => oneShot ? 'oneshot' : state,
        warmUp,
        // Jalankan perintah sebagai root. Menghasilkan stdout (string) atau null.
        exec(cmd, { timeoutMs = execTimeoutMs } = {}) {
            if (closed) return Promise.resolve(null);
            if (oneShot) {
                if (oneShotOk && Date.now() >= retryAt) {
                    // Root terbukti berfungsi: sesekali coba lagi shell persisten. Satu
                    // kegagalan saja langsung kembali ke mode su -c.
                    oneShot = false;
                    persistentFails = persistentFailMax - 1;
                    warmUp();
                }
                return execOneShot(cmd, timeoutMs);
            }
            if (state !== 'ready') { warmUp(); return Promise.resolve(null); }
            return new Promise(resolve => { queue.push({ cmd, timeoutMs, resolve }); pump(); });
        },
        close() {
            closed = true;
            killChild();
            state = 'dead';
            failAll();
        },
        // Untuk pengujian
        _pid: () => child && child.pid
    };
}

module.exports = { createRootShell };
