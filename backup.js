'use strict';
// ============================================================================
// backup.js — cadangan konfigurasi & data pengguna SEBELUM upgrade.
//
//   npm run backup          (atau: node backup.js)
//
// Yang dicadangkan (hanya dibaca, tidak pernah diubah/dihapus):
//   .env                      konfigurasi (password admin, ESP, Telegram, AI)
//   data/*.json, data/*.log   kalibrasi, kartu pintu, jadwal, riwayat, audit,
//                             perangkat mobile terdaftar
//
// Hasil: backups/<YYYYMMDD-HHMMSS>/{.env,data/...,manifest.json}
// Berkas sesi mobile (data/mobile-sessions.json) TIDAK disalin: isinya hanya hash
// token yang bisa dibuat ulang dengan login biometrik, dan menyalinnya tidak perlu.
//
// Flash disk (folder upload) sengaja tidak disalin: isinya milik pengguna di volume
// terpisah dan bisa sangat besar. Backup manual tetap disarankan bila perlu.
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SKIP = new Set(['mobile-sessions.json']);   // hash token sesi: tidak perlu dicadangkan

function git(args) {
    try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
}

function stamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copy(file, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    try { fs.chmodSync(dest, 0o600); } catch { /* filesystem tanpa izin unix */ }
    const st = fs.statSync(dest);
    return { path: path.relative(ROOT, dest), bytes: st.size, sha256: sha256(dest) };
}

function main() {
    const dir = path.join(ROOT, 'backups', stamp());
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    const env = path.join(ROOT, '.env');
    if (fs.existsSync(env)) files.push(copy(env, path.join(dir, '.env')));
    else console.log('[Backup] .env belum ada (server masih mode setup) - dilewati.');

    const dataDir = path.join(ROOT, 'data');
    if (fs.existsSync(dataDir)) {
        for (const name of fs.readdirSync(dataDir).sort()) {
            if (SKIP.has(name) || name.endsWith('.tmp')) continue;
            const src = path.join(dataDir, name);
            if (!fs.statSync(src).isFile()) continue;
            files.push(copy(src, path.join(dir, 'data', name)));
        }
    } else {
        console.log('[Backup] folder data/ belum ada - dilewati.');
    }

    const manifest = {
        createdAt: new Date().toISOString(),
        app: (() => { try { return require('./package.json').version || ''; } catch { return ''; } })(),
        node: process.version,
        platform: process.platform,
        commit: git(['rev-parse', 'HEAD']),
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        localChanges: git(['status', '--porcelain']).split('\n').filter(Boolean),
        files
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`[Backup] selesai: ${path.relative(ROOT, dir)}`);
    console.log(`[Backup] ${files.length} berkas dicadangkan (`.concat(files.reduce((n, f) => n + f.bytes, 0), ' byte).'));
    if (manifest.localChanges.length) {
        console.log(`[Backup] PERHATIAN: ada ${manifest.localChanges.length} perubahan lokal yang belum di-commit.`);
        console.log('[Backup] Periksa sebelum menjalankan `git pull` agar tidak tertimpa/bentrok.');
    }
    console.log('[Backup] Lanjutkan upgrade sesuai docs/UPGRADE.md.');
    return dir;
}

if (require.main === module) {
    try { main(); }
    catch (e) { console.error('[Backup] gagal:', e.message); process.exitCode = 1; }
}

module.exports = { main, stamp };
