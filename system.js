// Monitor CPU, RAM, dan flash disk perangkat server (termasuk Android/Termux).
// Prioritas: /proc (lebih akurat pada Linux), lalu /proc lewat su (Android yang
// membatasi /proc/stat untuk aplikasi), lalu API os bawaan Node.js, dan terakhir
// estimasi dari load average. Data dikirim lewat WebSocket {type:'SYSTEM'} dan
// riwayat tersedia di /api/system.
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const pollValue = Number(E('SYSTEM_POLL_MS', 2000));
const POLL_MS = Number.isFinite(pollValue) ? Math.max(1000, Math.min(30000, Math.floor(pollValue))) : 2000;
const FLASH_MS = 10000;
const HMAX = 90;
// Jeda singkat untuk sampel CPU kedua saat belum ada sampel sebelumnya, supaya
// pembacaan pertama (dashboard baru dibuka / skill AI) langsung punya angka CPU.
const PRIME_MS = 250;
// Jika su gagal berturut-turut, berhenti mencoba sementara agar tidak memanggil su tiap 2 detik.
const SU_FAIL_MAX = 3;
const SU_BACKOFF_MS = 60000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Parser murni (diekspor untuk pengujian) ----------
const CPU_LINE = /^cpu\s+(\d+(?:\s+\d+)*)/m;
const MARKER = '\n===\n';

function parseCpuCounters(stat) {
    const line = CPU_LINE.exec(String(stat || ''));
    if (!line) return null;
    // Field guest/guest_nice sudah termasuk dalam user/nice; jangan dihitung dua kali.
    const values = line[1].trim().split(/\s+/).map(Number).slice(0, 8);
    return values.length >= 4 ? values : null;
}

function cpuFromCounters(values, previous) {
    if (!Array.isArray(values) || values.length < 4 || values.some(v => !Number.isFinite(v) || v < 0)) return { pct: null, next: previous };
    const idle = values[3] + (values[4] || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) return { pct: null, next: previous };
    const next = { idle, total };
    if (!previous || total <= previous.total || idle < previous.idle) return { pct: null, next };
    const deltaTotal = total - previous.total;
    const deltaIdle = idle - previous.idle;
    if (deltaTotal <= 0) return { pct: null, next };
    return { pct: Math.max(0, Math.min(100, (1 - deltaIdle / deltaTotal) * 100)), next };
}

function parseRam(mem) {
    const text = String(mem || '');
    const get = key => {
        const match = new RegExp('^' + key + ':\\s+(\\d+)\\s*kB', 'm').exec(text);
        return match ? Number(match[1]) * 1024 : null;
    };
    const total = get('MemTotal');
    if (!(total > 0)) return null;
    let available = get('MemAvailable');
    if (available == null) {
        const free = get('MemFree');
        const buffers = get('Buffers');
        const cached = get('Cached');
        const reclaimable = get('SReclaimable');
        const shared = get('Shmem') || 0;
        // Kernel lama dapat tidak menyediakan MemAvailable. Jika seluruh field
        // estimasi juga tidak ada, serahkan ke os.freemem() agar tidak melaporkan 100%.
        if (free == null && buffers == null && cached == null && reclaimable == null) return null;
        available = Math.min(total, Math.max(0, (free || 0) + (buffers || 0) + (cached || 0) + (reclaimable || 0) - shared));
    }
    const used = Math.max(0, Math.min(total, total - available));
    return { total, used, pct: Math.max(0, Math.min(100, used / total * 100)) };
}

// Pisahkan keluaran perintah su: "<isi /proc/stat>\n===\n<isi /proc/meminfo>"
function splitSuOutput(out) {
    const text = String(out || '');
    const marker = text.indexOf(MARKER);
    if (marker < 0) return null;
    return { stat: text.slice(0, marker), mem: text.slice(marker + MARKER.length) };
}

function countCores(stat) {
    try {
        const cpus = os.cpus();
        if (Array.isArray(cpus) && cpus.length) return { cores: cpus.length, model: (cpus[0] && cpus[0].model) || '' };
    } catch { }
    // Android sering mengembalikan os.cpus() kosong; hitung baris cpuN dari /proc/stat.
    const lines = String(stat || '').match(/^cpu\d+\s/mg);
    if (lines && lines.length) return { cores: lines.length, model: '' };
    try {
        if (typeof os.availableParallelism === 'function') {
            const n = os.availableParallelism();
            if (Number.isFinite(n) && n > 0) return { cores: n, model: '' };
        }
    } catch { }
    return { cores: 0, model: '' };
}

function createSystemMonitor({ app, broadcast, storage: storageOverride, readFile, runSu } = {}) {
    const getStorage = () => storageOverride || require('./storage');
    const useSu = () => { try { return getStorage().MODE !== 'direct'; } catch { return false; } };
    const read = readFile || (p => fs.readFileSync(p, 'utf8'));

    // ---------- Sumber 1: /proc langsung ----------
    function readProcDirect() {
        let stat = null, mem = null;
        try { stat = read('/proc/stat'); } catch { /* Android 8+ menolak /proc/stat */ }
        try { mem = read('/proc/meminfo'); } catch { }
        return {
            stat: /^cpu\s/m.test(String(stat || '')) ? stat : null,
            mem: /^MemTotal:/m.test(String(mem || '')) ? mem : null
        };
    }

    // ---------- Sumber 2: /proc lewat su (hanya mode root) ----------
    let suFails = 0, suPausedUntil = 0;
    function defaultRunSu(cmd) {
        return new Promise(resolve => {
            let out = '';
            let settled = false;
            let child;
            const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
            const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { } finish(null); }, 4000);
            try { child = spawn(getStorage().SU, ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); }
            catch { return finish(null); }
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => { if (out.length < 32768) out += chunk; });
            child.on('error', () => finish(null));
            child.on('close', code => finish(code === 0 ? out : null));
        });
    }
    async function readProcSu() {
        if (!useSu() || Date.now() < suPausedUntil) return null;
        const cmd = "head -n 64 /proc/stat; echo '==='; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable|Shmem):' /proc/meminfo";
        let parsed = null;
        try { parsed = splitSuOutput(await (runSu || defaultRunSu)(cmd)); } catch { parsed = null; }
        if (!parsed || !/^cpu\s/m.test(parsed.stat)) {
            if (++suFails >= SU_FAIL_MAX) { suFails = 0; suPausedUntil = Date.now() + SU_BACKOFF_MS; }
            return null;
        }
        suFails = 0;
        return parsed;
    }

    async function readProc() {
        const direct = readProcDirect();
        if (direct.stat && direct.mem) return direct;
        const viaSu = await readProcSu();
        return {
            stat: direct.stat || (viaSu && viaSu.stat) || null,
            mem: direct.mem || (viaSu && viaSu.mem) || null
        };
    }

    // ---------- CPU ----------
    let prevProcCpu = null;
    let prevOsCpu = null;

    function cpuPctFromProc(stat) {
        const values = parseCpuCounters(stat);
        if (!values) return null;
        const result = cpuFromCounters(values, prevProcCpu);
        prevProcCpu = result.next;
        return result.pct;
    }

    function cpuPctFromOs() {
        try {
            const cpus = os.cpus();
            if (!Array.isArray(cpus) || !cpus.length) return null;
            const aggregate = [0, 0, 0, 0];
            for (const cpu of cpus) {
                const times = cpu && cpu.times;
                if (!times) return null;
                aggregate[0] += (Number(times.user) || 0) + (Number(times.irq) || 0); // IRQ = sibuk
                aggregate[1] += Number(times.nice) || 0;
                aggregate[2] += Number(times.sys) || 0;
                aggregate[3] += Number(times.idle) || 0;
            }
            const result = cpuFromCounters(aggregate, prevOsCpu);
            prevOsCpu = result.next;
            return result.pct;
        } catch { return null; }
    }

    function cpuPctFromLoad(cores) {
        try {
            const load = os.loadavg()[0];
            if (!(Number.isFinite(load) && load >= 0 && cores > 0)) return null;
            // loadavg Android sering 0 terus jika tidak didukung; anggap tidak tersedia.
            if (load === 0 && os.loadavg().every(v => v === 0)) return null;
            return Math.max(0, Math.min(100, load / cores * 100));
        } catch { return null; }
    }

    // ---------- RAM ----------
    function ramInfoFromOs() {
        try {
            const total = Number(os.totalmem()), free = Number(os.freemem());
            if (!(Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0)) return null;
            const used = Math.max(0, Math.min(total, total - free));
            return { total, used, pct: Math.max(0, Math.min(100, used / total * 100)) };
        } catch { return null; }
    }

    // ---------- Flash disk (tidak pernah memblokir CPU/RAM) ----------
    // storage.status() dapat memakan waktu hingga 45 detik (menunggu izin su atau
    // flash disk lambat). Penyegaran dijalankan di latar belakang dan sampel CPU/RAM
    // selalu memakai nilai flash terakhir yang diketahui.
    let flash = { ready: false, message: null }, flashAt = 0, flashBusy = null;
    function refreshFlash() {
        if (flashBusy || Date.now() - flashAt < FLASH_MS) return flashBusy;
        flashBusy = (async () => {
            try {
                const status = await getStorage().status();
                flash = { ready: !!status.ready, total: status.total || null, free: status.free || null, root: status.root, message: status.ready ? null : status.message };
            } catch (error) { flash = { ready: false, message: String(error && error.message || 'Storage unavailable') }; }
            flashAt = Date.now();
            flashBusy = null;
        })();
        return flashBusy;
    }

    // ---------- Sampel ----------
    const hist = [];
    let last = { t: 0, cpu: null, ram: null };
    let lastFull = null;

    async function readCpuRam() {
        const proc = await readProc();
        let cpu = proc.stat ? cpuPctFromProc(proc.stat) : null;
        let cpuSource = cpu != null ? 'proc' : '';
        if (cpu == null) {
            cpu = cpuPctFromOs();
            if (cpu != null) cpuSource = 'node-os';
        }
        let ram = proc.mem ? parseRam(proc.mem) : null;
        let ramSource = ram ? 'proc' : '';
        if (!ram) {
            ram = ramInfoFromOs();
            if (ram) ramSource = 'node-os';
        }
        return { proc, cpu, cpuSource, ram, ramSource };
    }

    async function doSample() {
        const unavailable = [];
        const firstCpu = !prevProcCpu && !prevOsCpu;
        let r = await readCpuRam();
        // Persentase CPU butuh dua titik waktu. Pada sampel pertama ambil titik kedua
        // setelah jeda singkat supaya dashboard tidak menampilkan "--" / N/A.
        if (r.cpu == null && firstCpu && (prevProcCpu || prevOsCpu)) {
            await delay(PRIME_MS);
            const again = await readCpuRam();
            r = { ...again, ram: again.ram || r.ram, ramSource: again.ram ? again.ramSource : r.ramSource };
        }
        const { cores, model } = countCores(r.proc.stat);
        let { cpu, cpuSource } = r;
        if (cpu == null) {
            cpu = cpuPctFromLoad(cores);
            if (cpu != null) cpuSource = 'loadavg';
        }
        const ram = r.ram, ramSource = r.ramSource;

        if (cpu != null || ram) {
            last = { t: Date.now(), cpu: cpu == null ? last.cpu : cpu, ram: ram || last.ram };
            hist.push({ t: last.t, cpu: last.cpu == null ? null : +last.cpu.toFixed(1), ram: last.ram ? +last.ram.pct.toFixed(1) : null });
            if (hist.length > HMAX) hist.shift();
        }
        if (last.cpu == null) unavailable.push('cpu');
        if (!last.ram) unavailable.push('ram');
        if (!cores) unavailable.push('cores');

        refreshFlash();

        let load = null;
        try { const values = os.loadavg(); if (values && Number.isFinite(values[0])) load = +values[0].toFixed(2); } catch { }
        let uptime = null;
        try { const value = os.uptime(); if (Number.isFinite(value)) uptime = Math.floor(value); } catch { }

        const data = {
            t: last.t || Date.now(),
            cpu: last.cpu == null ? null : +last.cpu.toFixed(1),
            ram: last.ram && { total: last.ram.total, used: last.ram.used, pct: +last.ram.pct.toFixed(1) },
            flash: { ...flash }, cores, model, load, uptime,
            source: { cpu: cpuSource || (last.cpu != null ? 'cached' : null), ram: ramSource || (last.ram ? 'cached' : null) },
            unavailable
        };
        lastFull = data;
        try { broadcast({ type: 'SYSTEM', data }); } catch { /* client WebSocket dapat terputus */ }
        return data;
    }

    // Satu sampel pada satu waktu: loop & getStatus() berbagi hasil yang sama supaya
    // penghitung CPU sebelumnya tidak tertimpa oleh pembacaan yang hampir bersamaan.
    let inflight = null;
    function sample() {
        if (!inflight) inflight = doSample().finally(() => { inflight = null; });
        return inflight;
    }

    let timer = null;
    let generation = 0;
    let running = false;
    function loop() {
        const current = generation;
        sample().catch(error => {
            const data = lastFull || {
                t: Date.now(), cpu: null, ram: null, flash: { ready: false, message: 'Monitoring error' },
                cores: 0, model: '', load: null, uptime: null, source: { cpu: null, ram: null },
                unavailable: ['cpu', 'ram']
            };
            data.monitorError = String(error && error.message || 'sampling failed').slice(0, 120);
            lastFull = data;
            try { broadcast({ type: 'SYSTEM', data }); } catch { }
        }).finally(() => {
            if (current !== generation || !running) return;
            timer = setTimeout(loop, POLL_MS);
        });
    }

    function stop() {
        running = false;
        generation++;
        clearTimeout(timer);
        timer = null;
    }
    function start() {
        stop();
        running = true;
        loop();
    }

    if (app && typeof app.get === 'function') {
        app.get('/api/system', (req, res) => res.json({ now: last, snapshot: lastFull, history: hist }));
    }

    async function getStatus() {
        if (lastFull && Date.now() - (lastFull.t || 0) < Math.max(3000, POLL_MS * 2)) return lastFull;
        try { return await sample(); }
        catch (error) {
            return lastFull || {
                t: Date.now(), cpu: null, ram: null,
                flash: { ready: false, message: String(error && error.message || 'monitoring unavailable') },
                cores: 0, load: null, uptime: null, source: { cpu: null, ram: null },
                unavailable: ['cpu', 'ram', 'flash']
            };
        }
    }

    return {
        start,
        stop,
        sample,
        getStatus,
        isRunning: () => running,
        history: () => hist.slice(),
        snapshot: () => lastFull
    };
}

module.exports = (opts) => createSystemMonitor(opts);
module.exports.createSystemMonitor = createSystemMonitor;
module.exports._internal = { parseCpuCounters, cpuFromCounters, parseRam, splitSuOutput, countCores };
