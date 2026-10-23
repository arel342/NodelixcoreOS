// ============================================================================
// tests/storage-behavior.test.js — keamanan operasi file:
//   • jalur relatif tidak bisa keluar dari root (termasuk lewat symlink)
//   • file rahasia (.env/private key) & biner tidak bisa dibaca sebagai teks
//   • overwrite tidak pernah diam-diam
//   • pembuatan folder bertingkat
// Memakai folder sementara; tidak menyentuh flash disk sungguhan.
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-storage-'));
process.env.STORAGE_DEVICE = base;
process.env.STORAGE_FOLDER = 'root';
process.env.STORAGE_MODE = 'direct';
process.env.LANGUAGE = 'id';

const rootDir = path.join(base, 'root');
fs.mkdirSync(rootDir, { recursive: true });

const storage = require(path.join(path.resolve(__dirname, '..'), 'storage'));

test('storage: status melaporkan folder siap', async () => {
    const st = await storage.status();
    assert.equal(st.ready, true, st.message);
    assert.equal(st.mode, 'direct');
    assert.equal(fs.realpathSync(st.root), fs.realpathSync(rootDir));
});

test('storage: folder bertingkat dibuat, lalu terbaca', async () => {
    await storage.mkdirPath('Dokumen/2026');
    const info = await storage.checked('Dokumen/2026');
    assert.equal(info.isDirectory, true);
    assert.ok(fs.existsSync(path.join(rootDir, 'Dokumen', '2026')));
});

test('storage: menolak .env dan file kunci privat', async () => {
    // Isi tidak penting: yang diuji adalah penolakan nama berkas .env.
    fs.writeFileSync(path.join(rootDir, '.env'), 'dummy\n');
    fs.writeFileSync(path.join(rootDir, 'server.pem'), 'PRIVATE KEY\n');
    await assert.rejects(() => storage.readTextFile('.env'), e => e.status === 403);
    await assert.rejects(() => storage.readTextFile('server.pem'), e => e.status === 403);
});

test('storage: file biner ditolak, teks biasa terbaca', async () => {
    fs.writeFileSync(path.join(rootDir, 'catatan.txt'), 'halo dunia\n');
    fs.writeFileSync(path.join(rootDir, 'data.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const ok = await storage.readTextFile('catatan.txt');
    assert.equal(ok.text, 'halo dunia\n');
    await assert.rejects(() => storage.readTextFile('data.bin'), e => e.status === 415);
});

test('storage: symlink ke luar root ditolak untuk baca & salin', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'rahasia di luar root\n');
    try {
        fs.symlinkSync(outside, path.join(rootDir, 'escape'), 'dir');
    } catch (e) {
        // Lingkungan tanpa izin symlink: lewati dengan bukti yang jelas.
        assert.ok(/EPERM|EACCES|ENOSYS/.test(e.code || ''), e.message);
        return;
    }
    await assert.rejects(() => storage.checked('escape/secret.txt'), e => e.status === 403);
    await assert.rejects(() => storage.readTextFile('escape/secret.txt'), e => e.status === 403);
    await assert.rejects(() => storage.copyPath('escape/secret.txt', 'salinan.txt'), e => e.status === 403);
    assert.equal(fs.existsSync(path.join(rootDir, 'salinan.txt')), false);
});

test('storage: copy/move tidak menimpa tujuan yang sudah ada', async () => {
    fs.writeFileSync(path.join(rootDir, 'a.txt'), 'A');
    fs.writeFileSync(path.join(rootDir, 'b.txt'), 'B');
    await assert.rejects(() => storage.copyPath('a.txt', 'b.txt'), e => e.code === 'PATH_EXISTS');
    await assert.rejects(() => storage.movePath('a.txt', 'b.txt'), e => e.code === 'PATH_EXISTS');
    assert.equal(fs.readFileSync(path.join(rootDir, 'b.txt'), 'utf8'), 'B');
    assert.equal(fs.readFileSync(path.join(rootDir, 'a.txt'), 'utf8'), 'A');
});

test('storage: pencarian dibatasi dan mengembalikan jalur relatif', async () => {
    fs.mkdirSync(path.join(rootDir, 'Cari'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'Cari', 'laporan-2026.txt'), 'isi');
    const r = await storage.search('Cari', { name: 'laporan', maxDepth: 2, limit: 10 });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].path, 'Cari/laporan-2026.txt');
    assert.equal(r.hasMore, false);
});
