// ============================================================================
// telegram.js — bot Telegram admin yang tetap responsif.
//
// Perubahan penting:
//   • Polling TIDAK menunggu AI/transfer file. Update diterima, di-dedupe
//     berdasarkan update_id, lalu pekerjaan panjang masuk ANTREAN dengan batas
//     concurrency (TELEGRAM_MAX_JOBS, default 2).
//   • Perintah langsung (/close, /status, /cancel, ...) diproses segera walau AI
//     sibuk. Perubahan status perangkat lewat lock bersama (locks.js) supaya
//     relay/pintu tidak saling bertabrakan.
//   • Pengguna mendapat pemberitahuan "sedang diproses" + /jobs dan /cancel.
//   • Jawaban panjang dipecah sesuai batas 4096 karakter Telegram.
//   • Konfirmasi tindakan sensitif memakai inline keyboard; pengirim callback,
//     chat tujuan, ID tindakan, dan masa berlaku divalidasi; sekali pakai.
//   • Update yang dikirim ulang tidak menjalankan tindakan dua kali.
//   • Chat pribadi admin tetap satu-satunya yang diizinkan.
// ============================================================================
const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const { Readable } = require('stream');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const { createLocks } = require('./locks');

const WAIT_MS = 5000;
const MAX_TELEGRAM_RECEIVE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_SEND_BYTES = 49 * 1024 * 1024;
const TEXT_LIMIT = 3900;                 // di bawah 4096 agar aman
const MAX_CHUNKS = 6;

function chunkText(text, limit = TEXT_LIMIT) {
    const s = String(text == null ? '' : text);
    if (s.length <= limit) return [s];
    const chunks = [];
    let rest = s;
    while (rest.length && chunks.length < MAX_CHUNKS) {
        if (rest.length <= limit) { chunks.push(rest); rest = ''; break; }
        let cut = rest.lastIndexOf('\n', limit);
        if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
        if (cut < limit * 0.5) cut = limit;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest.length) chunks.push('… (pesan dipotong; lihat detail di web/audit)');
    return chunks;
}

module.exports = ({ esp32, door, setWebEnabled, isWebEnabled, ai, locks, optional, storage: storageMod } = {}) => {
    const token = () => E('TELEGRAM_BOT_TOKEN', '');
    const aiMod = ai || null;
    const store = storageMod || storage;
    const lock = locks || createLocks();
    const opt = optional || null;
    const chatId = () => E('TELEGRAM_CHAT_ID', '');
    const maxJobs = () => {
        const n = Number(E('TELEGRAM_MAX_JOBS', '2'));
        return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.floor(n))) : 2;
    };
    const noticeDelay = () => {
        const n = Number(E('TELEGRAM_NOTICE_MS', '1500'));
        return Number.isFinite(n) ? Math.max(0, Math.min(10000, n)) : 1500;
    };

    let offset = 0, running = false, timer = null;
    let welcomed = false;
    let offReason = '';
    let jobSeq = 0;
    const pendingUploads = new Map();
    const seen = new Map();                 // update_id -> waktu (dedupe)
    const jobs = new Map();                 // id -> job
    const queue = [];
    let active = 0;

    // ---------- API Telegram ----------
    async function api(method, body = {}, timeout = 35000) {
        const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(timeout)
        });
        const data = await r.json().catch(() => null);
        if (!r.ok || !data || !data.ok) throw new Error((data && data.description) || `Telegram HTTP ${r.status}`);
        return data.result;
    }

    async function send(text, target, opts = {}) {
        const chat = target || chatId();
        if (!token() || !chat) return false;
        const body = { chat_id: chat, text: String(text == null ? '' : text) };
        if (opts.reply_markup) body.reply_markup = opts.reply_markup;
        if (opts.disable_notification) body.disable_notification = true;
        await api('sendMessage', body);
        return true;
    }

    async function sendChunked(text, target, opts = {}) {
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i++) {
            const last = i === chunks.length - 1;
            await send(chunks[i], target, last ? opts : {});
        }
        return chunks.length;
    }

    async function answerCallback(id, text, alert = false) {
        try { await api('answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 190), show_alert: !!alert }, 10000); } catch { }
    }

    async function removeButtons(cb) {
        try {
            await api('editMessageReplyMarkup', {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
                reply_markup: { inline_keyboard: [] }
            }, 10000);
        } catch { }
    }

    // ---------- Kirim file (streaming, tanpa memuat seluruh file ke RAM) ----------
    async function sendFile(relPath, target, caption = '') {
        const chat = String(target || chatId());
        if (!token() || !chatId()) throw new Error('Token bot atau Chat ID Telegram belum diisi.');
        if (chat !== String(chatId())) throw new Error('Pengiriman file hanya diizinkan ke chat admin Telegram yang dikonfigurasi.');
        const rel = String(relPath || '').trim();
        if (!rel || rel.includes(String.fromCharCode(92)) || rel.includes(String.fromCharCode(0)) || rel.startsWith('/') || rel.split('/').some(part => part === '..' || part === '')) throw new Error('Jalur file tidak valid. Gunakan jalur relatif dari flash disk.');
        const filename = path.posix.basename(rel);
        const file = await store.fileStream(rel);
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

    // ---------- Unggah file Telegram -> flash disk ----------
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
        const saved = await store.saveStream(folder, file.file_name, Readable.fromWeb(r.body), MAX_TELEGRAM_RECEIVE_BYTES);
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
            await store.list(folder); // pastikan folder tujuan benar-benar ada
            await lock.run('storage', () => saveTelegramFile(pending.file, folder, message.chat.id));
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
            await store.list(destination);
            await lock.run('storage', () => saveTelegramFile(file, destination, message.chat.id));
        } catch (e) {
            await send(`Gagal menyimpan file: ${e.message}. Pastikan folder tujuan sudah ada.`, message.chat.id);
        }
    }

    // Kirim pesan uji (Pengaturan > Telegram)
    async function test(text) {
        if (!token()) return { ok: false, error: 'TELEGRAM_BOT_TOKEN belum diisi' };
        if (!chatId()) return { ok: false, error: 'TELEGRAM_CHAT_ID belum diisi' };
        try {
            await api('sendMessage', { chat_id: chatId(), text: text || '🔔 Pesan uji NodelixcoreOS.' }, 12000);
            return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    // ---------- Antrean pekerjaan ----------
    function jobView(job) {
        return {
            id: job.id, kind: job.kind, status: job.status,
            created_at: job.createdAt, started_at: job.startedAt || null,
            label: job.label || ''
        };
    }

    function notifyProcessing(job) {
        const chat = job.chatId;
        const sendNotice = async () => {
            if (job.status !== 'queued' && job.status !== 'running') return;
            const pos = job.status === 'queued' ? `antrean #${queue.indexOf(job) + 1}` : 'sedang diproses';
            const text = `⏳ Permintaan diterima (job ${job.id}, ${pos}).\nKirim /jobs untuk status atau /cancel ${job.id} untuk membatalkan.`;
            await send(text, chat).catch(() => { });
        };
        const delay = noticeDelay();
        if (delay === 0) return void sendNotice();
        job.noticeTimer = setTimeout(() => { job.noticeTimer = null; sendNotice(); }, delay);
        if (job.noticeTimer.unref) job.noticeTimer.unref();
    }

    function enqueue({ kind, chatId: chat, label, run }) {
        const id = 'j' + (++jobSeq).toString(36) + crypto.randomBytes(2).toString('hex');
        const job = { id, kind, chatId: chat, label, run, status: 'queued', createdAt: Date.now(), startedAt: null, cancelled: false, ctrl: null, noticeTimer: null };
        jobs.set(id, job);
        queue.push(job);
        notifyProcessing(job);
        pump();
        return job;
    }

    function pump() {
        while (active < maxJobs() && queue.length) {
            const job = queue.shift();
            if (!job || job.cancelled) continue;
            active++;
            job.status = 'running';
            job.startedAt = Date.now();
            Promise.resolve()
                .then(() => job.run(job))
                .catch(e => { if (!job.cancelled) send(`⚠️ Pekerjaan ${job.id} gagal: ${e.message}`, job.chatId).catch(() => { }); })
                .finally(() => {
                    active = Math.max(0, active - 1);
                    if (job.status === 'running') job.status = 'done';
                    job.finishedAt = Date.now();
                    if (job.noticeTimer) { clearTimeout(job.noticeTimer); job.noticeTimer = null; }
                    if (!job.noticed) job.noticed = true;
                    pump();
                });
        }
    }

    function cancelJob(job) {
        if (!job) return false;
        if (job.status === 'queued') {
            job.cancelled = true;
            job.status = 'cancelled';
            const i = queue.indexOf(job);
            if (i >= 0) queue.splice(i, 1);
            return true;
        }
        if (job.status === 'running') {
            job.cancelled = true;
            job.status = 'cancelled';
            try { job.ctrl && job.ctrl.abort(); } catch { }
            return true;
        }
        return false;
    }

    function myJobs(chat) {
        return [...jobs.values()].filter(j => String(j.chatId) === String(chat) && (j.status === 'queued' || j.status === 'running'));
    }

    // Bersihkan job lama
    setInterval(() => {
        const t = Date.now();
        for (const [id, j] of jobs) if (j.finishedAt && t - j.finishedAt > 10 * 60 * 1000) jobs.delete(id);
    }, 60000).unref();

    // ---------- Konfirmasi (callback tombol) ----------
    async function runAiText(job, text, chat, requestId) {
        const ctrl = new AbortController();
        job.ctrl = ctrl;
        const r = await aiMod.handleMessageEx(text, {
            channel: 'telegram', chatId: String(chat), actor: 'admin',
            signal: ctrl.signal, requestId: requestId || job.id
        });
        if (job.cancelled) return;
        const buttons = (r.confirmations || []).map(cf => ([
            { text: '✅ Setujui', callback_data: `cf:${cf.confirmation_id}:y` },
            { text: '❌ Batalkan', callback_data: `cf:${cf.confirmation_id}:n` }
        ]));
        // Telegram hanya mendukung satu inline keyboard; bila ada beberapa konfirmasi,
        // tampilkan baris tombol per konfirmasi.
        const keyboard = buttons.length ? { inline_keyboard: buttons } : null;
        await sendChunked(r.text || '(tidak ada jawaban)', chat, keyboard ? { reply_markup: keyboard } : {});
    }

    async function handleCallback(cb) {
        const from = String((cb.from && cb.from.id) || '');
        const chat = String((cb.message && cb.message.chat && cb.message.chat.id) || '');
        const type = cb.message && cb.message.chat && cb.message.chat.type;
        if (!chatId() || from !== String(chatId()) || chat !== String(chatId()) || type !== 'private') {
            console.warn(`[Telegram] Callback ditolak dari chat/pengguna tidak diizinkan (${from || '-'}/${chat || '-'}).`);
            return answerCallback(cb.id, 'Tidak diizinkan.', true);
        }
        const m = /^cf:([a-z0-9]+):(y|n)$/.exec(String(cb.data || ''));
        if (!m) return answerCallback(cb.id, 'Aksi tidak dikenal.', true);
        const ident = { actor: 'admin', channel: 'telegram', chatId: chat, sessionId: '' };
        try {
            if (m[2] === 'n') {
                const rec = aiMod.cancelConfirmation(m[1], ident);
                await removeButtons(cb);
                await answerCallback(cb.id, 'Dibatalkan.');
                await send(`❌ Dibatalkan: ${rec.summary}`, chat);
                return;
            }
            await answerCallback(cb.id, 'Menjalankan…');
            const { result } = await aiMod.approveConfirmation(m[1], ident);
            await removeButtons(cb);
            if (result.status === 'ok') {
                const text = `✅ Dijalankan (${result.skill}).\n` + JSON.stringify(result.result, null, 1).slice(0, 3000);
                await sendChunked(text, chat);
            } else {
                await send(`⚠️ Tindakan gagal: ${result.message}`, chat);
            }
        } catch (e) {
            await answerCallback(cb.id, String(e.message).slice(0, 180), true);
            await send(`⚠️ Konfirmasi tidak dapat dipakai: ${e.message}`, chat);
        }
    }

    // ---------- Perintah ----------
    const help = [
        '🤖 Perintah NodelixcoreOS:',
        '/status — status ESP32, baterai, DHT11, relay, pintu, dan web',
        '/battery — pantau baterai',
        '/dht — suhu dan kelembapan DHT11',
        '/relay <nomor|all> <on|off> — kendalikan relay ESP32',
        '/door on|off — aktif/nonaktifkan akses kartu RFID',
        '/open — minta buka pintu (langsung, khusus admin)',
        '/close — tutup/kunci pintu',
        '/addcard [nama] — tambah kartu; tempelkan kartu saat diminta',
        '/cancelcard — batalkan tambah kartu',
        '/upload <folder> — petunjuk mengirim dokumen ke flash disk',
        '/cancelupload — batalkan pilihan folder file Telegram',
        '/web off|on — matikan/nyalakan hanya web dan WebSocket',
        '/ai <pertanyaan> — tanya AI Agent (Gemini)',
        '/jobs — pekerjaan AI/berkas yang sedang berjalan',
        '/cancel [id|all] — batalkan pekerjaan AI',
        '/reset — hapus riwayat percakapan AI di chat ini',
        '/transcribe — (balas pesan suara) transkripsi eksplisit; fitur opsional',
        '/analyze <path> [pertanyaan] — analisis dokumen eksplisit; fitur opsional',
        '/help — tampilkan bantuan'
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

    async function transcribeCommand(message, args) {
        const st = opt && typeof opt.voiceStatus === 'function' ? opt.voiceStatus() : { available: false, reason: 'Fitur transkripsi tidak tersedia.' };
        if (!st.available) return send(`🔇 Transkripsi suara belum dapat digunakan: ${st.reason}`, message.chat.id);
        const media = message.voice || message.audio || (message.reply_to_message && (message.reply_to_message.voice || message.reply_to_message.audio));
        if (media) {
            const size = Number(media.file_size || 0);
            if (size > st.max_mb * 1024 * 1024) return send(`⚠️ Audio terlalu besar (${(size / 1024 / 1024).toFixed(1)} MB; batas ${st.max_mb} MB).`, message.chat.id);
            const info = await api('getFile', { file_id: media.file_id });
            if (!info || !info.file_path) return send('⚠️ Telegram tidak memberikan lokasi file audio.', message.chat.id);
            const encoded = info.file_path.split('/').map(encodeURIComponent).join('/');
            const r = await fetch(`https://api.telegram.org/file/bot${token()}/${encoded}`, { signal: AbortSignal.timeout(120000) });
            if (!r.ok) return send(`⚠️ Gagal mengunduh audio (HTTP ${r.status}).`, message.chat.id);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > st.max_mb * 1024 * 1024) return send(`⚠️ Audio melebihi batas ${st.max_mb} MB.`, message.chat.id);
            const mime = String(media.mime_type || 'audio/ogg');
            const out = await opt.transcribeBuffer({ buffer: buf, mime, name: 'voice.ogg', language: String(args || '').trim() || 'id' });
            aiMod && aiMod.audit && aiMod.audit.write && aiMod.audit.write({ actor: 'admin', channel: 'telegram', skill: 'transcribe_voice', outcome: 'ok', target: 'voice-note', result: { bytes: buf.length } });
            return sendChunked('📝 Transkrip:\n' + out.text, message.chat.id);
        }
        if (args) {
            const out = await opt.transcribeVoice({ path: String(args).trim(), language: 'id' });
            return sendChunked('📝 Transkrip:\n' + out.text, message.chat.id);
        }
        return send('Balas pesan suara/audio dengan /transcribe (atau /transcribe <path>). Fitur ini hanya berjalan bila diminta eksplisit.', message.chat.id);
    }

    async function analyzeCommand(message, args) {
        const st = opt && typeof opt.documentStatus === 'function' ? opt.documentStatus() : { available: false, reason: 'Fitur dokumen tidak tersedia.' };
        if (!st.available) return send(`📄 Analisis dokumen belum dapat digunakan: ${st.reason}`, message.chat.id);
        const parts = String(args || '').trim().split(/\s+/);
        const relPath = parts.shift();
        if (!relPath) return send('Format: /analyze <path relatif> [pertanyaan]', message.chat.id);
        const out = await opt.analyzeDocument({ path: relPath, prompt: parts.join(' ') });
        aiMod && aiMod.audit && aiMod.audit.write && aiMod.audit.write({ actor: 'admin', channel: 'telegram', skill: 'analyze_document', outcome: 'ok', target: relPath, result: { bytes: out.bytes } });
        return sendChunked('📄 Analisis:\n' + out.text, message.chat.id);
    }

    async function command(message) {
        const text = String(message.text || '').trim();
        const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
        if (!match) return;
        const cmd = match[1].toLowerCase(), args = (match[2] || '').trim();
        const chat = message.chat.id;

        try {
            if (cmd === 'start' || cmd === 'help') return send(help, chat);
            if (cmd === 'upload') return send('Kirim dokumen ke bot. Tanpa folder tujuan saya akan menanyakannya; atau isi caption dengan /upload nama_folder. Folder tujuan harus sudah ada di flash disk.', chat);
            if (cmd === 'cancelupload') {
                const removed = pendingUploads.delete(String(chat));
                return send(removed ? '❌ Pilihan folder dan penerimaan file dibatalkan.' : 'Tidak ada file yang menunggu folder tujuan.', chat);
            }
            if (cmd === 'status') return send(statusText(), chat);
            if (cmd === 'battery') return send(batteryText(), chat);
            if (cmd === 'dht') return send(dhtText(), chat);

            if (cmd === 'jobs') {
                const list = myJobs(chat);
                if (!list.length) return send('Tidak ada pekerjaan yang berjalan.', chat);
                return send('🧵 Pekerjaan aktif:\n' + list.map(j => `• ${j.id} — ${j.kind} (${j.status})${j.label ? ' · ' + j.label : ''}`).join('\n'), chat);
            }

            if (cmd === 'cancel') {
                const active_ = myJobs(chat);
                if (!active_.length) return send('Tidak ada pekerjaan untuk dibatalkan.', chat);
                let targets;
                if (!args || args.toLowerCase() === 'all') targets = active_;
                else targets = active_.filter(j => j.id === args.replace(/^#/, ''));
                if (!targets.length) return send('ID pekerjaan tidak ditemukan. Kirim /jobs untuk melihat daftar.', chat);
                targets.forEach(cancelJob);
                return send(`🛑 Dibatalkan: ${targets.map(j => j.id).join(', ')}. Tindakan yang sudah selesai tidak diulang.`, chat);
            }

            if (cmd === 'reset' || cmd === 'forget') {
                if (!aiMod || typeof aiMod.clearHistory !== 'function') return send('Riwayat AI belum tersedia.', chat);
                aiMod.clearHistory({ channel: 'telegram', chatId: String(chat) });
                return send('🧹 Riwayat percakapan AI di chat ini dihapus.', chat);
            }

            if (cmd === 'transcribe') return await transcribeCommand(message, args);
            if (cmd === 'analyze') return await analyzeCommand(message, args);

            if (cmd === 'ai' || cmd === 'ask') {
                const q = args || '';
                if (!q) return send('Format: /ai <pertanyaan>', chat);
                if (!aiMod || typeof aiMod.handleMessageEx !== 'function') return send('AI agent belum tersedia.', chat);
                enqueue({ kind: 'ai', chatId: String(chat), label: q.slice(0, 60), run: job => runAiText(job, q, chat) });
                return;
            }

            if (cmd === 'relay') {
                const m = /^(all|semua|1\s*[&,-]\s*2|[1-9]\d*)\s+(on|off)$/i.exec(args);
                if (!m) return send('Format: /relay <nomor|all> <on|off>', chat);
                const rawTarget = m[1].toLowerCase();
                const target = (rawTarget === 'all' || rawTarget === 'semua') ? 'all' : /^1\s*[&,-]\s*2$/.test(rawTarget) ? '1&2' : Number(rawTarget);
                await lock.run('esp32', () => esp32.setRelay(target, m[2].toLowerCase() === 'on'));
                return send(`✅ Relay ${target === '1&2' ? '1 & 2' : m[1]} ${m[2].toUpperCase()}.`, chat);
            }

            if (cmd === 'door') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /door on atau /door off', chat);
                const enabled = args.toLowerCase() === 'on';
                const state = await lock.run('door', () => door.setEnabled(enabled));
                if (!state.synced) {
                    return send(`⚠️ Pengaturan ${enabled ? 'lock kartu aktif' : 'lock kartu mati'} tersimpan, tetapi ESP8266 belum mengonfirmasi sinkronisasi. Status saat ini: ${door.snapshot().online ? 'sinkronisasi tertunda' : 'ESP8266 offline'}. Periksa /status sebelum mengandalkan perubahan ini.`, chat);
                }
                return send(enabled
                    ? '🔐 Lock kartu RFID aktif kembali.'
                    : '🔒 Lock kartu RFID dimatikan. Kartu biasa tidak dapat membuka pintu; kartu admin tetap bisa.', chat);
            }

            if (cmd === 'open') {
                await lock.run('door', () => door.open());
                return send('🔓 Pintu dibuka melalui Telegram (perintah admin langsung).', chat);
            }

            if (cmd === 'close') {
                await lock.run('door', () => door.close());
                return send('🔒 Pintu dikunci kembali.', chat);
            }

            if (cmd === 'addcard') {
                await lock.run('door', () => door.enroll(args, true));
                const name = args ? ` "${args}"` : '';
                return send(`💳 Mode tambah kartu${name} aktif selama ${door.snapshot().enroll.total} detik. Tempelkan kartu sekarang.`, chat);
            }

            if (cmd === 'cancelcard') {
                await lock.run('door', () => door.cancelEnroll());
                return send('❌ Mode tambah kartu dibatalkan.', chat);
            }

            if (cmd === 'web') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /web on atau /web off', chat);
                const enabled = args.toLowerCase() === 'on';
                if (enabled) {
                    await setWebEnabled(true);
                    return send('🌐 Web dan WebSocket aktif kembali. Bot Telegram serta polling ESP32/pintu tetap berjalan.', chat);
                }
                await send('🌙 Web dan WebSocket akan dimatikan. Bot Telegram serta polling ESP32/pintu tetap berjalan; kirim /web on untuk menyalakannya lagi.', chat);
                setTimeout(() => setWebEnabled(false).catch(e => console.error('[Web]', e.message)), 500);
                return;
            }

            return send('Perintah tidak dikenal. Kirim /help untuk bantuan.', chat);
        } catch (e) {
            return send(`⚠️ Perintah gagal: ${e.message}`, chat);
        }
    }

    // ---------- Penerimaan update ----------
    function seenBefore(updateId) {
        const k = String(updateId);
        if (seen.has(k)) return true;
        seen.set(k, Date.now());
        if (seen.size > 2000) {
            const oldest = seen.keys().next().value;
            seen.delete(oldest);
        }
        return false;
    }

    async function handleUpdate(update) {
        if (update.callback_query) return handleCallback(update.callback_query);
        const message = update.message;
        if (!message || !message.chat) return;
        if (message.chat.type !== 'private') return;
        const chat = String(message.chat.id);
        if (chat !== chatId()) {
            console.warn(chatId()
                ? `[Telegram] Perintah diabaikan dari chat yang tidak diizinkan (${chat}).`
                : `[Telegram] Isi TELEGRAM_CHAT_ID=${chat} (web: Pengaturan > Telegram) untuk mengizinkan bot bagi chat pribadi ini.`);
            return;
        }

        if (message.document) {
            enqueue({ kind: 'file', chatId: chat, label: message.document.file_name || '', run: () => receiveDocument(message) });
            return;
        }
        if (message.voice || message.audio) {
            const caption = String(message.caption || '').trim().toLowerCase();
            if (caption.startsWith('/transcribe')) return enqueue({ kind: 'voice', chatId: chat, label: 'transkripsi', run: () => transcribeCommand(message, message.caption.replace(/^\/transcribe\s*/i, '')) });
            return send('🎙️ Pesan suara TIDAK otomatis dikirim ke provider AI. Balas pesan ini dengan /transcribe bila ingin ditranskripsi (fitur opsional).', chat);
        }
        const text = String(message.text || '').trim();
        if (!text) return;
        if (text.startsWith('/')) return command(message);
        if (pendingUploads.has(chat)) {
            enqueue({ kind: 'file', chatId: chat, label: 'folder file', run: () => handlePendingUpload({ ...message, text }) });
            return;
        }
        if (aiMod && typeof aiMod.handleMessageEx === 'function') {
            enqueue({ kind: 'ai', chatId: chat, label: text.slice(0, 60), run: job => runAiText(job, text, chat) });
        } else {
            await send('Kirim /help untuk bantuan. (AI agent belum tersedia)', chat);
        }
    }

    async function poll() {
        if (!running) return;
        try {
            const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
            for (const update of updates) {
                offset = update.update_id + 1;     // ack segera; pekerjaan berjalan async
                if (seenBefore(update.update_id)) continue;
                // JANGAN await: polling harus tetap menerima update berikutnya.
                handleUpdate(update).catch(e => console.error('[Telegram] Update gagal:', e.message));
            }
        } catch (e) {
            if (running) console.error('[Telegram] Polling gagal:', e.message);
        }
        if (running) timer = setTimeout(poll, WAIT_MS);
    }

    async function start() {
        if (!token()) {
            if (offReason !== 'token') {
                offReason = 'token';
                console.log('[Telegram] Bot dinonaktifkan: token bot belum diisi (isi dari web: Pengaturan > Telegram).');
            }
            return false;
        }
        offReason = '';
        if (!chatId()) console.warn('[Telegram] Isi Chat ID Telegram dengan ID chat pribadi admin sebelum memakai bot.');
        try {
            const pending = await api('getUpdates', { timeout: 0, allowed_updates: ['message', 'callback_query'] }, 8000);
            if (pending.length) {
                offset = pending[pending.length - 1].update_id + 1;   // update lama tidak dijalankan ulang
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
        // Hentikan pekerjaan yang masih berjalan supaya tidak ada tindakan tanpa pemantauan.
        for (const job of jobs.values()) if (job.status === 'running' || job.status === 'queued') cancelJob(job);
    }

    async function restart() {
        stop();
        offset = 0;
        try { return await start(); }
        catch (e) { console.error('[Telegram] Gagal memulai ulang bot:', e.message); return false; }
    }

    return {
        start, restart, test, sendFile, send, sendChunked, stop,
        welcome() {
            if (!token() || !chatId() || welcomed) return Promise.resolve(false);
            welcomed = true;
            return send('👋 Selamat datang di NodelixcoreOS!\n✅ Bot siap. Gunakan /help untuk melihat perintah yang tersedia.').catch(e => {
                welcomed = false;
                console.error('[Telegram] Gagal mengirim pesan sambutan:', e.message);
                return false;
            });
        },
        isRunning: () => running,
        jobs: () => [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').map(jobView),
        stats: () => ({ running, queued: queue.length, active, maxJobs: maxJobs() }),
        // Untuk pengujian/otomatisasi: proses satu update tanpa jaringan.
        _handleUpdate: handleUpdate,
        _seenBefore: seenBefore,
        _chunk: chunkText,
        _command: command,
        _enqueue: enqueue,
        _cancelJob: cancelJob
    };
};

module.exports.chunkText = chunkText;
