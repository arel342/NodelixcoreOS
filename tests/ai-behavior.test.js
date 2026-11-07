// ============================================================================
// tests/ai-behavior.test.js — perilaku AI dengan Gemini PALSU (tanpa jaringan):
//   • shell diblokir saat terminal nonaktif, tanpa memanggil executor
//   • parameter salah (state:"false", approved:true) tidak berefek samping
//   • model tidak bisa menyetujui sendiri; konfirmasi terikat sesi & sekali pakai
//   • panggilan tool ganda dalam satu giliran hanya dijalankan sekali
//   • retry model setelah error tidak mengulang tindakan perangkat
//   • riwayat web/Telegram terisolasi, hasil tool bisa dipakai di giliran berikut
//   • batas putaran tetap berlaku dan pesannya jelas
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const createAi = require(path.join(root, 'ai'));
const createConfirm = require(path.join(root, 'confirm'));

const ENV_BASE = {
    LANGUAGE: 'id',
    GEMINI_API_KEY: 'AQ.TestKey123',
    GEMINI_MODEL: 'gemini-3.5-flash-lite',
    GEMINI_FALLBACK_ENABLED: 'false',
    GEMINI_FALLBACK_MODELS: 'gemini-3.1-flash-lite',
    GEMINI_RETRY_MAX: '0',
    GEMINI_RETRY_DELAY_MS: '50',
    GEMINI_TIMEOUT_S: '10',
    AI_HISTORY_PERSIST: 'false',
    AUDIT_LOG_ENABLED: 'false',
    AI_MAX_ROUNDS: '6',
    AI_MAX_TOOL_CALLS: '8',
    TERMINAL_ENABLED: 'true',
    DOOR_IP: '10.0.0.9',
    SCHEDULE_TZ: 'Asia/Jakarta'
};
const MANAGED = k => k.startsWith('GEMINI_') || k.startsWith('AI_') || k === 'TERMINAL_ENABLED' || k === 'AUDIT_LOG_ENABLED' || k === 'DOOR_IP';

function setEnv(extra = {}) {
    for (const k of Object.keys(process.env)) if (MANAGED(k)) delete process.env[k];
    Object.assign(process.env, ENV_BASE, extra);
}

const textRes = text => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const callRes = (name, args) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] }) });
const errRes = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });

function mockGemini(steps) {
    const reqs = [];
    global.fetch = async (url, opt) => {
        assert.match(String(url), /generativelanguage\.googleapis\.com/, 'hanya Gemini yang boleh dipanggil di tes ini');
        reqs.push(JSON.parse((opt && opt.body) || '{}'));
        const step = steps[Math.min(reqs.length - 1, steps.length - 1)];
        return typeof step === 'function' ? step(url, opt) : step;
    };
    return reqs;
}

function makeHarness({ terminalEnabled = true, telegram = null } = {}) {
    const calls = { relay: [], doorOpen: 0, doorEnabled: [], enroll: 0, exec: 0 };
    const confirm = createConfirm({
        env: (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]),
        now: () => Date.now(), log() { }
    });
    const deps = {
        esp32: {
            setRelay: async (target, state) => { calls.relay.push([target, state]); return { ok: true }; },
            snapshot: () => ({
                online: true, lastOk: Date.now(),
                battery: { soc: 80, pack: 12.4, min: 3.1, status: 'ok' },
                dht: { ok: true, t: 30, h: 60, age: 5 },
                relays: [{ id: 3, name: 'Relay 3', pin: 27, on: false }],
                alerts: []
            })
        },
        door: {
            open: async () => { calls.doorOpen++; return { ok: true }; },
            close: async () => ({ ok: true }),
            setEnabled: async v => { calls.doorEnabled.push(v); return { ok: true, enabled: v }; },
            enroll: async () => { calls.enroll++; return { ok: true }; },
            snapshot: () => ({ enabled: true, synced: true, cards: 2 })
        },
        executor: {
            enabled: () => terminalEnabled,
            execute: async () => { calls.exec++; return { ok: true, code: 0, output: 'ok', stderr: '', ms: 1 }; }
        },
        storage: { list: async () => [], status: async () => ({ ready: true }) },
        telegram,
        locks: { run: async (key, fn) => fn() },
        confirm,
        audit: { write() { } }
    };
    const ai = createAi({ app: null, confirm, audit: deps.audit, deps });
    return { ai, calls, confirm };
}

const IDENT = { channel: 'web', sessionId: 's1', actor: 'admin' };
const lastPayload = reqs => {
    const parts = reqs[reqs.length - 1].contents.at(-1).parts;
    return parts.map(p => p.functionResponse && p.functionResponse.response.result).filter(Boolean).pop();
};

test('AI: terminal nonaktif -> run_command ditolak backend, executor tidak dipanggil', async () => {
    setEnv({ TERMINAL_ENABLED: 'false' });
    const h = makeHarness({ terminalEnabled: false });
    const reqs = mockGemini([callRes('run_command', { command: 'uptime' }), textRes('Terminal sedang nonaktif.')]);
    const r = await h.ai.handleMessageEx('jalankan uptime', IDENT);
    assert.equal(r.ok, true);
    assert.equal(h.calls.exec, 0, 'executor tidak boleh dipanggil sama sekali');
    assert.equal(lastPayload(reqs).code, 'FEATURE_UNAVAILABLE');
});

test('AI: state:"false" (string) ditolak dan relay tidak berubah', async () => {
    setEnv();
    const h = makeHarness();
    const reqs = mockGemini([callRes('set_relay', { id: '3', state: 'false' }), textRes('Tidak dijalankan.')]);
    await h.ai.handleMessageEx('matikan relay 3', IDENT);
    assert.equal(h.calls.relay.length, 0);
    assert.equal(lastPayload(reqs).code, 'INVALID_ARGS');
});

test('AI: model tidak bisa menyetujui sendiri; konfirmasi terikat sesi & sekali pakai', async () => {
    setEnv();
    const h = makeHarness();
    mockGemini([
        callRes('set_door_enabled', { enabled: false, approved: true }),   // ditolak schema
        callRes('set_door_enabled', { enabled: false }),                    // jadi pending
        textRes('Menunggu konfirmasi Anda.')
    ]);
    const r = await h.ai.handleMessageEx('matikan akses kartu', IDENT);
    assert.equal(h.calls.doorEnabled.length, 0, 'belum boleh mengubah perangkat');
    assert.equal(r.confirmations.length, 1);
    const id = r.confirmations[0].confirmation_id;

    await assert.rejects(
        () => h.ai.approveConfirmation(id, { channel: 'web', sessionId: 'sesi-lain', actor: 'admin' }),
        e => e.code === 'CONFIRM_IDENTITY'
    );
    assert.equal(h.calls.doorEnabled.length, 0);

    const ok = await h.ai.approveConfirmation(id, IDENT);
    assert.equal(ok.result.status, 'ok');
    assert.deepEqual(h.calls.doorEnabled, [false]);

    await assert.rejects(() => h.ai.approveConfirmation(id, IDENT), e => e.code === 'CONFIRM_USED');
    assert.deepEqual(h.calls.doorEnabled, [false], 'tidak boleh dijalankan dua kali');
});

test('AI: panggilan tool yang sama dua kali dalam satu giliran hanya dijalankan sekali', async () => {
    setEnv();
    const h = makeHarness();
    mockGemini([
        callRes('set_relay', { id: '3', state: true }),
        callRes('set_relay', { id: '3', state: true }),
        textRes('Relay 3 dinyalakan.')
    ]);
    const r = await h.ai.handleMessageEx('nyalakan relay 3', IDENT);
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls.relay, [[3, true]]);
});

test('AI: retry model setelah error server tidak mengulang tindakan perangkat', async () => {
    setEnv({ GEMINI_RETRY_MAX: '1' });
    const h = makeHarness();
    const reqs = mockGemini([
        callRes('set_relay', { id: '4', state: true }),
        errRes(503, 'model overloaded'),
        textRes('Selesai setelah percobaan ulang.')
    ]);
    const r = await h.ai.handleMessageEx('nyalakan relay 4', IDENT);
    assert.equal(r.ok, true, r.text);
    assert.equal(reqs.length, 3);
    assert.deepEqual(h.calls.relay, [[4, true]], 'tindakan perangkat hanya sekali');
});

test('AI: riwayat web/Telegram terisolasi dan hasil tool bisa dipakai di giliran berikutnya', async () => {
    setEnv();
    const h = makeHarness();
    mockGemini([callRes('set_relay', { id: '1&2', state: true }), textRes('Relay grup dinyalakan.')]);
    await h.ai.handleMessageEx('nyalakan relay 1 dan 2', IDENT);

    // Giliran kedua (sesi web yang sama): isi permintaan harus memuat functionResponse lama.
    const reqs2 = mockGemini([textRes('Ya, tadi sudah dinyalakan.')]);
    await h.ai.handleMessageEx('sudah dinyalakan?', IDENT);
    const hasFunctionResponse = reqs2[0].contents.some(c => (c.parts || []).some(p => p.functionResponse));
    assert.equal(hasFunctionResponse, true, 'hasil tool sebelumnya harus tersedia untuk konteks');

    // Sesi web lain tidak boleh melihat riwayat sesi pertama.
    const reqs3 = mockGemini([textRes('Halo juga.')]);
    await h.ai.handleMessageEx('halo', { channel: 'web', sessionId: 's2', actor: 'admin' });
    assert.equal(reqs3[0].contents.length, 1, 'sesi baru hanya berisi pesan pengguna');
    assert.equal(reqs3[0].contents.some(c => (c.parts || []).some(p => p.functionResponse)), false);

    // Telegram juga terpisah.
    const reqs4 = mockGemini([textRes('Halo dari Telegram.')]);
    await h.ai.handleMessageEx('halo', { channel: 'telegram', chatId: '555', actor: 'admin' });
    assert.equal(reqs4[0].contents.length, 1);

    assert.equal(h.ai.history.info('web:s1').turns, 2);
    assert.equal(h.ai.history.info('web:s2').turns, 1);
    assert.equal(h.ai.history.info('telegram:555').turns, 1);
});

test('AI: hapus riwayat hanya menghapus percakapan yang diminta', async () => {
    setEnv();
    const h = makeHarness();
    mockGemini([textRes('ok')]);
    await h.ai.handleMessageEx('halo', IDENT);
    mockGemini([textRes('ok')]);
    await h.ai.handleMessageEx('halo', { channel: 'web', sessionId: 's2', actor: 'admin' });
    assert.equal(h.ai.clearHistory(IDENT), true);
    assert.equal(h.ai.history.info('web:s1').turns, 0);
    assert.equal(h.ai.history.info('web:s2').turns, 1);
});

test('AI: batas putaran tetap berlaku dan memberi pesan jelas', async () => {
    setEnv({ AI_MAX_ROUNDS: '2', AI_MAX_TOOL_CALLS: '10' });
    const h = makeHarness();
    mockGemini([callRes('get_status', {}), callRes('get_status', {}), callRes('get_status', {})]);
    const r = await h.ai.handleMessageEx('status terus', IDENT);
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'ROUND_LIMIT');
    assert.match(r.text, /Terlalu banyak langkah/);
});

test('AI: batas total panggilan tool tercapai tanpa menjalankan tool tambahan', async () => {
    setEnv({ AI_MAX_ROUNDS: '5', AI_MAX_TOOL_CALLS: '1' });
    const h = makeHarness();
    const reqs = mockGemini([
        callRes('set_relay', { id: '3', state: true }),
        callRes('set_relay', { id: '4', state: true }),
        textRes('Selesai.')
    ]);
    await h.ai.handleMessageEx('nyalakan dua relay', IDENT);
    assert.equal(h.calls.relay.length, 1);
    assert.equal(lastPayload(reqs).code, 'TOOL_LIMIT');
});

test('AI: Gemini menerima kembali seluruh parts, signature, dan ID pada tool berurutan serta giliran berikutnya', async () => {
    setEnv();
    const h = makeHarness();
    const signature = Buffer.alloc(3600, 7).toString('base64');
    const firstParts = [
        { text: 'Memeriksa penyimpanan.', thought: true },
        { functionCall: { name: 'list_files', args: { dir: '' }, id: 'storage-call' }, thoughtSignature: signature }
    ];
    const secondParts = [
        { functionCall: { name: 'get_status', args: {}, id: 'status-call' }, thoughtSignature: 'signed-status-context' }
    ];
    const finalParts = [{ text: 'Penyimpanan diperiksa.', thoughtSignature: 'signed-final-answer' }];
    const res = parts => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) });
    const reqs = mockGemini([
        res(firstParts),
        (url, opt) => {
            const contents = JSON.parse(opt.body).contents;
            assert.deepEqual(contents.at(-2), { role: 'model', parts: firstParts });
            assert.equal(contents.at(-1).parts[0].functionResponse.id, 'storage-call');
            return res(secondParts);
        },
        (url, opt) => {
            const contents = JSON.parse(opt.body).contents;
            assert.deepEqual(contents.filter(c => c.role === 'model').map(c => c.parts), [firstParts, secondParts]);
            assert.equal(contents.at(-1).parts[0].functionResponse.id, 'status-call');
            return res(finalParts);
        },
        (url, opt) => {
            const contents = JSON.parse(opt.body).contents;
            assert.deepEqual(contents.filter(c => c.role === 'model').map(c => c.parts), [firstParts, secondParts, finalParts]);
            return textRes('Ya, penyimpanan tadi sudah diperiksa.');
        }
    ]);
    const first = await h.ai.handleMessageEx('cek storage dan status', IDENT);
    assert.equal(first.ok, true, first.text);
    assert.equal(first.text, 'Penyimpanan diperiksa.');
    const next = await h.ai.handleMessageEx('sudah diperiksa?', IDENT);
    assert.equal(next.ok, true, next.text);
    assert.equal(reqs.length, 4);
});

test('AI: tool paralel di Telegram mempertahankan urutan dan signature hanya pada part yang menerimanya', async () => {
    setEnv();
    const h = makeHarness();
    const parts = [
        { functionCall: { name: 'list_files', args: { dir: '' }, id: 'files-1' }, thoughtSignature: 'parallel-context' },
        { functionCall: { name: 'get_status', args: {}, id: 'status-2' } }
    ];
    mockGemini([
        { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) },
        (url, opt) => {
            const contents = JSON.parse(opt.body).contents;
            assert.deepEqual(contents.at(-2).parts, parts);
            assert.deepEqual(contents.at(-1).parts.map(p => p.functionResponse.id), ['files-1', 'status-2']);
            return textRes('Pemeriksaan selesai.');
        }
    ]);
    assert.equal(await h.ai.handleMessage('cek storage', '555'), 'Pemeriksaan selesai.');
});
