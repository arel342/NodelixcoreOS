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
        // Hanya kunci "AQ.Baik" yang diterima; kunci lain menjawab 403 seperti Google.
        if (!url.includes('key=AQ.Baik')) return { ok: false, status: 403, json: async () => ({ error: { message: 'API key not valid' } }) };
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
    const { ai, calls } = loadAi({ GEMINI_API_KEY: 'AQ.Lama', GEMINI_MODEL: 'gemini-1.5-flash' });
    const reply = await ai.testKey({ apiKey: 'AQ.Baik', model: 'gemini-3.5-flash-lite' });
    assert.equal(reply, 'OK');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /models\/gemini-3\.5-flash-lite:generateContent/);
    assert.match(calls[0].url, /key=AQ.Baik/);
    assert.doesNotMatch(calls[0].url, /AQ.Lama/, 'kunci lama tidak boleh ikut terkirim');
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
    await assert.rejects(() => ai.testKey({ apiKey: 'AQ.Salah123', model: 'gemini-3.5-flash-lite' }), e => {
        assert.match(e.message, /API key not valid/);
        assert.match(e.message, /gemini-3\.5-flash-lite/);
        return true;
    });
});

test('ai: POST /api/ai/test -> 200 dengan jawaban, 400 saat kunci kosong', async () => {
    const ok = loadAi({});
    const r1 = await ok.post('/api/ai/test', { apiKey: 'AQ.Baik', model: 'gemini-3.5-flash-lite' });
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
    assert.equal(e.model, 'gemini-3.5-flash-lite');
    assert.equal(e.skills.length, empty.ai.skills.length, 'daftar skill dipakai halaman untuk menampilkan kemampuan');

    const filled = loadAi({ GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'gemini-3.5-flash-lite' });
    const b = await filled.get('/api/ai/status').then(r => r.body);
    assert.equal(b.hasKey, true);
    assert.equal(b.ready, true);
    assert.equal(b.model, 'gemini-3.5-flash-lite');

    // Perilaku baru (lihat README > AI Agent): model yang diketik pengguna TIDAK
    // diganti diam-diam. Status melaporkan persis apa yang tersimpan; bila model itu
    // sudah pensiun, daftar cadangan (GEMINI_FALLBACK_MODELS) yang dipakai dan
    // pengguna melihatnya di jawaban/status.
    const legacy = loadAi({ GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'gemini-1.5-flash' });
    const l = await legacy.get('/api/ai/status').then(r => r.body);
    assert.equal(l.model, 'gemini-1.5-flash', 'model pengguna tidak boleh diubah otomatis');
    assert.equal(l.fallbackEnabled, true);
    assert.ok(l.fallbackModels.length > 0, 'cadangan tetap tersedia saat model utama ditolak');
});

test('ai: fallback otomatis ke gemini-3.1-flash-lite saat model utama gagal (404)', async () => {
    const calls = [];
    const context = {
        module: { exports: {} }, __dirname: root, console,
        require: n => require(require.resolve(n, { paths: [root] })),
        process: { env: { LANGUAGE: 'id', GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'gemini-3.5-flash-lite' }, uptime: () => 1 },
        fetch: async url => {
            calls.push(url);
            if (url.includes('models/gemini-3.5-flash-lite:')) {
                return { ok: false, status: 404, json: async () => ({ error: { message: 'Model not found' } }) };
            }
            return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Jawaban fallback' }] } }] }) };
        },
        AbortSignal, setTimeout, clearTimeout
    };
    vm.runInNewContext(source('ai.js'), context);
    const ai = context.module.exports({});
    const reply = await ai.handleMessage('cek status', 'chat-fallback');
    assert.equal(reply, 'Jawaban fallback');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /models\/gemini-3\.5-flash-lite:generateContent/);
    assert.match(calls[1], /models\/gemini-3\.1-flash-lite:generateContent/);
});

test('ai: model pengguna di .env tidak diganti otomatis (hanya awalan models/ dibuang)', async () => {
    for (const user of ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.1-flash-lite']) {
        const { ai } = loadAi({ GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: user });
        assert.equal(ai.cfg().model, user, user + ' harus dipertahankan apa adanya');
    }
    const prefixed = loadAi({ GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'models/gemini-3.1-flash-lite' });
    assert.equal(prefixed.ai.cfg().model, 'gemini-3.1-flash-lite', 'awalan models/ dinormalkan tanpa mengganti model');
});

test('ai: saran model di pesan error Google hanya dipakai bila diaktifkan', async () => {
    const calls = [];
    const context = {
        module: { exports: {} }, __dirname: root, console,
        require: n => require(require.resolve(n, { paths: [root] })),
        process: { env: { LANGUAGE: 'id', GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'gemini-3.5-flash-lite', GEMINI_HONOR_MODEL_SUGGESTION: 'true' }, uptime: () => 1 },
        fetch: async url => {
            calls.push(url);
            if (url.includes('models/gemini-3.5-flash-lite:')) {
                return { ok: false, status: 404, json: async () => ({ error: { message: 'This model models/gemini-3.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-9-test for the latest features.' } }) };
            }
            return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Dari saran' }] } }] }) };
        },
        AbortSignal, setTimeout, clearTimeout
    };
    vm.runInNewContext(source('ai.js'), context);
    const ai = context.module.exports({});
    const reply = await ai.handleMessage('halo', 'chat-suggest');
    assert.equal(reply, 'Dari saran');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /models\/gemini-9-test:generateContent/, 'saran Google dicoba sebelum cadangan');

    // Default: saran TIDAK dipakai, supaya model/tier biaya tidak berpindah diam-diam.
    const calls2 = [];
    const ctx2 = {
        module: { exports: {} }, __dirname: root, console,
        require: n => require(require.resolve(n, { paths: [root] })),
        process: { env: { LANGUAGE: 'id', GEMINI_API_KEY: 'AQ.Baik', GEMINI_MODEL: 'gemini-3.5-flash-lite' }, uptime: () => 1 },
        fetch: async url => {
            calls2.push(url);
            if (url.includes('models/gemini-3.5-flash-lite:')) {
                return { ok: false, status: 404, json: async () => ({ error: { message: 'This model models/gemini-3.5-flash-lite is no longer available. Please use models/gemini-9-test.' } }) };
            }
            return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Dari cadangan' }] } }] }) };
        },
        AbortSignal, setTimeout, clearTimeout
    };
    vm.runInNewContext(source('ai.js'), ctx2);
    const ai2 = ctx2.module.exports({});
    assert.equal(await ai2.handleMessage('halo', 'chat-suggest-2'), 'Dari cadangan');
    assert.equal(calls2.length, 2);
    assert.match(calls2[1], /models\/gemini-3\.1-flash-lite:generateContent/, 'tanpa izin, yang dipakai adalah daftar cadangan');
    assert.doesNotMatch(calls2[1], /gemini-9-test/);
});

test('ai: skill kirim file meneruskan jalur/caption ke bot dan hanya memakai chat aktif', async () => {
    const { ai } = loadAi({});
    const sent = [];
    ai.setTelegram({ sendFile: async (...args) => { sent.push(args); return { ok: true }; } });
    const result = await ai.executeTool('send_file_telegram', { file_path: 'Dokumen/laporan.pdf', caption: 'Laporan' }, '12345');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(sent, [['Dokumen/laporan.pdf', '12345', 'Laporan']]);
});

test('ai: handleMessage tanpa kunci mengarahkan ke setup awal, bukan error jaringan', async () => {
    const { ai } = loadAi({});
    const text = await ai.handleMessage('halo', 'chat-1');
    assert.match(text, /GEMINI_API_KEY belum diisi/);
    assert.match(text, /setup awal/i);
});
