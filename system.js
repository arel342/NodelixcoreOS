// Monitor CPU, RAM, dan flash disk perangkat server (termasuk Android/Termux).
// Prioritas: /proc (lebih akurat pada Linux), lalu API os bawaan Node.js sebagai fallback.
// Data dikirim lewat WebSocket {type:'SYSTEM'} dan riwayat tersedia di /api/system.
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const pollValue = Number(E('SYSTEM_POLL_MS', 2000));
const POLL_MS = Number.isFinite(pollValue) ? Math.max(1000, Math.min(30000, Math.floor(pollValue))) : 2000;
const FLASH_MS = 10000;
const HMAX = 90;

module.exports = ({ app, broadcast }) => {
    const storage = require('./storage');
    const useSu = () => storage.MODE !== 'direct';

    async function readProc() {
        try {
            const stat = fs.readFileSync('/proc/stat', 'utf8');
            const mem = fs.readFileSync('/proc/meminfo', 'utf8');
            if (/^cpu\\s/m.test(stat) && /^MemTotal:/m.test(mem)) return { stat, mem };
        } catch { /* /proc mungkin dibatasi Android */ }

        // Fallback hanya untuk perangkat yang memang memerlukan akses root.
        if (!useSu()) return null;
        return new Promise(resolve => {
            const cmd = "head -n 8 /proc/stat; echo '==='; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable|Shmem):' /proc/meminfo";
            const [bin, args] = [storage.SU, ['-c', cmd]];
            let out = '';
            let settled = false;
            const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
            const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, 4000);
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => { if (out.length < 32768) out += chunk; });
            child.on('error', () => finish(null));
            child.on('close', code => {
                if (code !== 0) return finish(null);
                const marker = out.indexOf('\\n===\\n');
                if (marker < 0) return finish(null);
                finish({ stat: out.slice(0, marker), mem: out.slice(marker + 5) });
            });
        });
    }

    let prevProcCpu = null;
    let prevOsCpu = null;
    function cpuFromCounters(values, previous) {
        if (!values.length || values.some(v => !Number.isFinite(v) || v < 0)) return { pct: null, next: previous };
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

    function cpuPctFromProc(stat) {
        const line = /^cpu\\s+([\\d\\s]+)/m.exec(String(stat || ''));
        if (!line) return null;
        // Field guest/guest_nice sudah termasuk dalam user/nice; jangan dihitung dua kali.
        const values = line[1].trim().split(/\\s+/).map(Number).slice(0, 8);
        if (values.length < 4) return null;
        const result = cpuFromCounters(values, prevProcCpu);
        prevProcCpu = result.next;
        return result.pct;
    }

    function cpuPctFromOs() {
        try {
            const cpus = os.cpus();
            if (!Array.isArray(cpus) || !cpus.length) return null;
            const values = cpus.map(cpu => cpu.times).filter(Boolean);
            if (values.length !== cpus.length) return null;
            const aggregate = Array(5).fill(0);
            for (const times of values) {
                aggregate[0] += Number(times.user) || 0;
                aggregate[1] += Number(times.nice) || 0;
                aggregate[2] += Number(times.sys) || 0;
                aggregate[3] += Number(times.idle) || 0;
                // IRQ tetap dihitung sebagai waktu sibuk, bukan waktu idle.
            }
            const result = cpuFromCounters(aggregate, prevOsCpu);
            prevOsCpu = result.next;
            return result.pct;
        } catch { return null; }
    }

    function ramInfoFromProc(mem) {
        const get = key => {
            const match = new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm').exec(String(mem || ''));
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

    function ramInfoFromOs() {
        try {
            const total = Number(os.totalmem()), free = Number(os.freemem());
            if (!(Number.isFinite(total) && total > 0 && Number.isFinite(free) && free >= 0)) return null;
            const used = Math.max(0, Math.min(total, total - free));
            return { total, used, pct: Math.max(0, Math.min(100, used / total * 100)) };
        } catch { return null; }
    }

    let flash = { ready: false }, flashAt = 0;
    async function flashInfo() {
        if (Date.now() - flashAt < FLASH_MS) return flash;
        try {
            const status = await storage.status();
            flash = { ready: !!status.ready, total: status.total || null, free: status.free || null, root: status.root, message: status.ready ? null : status.message };
        } catch (error) { flash = { ready: false, message: String(error && error.message || 'Storage unavailable') }; }
        flashAt = Date.now();
        return flash;
    }

    const hist = [];
    let last = { t: 0, cpu: null, ram: null };
    let lastFull = null;

    async function sample() {
        const unavailable = [];
        const proc = await readProc();
        let cpu = proc ? cpuPctFromProc(proc.stat) : null;
        let ram = proc ? ramInfoFromProc(proc.mem) : null;
        let cpuSource = cpu != null ? 'proc' : '';
        let ramSource = ram ? 'proc' : '';

        // Jangan biarkan dashboard N/A hanya karena akses /proc ditolak oleh Android.
        if (cpu == null) {
            cpu = cpuPctFromOs();
            if (cpu != null) cpuSource = 'node-os';
        }
        if (!ram) {
            ram = ramInfoFromOs();
            if (ram) ramSource = 'node-os';
        }

        if (cpu != null || ram) {
            last = { t: Date.now(), cpu: cpu == null ? last.cpu : cpu, ram: ram || last.ram };
            hist.push({ t: last.t, cpu: last.cpu, ram: last.ram ? +last.ram.pct.toFixed(1) : null });
            if (hist.length > HMAX) hist.shift();
        }
        if (last.cpu == null) unavailable.push('cpu');
        if (!last.ram) unavailable.push('ram');

        const fl = await flashInfo();
        let cores = 0, model = '';
        try {
            const cpus = os.cpus();
            cores = cpus.length;
            model = (cpus[0] && cpus[0].model) || '';
        } catch { }
        if (!cores) unavailable.push('cores');

        let load = null;
        try { const values = os.loadavg(); if (values && Number.isFinite(values[0])) load = +values[0].toFixed(2); } catch { }
        let uptime = null;
        try { const value = os.uptime(); if (Number.isFinite(value)) uptime = Math.floor(value); } catch { }

        const data = {
            t: last.t || Date.now(),
            cpu: last.cpu == null ? null : +last.cpu.toFixed(1),
            ram: last.ram && { total: last.ram.total, used: last.ram.used, pct: +last.ram.pct.toFixed(1) },
            flash: fl, cores, model, load, uptime,
            source: { cpu: cpuSource || (last.cpu != null ? 'cached' : null), ram: ramSource || (last.ram ? 'cached' : null) },
            unavailable
        };
        lastFull = data;
        try { broadcast({ type: 'SYSTEM', data }); } catch { /* client WebSocket dapat terputus */ }
        return data;
    }

    let timer = null;
    let generation = 0;
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
            if (current !== generation) return;
            timer = setTimeout(loop, POLL_MS);
        });
    }

    app.get('/api/system', (req, res) => res.json({ now: last, history: hist }));

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
        start() { stop(); loop(); },
        stop() { generation++; clearTimeout(timer); timer = null; },
        getStatus,
        history: () => hist.slice(),
        snapshot: () => lastFull
    };
};
