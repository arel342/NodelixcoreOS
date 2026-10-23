// ============================================================================
// ai.js — AI Agent berbasis Gemini. SATU-SATUNYA implementasi; agent.js,
// ai-agent.js, ai_agent.js, dan gemini.js hanya me-re-export modul ini.
//
// Perubahan penting dari versi lama:
//   • Skill tidak lagi didispatch di sini: semua lewat skills-registry.js
//     (schema + validator + kebijakan izin + handler + audit).
//   • run_command memakai executor.js yang SAMA dengan terminal web, sehingga
//     TERMINAL_ENABLED, shell Termux/Linux, cwd, batas, timeout, dan pembatalan
//     berlaku identik.
//   • Konfirmasi tindakan sensitif ditegakkan server (confirm.js). Model tidak
//     bisa menyetujui tindakannya sendiri.
//   • Riwayat menyimpan hasil tool (diringkas), dibatasi token, terisolasi per
//     sesi web/chat Telegram, dan bisa dihapus.
//   • Penanganan error Gemini dibedakan: autentikasi, model tidak tersedia,
//     kuota, gangguan server, timeout, respons kosong/diblokir/tidak valid.
//     Retry memakai jeda + batas percobaan; model TIDAK diganti diam-diam dan
//     fallback dapat dikonfigurasi (default: sesama tier flash-lite).
//   • Batas putaran + batas total panggilan tool + batas durasi satu pekerjaan.
// ============================================================================
const createRegistry = require('./skills-registry');
const staticSkills = require('./skills');
const createConfirm = require('./confirm');
const createAudit = require('./audit');
const createHistory = require('./ai-history');

const E = (k, d = '') => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const B = (k, d) => {
    const raw = process.env[k];
    if (raw === undefined || raw === '') return d;
    return String(raw).toLowerCase() === 'true' || raw === '1';
};

// Pesan bantuan saat kunci API belum ada.
const KEY_HELP = 'GEMINI_API_KEY belum diisi. Isi di setup awal (langkah AI Agent) atau tab Pengaturan > AI Agent — kunci gratis dari Google AI Studio (aistudio.google.com/apikey).';

// Model default. Model pilihan pengguna di GEMINI_MODEL TIDAK diubah otomatis;
// fallback hanya dipakai bila model utama gagal "tidak tersedia" dan dapat
// dikonfigurasi. Default fallback sengaja satu tier (flash-lite) agar tidak
// menaikkan biaya tanpa persetujuan pengguna.
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_FALLBACKS = 'gemini-3.1-flash-lite';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function normalizeModelName(m) {
    const raw = String(m == null ? '' : m).trim().replace(/^models\//i, '');
    if (!raw || raw.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) return DEFAULT_MODEL;
    return raw;
}

function modelList(value) {
    return String(value || '').split(',').map(s => normalizeModelName(s.trim())).filter(Boolean);
}

function extractText(parts, sep = '\n') {
    if (!Array.isArray(parts)) return '';
    const nonThought = parts.filter(p => p && !p.thought && typeof p.text === 'string' && p.text.trim());
    return nonThought.map(p => p.text).join(sep).trim();
}

// AbortController tersedia di semua Node modern, tetapi beberapa lingkungan uji
// (vm/embedding) tidak menyediakannya. Fallback kecil ini menjaga modul tetap bisa
// dimuat; di server sungguhan selalu dipakai implementasi bawaan Node.
const AbortCtl = (typeof AbortController === 'function') ? AbortController : class AbortController {
    constructor() {
        const listeners = new Set();
        this.signal = {
            aborted: false,
            reason: undefined,
            addEventListener: (ev, fn) => { if (ev === 'abort') listeners.add(fn); },
            removeEventListener: (ev, fn) => { if (ev === 'abort') listeners.delete(fn); }
        };
        this._listeners = listeners;
    }
    abort(reason) {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.reason = reason;
        for (const fn of [...this._listeners]) { try { fn(); } catch { /* abaikan */ } }
        this._listeners.clear();
    }
};

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (!signal) return;
        const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('Permintaan dibatalkan.'), { code: 'ABORTED' })); };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function combinedSignal(signal, timeoutMs) {
    const ctrl = new AbortCtl();
    const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs) : null;
    const onAbort = () => ctrl.abort(signal && signal.reason ? signal.reason : Object.assign(new Error('dibatalkan'), { code: 'ABORTED' }));
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    return {
        signal: ctrl.signal,
        cleanup: () => {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    };
}

function classifyGemini(status, msg) {
    const s = String(msg || '');
    if (status === 401 || status === 403) return 'auth';
    if (status === 400 && /api key not valid|api_key_invalid|invalid api key/i.test(s)) return 'auth';
    if (status === 404 || /not found|not supported|deprecated|retired|no longer available|does not exist/i.test(s)) return 'model';
    if (status === 429 || /quota|rate limit|resource_exhausted|too many requests/i.test(s)) return 'quota';
    if (status >= 500 || /overloaded|unavailable|internal error|backend error/i.test(s)) return 'server';
    if (/timeout|timed out|aborted|ETIMEDOUT/i.test(s)) return 'timeout';
    return 'other';
}

function friendlyError(kind, message, model) {
    switch (kind) {
        case 'auth': return `Kunci API Gemini ditolak (autentikasi). Periksa GEMINI_API_KEY di Pengaturan. Detail: ${message} (model ${model})`;
        case 'model': return `Model "${model}" tidak tersedia untuk kunci ini. Pilih model lain di Pengaturan > AI Agent. Detail: ${message}`;
        case 'quota': return 'Kuota Gemini habis atau terlalu banyak permintaan. Coba lagi beberapa menit lagi; tindakan perangkat yang sudah berhasil tidak diulang.';
        case 'server': return 'Layanan Gemini sedang gangguan. Coba lagi nanti; tindakan yang sudah berhasil tidak diulang.';
        case 'timeout': return 'Permintaan ke Gemini melebihi batas waktu. Coba lagi, atau pecah pertanyaannya menjadi lebih kecil.';
        case 'aborted': return 'Permintaan dibatalkan.';
        case 'empty': return 'Gemini mengembalikan jawaban kosong. Coba ulangi dengan pertanyaan yang lebih jelas.';
        case 'blocked': return `Permintaan diblokir oleh filter keamanan model${message ? ` (${message})` : ''}. Ubah/ringkas permintaannya.`;
        case 'invalid': return 'Respons Gemini tidak valid (bukan JSON yang diharapkan). Coba lagi.';
        default: return `AI gagal memproses permintaan: ${message}`;
    }
}

// Identitas percakapan DIBANGUN SERVER. String lama (chat id) tetap didukung
// demi pemanggil lama, tetapi route web selalu memakai sesi login, bukan IP.
function normalizeIdentity(identity) {
    if (typeof identity === 'string' || typeof identity === 'number') {
        return { channel: 'telegram', chatId: String(identity), sessionId: '', actor: 'admin' };
    }
    const i = identity || {};
    const channel = i.channel === 'web' ? 'web' : (i.channel === 'telegram' || i.chatId) ? 'telegram' : 'web';
    return {
        channel,
        chatId: i.chatId ? String(i.chatId) : '',
        sessionId: i.sessionId ? String(i.sessionId) : '',
        actor: i.actor ? String(i.actor) : 'admin',
        requestId: i.requestId ? String(i.requestId) : '',
        signal: i.signal || null
    };
}

function conversationKey(identity) {
    return identity.channel === 'web'
        ? 'web:' + (identity.sessionId || 'anon')
        : 'telegram:' + (identity.chatId || 'unknown');
}

function sidOf(req) {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec((req && req.headers && req.headers.cookie) || '');
    return m ? m[1] : '';
}

function timeLabel(tz) {
    try {
        const d = new Date();
        const f = new Intl.DateTimeFormat('id-ID', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
        return f.format(d);
    } catch { return new Date().toISOString(); }
}

module.exports = ({ app, saveEnv, esp32, door, telegram, terminal, executor, auth, broadcast, notify, registry, confirm, audit, scheduler, sensorHistory, optional, storage, system, locks, diagnostics, deps: sharedDeps, isWebEnabled } = {}) => {
    const env = (k, d) => E(k, d);
    const confirmStore = confirm || createConfirm({ env });
    const auditLog = audit || createAudit({ env, file: E('AUDIT_LOG_FILE', undefined) || undefined, log: console.log });
    const historyStore = createHistory({ env });

    // Server membuat satu objek skillDeps yang dipakai BERSAMA oleh registry, AI,
    // dan Telegram. Tanpa objek bersama, setTelegram() tidak akan terlihat oleh
    // registry (send_file_telegram). Untuk pemakaian mandiri, objek baru dibuat.
    const skillDeps = (sharedDeps && typeof sharedDeps === 'object') ? sharedDeps : {};
    const defaults = {
        esp32, door,
        storage: storage || require('./storage'),
        system,
        telegram: telegram || null,
        executor: executor || (terminal && terminal.executor) || null,
        scheduler: scheduler || null,
        sensorHistory: sensorHistory || null,
        optional: optional || null,
        diagnostics: diagnostics || null,
        locks: locks || null,
        confirm: confirmStore,
        audit: auditLog,
        isWebEnabled: typeof isWebEnabled === 'function' ? isWebEnabled : (() => null),
        telegramRunning: () => !!(skillDeps.telegram && typeof skillDeps.telegram.isRunning === 'function' && skillDeps.telegram.isRunning()),
        aiStatus: () => {
            const c = cfg();
            return { enabled: c.enabled, has_key: !!c.apiKey, model: c.model, ready: c.enabled && !!c.apiKey };
        }
    };
    for (const [k, v] of Object.entries(defaults)) if (skillDeps[k] === undefined) skillDeps[k] = v;
    skillDeps.confirm = skillDeps.confirm || confirmStore;
    skillDeps.audit = skillDeps.audit || auditLog;
    const reg = registry || createRegistry({ deps: skillDeps, env, log: console.log });

    let started = false;

    function cfg() {
        return {
            enabled: E('AI_AGENT_ENABLED', 'true') !== 'false',
            apiKey: E('GEMINI_API_KEY', ''),
            model: normalizeModelName(E('GEMINI_MODEL', DEFAULT_MODEL)),
            fallbackEnabled: E('GEMINI_FALLBACK_ENABLED', 'true') !== 'false',
            fallbackModels: modelList(E('GEMINI_FALLBACK_MODELS', DEFAULT_FALLBACKS)),
            fallbackOnQuota: E('GEMINI_FALLBACK_ON_QUOTA', 'false') === 'true',
            honorSuggestion: E('GEMINI_HONOR_MODEL_SUGGESTION', 'false') === 'true',
            retryMax: clamp(Math.floor(N('GEMINI_RETRY_MAX', 2)), 0, 5),
            retryDelayMs: clamp(N('GEMINI_RETRY_DELAY_MS', 1200), 100, 15000),
            maxRounds: clamp(Math.floor(N('AI_MAX_ROUNDS', 8)), 1, 12),
            maxToolCalls: clamp(Math.floor(N('AI_MAX_TOOL_CALLS', 12)), 1, 40),
            jobTimeoutMs: clamp(N('AI_JOB_TIMEOUT_S', 120), 10, 600) * 1000,
            requestTimeoutMs: clamp(N('GEMINI_TIMEOUT_S', 60), 5, 300) * 1000,
            maxRetryAfterMs: 20000,
            tz: E('SCHEDULE_TZ', 'Asia/Jakarta')
        };
    }

    // ---------------------------------------------------------------------
    // Panggilan model: retry berjeda + fallback terkonfigurasi, error dibedakan
    // ---------------------------------------------------------------------
    async function requestModel(body, { apiKey, model, signal, timeoutMs }) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const { signal: sig, cleanup } = combinedSignal(signal, timeoutMs);
        let res;
        try {
            res = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: sig
            });
        } catch (e) {
            cleanup();
            const aborted = e && (e.name === 'AbortError' || e.code === 'ABORTED' || /abort/i.test(e.message || ''));
            const timedOut = aborted && !(signal && signal.aborted);
            throw Object.assign(new Error(timedOut ? 'Permintaan timeout' : (signal && signal.aborted ? 'Permintaan dibatalkan.' : 'Gagal menghubungi Gemini: ' + e.message)), {
                kind: timedOut ? 'timeout' : (signal && signal.aborted ? 'aborted' : 'network'), status: 0, model
            });
        }
        let text = '';
        if (typeof res.text === 'function') {
            try { text = await res.text(); } catch { text = ''; }
        }
        cleanup();
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        // Beberapa klien/perkakas uji hanya menyediakan res.json().
        if (json === null && typeof res.json === 'function') {
            try { json = await res.json(); } catch { json = null; }
        }
        if (!res.ok) {
            const msg = (json && json.error && (json.error.message || json.error.status)) || `Gemini HTTP ${res.status}`;
            const kind = classifyGemini(res.status, msg);
            const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
            throw Object.assign(new Error(msg), { kind, status: res.status, model, retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0 });
        }
        if (json === null) throw Object.assign(new Error('Respons Gemini bukan JSON yang valid.'), { kind: 'invalid', status: res.status, model });
        return json;
    }

    function suggestedModel(msg) {
        const m = /use models\/([a-z0-9][a-z0-9.-]*)/i.exec(String(msg || ''));
        return m ? m[1].replace(/\.+$/, '') : '';
    }

    // Kembalikan { json, model, attempts, notices }
    async function callModel(body, { apiKey, model, signal, timeoutMs } = {}) {
        const c = cfg();
        const primary = normalizeModelName(model || c.model);
        const queue = [primary];
        if (c.fallbackEnabled) for (const m of c.fallbackModels) if (m && !queue.includes(m)) queue.push(m);
        let lastErr = null;
        const notices = [];
        for (let mi = 0; mi < queue.length; mi++) {
            const m = queue[mi];
            let attempt = 0;
            while (attempt <= c.retryMax) {
                if (signal && signal.aborted) throw Object.assign(new Error('Permintaan dibatalkan.'), { kind: 'aborted' });
                try {
                    const json = await requestModel(body, { apiKey, model: m, signal, timeoutMs: timeoutMs || c.requestTimeoutMs });
                    return { json, model: m, attempts: attempt + 1, notices };
                } catch (e) {
                    lastErr = e;
                    let kind = e.kind || 'other';
                    // Saran model dari Google hanya dipakai bila admin mengaktifkannya
                    // (menghindari pindah tier biaya tanpa konfigurasi).
                    if (kind === 'model' && c.honorSuggestion) {
                        const s = suggestedModel(e.message);
                        if (s && !queue.includes(normalizeModelName(s))) {
                            const ns = normalizeModelName(s);
                            queue.splice(mi + 1, 0, ns);
                            notices.push(`Mencoba model yang disarankan provider: ${ns}`);
                        }
                    }
                    if (kind === 'auth' || kind === 'aborted') throw e;
                    if (kind === 'invalid') throw e;
                    const retryable = kind === 'quota' || kind === 'server' || kind === 'timeout' || kind === 'network';
                    if (retryable && attempt < c.retryMax) {
                        const base = e.retryAfterMs > 0 ? Math.min(e.retryAfterMs, c.maxRetryAfterMs) : c.retryDelayMs * 2 ** attempt;
                        attempt++;
                        notices.push(`Percobaan ${attempt + 1} untuk ${m} setelah ${Math.round(base)} ms (${kind}).`);
                        await sleep(base, signal);
                        continue;
                    }
                    if (kind === 'model') break;                                     // lanjut ke fallback
                    if (kind === 'quota' && c.fallbackOnQuota) break;                 // fallback hanya bila diizinkan
                    if (kind === 'quota' || kind === 'server' || kind === 'timeout' || kind === 'network') throw e;
                    throw e;                                                          // 400 lain: jangan ulangi
                }
            }
        }
        throw lastErr || Object.assign(new Error('Semua model Gemini gagal.'), { kind: 'other' });
    }

    function buildBody(contents) {
        return {
            system_instruction: { parts: [{ text: reg.systemPrompt + `\nWaktu server sekarang: ${timeLabel(cfg().tz)}.` }] },
            contents,
            tools: [{ function_declarations: reg.declarations }],
            tool_config: { function_calling_config: { mode: 'AUTO' } }
        };
    }

    async function gemini(contents, { signal } = {}) {
        const c = cfg();
        if (!c.enabled) throw Object.assign(new Error('AI agent dinonaktifkan. Aktifkan di setup awal atau Pengaturan > AI Agent.'), { kind: 'disabled' });
        if (!c.apiKey) throw Object.assign(new Error(KEY_HELP), { kind: 'nokey' });
        return callModel(buildBody(contents), { apiKey: c.apiKey, model: c.model, signal });
    }

    // ---------------------------------------------------------------------
    // Konteks eksekusi skill (dibangun server, bukan dari argumen model)
    // ---------------------------------------------------------------------
    function ctxFor(identity, requestId, signal) {
        return {
            channel: identity.channel, actor: identity.actor || 'admin',
            sessionId: identity.sessionId || '', chatId: identity.chatId || '',
            requestId: requestId || identity.requestId || '', signal,
            confirmed: false
        };
    }

    function toolPayload(out) {
        if (!out) return { status: 'error', code: 'EMPTY', message: 'Tidak ada hasil.' };
        if (out.status === 'ok') return { status: 'ok', op_id: out.op_id, result: out.result };
        if (out.status === 'pending_confirmation') {
            return {
                status: 'pending_confirmation', op_id: out.op_id,
                confirmation_id: out.confirmation_id, summary: out.summary, target: out.target,
                expires_in_sec: out.expires_in_sec,
                message: 'Tindakan BELUM dijalankan; menunggu persetujuan pengguna lewat tombol.'
            };
        }
        return { status: 'error', op_id: out.op_id, code: out.code || 'ERROR', message: out.message || 'Gagal.' };
    }

    function limitPayload(payload, max = 6000) {
        let s;
        try { s = JSON.stringify(payload); } catch { return { status: 'error', code: 'UNSERIALIZABLE', message: 'Hasil tidak dapat dibaca.' }; }
        while (s.length > max && payload.result) {
            if (typeof payload.result === 'string') { payload.result = payload.result.slice(0, Math.max(0, payload.result.length - 1000)); }
            else if (payload.result && typeof payload.result === 'object') {
                const keys = Object.keys(payload.result);
                if (!keys.length) break;
                const last = keys[keys.length - 1];
                if (typeof payload.result[last] === 'string') payload.result[last] = payload.result[last].slice(0, 1000);
                else delete payload.result[last];
            } else break;
            try { s = JSON.stringify(payload); } catch { break; }
        }
        if (s.length > max) return { status: payload.status, op_id: payload.op_id, code: payload.code, message: 'Hasil terlalu besar dan dipotong.', truncated: true };
        return payload;
    }

    // ---------------------------------------------------------------------
    // Percakapan
    // ---------------------------------------------------------------------
    async function handleMessageEx(userText, identityIn, options = {}) {
        const identity = normalizeIdentity(identityIn);
        const key = conversationKey(identity);
        const text = String(userText == null ? '' : userText).trim().slice(0, 8000);
        const confirmations = [];
        const out = (payload) => ({ ...payload, conversation: key, channel: identity.channel });

        if (!text) return out({ ok: false, errorCode: 'EMPTY_INPUT', text: 'Tulis pertanyaan atau perintah untuk AI Agent.' });
        const c = cfg();
        if (!c.enabled) return out({ ok: false, errorCode: 'DISABLED', text: 'AI agent dinonaktifkan. Aktifkan di setup awal atau Pengaturan > AI Agent.' });
        if (!c.apiKey) return out({ ok: false, errorCode: 'NO_KEY', text: KEY_HELP });

        const requestId = options.requestId || identity.requestId || ('req-' + Date.now().toString(36));
        const ac = new AbortCtl();
        const deadline = setTimeout(() => ac.abort(Object.assign(new Error('batas durasi pekerjaan'), { code: 'JOB_TIMEOUT' })), c.jobTimeoutMs);
        if (deadline.unref) deadline.unref();
        const forwardAbort = () => ac.abort(identity.signal && identity.signal.reason);
        if (identity.signal) {
            if (identity.signal.aborted) forwardAbort();
            else identity.signal.addEventListener('abort', forwardAbort, { once: true });
        }

        const entries = [{ role: 'user', parts: [{ text }] }];
        const contents = [...historyStore.contents(key), ...entries];
        let toolCalls = 0;
        let rounds = 0;
        const executed = new Map();     // signature -> hasil ok (cegah tindakan ganda dalam satu giliran)
        const pendingBy = new Map();    // signature -> pending confirmation

        const closeTurn = (answer, extraEntries = []) => {
            const modelEntry = { role: 'model', parts: [{ text: answer }] };
            entries.push(...extraEntries, modelEntry);
            historyStore.push(key, entries);
            return answer;
        };

        try {
            while (rounds < c.maxRounds) {
                rounds++;
                if (ac.signal.aborted) throw Object.assign(new Error('Permintaan dibatalkan atau melebihi batas durasi.'), { kind: 'aborted' });
                const { json } = await gemini(contents, { signal: ac.signal });
                const candidate = ((json || {}).candidates || [])[0] || {};
                const parts = (candidate.content && candidate.content.parts) || [];
                const block = (json && json.promptFeedback && json.promptFeedback.blockReason) || '';
                const functionParts = parts.filter(p => p && p.functionCall);

                if (functionParts.length) {
                    const modelEntry = { role: 'model', parts: functionParts.map(p => ({ functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} } })) };
                    entries.push(modelEntry);
                    contents.push(modelEntry);
                    const responses = [];
                    for (const p of functionParts) {
                        const name = p.functionCall.name;
                        const args = p.functionCall.args || {};
                        let sig;
                        try { sig = name + ':' + JSON.stringify(args); } catch { sig = name + ':' + String(args); }
                        let payload;
                        if (executed.has(sig)) {
                            payload = { status: 'ok', note: 'Tindakan yang sama sudah berhasil pada giliran ini; tidak diulang.', result: executed.get(sig) };
                        } else if (pendingBy.has(sig)) {
                            payload = { status: 'pending_confirmation', ...pendingBy.get(sig), message: 'Sudah menunggu konfirmasi pengguna; tidak membuat permintaan baru.' };
                        } else if (toolCalls >= c.maxToolCalls) {
                            payload = { status: 'error', code: 'TOOL_LIMIT', message: `Batas ${c.maxToolCalls} panggilan tool per pekerjaan tercapai. Minta pengguna memecah permintaan.` };
                        } else {
                            toolCalls++;
                            let res;
                            try {
                                res = await reg.execute(name, args, ctxFor(identity, requestId, ac.signal));
                            } catch (e) {
                                res = { status: 'error', code: 'SKILL_FAILED', message: e.message, op_id: '' };
                            }
                            payload = limitPayload(toolPayload(res));
                            if (res.status === 'ok') executed.set(sig, payload.result);
                            if (res.status === 'pending_confirmation') {
                                const info = { confirmation_id: res.confirmation_id, summary: res.summary, target: res.target, expires_in_sec: res.expires_in_sec };
                                pendingBy.set(sig, info);
                                confirmations.push(info);
                            }
                        }
                        responses.push({ functionResponse: { name, response: { result: payload } } });
                    }
                    const userEntry = { role: 'user', parts: responses };
                    entries.push(userEntry);
                    contents.push(userEntry);
                    continue;
                }

                const answer = extractText(parts, '\n');
                if (!answer) {
                    const kind = block ? 'blocked' : 'empty';
                    const msg = friendlyError(kind, block);
                    closeTurn(msg);
                    return out({ ok: false, errorCode: block ? 'BLOCKED' : 'EMPTY_RESPONSE', text: msg, confirmations });
                }
                let finalText = answer;
                if (confirmations.length) {
                    finalText += '\n\n' + confirmations.map(cf =>
                        `🔐 Menunggu konfirmasi: ${cf.summary} (berlaku ${cf.expires_in_sec} detik).`
                    ).join('\n') + '\nTindakan BELUM dijalankan sampai pengguna menekan tombol konfirmasi.';
                }
                closeTurn(finalText);
                return out({ ok: true, text: finalText, confirmations, rounds, toolCalls });
            }
            const msg = `Terlalu banyak langkah (batas ${c.maxRounds} putaran). Tindakan yang sudah berhasil tetap tercatat; minta pengguna memecah permintaan.`;
            closeTurn(msg);
            return out({ ok: false, errorCode: 'ROUND_LIMIT', text: msg, confirmations, rounds, toolCalls });
        } catch (e) {
            const jobTimedOut = ac.signal.aborted && ac.signal.reason && ac.signal.reason.code === 'JOB_TIMEOUT';
            const kind = jobTimedOut ? 'timeout' : (e.kind || 'other');
            const msg = jobTimedOut
                ? `Pekerjaan dihentikan karena melebihi batas ${Math.round(c.jobTimeoutMs / 1000)} detik. Tindakan yang sudah berhasil tidak diulang.`
                : kind === 'aborted'
                    ? 'Permintaan dibatalkan.'
                    : friendlyError(kind === 'nokey' ? 'other' : kind, e.message, e.model || c.model);
            // Giliran ditutup dengan struktur valid supaya riwayat berikutnya tidak rusak.
            try { closeTurn(msg); } catch { }
            return out({ ok: false, errorCode: String(kind).toUpperCase(), text: msg, confirmations, rounds, toolCalls });
        } finally {
            clearTimeout(deadline);
            if (identity.signal) identity.signal.removeEventListener('abort', forwardAbort);
        }
    }

    async function handleMessage(userText, identity) {
        const r = await handleMessageEx(userText, identity);
        return r.text;
    }

    // Pemanggil lama: executeTool(name, args, chatIdOrCtx) mengembalikan hasil mentah
    // skill (bukan envelope). Konfirmasi tetap ditegakkan registry.
    async function executeTool(name, args, identity) {
        const id = normalizeIdentity(identity);
        const res = await reg.execute(name, args, ctxFor(id, '', null));
        if (res.status === 'ok') return res.result;
        if (res.status === 'pending_confirmation') {
            return { needsConfirmation: true, confirmation_id: res.confirmation_id, summary: res.summary, expires_at: res.expires_at };
        }
        const err = new Error(res.message);
        err.code = res.code;
        throw err;
    }

    async function executeSkill(name, args, identity) {
        return reg.execute(name, args, ctxFor(normalizeIdentity(identity), '', null));
    }

    // ---------------------------------------------------------------------
    // Konfirmasi: hanya lewat aksi pengguna yang diverifikasi backend
    // ---------------------------------------------------------------------
    async function approveConfirmation(id, ident) {
        const rec = confirmStore.approve(id, ident);
        const ctx = {
            channel: ident.channel || rec.channel, actor: ident.actor || 'admin',
            sessionId: ident.sessionId || '', chatId: ident.chatId || '',
            requestId: rec.requestId, confirmId: rec.id, confirmed: true,
            preValidated: true
        };
        let result;
        try {
            result = await reg.execute(rec.skill, rec.args, ctx);
        } catch (e) {
            confirmStore.complete(rec.id, { ok: false, error: e.message });
            throw e;
        }
        confirmStore.complete(rec.id, {
            ok: result.status === 'ok',
            result: result.status === 'ok' ? result.result : null,
            error: result.status === 'error' ? result.message : null
        });
        return { confirmation: rec, result };
    }

    function cancelConfirmation(id, ident) {
        return confirmStore.cancel(id, ident);
    }

    async function askUploadDestination(filename) {
        const fallback = `File “${filename}” sudah diterima. Mau disimpan ke folder mana di flash disk? Balas nama folder (misalnya Dokumen) atau “.” untuk folder utama.`;
        const c = cfg();
        if (!c.enabled || !c.apiKey) return fallback;
        try {
            const body = {
                system_instruction: { parts: [{ text: 'Kamu asisten NodelixcoreOS. Tanyakan dengan singkat dan ramah dalam bahasa Indonesia folder tujuan untuk menyimpan file Telegram. Folder tujuan belum diberikan. Jangan menyimpan atau mengirim file, jangan mengarang nama folder. Sebutkan balasan “.” untuk folder utama.' }] },
                contents: [{ role: 'user', parts: [{ text: `Nama file: ${String(filename).slice(0, 180)}. Buat satu pertanyaan klarifikasi singkat.` }] }]
            };
            const { json } = await callModel(body, { apiKey: c.apiKey, model: c.model, timeoutMs: 20000 });
            const parts = (((json || {}).candidates || [])[0] || {}).content || {};
            return extractText(parts.parts || [], ' ') || fallback;
        } catch { return fallback; }
    }

    // Uji kunci (dipakai setup awal & Pengaturan). Override {apiKey, model} diuji
    // tanpa menyimpan, sehingga pengguna tahu kuncinya benar sebelum menyimpan.
    async function testKey(override = {}) {
        const c = cfg();
        const apiKey = String(override.apiKey === undefined ? c.apiKey : override.apiKey).trim();
        if (!apiKey) { const e = new Error(KEY_HELP); e.status = 400; throw e; }
        const model = normalizeModelName(override.model || c.model);
        const body = { contents: [{ role: 'user', parts: [{ text: 'Balas singkat: OK' }] }] };
        let json;
        try {
            ({ json } = await callModel(body, { apiKey, model, timeoutMs: 30000 }));
        } catch (e) {
            if (e && e.status === 400) throw e;
            // Pesan uji harus menyebut model yang benar-benar dicoba supaya pengguna
            // tahu apa yang perlu diubah saat kunci/model ditolak.
            const err = new Error(friendlyError(e && e.kind ? e.kind : 'other', e && e.message, (e && e.model) || model));
            err.status = e && e.status >= 400 ? e.status : 502;
            err.kind = e && e.kind;
            err.model = (e && e.model) || model;
            throw err;
        }
        const text = extractText(((((json || {}).candidates || [])[0] || {}).content || {}).parts || [], ' ');
        if (!text) throw new Error('Gemini menjawab kosong — pastikan model sudah diizinkan untuk kunci ini');
        return text;
    }

    function status() {
        const c = cfg();
        return {
            enabled: c.enabled, hasKey: !!c.apiKey, model: c.model,
            fallbackEnabled: c.fallbackEnabled, fallbackModels: c.fallbackModels,
            ready: c.enabled && !!c.apiKey,
            skills: reg.names,
            capabilities: reg.list(),
            timezone: c.tz,
            limits: { rounds: c.maxRounds, toolCalls: c.maxToolCalls, jobTimeoutSec: c.jobTimeoutMs / 1000, retries: c.retryMax },
            history: historyStore.stats(),
            confirmations: confirmStore.stats(),
            features: optional && typeof optional.statuses === 'function' ? optional.statuses() : null,
            terminalEnabled: !!(skillDeps.executor && typeof skillDeps.executor.enabled === 'function' && skillDeps.executor.enabled())
        };
    }

    // ---------------------------------------------------------------------
    // Route HTTP (web). Semua sudah dilindungi login di server.js.
    // ---------------------------------------------------------------------
    if (app) {
        const webIdent = req => ({ channel: 'web', actor: 'admin', sessionId: sidOf(req), chatId: '' });
        const route = (method, path, handler) => {
            if (typeof app[method] === 'function') app[method](path, handler);
        };

        route('get', '/api/ai/status', (req, res) => {
            const s = status();
            res.json({
                enabled: s.enabled, hasKey: s.hasKey, ready: s.ready, model: s.model,
                fallbackEnabled: s.fallbackEnabled, fallbackModels: s.fallbackModels,
                skills: s.skills, capabilities: s.capabilities, timezone: s.timezone,
                limits: s.limits, history: s.history, confirmations: s.confirmations,
                features: s.features, terminalEnabled: s.terminalEnabled
            });
        });

        route('post', '/api/ai/chat', async (req, res) => {
            try {
                const r = await handleMessageEx((req.body || {}).message || '', webIdent(req), { requestId: (req.body || {}).requestId });
                res.json({ success: r.ok, reply: r.text, text: r.text, confirmations: r.confirmations || [], error_code: r.errorCode || null, conversation: r.conversation });
            } catch (e) {
                res.status(500).json({ success: false, reply: 'AI gagal: ' + e.message, error_code: 'INTERNAL' });
            }
        });

        route('post', '/api/ai/test', async (req, res) => {
            const b = req.body || {};
            try {
                const reply = await testKey({ apiKey: b.apiKey === undefined || b.apiKey === '' ? undefined : b.apiKey, model: b.model });
                res.json({ success: true, reply });
            } catch (e) {
                const status = e && e.kind === 'auth' ? 502 : (e && e.status === 400 ? 400 : 502);
                res.status(status).json({ success: false, message: e.message });
            }
        });

        // Hapus riwayat percakapan sesi ini.
        const clearHistory = (req, res) => {
            const ident = webIdent(req);
            const key = conversationKey(ident);
            const removed = historyStore.clear(key);
            res.json({ success: true, cleared: removed, conversation: key });
        };
        route('post', '/api/ai/history/clear', clearHistory);
        route('delete', '/api/ai/history', clearHistory);
        route('get', '/api/ai/history', (req, res) => {
            const ident = webIdent(req);
            res.json(historyStore.info(conversationKey(ident)));
        });

        // Daftar konfirmasi milik sesi ini + persetujuan/pembatalan.
        route('get', '/api/ai/confirmations', (req, res) => {
            const ident = webIdent(req);
            res.json({ confirmations: confirmStore.list(ident) });
        });

        route('post', '/api/ai/confirmations/:id/approve', async (req, res) => {
            const ident = webIdent(req);
            try {
                const { result } = await approveConfirmation(req.params.id, ident);
                res.status(result.status === 'ok' ? 200 : 502).json({ success: result.status === 'ok', result, status: result.status, message: result.message || (result.status === 'ok' ? 'Tindakan dijalankan.' : '') });
            } catch (e) {
                res.status(e.status || 400).json({ success: false, code: e.code || 'CONFIRM_ERROR', message: e.message });
            }
        });

        route('post', '/api/ai/confirmations/:id/cancel', (req, res) => {
            const ident = webIdent(req);
            try {
                const rec = cancelConfirmation(req.params.id, ident);
                res.json({ success: true, cancelled: true, id: rec.id });
            } catch (e) {
                res.status(e.status || 400).json({ success: false, code: e.code || 'CONFIRM_ERROR', message: e.message });
            }
        });
    }

    return {
        start() {
            if (started) return cfg().enabled && !!cfg().apiKey;
            started = true;
            const c = cfg();
            if (!c.apiKey) console.log('[AI] ' + KEY_HELP);
            else console.log(`[AI] AI Agent ${c.enabled ? 'aktif' : 'nonaktif'} (model ${c.model}, ${reg.names.length} skill).`);
            return c.enabled && !!c.apiKey;
        },
        testKey,
        reload() { /* konfigurasi dibaca saat dipakai */ },
        setTelegram(value) {
            // Objek deps dipakai bersama registry, jadi cukup satu penugasan.
            skillDeps.telegram = value || null;
        },
        askUploadDestination,
        handleMessage,
        handleMessageEx,
        handle: handleMessage,
        ask: handleMessage,
        chat: handleMessage,
        run: handleMessage,
        handleTelegramMessage: handleMessage,
        handleTelegram: handleMessage,
        skills: staticSkills.skills,
        cfg,
        status,
        executeTool,
        execute: executeTool,
        executeSkill,
        callSkill: executeTool,
        runSkill: executeTool,
        registry: reg,
        confirmations: confirmStore,
        approveConfirmation,
        cancelConfirmation,
        history: historyStore,
        clearHistory: identity => historyStore.clear(conversationKey(normalizeIdentity(identity))),
        audit: auditLog,
        deps: skillDeps
    };
};

module.exports.skills = require('./skills').skills;
module.exports.systemPrompt = require('./skills').systemPrompt;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
