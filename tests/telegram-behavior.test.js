// ============================================================================
// tests/telegram-behavior.test.js — bot tetap responsif & aman (tanpa jaringan):
//   • perintah langsung (/status, /cancel) diproses walau AI masih bekerja
//   • update_id yang dikirim ulang tidak menjalankan tindakan dua kali
//   • callback konfirmasi hanya diterima dari chat admin; identitas terikat
//   • jawaban panjang dipecah, bukan dipotong diam-diam
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const createTelegram = require(path.join(root, 'telegram'));

const FAKE = (() => {
    process.env.TELEGRAM_BOT_TOKEN = ['123456', 'TESTTOKEN-abcdefghijklmnopqrstuvwxyz'].join(':');
    process.env.TELEGRAM_CHAT_ID = '42';
    process.env.TELEGRAM_NOTICE_MS = '0';
    process.env.TELEGRAM_MAX_JOBS = '1';
})();

const delay = ms => new Promise(r => setTimeout(r, ms));

function fakeEsp() {
    return {
        snapshot: () => ({
            online: true, lastOk: Date.now(),
            battery: { soc: 80, pack: 12.4, min: 3.1, status: 'ok' },
            dht: { ok: true, t: 30.5, h: 60 },
            relays: [{ id: 3, name: 'Relay 3', pin: 27, on: true }],
            aux: null
        }),
        setRelay: async () => ({ ok: true })
    };
}
function fakeDoor() {
    return {
        snapshot: () => ({ online: true, enabled: true, synced: true, open: false }),
        open: async () => ({ ok: true }), close: async () => ({ ok: true }),
        setEnabled: async v => ({ ok: true, enabled: v }), enroll: async () => ({ ok: true })
    };
}

function makeHarness(ai) {
    const sent = [];
    const callbacks = [];
    global.fetch = async (url, opt) => {
        const method = String(url).split('/').pop();
        const body = JSON.parse((opt && opt.body) || '{}');
        if (method === 'sendMessage') {
            sent.push(body.text);
            return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
        }
        if (method === 'answerCallbackQuery') {
            callbacks.push(body);
            return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };
    const tg = createTelegram({
        ai, esp32: fakeEsp(), door: fakeDoor(),
        setWebEnabled: async () => true, isWebEnabled: () => true,
        locks: { run: async (k, fn) => fn() }
    });
    return { tg, sent, callbacks };
}

const msg = (id, text) => ({
    update_id: id,
    message: { message_id: id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text }
});

test('Telegram: perintah langsung jalan saat pekerjaan AI masih berjalan', async () => {
    let release;
    const ai = {
        handleMessageEx: () => new Promise(resolve => {
            release = () => resolve({ ok: true, text: 'Jawaban AI yang panjang.', confirmations: [] });
        }),
        approveConfirmation: async () => ({ result: { status: 'ok' } }),
        cancelConfirmation: () => ({ summary: 'x' })
    };
    const { tg, sent } = makeHarness(ai);

    await tg._handleUpdate(msg(1, 'tolong jelaskan sesuatu'));
    await tg._handleUpdate(msg(2, '/status'));

    assert.equal(sent.some(t => String(t).includes('Status NodelixcoreOS')), true, '/status harus dijawab walau AI sibuk');
    release();
    await delay(30);
    assert.equal(sent.some(t => String(t).includes('Jawaban AI')), true);
    tg.stop();
});

test('Telegram: update_id yang sama tidak membuat pekerjaan kedua', async () => {
    let calls = 0;
    const ai = {
        handleMessageEx: async () => { calls++; return { ok: true, text: 'ok', confirmations: [] }; },
        approveConfirmation: async () => ({ result: { status: 'ok' } }),
        cancelConfirmation: () => ({ summary: 'x' })
    };
    const { tg } = makeHarness(ai);
    assert.equal(tg._seenBefore(777), false);
    assert.equal(tg._seenBefore(777), true, 'update yang dikirim ulang harus dikenali');
    await tg._handleUpdate(msg(778, '/status'));
    assert.equal(calls, 0);
    tg.stop();
});

test('Telegram: callback konfirmasi dari chat lain ditolak, dari admin mengikat identitas chat', async () => {
    const approved = [];
    const ai = {
        handleMessageEx: async () => ({ ok: true, text: 'ok', confirmations: [] }),
        cancelConfirmation: () => ({ summary: 'x' }),
        approveConfirmation: async (id, ident) => {
            approved.push([id, ident]);
            return { result: { status: 'ok', skill: 'open_door', result: { ok: true } } };
        }
    };
    const { tg, callbacks, sent } = makeHarness(ai);

    await tg._handleUpdate({
        update_id: 10,
        callback_query: {
            id: 'cb-bad', from: { id: 999 }, data: 'cf:abc123:y',
            message: { message_id: 5, chat: { id: 999, type: 'private' } }
        }
    });
    assert.equal(approved.length, 0);
    assert.match(String(callbacks.at(-1).text), /Tidak diizinkan/);

    await tg._handleUpdate({
        update_id: 11,
        callback_query: {
            id: 'cb-ok', from: { id: 42 }, data: 'cf:abc123:y',
            message: { message_id: 6, chat: { id: 42, type: 'private' } }
        }
    });
    assert.equal(approved.length, 1);
    assert.equal(approved[0][0], 'abc123');
    assert.deepEqual(approved[0][1], { actor: 'admin', channel: 'telegram', chatId: '42', sessionId: '' });
    assert.equal(sent.some(t => String(t).includes('Dijalankan')), true);
    tg.stop();
});

test('Telegram: jawaban panjang dipecah menjadi beberapa pesan', async () => {
    const long = 'baris panjang '.repeat(700);          // ±9.800 karakter
    const ai = {
        handleMessageEx: async () => ({ ok: true, text: long, confirmations: [] }),
        approveConfirmation: async () => ({ result: { status: 'ok' } }),
        cancelConfirmation: () => ({ summary: 'x' })
    };
    const { tg, sent } = makeHarness(ai);
    await tg._handleUpdate(msg(20, 'tulis panjang'));
    await delay(40);
    const chunks = sent.filter(t => String(t).includes('baris panjang'));
    assert.ok(chunks.length >= 3, `harus dipecah, dapat ${chunks.length} bagian`);
    assert.ok(chunks.every(t => t.length <= 4096));
    tg.stop();
});
