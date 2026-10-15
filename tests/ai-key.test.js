// Isolated tests untuk jalur kunci API Gemini di ai.js: uji kunci (testKey) dan route
// /api/ai/test. Tanpa jaringan: fetch dipalsukan, jadi URL + model + kunci yang dipakai
// yang diperiksa. Kunci yang belum diisi harus menghasilkan 400 (bukan 502) supaya
// halaman setup awal dan tab Pengaturan bisa memberi tahu pengguna cara mengisinya.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

const response = () => ({ code: 200, body: null, status(n) { this.code = n; return this; }, json(j) { this.body = j; return this; } });

function loadAi(env = {}, reply = 'OK') {
    const routes = {}, calls = [];
    const app = { get: (u, f) => { routes['GET ' + u] = f; }, post: (u, f) => { routes['POST ' + u] = f; } };
    const fetchImpl = async (url, opt) => {
        calls.push({ url, opt });
        // Hanya kunci "AIzaBaik" yang diterima; kunci lain menjawab 403 seperti Google.
        if (!url.includes('key=AIzaBaik')) return { ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) };
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: reply }] } }] }) };
    };
    const context = {
        module: { exports: {} }, __dirname: root, console,
        require: n => require(require.resolve(n, { paths: [root] })),
        process: { env: { LANGUAGE: 'id', ...env }, uptime: () => 1 },
        fetch: fetchImpl, AbortSignal, setTimeout, clearTimeout
    };
    vm.runInNewContext(source('ai.js'), context);
    const ai = context.module.exports({ app });
    const ctx = { ai, routes, calls };
    ctx.post = async (url, body) => { const res = response(); await routes['POST ' + url]({ body: body || {}, ip: '127.0.0.1' }, res); return res; };
    ctx.get = async url => { const res = response(); await routes['GET ' + url]({}, res); return res; };
    return ctx;
}

test('ai: testKey memakai kunci dan model yang dikirim, bukan yang tersimpan', async () => {
    const { ai, calls } = loadAi({ GEMINI_API_KEY: 'AIzaLama', GEMINI_MODEL: 'gemini-1.5-flash' });
    const reply = await ai.testKey({ apiKey: 'AIzaBaik', model: 'gemini-2.5-flash' });
    assert.equal(reply, 'OK');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /models\/gemini-2\.5-flash:generateContent/);
    assert.match(calls[0].url, /key=AIzaBaik/);
    assert.doesNotMatch(calls[0].url, /AIzaLama/, 'kunci lama tidak boleh ikut terkirim');
});

test('ai: testKey tanpa kunci menolak dengan status 400 + petunjuk isi di setup', async () => {
    const { ai } = loadAi({});
    await assert.rejects(() => ai.testKey({}), e => {
        assert.equal(e.status, 400);
        assert.match(e.message, /GEMINI_API_KEY belum diisi/);
        assert.match(e.message, /setup/i);
        assert.match(e.message, /aistudio\.google\.com/);
        return true;
    });
});

test('ai: error dari Gemini diteruskan beserta model yang dicoba', async () => {
    const { ai } = loadAi({}, 'OK');
    await assert.rejects(() => ai.testKey({ apiKey: 'AIzaSalah123', model: 'gemini-2.5-flash' }), e => {
        assert.match(e.message, /API key not valid/);
        assert.match(e.message, /gemini-2\.5-flash/);
        return true;
    });
});

test('ai: POST /api/ai/test -> 200 dengan jawaban, 400 saat kunci kosong', async () => {
    const ok = loadAi({});
    const r1 = await ok.post('/api/ai/test', { apiKey: 'AIzaBaik', model: 'gemini-2.5-flash' });
    assert.equal(r1.code, 200);
    assert.equal(r1.body.reply, 'OK');

    const nope = loadAi({});
    const r2 = await nope.post('/api/ai/test', {});
    assert.equal(r2.code, 400, 'belum ada kunci = salah pakai (400), bukan gangguan jaringan (502)');
    assert.equal(r2.body.success, false);
});

test('ai: GET /api/ai/status melaporkan hasKey/ready untuk halaman setup dan Pengaturan', async () => {
    const empty = loadAi({});
    const e = await empty.get('/api/ai/status').then(r => r.body);
    assert.equal(e.enabled, true);
    assert.equal(e.hasKey, false);
    assert.equal(e.ready, false);
    assert.equal(e.model, 'gemini-1.5-flash');
    assert.equal(e.skills.length, empty.ai.skills.length, 'daftar skill dipakai halaman untuk menampilkan kemampuan');

    const filled = loadAi({ GEMINI_API_KEY: 'AIzaBaik', GEMINI_MODEL: 'gemini-2.5-flash' });
    const b = await filled.get('/api/ai/status').then(r => r.body);
    assert.equal(b.hasKey, true);
    assert.equal(b.ready, true);
    assert.equal(b.model, 'gemini-2.5-flash');
});

test('ai: handleMessage tanpa kunci mengarahkan ke setup awal, bukan error jaringan', async () => {
    const { ai } = loadAi({});
    const text = await ai.handleMessage('halo', 'chat-1');
    assert.match(text, /GEMINI_API_KEY belum diisi/);
    assert.match(text, /setup awal/i);
});
