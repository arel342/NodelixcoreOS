// ============================================================================
// confirm.js — konfirmasi tindakan sensitif yang DITEGAKKAN SERVER.
//
// Instruksi di prompt ("jangan buka pintu tanpa konfirmasi") sebelumnya hanya
// imbauan. Modul ini menyimpan permintaan konfirmasi nyata dengan:
//   • ID unik dan masa berlaku (CONFIRM_TTL_S, default 300 detik)
//   • ikatan pada aktor + kanal + sesi web ATAU chat Telegram peminta
//   • sekali pakai (pending -> executing -> done/failed, tidak bisa diulang)
//   • pembatalan eksplisit
//   • penolakan bila kedaluwarsa atau identitas berbeda
//
// Persetujuan HANYA boleh berasal dari aksi pengguna yang diverifikasi backend:
// tombol di web (sesi login) atau callback Telegram dari chat admin. Model tidak
// pernah bisa menyetujui tindakannya sendiri; argumen seperti `approved: true`
// tidak dibaca di mana pun.
// ============================================================================
const crypto = require('crypto');

class ConfirmError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'ConfirmError';
        this.code = code;
        this.status = status || 400;
    }
}

const STATES = ['pending', 'executing', 'done', 'failed', 'cancelled'];

module.exports = function createConfirmStore({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    now = () => Date.now(),
    log = console.log
} = {}) {
    const items = new Map();
    let seq = 0;

    function ttlMs() {
        const s = Number(env('CONFIRM_TTL_S', '300'));
        return (Number.isFinite(s) ? Math.max(30, Math.min(3600, s)) : 300) * 1000;
    }

    function view(rec) {
        return {
            id: rec.id,
            skill: rec.skill,
            summary: rec.summary,
            target: rec.target,
            channel: rec.channel,
            status: rec.status,
            createdAt: rec.createdAt,
            expiresAt: rec.expiresAt,
            expiresIn: Math.max(0, Math.ceil((rec.expiresAt - now()) / 1000)),
            meta: rec.meta || {}
        };
    }

    function get(id) {
        const rec = items.get(String(id || ''));
        if (!rec) return null;
        if (rec.status === 'pending' && rec.expiresAt <= now()) rec.status = 'expired';
        return rec;
    }

    function requirePending(rec) {
        if (!rec) throw new ConfirmError('Konfirmasi tidak ditemukan atau sudah dibersihkan.', 'CONFIRM_NOT_FOUND', 404);
        if (rec.status === 'expired') throw new ConfirmError('Konfirmasi sudah kedaluwarsa. Jalankan ulang permintaannya bila masih perlu.', 'CONFIRM_EXPIRED', 410);
        if (rec.status === 'cancelled') throw new ConfirmError('Konfirmasi sudah dibatalkan.', 'CONFIRM_CANCELLED', 409);
        if (rec.status === 'executing' || rec.status === 'done' || rec.status === 'failed')
            throw new ConfirmError('Konfirmasi ini sudah dipakai. Minta tindakan baru bila perlu diulang.', 'CONFIRM_USED', 409);
        if (rec.status !== 'pending') throw new ConfirmError('Konfirmasi tidak dapat dipakai lagi.', 'CONFIRM_USED', 409);
    }

    // Identitas yang dicocokkan berasal dari server (sesi login / chat Telegram),
    // bukan dari argumen model.
    function assertIdentity(rec, ident = {}) {
        if (!rec) throw new ConfirmError('Konfirmasi tidak ditemukan atau sudah dibersihkan.', 'CONFIRM_NOT_FOUND', 404);
        const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
        if (rec.actor && ident.actor && !same(rec.actor, ident.actor))
            throw new ConfirmError('Konfirmasi ini milik pengguna lain.', 'CONFIRM_IDENTITY', 403);
        if (rec.channel && ident.channel && !same(rec.channel, ident.channel))
            throw new ConfirmError('Konfirmasi ini diminta dari kanal lain (web/Telegram).', 'CONFIRM_IDENTITY', 403);
        if (rec.sessionId && !same(rec.sessionId, ident.sessionId))
            throw new ConfirmError('Konfirmasi ini terikat pada sesi web lain. Login ulang lalu ulangi permintaan.', 'CONFIRM_IDENTITY', 403);
        if (rec.chatId && !same(rec.chatId, ident.chatId))
            throw new ConfirmError('Konfirmasi ini terikat pada chat Telegram lain.', 'CONFIRM_IDENTITY', 403);
        if (!rec.sessionId && !rec.chatId && !ident.sessionId && !ident.chatId)
            throw new ConfirmError('Identitas peminta tidak tersedia; konfirmasi ditolak.', 'CONFIRM_IDENTITY', 403);
        return true;
    }

    function create(opts = {}) {
        const id = (++seq).toString(36).padStart(2, '0') + crypto.randomBytes(8).toString('hex');
        const t = now();
        const rec = {
            id,
            skill: String(opts.skill || ''),
            args: opts.args || {},
            summary: String(opts.summary || '').slice(0, 500),
            target: String(opts.target || '').slice(0, 200),
            actor: String(opts.actor || 'admin'),
            channel: String(opts.channel || 'web'),
            sessionId: opts.sessionId ? String(opts.sessionId) : '',
            chatId: opts.chatId ? String(opts.chatId) : '',
            requestId: opts.requestId ? String(opts.requestId) : '',
            meta: opts.meta || {},
            status: 'pending',
            createdAt: t,
            expiresAt: t + ttlMs(),
            usedAt: null,
            result: null
        };
        items.set(id, rec);
        log(`[Konfirmasi] dibuat ${id} (${rec.channel}) untuk ${rec.skill}: ${rec.summary}`);
        return rec;
    }

    // Setujui + klaim sekaligus (atomik). Status langsung menjadi 'executing' supaya
    // klik ganda / kirim ulang tidak menjalankan tindakan dua kali.
    function approve(id, ident = {}) {
        const rec = get(id);
        assertIdentity(rec, ident);
        requirePending(rec);
        rec.status = 'executing';
        rec.usedAt = now();
        rec.approvedBy = { actor: ident.actor || rec.actor, channel: ident.channel || rec.channel };
        log(`[Konfirmasi] disetujui ${rec.id} oleh ${rec.approvedBy.actor}/${rec.approvedBy.channel}`);
        return rec;
    }

    function cancel(id, ident = {}) {
        const rec = get(id);
        assertIdentity(rec, ident);
        requirePending(rec);
        rec.status = 'cancelled';
        rec.cancelledAt = now();
        log(`[Konfirmasi] dibatalkan ${rec.id}`);
        return rec;
    }

    function complete(id, { ok = false, result = null, error = null } = {}) {
        const rec = items.get(String(id || ''));
        if (!rec) return null;
        rec.status = ok ? 'done' : 'failed';
        rec.completedAt = now();
        rec.result = result;
        rec.error = error ? String(error).slice(0, 500) : null;
        return rec;
    }

    function list(ident = {}) {
        const out = [];
        for (const rec of items.values()) {
            try {
                assertIdentity(rec, ident);
                if (rec.status === 'pending') out.push(view(rec));
            } catch { }
        }
        return out.sort((a, b) => b.createdAt - a.createdAt);
    }

    const RETENTION_MS = 15 * 60 * 1000;
    const sweeper = setInterval(() => {
        const t = now();
        for (const [id, rec] of items) {
            if (rec.expiresAt + RETENTION_MS < t || rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled') {
                if (rec.expiresAt + RETENTION_MS < t) items.delete(id);
            }
        }
    }, 60000);
    if (sweeper.unref) sweeper.unref();

    return {
        create, get, view, approve, cancel, complete, list, assertIdentity,
        stats: () => {
            const all = [...items.values()];
            return { total: all.length, pending: all.filter(r => r.status === 'pending').length, states: STATES.slice() };
        },
        stop: () => clearInterval(sweeper),
        ttlMs
    };
};

module.exports.ConfirmError = ConfirmError;
