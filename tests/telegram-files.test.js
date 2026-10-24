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

const waitIdle = async (bot, timeoutMs = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const st = bot.stats();
        if (st.active === 0 && st.queued === 0) return;
        await new Promise(r => setTimeout(r, 15));
    }
    throw new Error('Antrean bot tidak selesai tepat waktu.');
};

test('Telegram upload: video 9 MB dengan caption "/upload foto", tanpa caption, foto galeri, dan file .ino 18 KB', async () => {
    await storage.mkdir('', 'Foto'); // sengaja huruf besar "Foto" untuk menguji pencocokan "/upload foto"
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    process.env.TELEGRAM_NOTICE_MS = '5000';

    const video9Mb = Buffer.alloc(9 * 1024 * 1024);
    video9Mb[0] = 0x66;
    video9Mb[video9Mb.length - 1] = 0x99;
    const ino18Kb = Buffer.from('// sketch\n'.repeat(1844).slice(0, 18 * 1024));
    const photoHigh = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

    const files = new Map([
        ['vid-9mb', { path: 'videos/file_10.mp4', data: video9Mb }],
        ['vid-9mb-noname', { path: 'videos/file_11.mp4', data: video9Mb }],
        ['ino-18kb', { path: 'documents/sketch.ino', data: ino18Kb }],
        ['photo-low', { path: 'photos/thumb.jpg', data: Buffer.from([1]) }],
        ['photo-hi', { path: 'photos/full.jpg', data: photoHigh }]
    ]);

    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opt) => {
        const u = String(url);
        if (u.includes('/file/bottest-token/')) {
            const rel = decodeURIComponent(u.split('/file/bottest-token/')[1]);
            const entry = [...files.values()].find(v => v.path === rel);
            if (!entry) return { ok: false, status: 404, body: null };
            const webStream = Readable.toWeb(Readable.from((async function* () {
                const step = 256 * 1024;
                for (let i = 0; i < entry.data.length; i += step) {
                    yield entry.data.subarray(i, i + step);
                }
            })()));
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-length': String(entry.data.length) }),
                body: webStream
            };
        }
        const method = u.split('/').pop();
        const body = JSON.parse((opt && opt.body) || '{}');
        if (method === 'sendMessage') {
            sent.push(body.text);
            return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
        }
        if (method === 'getFile') {
            const entry = files.get(body.file_id);
            if (!entry) return { ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: file not found' }) };
            return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_id: body.file_id, file_path: entry.path, file_size: entry.data.length } }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };

    const bot = createTelegram({ storage });
    try {
        // 1. Video 9 MB (message.video tanpa file_name dari galeri HP) + caption "/upload foto"
        await bot._handleUpdate({
            update_id: 101,
            message: {
                message_id: 501,
                date: 1761300000,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload foto',
                video: {
                    file_id: 'vid-9mb-noname',
                    file_unique_id: 'uniqV1',
                    width: 1920,
                    height: 1080,
                    duration: 12,
                    mime_type: 'video/mp4',
                    file_size: video9Mb.length
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File') && t.includes('Foto/') && t.includes('9.00 MB')), `harus konfirmasi simpan video 9 MB, dapat: ${JSON.stringify(sent)}`);

        const listedAfterVid1 = await storage.list('Foto');
        const savedVid1 = listedAfterVid1.find(f => f.name.startsWith('video_') && f.name.endsWith('.mp4'));
        assert.ok(savedVid1, 'file video tanpa nama harus dibuatkan nama .mp4 unik');
        assert.equal(savedVid1.size, video9Mb.length);
        const readBack = await storage.readBuffer(`Foto/${savedVid1.name}`);
        assert.equal(readBack.length, video9Mb.length);
        assert.equal(readBack[0], 0x66);
        assert.equal(readBack[readBack.length - 1], 0x99);

        // 2. Video 9 MB TANPA caption -> bot menanyakan folder tujuan -> balas "/upload foto" -> tersimpan
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 102,
            message: {
                message_id: 502,
                date: 1761300010,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                video: {
                    file_id: 'vid-9mb',
                    file_unique_id: 'uniqV2',
                    file_name: 'rekaman_9mb.mp4',
                    mime_type: 'video/mp4',
                    file_size: video9Mb.length
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('rekaman_9mb.mp4') && t.includes('folder')), `tanpa caption harus menanyakan folder, dapat: ${JSON.stringify(sent)}`);

        sent.length = 0;
        await bot._handleUpdate({
            update_id: 103,
            message: {
                message_id: 503,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                text: '/upload foto'
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File “rekaman_9mb.mp4”') && t.includes('Foto/')), `balasan folder harus menyimpan video, dapat: ${JSON.stringify(sent)}`);

        // 3. Foto galeri (message.photo berisi beberapa resolusi) + caption "/upload foto"
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 104,
            message: {
                message_id: 504,
                date: 1761300020,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload foto',
                photo: [
                    { file_id: 'photo-low', file_unique_id: 'pLow', width: 90, height: 90, file_size: 1 },
                    { file_id: 'photo-hi', file_unique_id: 'pHi', width: 1280, height: 960, file_size: photoHigh.length }
                ]
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File “foto_') && t.includes('.jpg”') && t.includes('Foto/')), `foto galeri harus disimpan resolusi tertinggi, dapat: ${JSON.stringify(sent)}`);

        // 4. File .ino 18 KB (message.document) + caption "/upload foto" tetap lancar
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 105,
            message: {
                message_id: 505,
                date: 1761300030,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload foto',
                document: {
                    file_id: 'ino-18kb',
                    file_unique_id: 'ino1',
                    file_name: 'sensor.ino',
                    file_size: ino18Kb.length
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File “sensor.ino”') && t.includes('18.0 KB')), `file .ino 18 KB harus tersimpan, dapat: ${JSON.stringify(sent)}`);

        // 5. Folder pada caption belum ada -> langsung merespons & tidak perlu kirim ulang file
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 106,
            message: {
                message_id: 506,
                date: 1761300040,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload belum_ada',
                video: {
                    file_id: 'vid-9mb',
                    file_unique_id: 'uniqV3',
                    file_name: 'cadangan.mp4',
                    mime_type: 'video/mp4',
                    file_size: video9Mb.length
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('belum ada di flash disk') && t.includes('tidak perlu kirim ulang')), `harus memberi tahu folder belum ada, dapat: ${JSON.stringify(sent)}`);

        sent.length = 0;
        await bot._handleUpdate({
            update_id: 107,
            message: {
                message_id: 507,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                text: '.'
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File “cadangan.mp4”') && t.includes('folder utama')), `balasan "." menyimpan ke folder utama tanpa upload ulang, dapat: ${JSON.stringify(sent)}`);

        // 6. Video melebihi 20 MB langsung ditolak dengan penjelasan jelas
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 108,
            message: {
                message_id: 508,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload foto',
                video: {
                    file_id: 'vid-too-big',
                    file_unique_id: 'uniqBig',
                    file_name: 'besar.mp4',
                    file_size: 25 * 1024 * 1024
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('20 MB')), `harus menolak file > 20 MB, dapat: ${JSON.stringify(sent)}`);

        // 7. Edit caption media (edited_message) menjadi "/upload foto" tetap diproses
        sent.length = 0;
        await bot._handleUpdate({
            update_id: 109,
            edited_message: {
                message_id: 509,
                date: 1761300050,
                chat: { id: 12345, type: 'private' },
                from: { id: 12345 },
                caption: '/upload foto',
                video: {
                    file_id: 'vid-9mb',
                    file_unique_id: 'uniqEdit',
                    file_name: 'edit_caption.mp4',
                    mime_type: 'video/mp4',
                    file_size: video9Mb.length
                }
            }
        });
        await waitIdle(bot);
        assert.ok(sent.some(t => t.includes('✅ File “edit_caption.mp4”') && t.includes('Foto/')), `edit caption harus menyimpan video, dapat: ${JSON.stringify(sent)}`);
    } finally {
        bot.stop();
        global.fetch = realFetch;
    }
});
