// Monitor CPU, RAM, dan flash disk perangkat server (HP Android).
// /proc dibaca langsung; kalau dibatasi Android, otomatis beralih lewat `su` (perangkat sudah root).
// Data dikirim ke semua klien lewat WebSocket {type:'SYSTEM'} tiap 2 detik,
// dan riwayat 90 sampel terakhir (±3 menit) tersedia di /api/system untuk menggambar diagram garis.
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const POLL_MS = +E('SYSTEM_POLL_MS', 2000);   // interval sampling CPU/RAM
const FLASH_MS = 10000;                        // cek flash disk lebih jarang (perlu su, agak berat)
const HMAX = 90;                               // jumlah sampel riwayat yang disimpan

module.exports = ({ app, broadcast }) => {
    const storage = require('./storage');
    const useSu = () => storage.MODE !== 'direct';

    // Baca /proc/stat + /proc/meminfo: langsung dulu, fallback lewat su
    async function readProc() {
        try {
            const stat = fs.readFileSync('/proc/stat', 'utf8');
            const mem = fs.readFileSync('/proc/meminfo', 'utf8');
            if (/^cpu\s/m.test(stat) && /MemTotal/.test(mem)) return { stat, mem };
            throw new Error('proc kosong');
        } catch {
            return new Promise(resolve => {
                const cmd = `head -n 8 /proc/stat; echo '==='; grep -E 'MemTotal|MemAvailable' /proc/meminfo`;
                const [bin, args] = useSu() ? [storage.SU, ['-c', cmd]] : ['sh', ['-c', cmd]];
                let out = '';
                const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
                const t = setTimeout(() => { c.kill('SIGKILL'); resolve(null); }, 8000);
                c.stdout.setEncoding('utf8');
                c.stdout.on('data', d => out += d);
                c.on('error', () => { clearTimeout(t); resolve(null); });
                c.on('close', code => {
                    clearTimeout(t);
                    if (code !== 0) return resolve(null);
                    const i = out.indexOf('\n===\n');
                    resolve(i < 0 ? null : { stat: out.slice(0, i), mem: out.slice(i + 5) });
                });
            });
        }
    }

    // Persen CPU dari selisih dua pembacaan /proc/stat (baris agregat "cpu ...")
    let prevCpu = null;
    function cpuPct(stat) {
        const m = /^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(stat);
        if (!m) return null;
        const v = m.slice(1).map(Number);
        const idle = v[3] + v[4], total = v.reduce((a, b) => a + b, 0);
        const cur = { idle, total };
        let pct = null;
        if (prevCpu && total > prevCpu.total) pct = Math.max(0, Math.min(100, (1 - (idle - prevCpu.idle) / (total - prevCpu.total)) * 100));
        prevCpu = cur;
        return pct;
    }

    function ramInfo(mem) {
        const g = k => { const m = new RegExp('^' + k + ':\\s+(\\d+) kB', 'm').exec(mem); return m ? +m[1] * 1024 : null; };
        const total = g('MemTotal'), avail = g('MemAvailable');
        if (total == null) return null;
        const used = total - (avail != null ? avail : 0);
        return { total, used, pct: Math.max(0, Math.min(100, used / total * 100)) };
    }

    let flash = { ready: false }, flashAt = 0;
    async function flashInfo() {
        if (Date.now() - flashAt < FLASH_MS) return flash;
        try {
            const s = await storage.status();
            flash = { ready: !!s.ready, total: s.total || null, free: s.free || null, root: s.root, message: s.ready ? null : s.message };
        } catch (e) { flash = { ready: false, message: e.message }; }
        flashAt = Date.now();
        return flash;
    }

    const hist = [];   // [{t, cpu, ram}]
    let last = { t: 0, cpu: null, ram: null };
    let lastFull = null;   // snapshot lengkap terakhir untuk /api/system & skill sistem

    async function sample() {
        const unavailable = [];
        const p = await readProc();
        if (p) {
            const cpu = cpuPct(p.stat), ram = ramInfo(p.mem);
            if (cpu != null || ram) {
                last = { t: Date.now(), cpu: cpu == null ? last.cpu : cpu, ram: ram || last.ram };
                hist.push({ t: last.t, cpu: last.cpu, ram: last.ram ? +last.ram.pct.toFixed(1) : null });
                if (hist.length > HMAX) hist.shift();
            }
        } else {
            unavailable.push('cpu_ram');
        }
        if (last.cpu == null) { if (!unavailable.includes('cpu')) unavailable.push('cpu'); }
        if (!last.ram) { if (!unavailable.includes('ram')) unavailable.push('ram'); }
        const fl = await flashInfo();
        let cores = 0, model = '';
        try { const c = os.cpus(); cores = c.length; model = (c[0] && c[0].model) || ''; } catch { }
        if (!cores) unavailable.push('cores');
        const data = {
            t: last.t || Date.now(), cpu: last.cpu == null ? null : +last.cpu.toFixed(1),
            ram: last.ram && { total: last.ram.total, used: last.ram.used, pct: +last.ram.pct.toFixed(1) },
            flash: fl, cores, model, load: (() => { try { return +os.loadavg()[0].toFixed(2); } catch { return null; } })(),
            uptime: Math.floor(os.uptime()), unavailable
        };
        lastFull = data;
        broadcast({ type: 'SYSTEM', data });
        return data;
    }

    let timer = null;
    function loop() { sample().catch(() => { }).finally(() => { timer = setTimeout(loop, POLL_MS); }); }

    // Sudah dilindungi login di server.js
    app.get('/api/system', (req, res) => res.json({ now: last, history: hist }));

    // Accessor untuk skill AI/diagnosis: selalu mengembalikan nilai yang benar-benar
    // dibaca. Bila sampling belum pernah berhasil, nilai null + daftar unavailable.
    async function getStatus() {
        if (lastFull && Date.now() - (lastFull.t || 0) < Math.max(3000, POLL_MS * 2)) return lastFull;
        try { return await sample(); }
        catch (e) { return lastFull || { t: Date.now(), cpu: null, ram: null, flash: { ready: false, message: e.message }, cores: 0, load: null, uptime: null, unavailable: ['cpu', 'ram', 'flash'] }; }
    }

    return {
        start() { loop(); },
        stop() { clearTimeout(timer); },
        getStatus,
        history: () => hist.slice(),
        snapshot: () => lastFull
    };
};
