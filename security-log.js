// ============================================================================
// security-log.js — pencatatan audit keamanan (security audit trail).
//
// Mencatatan peristiwa keamanan penting ke data/security.log (JSON Lines):
//   login sukses/gagal, register/revokasi perangkat, token expired/revoked,
//   akses API ditolak, auth WebSocket gagal, upaya path traversal, operasi
//   perintah sensitif, perubahan konfigurasi keamanan.
//
// TIDAK MENCATAT password, token, kunci, atau rahasia. Nilai sensitif
// di-redact. Berkas dirotasi saat melebihi ukuran. Format JSON Lines agar
// mudah dianalisis (timestamp + event + detail + outcome).
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_BYTES = () => Math.max(1 << 20, Math.floor(num(process.env.SECURITY_LOG_MAX_KB, 4096)) * 1024);
const MAX_FILES = () => Math.max(1, Math.floor(num(process.env.SECURITY_LOG_FILES, 5)));
const REDACT = new Set(['password', 'token', 'sessionToken', 'sid', 'key', 'privateKey', 'apiKey', 'api_key', 'secret', 'nonce', 'signature', 'publicKeyPem']);

function num(v, dflt) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? n : dflt; }

function redact(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (REDACT.has(k)) { out[k] = '[REDACTED]'; continue; }
        out[k] = redact(v);
    }
    return out;
}

function createSecurityLog(opts = {}) {
    const file = opts.file || path.join(__dirname, 'data', 'security.log');
    const quiet = opts.quiet === true;
    let writing = Promise.resolve();

    function rotate() {
        try {
            if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES()) return;
            for (let i = MAX_FILES() - 1; i >= 1; i--) {
                const src = file + '.' + i, dst = file + '.' + (i + 1);
                try { fs.renameSync(src, dst); } catch { }
            }
            fs.renameSync(file, file + '.1');
        } catch { /* rotasi gagal — abaikan, jangan hentikan server */ }
    }

    function write(event, details = {}, outcome = 'ok') {
        const rec = {
            ts: new Date().toISOString(),
            event: String(event || 'unknown').slice(0, 64),
            outcome: String(outcome || 'ok').slice(0, 16),
            ...redact(details || {})
        };
        const line = JSON.stringify(rec) + '\n';
        writing = writing.then(() => new Promise(resolve => {
            fs.appendFile(file, line, err => {
                if (!err) { rotate(); }
                else if (!quiet) { try { console.error('[SecurityLog] gagal menulis: ' + err.message); } catch { } }
                resolve();
            });
        })).catch(() => { /* jangan biarkan rantai promise rusak */ });
        return writing;
    }

    // Ringkasan ke console (tanpa rahasia).
    const consoleLog = (msg) => { if (!quiet) { try { console.log('[Security] ' + msg); } catch { } } };

    return {
        file,
        write,
        // Aksi umum — mencetak ke log & console.
        loginSuccess: (ip, user) => { write('login_success', { ip, user }); consoleLog(`login sukses: ${user} dari ${ip}`); },
        loginFail: (ip, user, reason) => { write('login_fail', { ip, user, reason }, 'fail'); consoleLog(`login gagal: ${user} dari ${ip} (${reason})`); },
        otpFail: (ip, reason) => { write('otp_fail', { ip, reason }, 'fail'); consoleLog(`OTP gagal: ${ip} (${reason})`); },
        mobileRegister: (deviceId, ip) => { write('mobile_register', { deviceId, ip }); consoleLog(`perangkat didaftarkan: ${deviceId} dari ${ip}`); },
        mobileRevoke: (deviceId, reason) => { write('mobile_revoke', { deviceId, reason }, 'revoked'); consoleLog(`perangkat dicabut: ${deviceId} (${reason})`); },
        sessionRevoke: (deviceId, reason) => { write('session_revoked', { deviceId, reason }, 'revoked'); },
        tokenExpired: (deviceId) => { write('token_expired', { deviceId }, 'expired'); },
        apiDenied: (ip, endpoint, reason) => { write('api_denied', { ip, endpoint, reason }, 'denied'); },
        wsAuthFail: (ip, reason) => { write('ws_auth_fail', { ip, reason }, 'fail'); consoleLog(`WS auth gagal: ${ip} (${reason})`); },
        pathTraversal: (ip, endpoint, detail) => { write('path_traversal', { ip, endpoint, detail }, 'denied'); consoleLog(`upaya path traversal: ${ip} ${endpoint}`); },
        commandOp: (ip, op, target) => { write('command_op', { ip, op, target }); },
        configChange: (what, detail) => { write('config_change', { what, detail }); consoleLog(`konfigurasi keamanan berubah: ${what}`); },
        rateLimited: (ip, endpoint) => { write('rate_limited', { ip, endpoint }, 'throttled'); },
        flush: () => writing
    };
}

module.exports = { createSecurityLog };
