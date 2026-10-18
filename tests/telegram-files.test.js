// Uji transfer file dengan penyimpanan lokal sementara; tidak memerlukan flash disk atau Telegram nyata.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const device = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-storage-'));
process.env.STORAGE_DEVICE = device;
process.env.STORAGE_FOLDER = 'telegram';
process.env.STORAGE_MODE = 'direct';
const storage = require('../storage');
const createTelegram = require('../telegram');
test.after(() => fs.rmSync(device, { recursive: true, force: true }));

test('storage Telegram: menerima stream, dapat dibaca kembali, dan tidak menimpa nama yang sudah ada', async () => {
    const data = Buffer.from([0, 1, 2, 3, 254, 255]);
    const saved = await storage.saveStream('', 'arsip.bin', Readable.from([data]));
    assert.equal(saved.filename, 'arsip.bin');
    assert.equal(saved.size, data.length);
    assert.deepEqual(await storage.readBuffer('arsip.bin'), data);
    await assert.rejects(() => storage.saveStream('', 'arsip.bin', Readable.from(['duplikat'])), /sudah ada/);

    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    const bot = createTelegram({});
    const realFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
        request = { url, options, body: Buffer.concat(chunks) };
        return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };
    try {
        const result = await bot.sendFile('arsip.bin', '12345', 'file uji');
        assert.equal(result.size, data.length);
        assert.equal(request.url, 'https://api.telegram.org/bottest-token/sendDocument');
        assert.equal(Number(request.options.headers['Content-Length']), request.body.length);
        assert.match(request.body.toString('latin1'), /name="caption"/);
        assert.ok(request.body.includes(data), 'payload binary tetap utuh di multipart streaming');
        await assert.rejects(() => bot.sendFile('arsip.bin', 'other-chat'), /hanya diizinkan/);
    } finally { global.fetch = realFetch; }
});

test('storage Telegram: menolak path/nama tidak valid dan stream yang melewati batas ukuran', async () => {
    await assert.rejects(() => storage.saveStream('', '../keluar.txt', Readable.from(['x'])), /tidak valid/);
    await assert.rejects(() => storage.saveStream('', 'besar.bin', Readable.from([Buffer.alloc(16)]), 8), /terlalu besar/);
    await assert.rejects(() => storage.readBuffer('besar.bin'), /tidak ditemukan/);
});
