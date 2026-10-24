// HTTP sungguhan, byte biner sungguhan; su diganti sh agar bisa diuji tanpa Android.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-media-'));
const root = path.join(base, 'upload');
fs.mkdirSync(root);
process.env.STORAGE_DEVICE = base;
process.env.STORAGE_FOLDER = 'upload';
process.env.STORAGE_MODE = 'root';
process.env.SU_BIN = '/bin/sh';
const storage = require('../storage');
const bytes = Buffer.alloc(3 * 65536 + 71);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
fs.writeFileSync(path.join(root, 'video.mp4'), bytes);
fs.writeFileSync(path.join(root, 'empty.mp4'), '');
fs.writeFileSync(path.join(root, 'page.html'), '<h1>test</h1>');
fs.writeFileSync(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
const special = "Foto #50% '中文😀.JPG";
fs.mkdirSync(path.join(root, 'Folder foto'));
fs.writeFileSync(path.join(root, 'Folder foto', special), bytes.subarray(0, 31));
let server, url;
before(async () => {
    const app = express();
    app.get('/file', async (req, res) => {
        try { await storage.send(res, req.query.path || 'video.mp4', { inline: req.query.download !== '1', zip: req.query.zip === '1', req }); }
        catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}/file`;
});
after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
});
const body = async res => Buffer.from(await res.arrayBuffer());

test('media: GET mengirim byte asli, MIME inline, dan dukungan seek', async () => {
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('content-disposition'), 'inline');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-length'), String(bytes.length));
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await body(r), bytes);
});

test('media: range tertutup, melintasi blok, terbuka, suffix, dan ujung file akurat', async () => {
    for (const [range, start, end] of [
        ['bytes=0-0', 0, 0], ['bytes=65530-65545', 65530, 65545],
        ['bytes=131072-131120', 131072, 131120], ['bytes=70001-', 70001, bytes.length - 1],
        ['bytes=-25', bytes.length - 25, bytes.length - 1],
        ['bytes=196600-99999999999999999999999', 196600, bytes.length - 1],
        ['bytes=-99999999999999999999999', 0, bytes.length - 1]
    ]) {
        const r = await fetch(url, { headers: { range } });
        assert.equal(r.status, 206, range);
        assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
        assert.equal(r.headers.get('content-length'), String(end - start + 1));
        assert.deepEqual(await body(r), bytes.subarray(start, end + 1), range);
    }
});

test('media: range di luar file/rusak ditolak 416 tanpa body', async () => {
    for (const range of [`bytes=${bytes.length}-`, 'bytes=5-2', 'bytes=-0', 'bytes=abc', 'bytes=-', 'bytes=999999999999999999999-']) {
        const r = await fetch(url, { headers: { range } });
        assert.equal(r.status, 416, range);
        assert.equal(r.headers.get('content-range'), `bytes */${bytes.length}`);
        assert.equal((await body(r)).length, 0);
    }
});

test('media: multi-range/unit lain diabaikan; HEAD tidak mengirim isi', async () => {
    for (const range of ['bytes=0-1,10-11', 'items=0-5']) {
        const r = await fetch(url, { headers: { range } });
        assert.equal(r.status, 200);
        assert.deepEqual(await body(r), bytes);
    }
    const r = await fetch(url, { method: 'HEAD', headers: { range: 'bytes=0-1' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), String(bytes.length));
    assert.equal((await body(r)).length, 0);
});

test('media: If-Range memakai Last-Modified, data berubah dikirim penuh', async () => {
    const h = await fetch(url, { method: 'HEAD' });
    const modified = h.headers.get('last-modified');
    const same = await fetch(url, { headers: { range: 'bytes=10-19', 'if-range': modified } });
    assert.equal(same.status, 206);
    assert.deepEqual(await body(same), bytes.subarray(10, 20));
    const stale = await fetch(url, { headers: { range: 'bytes=10-19', 'if-range': 'Mon, 01 Jan 1990 00:00:00 GMT' } });
    assert.equal(stale.status, 200);
    assert.deepEqual(await body(stale), bytes);
});

test('media: file kosong, subfolder, unicode, spasi, %, # dan kutip tetap aman', async () => {
    const empty = await fetch(url + '?path=empty.mp4');
    assert.equal(empty.status, 200);
    assert.equal((await body(empty)).length, 0);
    const invalid = await fetch(url + '?path=empty.mp4', { headers: { range: 'bytes=0-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */0');
    await invalid.arrayBuffer();
    const photo = await fetch(url + '?path=' + encodeURIComponent('Folder foto/' + special));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(await body(photo), bytes.subarray(0, 31));
});

test('media: download tetap attachment; HTML/SVG tidak dijalankan inline', async () => {
    const dl = await fetch(url + '?download=1');
    assert.match(dl.headers.get('content-disposition'), /^attachment;/);
    assert.deepEqual(await body(dl), bytes);
    for (const file of ['page.html', 'icon.svg']) {
        const r = await fetch(url + '?path=' + file);
        assert.match(r.headers.get('content-disposition'), /^attachment;/);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        await r.arrayBuffer();
    }
});

test('media: symlink keluar root dan file hilang ditolak sebelum streaming', async () => {
    fs.symlinkSync(path.join(base, 'outside.mp4'), path.join(root, 'escape.mp4'));
    fs.writeFileSync(path.join(base, 'outside.mp4'), 'outside');
    const denied = await fetch(url + '?path=escape.mp4', { headers: { range: 'bytes=0-2' } });
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();
    const missing = await fetch(url + '?path=missing.mp4');
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
});

test('media: seek file di atas 4 GiB tidak membaca seluruh file', { timeout: 5000 }, async () => {
    const size = 5 * 1024 ** 3 + 31, tail = Buffer.from('akhir video besar');
    const fd = fs.openSync(path.join(root, 'large.mp4'), 'w');
    try { fs.ftruncateSync(fd, size); fs.writeSync(fd, tail, 0, tail.length, size - tail.length); }
    finally { fs.closeSync(fd); }
    const r = await fetch(url + '?path=large.mp4', { headers: { range: `bytes=-${tail.length}` } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${size - tail.length}-${size - 1}/${size}`);
    assert.deepEqual(await body(r), tail);
});

test('media: Download ZIP tetap berisi arsip ZIP', async () => {
    const r = await fetch(url + '?download=1&zip=1', { headers: { range: 'bytes=0-3' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /video\.mp4\.zip/);
    assert.equal(r.headers.get('accept-ranges'), 'none');
    const zip = await body(r);
    assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
});
