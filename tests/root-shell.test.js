'use strict';
// Uji shell root persisten (root-shell.js) dengan "su" palsu berbasis /bin/sh.
// Mensimulasikan Magisk/KernelSU di Android 13: su dibuka sekali, dialog izin root
// (jeda sebelum shell siap), dan su yang hanya mendukung `su -c`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createRootShell } = require('../root-shell');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndlx-su-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fakeSu(name, body) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
    return file;
}
const countingSpawn = () => {
    const calls = [];
    const fn = (bin, args, opts) => { calls.push(args); return spawn(bin, args, opts); };
    fn.calls = calls;
    return fn;
};
const waitFor = async (cond, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); }
    return false;
};

test('shell persisten: su hanya dibuka SATU kali untuk banyak perintah', async () => {
    const bin = fakeSu('su-persistent', 'if [ "$1" = "-c" ]; then exec /bin/sh -c "$2"; fi\nexec /bin/sh');
    const sp = countingSpawn();
    const sh = createRootShell({ bin, spawn: sp });
    try {
        assert.strictEqual(await sh.exec('echo hai'), null, 'belum siap -> null, tidak menunggu');
        assert.ok(await waitFor(() => sh.ready()), 'shell siap');
        for (let i = 0; i < 20; i++) {
            const out = await sh.exec(`echo baris-${i}; grep '^cpu ' /proc/stat`);
            assert.match(out, new RegExp(`^baris-${i}\\ncpu `));
        }
        assert.strictEqual(sp.calls.length, 1, 'hanya satu proses su');
        assert.deepStrictEqual(sp.calls[0], []);
        assert.strictEqual(await sh.exec('exit_code_test() { return 3; }; exit_code_test'), null, 'exit code != 0 -> null');
        assert.strictEqual(await sh.exec('echo masih-hidup'), 'masih-hidup', 'shell tetap hidup setelah perintah gagal');
        // Perintah paralel diantrekan berurutan, tidak tercampur.
        const outs = await Promise.all([1, 2, 3, 4, 5].map(n => sh.exec(`echo n${n}`)));
        assert.deepStrictEqual(outs, ['n1', 'n2', 'n3', 'n4', 'n5']);
    } finally { sh.close(); }
});

test('dialog izin root (shell lambat siap) tidak memblokir pemanggil', async () => {
    const bin = fakeSu('su-slow', 'sleep 1\nexec /bin/sh');
    const sh = createRootShell({ bin });
    try {
        const t0 = Date.now();
        assert.strictEqual(await sh.exec('echo x'), null);
        assert.ok(Date.now() - t0 < 200, 'langsung kembali');
        assert.strictEqual(sh.ready(), false);
        assert.ok(await waitFor(() => sh.ready(), 5000), 'siap setelah izin diberikan');
        assert.strictEqual(await sh.exec('echo ok'), 'ok');
    } finally { sh.close(); }
});

test('su yang hanya mendukung `su -c` beralih otomatis ke mode sekali-jalan', async () => {
    const bin = fakeSu('su-oneshot', 'if [ "$1" = "-c" ]; then exec /bin/sh -c "$2"; fi\nexit 1');
    const sh = createRootShell({ bin, persistentFailMax: 2 });
    try {
        for (let i = 0; i < 2; i++) { sh.exec('echo x'); await waitFor(() => sh.mode() === 'dead' || sh.mode() === 'oneshot', 3000); await new Promise(r => setTimeout(r, 1100)); }
        assert.ok(await waitFor(() => sh.mode() === 'oneshot', 3000), 'mode: ' + sh.mode());
        assert.strictEqual(await sh.exec('echo lewat-c'), 'lewat-c');
        assert.strictEqual(sh.ready(), true);
    } finally { sh.close(); }
});

test('perintah yang macet di-timeout lalu shell dibuat ulang', async () => {
    const bin = fakeSu('su-timeout', 'exec /bin/sh');
    const sh = createRootShell({ bin });
    try {
        sh.exec('true');
        assert.ok(await waitFor(() => sh.ready()));
        const pid = sh._pid();
        assert.strictEqual(await sh.exec('sleep 5', { timeoutMs: 300 }), null);
        assert.strictEqual(sh.ready(), false);
        await new Promise(r => setTimeout(r, 1100));
        sh.exec('true');
        assert.ok(await waitFor(() => sh.ready()), 'shell dibuat ulang');
        assert.notStrictEqual(sh._pid(), pid);
        assert.strictEqual(await sh.exec('echo baru'), 'baru');
    } finally { sh.close(); }
});

test('close() mematikan proses su', async () => {
    const bin = fakeSu('su-close', 'exec /bin/sh');
    const sh = createRootShell({ bin });
    sh.exec('true');
    assert.ok(await waitFor(() => sh.ready()));
    const pid = sh._pid();
    sh.close();
    assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000), 'proses su berhenti');
    assert.strictEqual(await sh.exec('echo x'), null);
});
