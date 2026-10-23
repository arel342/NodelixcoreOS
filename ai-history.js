// ============================================================================
// ai-history.js — riwayat percakapan AI yang terisolasi dan dibatasi.
//
// • Satu kunci percakapan per sesi web (`web:<sid>`) atau chat Telegram
//   (`telegram:<chatId>`). IP bukan identitas percakapan.
// • Setiap giliran disimpan utuh: pesan pengguna, functionCall, functionResponse
//   (diringkas), dan jawaban akhir — sehingga hasil tool relevan bisa dipakai lagi.
// • Batas utama adalah perkiraan TOKEN (4 karakter ≈ 1 token), ditambah batas
//   giliran. Pemangkasan dilakukan per giliran agar pasangan functionCall/Response
//   tidak pernah terpotong.
// • Rahasia disaring sebelum disimpan; berkas (opsional) kecil dan atomik.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { maskString } = require('./audit');

const CHARS_PER_TOKEN = 4;

function estimateTokens(value) {
    let s;
    try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
    return Math.ceil((s || '').length / CHARS_PER_TOKEN);
}

const SECRET_KEY = /(PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET|AUTHORIZATION|COOKIE)/i;

// Saring rahasia tanpa merusak struktur JSON (maskString pada seluruh JSON bisa
// menghasilkan string yang tidak bisa di-parse lagi).
function sanitizeValue(value, depth = 0) {
    if (depth > 20) return "[dalam]";
    if (value == null) return value;
    if (typeof value === 'string') return maskString(value, 4000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitizeValue(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 40)) {
            if (SECRET_KEY.test(k)) { out[k] = '[REDACTED]'; continue; }
            out[k] = sanitizeValue(v, depth + 1);
        }
        return out;
    }
    return maskString(value, 500);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

module.exports = function createHistory({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    file = path.join(__dirname, 'data', 'ai-history.json'),
    now = () => Date.now(),
    log = console.log
} = {}) {
    const maxTokens = () => clamp(Number(env('AI_HISTORY_MAX_TOKENS', '6000')) || 6000, 500, 50000);
    const maxTurns = () => clamp(Number(env('AI_HISTORY_MAX_TURNS', '12')) || 12, 1, 100);
    const persist = () => String(env('AI_HISTORY_PERSIST', 'true')).toLowerCase() !== 'false';
    const maxSessions = () => clamp(Number(env('AI_HISTORY_MAX_SESSIONS', '20')) || 20, 1, 200);
    const maxBytes = () => clamp(Number(env('AI_HISTORY_MAX_KB', '512')) || 512, 16, 8192) * 1024;

    /** @type {Map<string, {turns: Array, tokens: number, at: number}>} */
    const sessions = new Map();
    let dirty = false;
    let saveTimer = null;
    let lastError = '';

    function load() {
        if (!persist()) return;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!raw || typeof raw !== 'object') return;
            for (const [key, value] of Object.entries(raw.sessions || {})) {
                if (!value || !Array.isArray(value.turns)) continue;
                sessions.set(key, {
                    turns: value.turns.slice(-maxTurns()).map(t => ({
                        at: Number(t.at) || now(),
                        entries: Array.isArray(t.entries) ? t.entries : []
                    })),
                    tokens: 0,
                    at: Number(value.at) || now()
                });
            }
            for (const s of sessions.values()) recompute(s);
        } catch { }
    }

    function recompute(s) {
        s.tokens = s.turns.reduce((sum, t) => sum + estimateTokens(t.entries), 0);
        return s;
    }

    function trim(s) {
        while (s.turns.length > maxTurns()) s.turns.shift();
        recompute(s);
        while (s.tokens > maxTokens() && s.turns.length > 1) {
            s.turns.shift();
            recompute(s);
        }
        return s;
    }

    function saveNow() {
        if (!persist() || !dirty) return;
        dirty = false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Urutkan sesi terbaru, batasi jumlah & ukuran.
            const keys = [...sessions.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, maxSessions()).map(([k]) => k);
            const out = {};
            for (const k of keys) out[k] = sessions.get(k);
            let json = JSON.stringify({ ver: 1, sessions: out, savedAt: new Date(now()).toISOString() });
            while (Buffer.byteLength(json) > maxBytes() && keys.length > 1) {
                keys.pop();
                const o = {};
                for (const k of keys) o[k] = sessions.get(k);
                json = JSON.stringify({ ver: 1, sessions: o, savedAt: new Date(now()).toISOString() });
            }
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, json, { mode: 0o600 });
            fs.renameSync(tmp, file);
            lastError = '';
        } catch (e) {
            lastError = e.message;
            log('[AI] gagal menyimpan riwayat: ' + e.message);
        }
    }

    function scheduleSave() {
        if (!persist()) return;
        dirty = true;
        if (saveTimer) return;
        saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 500);
        if (saveTimer.unref) saveTimer.unref();
    }

    // entries: array Gemini contents untuk SATU giliran (user -> tool -> jawaban).
    function push(key, entries) {
        const k = String(key);
        let s = sessions.get(k);
        if (!s) { s = { turns: [], tokens: 0, at: now() }; sessions.set(k, s); }
        let clean = sanitizeValue(entries || []);
        // Jaring pengaman: satu giliran tidak boleh membuat berkas/konteks membengkak.
        if (JSON.stringify(clean).length > 24000) {
            const flat = (entries || []).flatMap(e => e.parts || []);
            const userText = flat.find(p => typeof p.text === 'string');
            const lastText = [...flat].reverse().find(p => typeof p.text === 'string');
            clean = [
                { role: 'user', parts: [{ text: maskString(userText ? userText.text : '', 2000) }] },
                { role: 'model', parts: [{ text: maskString(lastText ? lastText.text : '(riwayat diringkas)', 2000) }] }
            ];
        }
        const turn = { at: now(), entries: clean };
        s.turns.push(turn);
        s.at = now();
        trim(s);
        // Batasi jumlah sesi keseluruhan (yang paling lama dibuang).
        if (sessions.size > maxSessions()) {
            const oldest = [...sessions.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0];
            if (oldest) sessions.delete(oldest[0]);
        }
        scheduleSave();
        return s;
    }

    function contents(key) {
        const s = sessions.get(String(key));
        if (!s) return [];
        return s.turns.flatMap(t => t.entries).map(e => {
            // Pastikan hanya field Gemini yang dikirim.
            const parts = (e.parts || []).map(p => {
                const out = {};
                if (typeof p.text === 'string') out.text = p.text;
                if (p.functionCall) out.functionCall = { name: p.functionCall.name, args: p.functionCall.args || {} };
                if (p.functionResponse) out.functionResponse = { name: p.functionResponse.name, response: p.functionResponse.response || {} };
                return out;
            }).filter(p => Object.keys(p).length);
            return parts.length ? { role: e.role === 'model' ? 'model' : 'user', parts } : null;
        }).filter(Boolean);
    }

    function info(key) {
        const s = sessions.get(String(key));
        return {
            key: String(key),
            turns: s ? s.turns.length : 0,
            tokens: s ? s.tokens : 0,
            maxTokens: maxTokens(), maxTurns: maxTurns(),
            persist: persist(), lastError
        };
    }

    function clear(key) {
        const removed = sessions.delete(String(key));
        scheduleSave();
        return removed;
    }

    function clearAll() { sessions.clear(); scheduleSave(); }

    function stats() {
        return {
            sessions: sessions.size, maxSessions: maxSessions(), maxTokens: maxTokens(), maxTurns: maxTurns(),
            persist: persist(), file: persist() ? file : null, lastError
        };
    }

    load();

    return {
        push, contents, info, clear, clearAll, stats, estimateTokens,
        save: () => { dirty = true; saveNow(); },
        stop: () => { if (saveTimer) clearTimeout(saveTimer); saveNow(); }
    };
};

module.exports.estimateTokens = estimateTokens;
