const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const { Readable } = require('stream');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const WAIT_MS = 5000;
const MAX_TELEGRAM_RECEIVE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_SEND_BYTES = 49 * 1024 * 1024;

module.exports = ({ esp32, door, setWebEnabled, isWebEnabled, ai }) => {
    // Token & chat ID dibaca saat dipakai, supaya perubahan dari web (Pengaturan > Telegram)
    // langsung berlaku tanpa menjalankan ulang server.
    const token = () => E('TELEGRAM_BOT_TOKEN', '');
    const aiMod = ai || null;
    let welcomed = false;                      // sudah mengirim pesan sambutan atau belum
    const chatId = () => E('TELEGRAM_CHAT_ID', '');
    let offset = 0, running = false, timer = null;
    const pendingUploads = new Map();          // file Telegram menunggu folder tujuan
    let offReason = '';                       // supaya pesan "dinonaktifkan" tidak berulang

    async function api(method, body = {}, timeout = 35000) {
        const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout)
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${r.status}`);
        return data.result;
    }

    async function send(text, target) {
        const chat = target || chatId();
        if (!token() || !chat) return false;
        await api('sendMessage', { chat_id: chat, text });
        return true;
    }

    // Kirim file dari flash disk secara streaming (tanpa memuat seluruh file ke RAM).
    // Jalur selalu relatif terhadap direktori penyimpanan dan ukurannya dibatasi.
    async function sendFile(relPath, target, caption = '') {
        const chat = String(target || chatId());
        if (!token() || !chatId()) throw new Error('Token bot atau Chat ID Telegram belum diisi.');
        if (chat !== String(chatId())) throw new Error('Pengiriman file hanya diizinkan ke chat admin Telegram yang dikonfigurasi.');
        const rel = String(relPath || '').trim();
        if (!rel || rel.includes(String.fromCharCode(92)) || rel.includes(String.fromCharCode(0)) || rel.startsWith('/') || rel.split('/').some(part => part === '..' || part === '')) throw new Error('Jalur file tidak valid. Gunakan jalur relatif dari flash disk.');
        const filename = path.posix.basename(rel);
        const file = await storage.fileStream(rel);
        if (file.size > MAX_TELEGRAM_SEND_BYTES) throw new Error('Ukuran file melebihi batas pengiriman Telegram saat ini (49 MB).');
        const boundary = `----NodelixTelegram${crypto.randomBytes(18).toString('hex')}`;
        const safeFilename = filename.replaceAll('"', '_').replaceAll(String.fromCharCode(92), '_').replaceAll('\r', '_').replaceAll('\n', '_');
        let prefix = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat}\r\n`;
        if (caption) prefix += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${String(caption).slice(0, 1024)}\r\n`;
        prefix += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const suffix = `\r\n--${boundary}--\r\n`;
        const body = Readable.from((async function* () {
            yield prefix;
            for await (const chunk of file.stream) yield chunk;
            yield suffix;
        })());
        const contentLength = Buffer.byteLength(prefix) + file.size + Buffer.byteLength(suffix);
        const r = await fetch(`https://api.telegram.org/bot${token()}/sendDocument`, {
            method: 'POST', body, duplex: 'half',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(contentLength) },
            signal: AbortSignal.timeout(30 * 60 * 1000)
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || !data.ok) throw new Error((data && data.description) || `Telegram HTTP ${r.status}`);
        return { ok: true, filename, size: file.size };
    }

    function captionFolder(caption) {
        const text = String(caption || '').trim();
        const lower = text.toLowerCase();
        if (lower.startsWith('/upload ')) return text.slice(8).trim();
        if (lower.startsWith('folder:')) return text.slice(7).trim();
        if (lower.startsWith('folder tujuan:')) return text.slice(14).trim();
        if (lower.startsWith('ke folder ')) return text.slice(10).trim();
        if (lower.startsWith('simpan ke folder ')) return text.slice(17).trim();
        return null;
    }

    function cleanFolder(value) {
        let folder = String(value || '').trim();
        const lower = folder.toLowerCase();
        if (['.', 'root', 'utama', 'folder utama'].includes(lower)) return '';
        if (lower.startsWith('ke folder ')) folder = folder.slice(10).trim();
        else if (lower.startsWith('folder:')) folder = folder.slice(7).trim();
        if (!folder || folder.startsWith('/') || folder.includes(String.fromCharCode(92)) || folder.includes(String.fromCharCode(0)) || Array.from(folder).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || folder.split('/').some(p => !p || p === '.' || p === '..')) return null;
        return folder;
    }

    async function saveTelegramFile(file, folder, target) {
        if (!file.file_id || !file.file_name) throw new Error('File Telegram tidak memiliki nama atau ID yang valid.');
        if (file.file_size && file.file_size > MAX_TELEGRAM_RECEIVE_BYTES) throw new Error('Ukuran file melebihi batas unduhan Telegram saat ini (20 MB).');
        const info = await api('getFile', { file_id: file.file_id });
        if (!info || !info.file_path) throw new Error('Telegram tidak memberikan lokasi file.');
        const encoded = info.file_path.split('/').map(encodeURIComponent).join('/');
        const r = await fetch(`https://api.telegram.org/file/bot${token()}/${encoded}`, { signal: AbortSignal.timeout(120000) });
        if (!r.ok || !r.body) throw new Error(`Gagal mengunduh file dari Telegram (HTTP ${r.status}).`);
        const size = Number(r.headers.get('content-length') || file.file_size || 0);
        if (size > MAX_TELEGRAM_RECEIVE_BYTES) { await r.body.cancel(); throw new Error('Ukuran file melebihi batas unduhan Telegram saat ini (20 MB).'); }
        const saved = await storage.saveStream(folder, file.file_name, Readable.fromWeb(r.body), MAX_TELEGRAM_RECEIVE_BYTES);
        await send(`✅ File “${saved.filename}” disimpan di ${folder ? folder + '/' : 'folder utama'} flash disk (${(saved.size / 1024).toFixed(1)} KB).`, target);
        return saved;
    }

    async function askUploadFolder(message, file) {
        const chat = String(message.chat.id);
        const pending = pendingUploads.get(chat);
        if (pending) return send(`Masih menunggu folder untuk “${pending.file.file_name}”. Balas nama folder, “.” untuk folder utama, atau /cancelupload.`, message.chat.id);
        pendingUploads.set(chat, { file, expires: Date.now() + 10 * 60 * 1000 });
        const question = aiMod && typeof aiMod.askUploadDestination === 'function'
            ? await aiMod.askUploadDestination(file.file_name)
            : `File “${file.file_name}” diterima. Mau disimpan ke folder mana? Balas nama folder (misalnya Dokumen) atau “.” untuk folder utama.`;
        return send(question, message.chat.id);
    }

    async function handlePendingUpload(message) {
        const chat = String(message.chat.id), pending = pendingUploads.get(chat);
        if (!pending) return false;
        if (pending.expires < Date.now()) {
            pendingUploads.delete(chat);
            await send('Waktu memilih folder sudah habis. Kirim ulang file untuk memulai lagi.', message.chat.id);
            return true;
        }
        const folder = cleanFolder(message.text);
        if (folder === null) {
            await send('Nama folder tidak valid. Balas nama folder yang sudah ada, “.” untuk folder utama, atau /cancelupload.', message.chat.id);
            return true;
        }
        try {
            await storage.list(folder); // pastikan folder tujuan benar-benar ada
            await saveTelegramFile(pending.file, folder, message.chat.id);
            pendingUploads.delete(chat);
        } catch (e) {
            await send(`Belum berhasil menyimpan file: ${e.message}\nPilih folder lain atau kirim /cancelupload.`, message.chat.id);
        }
        return true;
    }

    async function receiveDocument(message) {
        const file = message.document;
        const folder = captionFolder(message.caption);
        if (folder === null) return askUploadFolder(message, file);
        const destination = cleanFolder(folder);
        if (destination === null) return send('Folder pada caption tidak valid. Kirim ulang file dengan caption “/upload nama_folder”, atau kirim tanpa caption untuk ditanya foldernya.', message.chat.id);
        try {
            await storage.list(destination);
            await saveTelegramFile(file, destination, message.chat.id);
        } catch (e) {
            await send(`Gagal menyimpan file: ${e.message}. Pastikan folder tujuan sudah ada.`, message.chat.id);
        }
    }

    // Kirim pesan uji (dipakai tombol "Kirim pesan uji" di Pengaturan > Telegram)
    async function test(text) {
        if (!token()) return { ok: false, error: 'TELEGRAM_BOT_TOKEN belum diisi' };
        if (!chatId()) return { ok: false, error: 'TELEGRAM_CHAT_ID belum diisi' };
        try {
            await api('sendMessage', { chat_id: chatId(), text: text || '🔔 Pesan uji NodelixcoreOS.' }, 12000);
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    const help = [
        '🤖 Perintah NodelixcoreOS:',
        '/status — status ESP32, baterai, DHT11, relay, pintu, dan web',
        '/battery — pantau baterai',
        '/dht — suhu dan kelembapan DHT11',
        '/relay <nomor|all> <on|off> — kendalikan relay ESP32',
        '/door on|off — aktif/nonaktifkan akses kartu RFID',
        '/open — buka pintu melalui server',
        '/close — tutup/kunci pintu',
        '/addcard [nama] — tambah kartu; tempelkan kartu saat diminta',
        '/cancelcard — batalkan tambah kartu',
        '/upload <folder> — petunjuk mengirim dokumen ke flash disk (caption file dapat berisi /upload <folder>)',
        '/cancelupload — batalkan pilihan folder file Telegram',
        '/web off|on — matikan/nyalakan hanya web dan WebSocket',
        '/help — tampilkan bantuan',
        '/ai <pertanyaan> — tanya AI Agent (Gemini)'
    ].join('\n');

    function batteryText() {
        const s = esp32.snapshot(), b = s.battery;
        if (!s.online) return '⚠️ ESP32 sedang offline.';
        if (!b) return '🔋 Data baterai belum tersedia. Periksa sensor dan konfigurasi tap pada ESP32.';
        return `🔋 Baterai ${b.soc.toFixed(0)}% · pack ${b.pack.toFixed(2)} V · sel terendah ${b.min.toFixed(2)} V · ${b.status}`;
    }

    function dhtText() {
        const s = esp32.snapshot(), d = s.dht;
        if (!s.online) return '⚠️ ESP32 sedang offline.';
        if (!d || !d.ok || !Number.isFinite(d.t) || !Number.isFinite(d.h))
            return '🌡️ Data DHT11 belum tersedia. Periksa sensor, kabel GPIO 4, dan firmware ESP32.';
        return `🌡️ Suhu ${d.t.toFixed(1)} °C · kelembapan ${d.h.toFixed(0)}%`;
    }

    function statusText() {
        const e = esp32.snapshot(), d = door.snapshot();
        const relays = e.relays.length
            ? e.relays.map(r => `R${r.id} ${r.name}: ${r.on ? 'ON' : 'OFF'}`).join('\n')
            : 'Belum ada data relay.';
        const aux = e.aux ? `\nKeluaran pendamping GPIO ${e.aux.on_pin}/${e.aux.off_pin}: ${e.aux.on ? 'ON' : 'OFF'}/${e.aux.off ? 'ON' : 'OFF'}` : '';
        return [
            '📊 Status NodelixcoreOS',
            `📡 ESP32: ${e.online ? 'online' : 'offline'}`,
            batteryText(),
            dhtText(),
            '🔌 Relay:\n' + relays + aux,
            `🚪 Pintu: ${d.online ? 'online' : 'offline'} · lock kartu ${d.enabled ? 'aktif' : 'nonaktif'} (${d.synced ? 'sinkron' : 'belum sinkron'}) · pintu ${d.open ? 'terbuka' : 'terkunci'}`,
            `🌐 Web: ${isWebEnabled() ? 'aktif' : 'mati'}`
        ].join('\n');
    }

    async function command(message) {
        const text = String(message.text || '').trim();
        const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
        if (!match) return;
        const cmd = match[1].toLowerCase(), args = (match[2] || '').trim();

        try {
            if (cmd === 'start' || cmd === 'help') return send(help, message.chat.id);
            if (cmd === 'upload') return send('Kirim dokumen ke bot. Tanpa folder tujuan saya akan menanyakannya; atau isi caption dengan /upload nama_folder. Folder tujuan harus sudah ada di flash disk.', message.chat.id);
            if (cmd === 'cancelupload') {
                const removed = pendingUploads.delete(String(message.chat.id));
                return send(removed ? '❌ Pilihan folder dan penerimaan file dibatalkan.' : 'Tidak ada file yang menunggu folder tujuan.', message.chat.id);
            }
            if (cmd === 'status') return send(statusText(), message.chat.id);
            if (cmd === 'battery') return send(batteryText(), message.chat.id);
            if (cmd === 'dht') return send(dhtText(), message.chat.id);

            if (cmd === 'ai' || cmd === 'ask') {
                const q = args || '';
                if (!q) return send('Format: /ai <pertanyaan>', message.chat.id);
                if (!aiMod || typeof aiMod.handleMessage !== 'function') return send('AI agent belum tersedia.', message.chat.id);
                try {
                    const reply = await aiMod.handleMessage(q, message.chat.id);
                    return send(reply || '(tidak ada jawaban)', message.chat.id);
                } catch (e) {
                    return send('⚠️ AI gagal: ' + e.message, message.chat.id);
                }
            }

            if (cmd === 'relay') {
                const m = /^(all|semua|1\s*[&,-]\s*2|[1-9]\d*)\s+(on|off)$/i.exec(args);
                if (!m) return send('Format: /relay <nomor|all> <on|off>', message.chat.id);
                const rawTarget = m[1].toLowerCase();
                const target = (rawTarget === 'all' || rawTarget === 'semua') ? 'all' : /^1\s*[&,-]\s*2$/.test(rawTarget) ? '1&2' : Number(rawTarget);
                await esp32.setRelay(target, m[2].toLowerCase() === 'on');
                return send(`✅ Relay ${target === '1&2' ? '1 & 2' : m[1]} ${m[2].toUpperCase()}.`, message.chat.id);
            }

            if (cmd === 'door') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /door on atau /door off', message.chat.id);
                const enabled = args.toLowerCase() === 'on';
                const state = await door.setEnabled(enabled);
                if (!state.synced) {
                    return send(`⚠️ Pengaturan ${enabled ? 'lock kartu aktif' : 'lock kartu mati'} tersimpan, tetapi ESP8266 belum mengonfirmasi sinkronisasi. Status saat ini: ${door.snapshot().online ? 'sinkronisasi tertunda' : 'ESP8266 offline'}. Periksa /status sebelum mengandalkan perubahan ini.`, message.chat.id);
                }
                return send(enabled
                    ? '🔐 Lock kartu RFID aktif kembali.'
                    : '🔒 Lock kartu RFID dimatikan. Kartu biasa tidak dapat membuka pintu; kartu admin tetap bisa.', message.chat.id);
            }

            if (cmd === 'open') {
                await door.open();
                return send('🔓 Pintu dibuka melalui Telegram.', message.chat.id);
            }

            if (cmd === 'close') {
                await door.close();
                return send('🔒 Pintu dikunci kembali.', message.chat.id);
            }

            if (cmd === 'addcard') {
                await door.enroll(args, true);
                const name = args ? ` "${args}"` : '';
                return send(`💳 Mode tambah kartu${name} aktif selama ${door.snapshot().enroll.total} detik. Tempelkan kartu sekarang.`, message.chat.id);
            }

            if (cmd === 'cancelcard') {
                await door.cancelEnroll();
                return send('❌ Mode tambah kartu dibatalkan.', message.chat.id);
            }

            if (cmd === 'web') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /web on atau /web off', message.chat.id);
                const enabled = args.toLowerCase() === 'on';
                if (enabled) {
                    await setWebEnabled(true);
                    return send('🌐 Web dan WebSocket aktif kembali. Bot Telegram serta polling ESP32/pintu tetap berjalan.', message.chat.id);
                }
                await send('🌙 Web dan WebSocket akan dimatikan. Bot Telegram serta polling ESP32/pintu tetap berjalan; kirim /web on untuk menyalakannya lagi.', message.chat.id);
                setTimeout(() => setWebEnabled(false).catch(e => console.error('[Web]', e.message)), 500);
                return;
            }

            return send('Perintah tidak dikenal. Kirim /help untuk bantuan.', message.chat.id);
        } catch (e) {
            return send(`⚠️ Perintah gagal: ${e.message}`, message.chat.id);
        }
    }

    async function poll() {
        if (!running) return;
        try {
            const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000);
            for (const update of updates) {
                offset = update.update_id + 1;
                const message = update.message;
                if (!message || !message.chat || message.chat.type !== 'private') continue;
                if (String(message.chat.id) !== chatId()) {
                    console.warn(chatId()
                        ? `[Telegram] Perintah diabaikan dari chat yang tidak diizinkan (${message.chat.id}).`
                        : `[Telegram] Isi TELEGRAM_CHAT_ID=${message.chat.id} (web: Pengaturan > Telegram) untuk mengizinkan bot bagi chat pribadi ini.`);
                    continue;
                }
                if (message.document) {
                    try { await receiveDocument(message); }
                    catch (e) { await send(`⚠️ File tidak dapat diproses: ${e.message}`, message.chat.id); }
                    continue;
                }
                if (!message.text) continue;
                const text = String(message.text || '').trim();
                if (text.startsWith('/')) {
                    await command(message);
                    continue;
                }
                if (await handlePendingUpload({ ...message, text })) continue;
                if (aiMod && typeof aiMod.handleMessage === 'function') {
                    try {
                        const reply = await aiMod.handleMessage(text, message.chat.id);
                        if (reply) await send(reply, message.chat.id);
                    } catch (e) {
                        await send('⚠️ AI gagal: ' + e.message, message.chat.id);
                    }
                } else {
                    await send('Kirim /help untuk bantuan. (AI agent belum tersedia)', message.chat.id);
                }
            }
        } catch (e) {
            if (running) console.error('[Telegram] Polling gagal:', e.message);
        }
        if (running) timer = setTimeout(poll, WAIT_MS);
    }

    async function start() {
        if (!token()) {
            // Cukup sekali sampai token diisi: boot, setup awal, dan ganti pengaturan
            // sama-sama memanggil start(), pesannya jangan menumpuk di log Termux.
            if (offReason !== 'token') {
                offReason = 'token';
                console.log('[Telegram] Bot dinonaktifkan: token bot belum diisi (isi dari web: Pengaturan > Telegram).');
            }
            return false;
        }
        offReason = '';
        if (!chatId()) console.warn('[Telegram] Isi Chat ID Telegram dengan ID chat pribadi admin sebelum memakai bot.');
        try {
            const pending = await api('getUpdates', { timeout: 0, allowed_updates: ['message'] }, 8000);
            if (pending.length) {
                offset = pending[pending.length - 1].update_id + 1;
                if (!chatId()) {
                    const ids = [...new Set(pending.map(u => u.message).filter(m => m && m.chat && m.chat.type === 'private').map(m => m.chat.id))];
                    if (ids.length) console.log(`[Telegram] Isi Chat ID (web: Pengaturan > Telegram) dengan salah satu ID chat pribadi ini: ${ids.join(', ')}`);
                }
            }
        } catch (e) {
            console.error('[Telegram] Gagal menyiapkan polling:', e.message);
        }
        running = true;
        poll();
        return true;
    }

    function stop() {
        running = false;
        clearTimeout(timer);
        timer = null;
    }

    // Dipakai setelah pengaturan Telegram diubah dari web: hentikan polling lama, mulai lagi
    // dengan token/chat ID baru (tanpa menjalankan ulang server).
    async function restart() {
        stop();
        offset = 0;
        try { return await start(); }
        catch (e) { console.error('[Telegram] Gagal memulai ulang bot:', e.message); return false; }
    }

    return {
        start,
        restart,
        test,
        sendFile,
        // Sekali saja per proses: setup awal memanggil welcome() dan startDevices()
        // memanggilnya lewat telegram.start(), tanpa itu pengguna menerima 2 pesan.
        welcome() {
            if (!token() || !chatId() || welcomed) return Promise.resolve(false);
            welcomed = true;
            return send('👋 Selamat datang di NodelixcoreOS!\n✅ Bot siap. Gunakan /help untuk melihat perintah yang tersedia.').catch(e => {
                welcomed = false;
                console.error('[Telegram] Gagal mengirim pesan sambutan:', e.message);
                return false;
            });
        },
        stop,
        isRunning: () => running
    };
};
