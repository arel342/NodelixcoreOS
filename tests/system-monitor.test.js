'use strict';
// Uji monitor CPU/RAM: memastikan start() tidak melempar error, parser /proc benar,
// fallback su/os berjalan, dan data SYSTEM benar-benar dikirim ke dashboard.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const systemFactory = require('../system');
const { parseCpuCounters, cpuFromCounters, parseRam, splitSuOutput } = systemFactory._internal;

const STAT1 = 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\nintr 1\n';
const STAT2 = 'cpu  150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0\ncpu1 75 0 75 450 0 0 0 0 0 0\nintr 1\n';
const MEM = 'MemTotal:        4000000 kB\nMemFree:          500000 kB\nMemAvailable:    1000000 kB\nBuffers:           10000 kB\nCached:           200000 kB\n';

const fakeStorage = (mode = 'direct') => ({ MODE: mode, SU: 'su', status: async () => ({ ready: true, total: 1000, free: 400, root: '/x' }) });
const fakeApp = () => { const routes = {}; return { routes, get(p, h) { routes[p] = h; } }; };

test('parser /proc/stat membaca baris cpu agregat', () => {
    assert.deepStrictEqual(parseCpuCounters(STAT1), [100, 0, 100, 800, 0, 0, 0, 0]);
    assert.strictEqual(parseCpuCounters('intr 1\n'), null);
    const a = cpuFromCounters(parseCpuCounters(STAT1), null);
    assert.strictEqual(a.pct, null);
    const b = cpuFromCounters(parseCpuCounters(STAT2), a.next);
    // delta total 200, delta idle 100 -> 50%
    assert.strictEqual(b.pct, 50);
});

test('parser /proc/meminfo memakai MemAvailable', () => {
    const r = parseRam(MEM);
    assert.strictEqual(r.total, 4000000 * 1024);
    assert.strictEqual(r.used, 3000000 * 1024);
    assert.strictEqual(r.pct, 75);
    assert.strictEqual(parseRam('junk'), null);
});

test('pemisah keluaran su memakai baris === yang benar', () => {
    const r = splitSuOutput(STAT1 + '===\n' + MEM);
    assert.ok(r);
    assert.match(r.stat, /^cpu\s/m);
    assert.match(r.mem, /^MemTotal:/m);
    assert.strictEqual(splitSuOutput('tanpa penanda'), null);
});

test('start() tidak melempar error dan menyiarkan CPU + RAM nyata', async () => {
    const msgs = [];
    const mon = systemFactory({ app: fakeApp(), broadcast: m => msgs.push(m), storage: fakeStorage() });
    assert.doesNotThrow(() => mon.start());
    try {
        for (let i = 0; i < 50 && !msgs.length; i++) await new Promise(r => setTimeout(r, 50));
        assert.ok(msgs.length, 'pesan SYSTEM harus terkirim');
        const d = msgs[0].data;
        assert.strictEqual(msgs[0].type, 'SYSTEM');
        assert.strictEqual(typeof d.cpu, 'number', 'CPU tidak boleh null pada sampel pertama');
        assert.ok(d.cpu >= 0 && d.cpu <= 100);
        assert.ok(d.ram && d.ram.total > 0 && d.ram.pct >= 0 && d.ram.pct <= 100);
        assert.ok(d.cores > 0);
        assert.deepStrictEqual(d.unavailable, []);
        assert.ok(mon.isRunning());
    } finally { mon.stop(); }
    assert.strictEqual(mon.isRunning(), false);
});

test('fallback su dipakai jika /proc langsung ditolak (Android)', async () => {
    let suCalls = 0;
    const seq = [STAT1, STAT2];
    const mon = systemFactory({
        app: fakeApp(), broadcast() { }, storage: fakeStorage('root'),
        readFile() { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
        runSu: async cmd => { assert.match(cmd, /\/proc\/stat/); return seq[Math.min(suCalls++, 1)] + '===\n' + MEM; }
    });
    const d = await mon.getStatus();
    assert.ok(suCalls >= 2);
    assert.strictEqual(d.source.cpu, 'proc');
    assert.strictEqual(d.cpu, 50);
    assert.strictEqual(d.source.ram, 'proc');
    assert.strictEqual(d.ram.pct, 75);
});

test('fallback os Node.js jika /proc dan su tidak tersedia', async () => {
    const mon = systemFactory({
        app: fakeApp(), broadcast() { }, storage: fakeStorage('root'),
        readFile() { throw new Error('EACCES'); },
        runSu: async () => null
    });
    const d = await mon.getStatus();
    assert.strictEqual(d.source.ram, 'node-os');
    assert.ok(d.ram.total > 0);
    if (os.cpus().length) {
        assert.strictEqual(d.source.cpu, 'node-os');
        assert.strictEqual(typeof d.cpu, 'number');
    }
});

test('flash disk lambat tidak memblokir CPU/RAM', async () => {
    const slow = { MODE: 'direct', SU: 'su', status: () => new Promise(() => { }) };
    const mon = systemFactory({ app: fakeApp(), broadcast() { }, storage: slow });
    const started = Date.now();
    const d = await mon.getStatus();
    assert.ok(Date.now() - started < 3000);
    assert.strictEqual(typeof d.cpu, 'number');
    assert.ok(d.ram);
});

test('/api/system mengembalikan snapshot dan riwayat', async () => {
    const app = fakeApp();
    const mon = systemFactory({ app, broadcast() { }, storage: fakeStorage() });
    await mon.sample();
    let body;
    app.routes['/api/system']({}, { json: b => { body = b; } });
    assert.ok(body.snapshot && typeof body.snapshot.cpu === 'number');
    assert.ok(Array.isArray(body.history) && body.history.length === 1);
    assert.strictEqual(typeof body.history[0].cpu, 'number');
});

test('simulasi Android 13 + root: /proc/stat EACCES, os.cpus() kosong -> CPU via shell su persisten', async () => {
    const fs = require('fs'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndlx-android-'));
    const countFile = path.join(dir, 'su-calls');
    const su = path.join(dir, 'su');
    // "su" palsu: mencatat tiap pemanggilan, lalu menjadi shell (seperti Magisk).
    fs.writeFileSync(su, `#!/bin/sh\necho x >> '${countFile}'\nif [ "$1" = "-c" ]; then exec /bin/sh -c "$2"; fi\nexec /bin/sh\n`, { mode: 0o755 });
    const realCpus = os.cpus;
    os.cpus = () => [];                       // perilaku Node di Termux Android 8+
    const msgs = [];
    const mon = systemFactory({
        app: fakeApp(), broadcast: m => msgs.push(m.data),
        storage: { MODE: 'root', SU: su, status: async () => ({ ready: true, total: 1000, free: 500, root: '/x' }) },
        readFile(p) {
            if (p === '/proc/stat') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
            return fs.readFileSync(p, 'utf8');
        }
    });
    try {
        mon.start();
        const ok = await (async () => {
            for (let i = 0; i < 100; i++) {
                if (msgs.some(d => d.source.cpu === 'proc' && typeof d.cpu === 'number')) return true;
                await new Promise(r => setTimeout(r, 100));
            }
            return false;
        })();
        assert.ok(ok, 'CPU harus terbaca lewat root: ' + JSON.stringify(msgs.slice(-1)));
        const d = msgs.filter(m => m.source.cpu === 'proc').pop();
        assert.ok(d.cpu >= 0 && d.cpu <= 100);
        assert.ok(d.cores > 0, 'jumlah core dihitung dari /proc/stat walau os.cpus() kosong');
        assert.ok(d.ram && d.ram.total > 0);
        assert.deepStrictEqual(d.unavailable, []);
        // Tunggu beberapa siklus lagi: su TIDAK boleh dibuka ulang tiap sampel.
        await new Promise(r => setTimeout(r, 2500));
        const calls = fs.readFileSync(countFile, 'utf8').trim().split('\n').length;
        assert.strictEqual(calls, 1, 'su dibuka ' + calls + ' kali');
    } finally {
        mon.stop();
        os.cpus = realCpus;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
