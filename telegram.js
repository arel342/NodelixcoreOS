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
const FILE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TEXT_LIMIT = 3900;                 // di bawah 4096 agar aman
const MAX_CHUNKS = 6;
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];

const MIME_EXT = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    'video/3gpp': '.3gp',
    'video/x-msvideo': '.avi',
    'video/mpeg': '.mpg',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'audio/opus': '.opus',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/flac': '.flac',
    'application/pdf': '.pdf',
    'application/zip': '.zip'
};
const KIND_PREFIX = {
    document: 'berkas',
    video: 'video',
    photo: 'foto',
    animation: 'animasi',
    audio: 'audio',
    voice: 'suara',
    video_note: 'videonote'
};
const KIND_DEFAULT_EXT = {
    document: '',
    video: '.mp4',
    photo: '.jpg',
    animation: '.mp4',
    audio: '.mp3',
    voice: '.ogg',
    video_note: '.mp4'
};

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
    const mediaGroupFolders = new Map();    // chat:media_group_id -> { folder, expires }
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
    function formatBytes(bytes) {
        if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    function combineSignals(signal, timeoutMs) {
        const timeoutSig = AbortSignal.timeout(timeoutMs);
        if (!signal) return timeoutSig;
        if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSig]);
        return timeoutSig;
    }

    function hasUploadCaption(caption) {
        const firstLine = String(caption || '').trim().split(/\r?\n/)[0].trim();
        if (!firstLine) return false;
        if (/^\/upload(?:@[a-z0-9_]+)?(?:\s|$)/i.test(firstLine)) return true;
        return captionFolder(firstLine) !== null;
    }

    function captionFolder(caption) {
        const firstLine = String(caption || '').trim().split(/\r?\n/)[0].trim();
        if (!firstLine) return null;
        let m = /^\/upload(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(firstLine);
        if (m) {
            const arg = (m[1] || '').trim();
            return arg ? arg : null;
        }
        m = /^(?:folder(?:\s+tujuan)?\s*:|simpan\s+ke\s+folder\s+|ke\s+folder\s+)([\s\S]*)$/i.exec(firstLine);
        if (m) {
            const arg = m[1].trim();
            return arg ? arg : null;
        }
        return null;
    }

    function cleanFolder(value) {
        let folder = String(value || '').trim();
        if ((folder.startsWith('"') && folder.endsWith('"')) || (folder.startsWith("'") && folder.endsWith("'")) || (folder.startsWith('“') && folder.endsWith('”'))) {
            folder = folder.slice(1, -1).trim();
        }
        const lower = folder.toLowerCase();
        if (['.', './', 'root', 'utama', 'folder utama'].includes(lower)) return '';
        if (lower.startsWith('ke folder ')) folder = folder.slice(10).trim();
        else if (/^folder\s*:/.test(lower)) folder = folder.replace(/^folder\s*:\s*/i, '').trim();
        if (!folder || folder.startsWith('/')) return null;
        folder = folder.replace(/\/+$/, '');
        if (!folder || folder.includes(String.fromCharCode(92)) || folder.includes(String.fromCharCode(0)) || Array.from(folder).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || folder.split('/').some(p => !p || p === '.' || p === '..')) return null;
        return folder;
    }

    async function resolveExistingFolder(destination) {
        if (destination === '') {
            await store.list('');
            return '';
        }
        try {
            await store.list(destination);
            return destination;
        } catch (err) {
            if (!err || (err.code !== 'PATH_NOT_FOUND' && err.code !== 4 && err.status !== 404)) throw err;
            // Cocokkan nama folder tanpa membedakan huruf besar/kecil bila satu-satunya yang cocok (mis. "/upload foto" -> "Foto")
            const parts = destination.split('/');
            let current = '';
            for (const part of parts) {
                const entries = await store.list(current);
                const exact = entries.find(e => e.isDirectory && e.name === part);
                if (exact) {
                    current = current ? `${current}/${exact.name}` : exact.name;
                    continue;
                }
                const matches = entries.filter(e => e.isDirectory && e.name.toLowerCase() === part.toLowerCase());
                if (matches.length !== 1) throw err;
                current = current ? `${current}/${matches[0].name}` : matches[0].name;
            }
            await store.list(current);
            return current;
        }
    }

    function pickBestPhoto(photos) {
        const valid = (Array.isArray(photos) ? photos : []).filter(p => p && p.file_id);
        if (!valid.length) return null;
        const withinLimit = valid.filter(p => !p.file_size || p.file_size <= MAX_TELEGRAM_RECEIVE_BYTES);
        const pool = withinLimit.length ? withinLimit : valid;
        return pool.reduce((best, cur) => {
            const bestArea = (best.width || 0) * (best.height || 0);
            const curArea = (cur.width || 0) * (cur.height || 0);
            if (curArea !== bestArea) return curArea > bestArea ? cur : best;
            return (cur.file_size || 0) >= (best.file_size || 0) ? cur : best;
        });
    }

    function buildFallbackFileName(kind, raw, message) {
        const tsSec = Number(message && message.date);
        const d = Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();
        const pad = n => String(n).padStart(2, '0');
        const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
        const tag = String((message && message.message_id) || (raw && raw.file_unique_id) || '')
            .replace(/[^A-Za-z0-9_-]/g, '').slice(-8);
        const mime = String((raw && raw.mime_type) || '').split(';')[0].trim().toLowerCase();
        const mimeExt = MIME_EXT[mime] || '';
        const ext = mimeExt || KIND_DEFAULT_EXT[kind] || '';
        const prefix = KIND_PREFIX[kind] || 'berkas';
        return {
            fileName: `${prefix}_${stamp}${tag ? '_' + tag : ''}${ext}`,
            hasMimeExt: Boolean(mimeExt)
        };
    }

    // Ekstrak berkas dari berbagai jenis pesan media Telegram (document, video, photo, animation, audio, video_note, voice).
    function extractTelegramFile(message) {
        if (!message) return null;
        let kind = null, raw = null;
        if (message.document) {
            // Pada GIF/MP4 tanpa suara, Telegram mengisi message.animation sekaligus message.document.
            kind = message.animation ? 'animation' : 'document';
            raw = message.document;
        } else if (message.video) {
            kind = 'video';
            raw = message.video;
        } else if (Array.isArray(message.photo) && message.photo.length) {
            kind = 'photo';
            raw = pickBestPhoto(message.photo);
        } else if (message.animation) {
            kind = 'animation';
            raw = message.animation;
        } else if (message.video_note) {
            kind = 'video_note';
            raw = message.video_note;
        } else if (message.audio) {
            kind = 'audio';
            raw = message.audio;
        } else if (message.voice) {
            kind = 'voice';
            raw = message.voice;
        }
        if (!raw || !raw.file_id) return null;
        const cleaned = raw.file_name
            ? (typeof store.cleanName === 'function' ? store.cleanName(raw.file_name) : path.posix.basename(String(raw.file_name).trim()))
            : null;
        if (cleaned) {
            return {
                kind,
                file_id: raw.file_id,
                file_unique_id: raw.file_unique_id || '',
                file_size: Number(raw.file_size || 0),
                mime_type: String(raw.mime_type || ''),
                file_name: cleaned,
                generatedName: false,
                hasMimeExt: true
            };
        }
        const fb = buildFallbackFileName(kind, raw, message);
        return {
            kind,
            file_id: raw.file_id,
            file_unique_id: raw.file_unique_id || '',
            file_size: Number(raw.file_size || 0),
            mime_type: String(raw.mime_type || ''),
            file_name: fb.fileName,
            generatedName: true,
            hasMimeExt: fb.hasMimeExt
        };
    }

    async function saveTelegramFile(file, folder, target, signal) {
        if (!file || !file.file_id || !file.file_name) throw new Error('File Telegram tidak memiliki nama atau ID yang valid.');
        if (file.file_size && file.file_size > MAX_TELEGRAM_RECEIVE_BYTES) throw new Error('Ukuran file melebihi batas unduhan Telegram saat ini (20 MB).');
        let info;
        try {
            info = await api('getFile', { file_id: file.file_id }, 90000);
        } catch (e) {
            if (/file is too big/i.test(String(e && e.message))) {
                throw new Error('Ukuran file melebihi batas unduhan Telegram saat ini (20 MB).');
            }
            throw e;
        }
        if (!info || !info.file_path) throw new Error('Telegram tidak memberikan lokasi file.');
        let fileName = file.file_name;
        if (file.generatedName) {
            const remoteExt = path.posix.extname(String(info.file_path || '')).toLowerCase();
            if (/^\.[a-z0-9]{1,8}$/.test(remoteExt)) {
                const curExt = path.posix.extname(fileName);
                if (!curExt) fileName = fileName + remoteExt;
                else if (!file.hasMimeExt && curExt.toLowerCase() !== remoteExt) fileName = fileName.slice(0, -curExt.length) + remoteExt;
            }
        }
        const encoded = info.file_path.split('/').map(encodeURIComponent).join('/');
        const r = await fetch(`https://api.telegram.org/file/bot${token()}/${encoded}`, {
            signal: combineSignals(signal, FILE_DOWNLOAD_TIMEOUT_MS)
        });
        if (!r.ok || !r.body) {
            if (r.body) try { await r.body.cancel(); } catch { }
            throw new Error(`Gagal mengunduh file dari Telegram (HTTP ${r.status}).`);
        }
        const size = Number(r.headers.get('content-length') || file.file_size || 0);
        if (size > MAX_TELEGRAM_RECEIVE_BYTES) {
            try { await r.body.cancel(); } catch { }
            throw new Error('Ukuran file melebihi batas unduhan Telegram saat ini (20 MB).');
        }
        const saved = await store.saveStream(folder, fileName, Readable.fromWeb(r.body), MAX_TELEGRAM_RECEIVE_BYTES);
        await send(`✅ File “${saved.filename}” disimpan di ${folder ? folder + '/' : 'folder utama'} flash disk (${formatBytes(saved.size)}).`, target);
        return saved;
    }

    async function askUploadFolder(message, file) {
        const chat = String(message.chat.id);
        const pending = pendingUploads.get(chat);
        if (pending && pending.expires >= Date.now()) {
            return send(`Masih menunggu folder untuk “${pending.file.file_name}”. Balas nama folder, “.” untuk folder utama, atau /cancelupload.`, message.chat.id);
        }
        if (pending) pendingUploads.delete(chat);
        pendingUploads.set(chat, { file, messageId: message.message_id, expires: Date.now() + 10 * 60 * 1000 });
        const question = aiMod && typeof aiMod.askUploadDestination === 'function'
            ? await aiMod.askUploadDestination(file.file_name)
            : `File “${file.file_name}” diterima. Mau disimpan ke folder mana? Balas nama folder (misalnya Dokumen) atau “.” untuk folder utama.`;
        return send(question, message.chat.id);
    }

    async function handlePendingUpload(message, job) {
        const chat = String(message.chat.id), pending = pendingUploads.get(chat);
        if (!pending) return false;
        if (pending.expires < Date.now()) {
            pendingUploads.delete(chat);
            await send('Waktu memilih folder sudah habis. Kirim ulang file untuk memulai lagi.', message.chat.id);
            return true;
        }
        const extracted = captionFolder(message.text);
        const folder = cleanFolder(extracted !== null ? extracted : message.text);
        if (folder === null) {
            await send('Nama folder tidak valid. Balas nama folder yang sudah ada, “.” untuk folder utama, atau /cancelupload.', message.chat.id);
            return true;
        }
        const ctrl = new AbortController();
        if (job) job.ctrl = ctrl;
        try {
            const targetFolder = await resolveExistingFolder(folder); // pastikan folder tujuan benar-benar ada
            if (job && job.cancelled) return true;
            await lock.run('storage', () => saveTelegramFile(pending.file, targetFolder, message.chat.id, ctrl.signal));
            pendingUploads.delete(chat);
        } catch (e) {
            if (job && job.cancelled) return true;
            await send(`Belum berhasil menyimpan file: ${e.message}\nPilih folder lain atau kirim /cancelupload.`, message.chat.id);
        }
        return true;
    }

    async function receiveMedia(message, media, job) {
        const file = media || extractTelegramFile(message);
        if (!file) return;
        const chat = String(message.chat.id);
        if (file.file_size && file.file_size > MAX_TELEGRAM_RECEIVE_BYTES) {
            return send(`⚠️ Ukuran file (${formatBytes(file.file_size)}) melebihi batas unduhan Telegram saat ini (20 MB). Untuk file > 20 MB, unggah melalui dashboard web.`, message.chat.id);
        }
        let folder = captionFolder(message.caption);
        if (message.media_group_id) {
            const gKey = `${chat}:${message.media_group_id}`;
            if (folder !== null) {
                mediaGroupFolders.set(gKey, { folder, expires: Date.now() + 2 * 60 * 1000 });
            } else {
                const cached = mediaGroupFolders.get(gKey);
                if (cached && cached.expires > Date.now()) folder = cached.folder;
                else if (cached) mediaGroupFolders.delete(gKey);
            }
        }
        if (folder === null) return askUploadFolder(message, file);
        const destination = cleanFolder(folder);
        if (destination === null) {
            pendingUploads.set(chat, { file, messageId: message.message_id, expires: Date.now() + 10 * 60 * 1000 });
            return send('⚠️ Folder pada caption tidak valid. Balas dengan nama folder tujuan yang sudah ada, “.” untuk folder utama, atau /cancelupload (tidak perlu kirim ulang file).', message.chat.id);
        }
        const ctrl = new AbortController();
        if (job) job.ctrl = ctrl;
        try {
            const targetFolder = await resolveExistingFolder(destination);
            if (job && job.cancelled) return;
            await lock.run('storage', () => saveTelegramFile(file, targetFolder, message.chat.id, ctrl.signal));
        } catch (e) {
            if (job && job.cancelled) return;
            const notFound = e && (e.code === 'PATH_NOT_FOUND' || e.code === 4 || e.status === 404);
            if (notFound) {
                pendingUploads.set(chat, { file, messageId: message.message_id, expires: Date.now() + 10 * 60 * 1000 });
                await send(`⚠️ Folder “${destination}” belum ada di flash disk.\nBalas dengan nama folder yang sudah ada, “.” untuk folder utama, atau /cancelupload (tidak perlu kirim ulang file).`, message.chat.id);
                return;
            }
            await send(`Gagal menyimpan file: ${e.message}`, message.chat.id);
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

    // Bersihkan job & state sementara yang sudah kedaluwarsa
    setInterval(() => {
        const t = Date.now();
        for (const [id, j] of jobs) if (j.finishedAt && t - j.finishedAt > 10 * 60 * 1000) jobs.delete(id);
        for (const [k, v] of mediaGroupFolders) if (v.expires < t) mediaGroupFolders.delete(k);
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
        '/upload <folder> — petunjuk mengirim berkas/media ke flash disk',
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
            if (cmd === 'upload') {
                if (args && pendingUploads.has(String(chat))) {
                    enqueue({ kind: 'file', chatId: String(chat), label: 'folder file', run: job => handlePendingUpload({ ...message, text: args }, job) });
                    return;
                }
                return send('Kirim dokumen, foto, video, atau audio ke bot (maks. 20 MB). Tanpa folder tujuan saya akan menanyakannya; atau isi caption dengan /upload nama_folder (atau /upload . untuk folder utama). Folder tujuan harus sudah ada di flash disk.', chat);
            }
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
        const edited = Boolean(update.edited_message && !update.message);
        const message = update.message || update.edited_message;
        if (!message || !message.chat) return;
        if (message.chat.type !== 'private') return;
        const chat = String(message.chat.id);
        const allowedChat = String(chatId()).trim();
        if (chat !== allowedChat) {
            if (!edited) {
                console.warn(allowedChat
                    ? `[Telegram] Perintah diabaikan dari chat yang tidak diizinkan (${chat}).`
                    : `[Telegram] Isi TELEGRAM_CHAT_ID=${chat} (web: Pengaturan > Telegram) untuk mengizinkan bot bagi chat pribadi ini.`);
            }
            return;
        }

        if (edited) {
            // Hanya proses edit pesan bila pengguna menambahkan/mengubah caption upload pada berkas/media.
            if (!hasUploadCaption(message.caption)) return;
            const editedMedia = extractTelegramFile(message);
            if (!editedMedia) return;
            const pending = pendingUploads.get(chat);
            if (pending && ((pending.file.file_unique_id && pending.file.file_unique_id === editedMedia.file_unique_id) || pending.messageId === message.message_id)) {
                pendingUploads.delete(chat);
            }
            enqueue({ kind: 'file', chatId: chat, label: editedMedia.file_name || '', run: job => receiveMedia(message, editedMedia, job) });
            return;
        }

        const rawCaption = String(message.caption || '').trim();
        if ((message.voice || message.audio) && /^\/transcribe(?:@[a-z0-9_]+)?(?:\s|$)/i.test(rawCaption)) {
            const args = rawCaption.replace(/^\/transcribe(?:@[a-z0-9_]+)?\s*/i, '');
            return enqueue({ kind: 'voice', chatId: chat, label: 'transkripsi', run: () => transcribeCommand(message, args) });
        }
        if (message.voice && !hasUploadCaption(rawCaption)) {
            return send('🎙️ Pesan suara TIDAK otomatis dikirim ke provider AI. Balas pesan ini dengan /transcribe bila ingin ditranskripsi (fitur opsional), atau beri caption /upload <folder> untuk menyimpannya.', chat);
        }
        const media = extractTelegramFile(message);
        if (media) {
            enqueue({ kind: 'file', chatId: chat, label: media.file_name || '', run: job => receiveMedia(message, media, job) });
            return;
        }
        const text = String(message.text || '').trim();
        if (!text) return;
        if (text.startsWith('/')) return command(message);
        if (pendingUploads.has(chat)) {
            enqueue({ kind: 'file', chatId: chat, label: 'folder file', run: job => handlePendingUpload({ ...message, text }, job) });
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
            const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ALLOWED_UPDATES }, 35000);
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
            const pending = await api('getUpdates', { timeout: 0, allowed_updates: ALLOWED_UPDATES }, 8000);
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
