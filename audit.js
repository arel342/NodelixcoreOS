// ============================================================================
// audit.js — catatan audit tindakan AI/skill.
//
// Setiap eksekusi (langsung, terjadwal, atau setelah konfirmasi) dicatat:
// waktu, aktor, kanal, skill, target, hasil, ID operasi, dan ID konfirmasi.
// Informasi rahasia disaring: nilai env sensitif, token/API key, password, dan
// string panjang yang menyerupai kredensial tidak pernah masuk ke berkas.
//
// Berkas: data/audit.log (JSON Lines), dirotasi ke audit.log.1 bila melewati
// AUDIT_LOG_MAX_BYTES. AUDIT_LOG_ENABLED=false mematikan penulisan (bukan
// pemeriksaan izin).
// ============================================================================
const fs = require('fs');
const path = require('path');

const SECRET_KEY = /(PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET|AUTHORIZATION|COOKIE|SESSION)/i;
const SECRET_VALUE = [
    /\b(AIza|AQ\.|sk-|ghp_|xoxb-)[A-Za-z0-9_\-.~]{6,}/g,       // kunci API umum
    /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,                        // token bot Telegram
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
    /\b(?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*\S+/gi,
    /\b[0-9a-f]{40,}\b/gi
];

function maskString(value, max = 400) {
    let s = String(value == null ? '' : value);
    for (const re of SECRET_VALUE) s = s.replace(re, '[REDACTED]');
    if (s.length > max) s = s.slice(0, max) + `… (${s.length - max} karakter lagi)`;
    return s;
}

function sanitize(value, depth = 0) {
    if (depth > 4) return '[dalam]';
    if (value == null) return value;
    if (typeof value === 'string') return maskString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (SECRET_KEY.test(k)) { out[k] = '[REDACTED]'; continue; }
            out[k] = sanitize(v, depth + 1);
        }
        return out;
    }
    return maskString(value);
}

module.exports = function createAudit({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    file = path.join(__dirname, 'data', 'audit.log'),
    log = console.log
} = {}) {
    const enabled = () => String(env('AUDIT_LOG_ENABLED', 'true')).toLowerCase() !== 'false';
    const maxBytes = () => {
        const mb = Number(env('AUDIT_LOG_MAX_MB', '2'));
        return (Number.isFinite(mb) ? Math.max(0.1, Math.min(50, mb)) : 2) * 1024 * 1024;
    };
    let queue = Promise.resolve();
    let lastError = '';

    function rotateIfNeeded() {
        try {
            const st = fs.statSync(file);
            if (st.size <= maxBytes()) return;
            fs.renameSync(file, file + '.1');
        } catch { }
    }

    function write(entry = {}) {
        const record = sanitize({
            t: new Date().toISOString(),
            actor: entry.actor || 'admin',
            channel: entry.channel || 'web',
            session: entry.sessionId ? maskString(entry.sessionId, 12) : '',
            chat: entry.chatId ? maskString(entry.chatId, 24) : '',
            opId: entry.opId || '',
            confirmId: entry.confirmId || '',
            requestId: entry.requestId || '',
            skill: entry.skill || '',
            target: entry.target || '',
            args: entry.args || undefined,
            outcome: entry.outcome || 'ok',
            code: entry.code || '',
            ms: Number.isFinite(entry.ms) ? entry.ms : undefined,
            error: entry.error || undefined,
            result: entry.result || undefined
        });
        if (!enabled()) return Promise.resolve(null);
        queue = queue.then(async () => {
            try {
                await fs.promises.mkdir(path.dirname(file), { recursive: true });
                rotateIfNeeded();
                await fs.promises.appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
                lastError = '';
            } catch (e) {
                lastError = e.message;
                log('[Audit] gagal menulis catatan: ' + e.message);
            }
            return record;
        }).catch(() => { });
        return queue;
    }

    async function tail(n = 50) {
        try {
            const txt = await fs.promises.readFile(file, 'utf8');
            return txt.trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, n)))
                .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { return []; }
    }

    return { write, tail, file, enabled, lastError: () => lastError, sanitize, maskString };
};

module.exports.sanitize = sanitize;
module.exports.maskString = maskString;
