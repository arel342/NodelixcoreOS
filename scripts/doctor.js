#!/usr/bin/env node
'use strict';
// ============================================================================
// doctor.js — pemeriksa mandiri sebelum `npm start`.
//
// Menjawab pertanyaan: "kenapa `npm start` tidak bisa jalan?" tanpa perlu
// membaca kode. Skrip ini TIDAK menyalakan server dan TIDAK mengubah berkas;
// hanya membaca konfigurasi lalu mencoba hal-hal yang aman (bind port, tulis
// berkas uji kecil yang langsung dihapus).
//
// Pakai:  npm run doctor
//         npm run doctor -- --port 3001     (periksa port lain)
//
// Kode keluar: 0 = tidak ada masalah fatal, 1 = ada masalah yang membuat
// `npm start` gagal.
// ============================================================================
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argPort = (() => {
    const i = argv.indexOf('--port');
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
})();

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => useColor ? `\u001b[${code}m${s}\u001b[0m` : s;
const OK = c(32, '[ OK ]');
const WARN = c(33, '[WARN]');
const BAD = c(31, '[FAIL]');
const INFO = c(36, '[INFO]');

const problems = [];   // fatal: membuat server tidak bisa/berbahaya dijalankan
const warnings = [];   // tidak fatal, tapi sebaiknya diperbaiki

function line(status, title, detail) {
    console.log(`${status} ${title}${detail ? ' — ' + detail : ''}`);
}
function fail(title, detail, fix) {
    line(BAD, title, detail);
    problems.push({ title, detail, fix });
}
function warn(title, detail, fix) {
    line(WARN, title, detail);
    warnings.push({ title, detail, fix });
}

// ---------- .env (dibaca sama seperti server.js) ----------
const ENV_FILE = path.join(ROOT, '.env');
function readEnvFile(file) {
    const map = new Map();
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m) map.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
    }
    return map;
}
let envMap = new Map();
function env(key, def = '') {
    const v = process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : envMap.get(key);
    return v === undefined || v === '' ? def : v;
}
const isTrue = v => String(v).toLowerCase() === 'true';

// ---------- Cari pemilik port lewat /proc (Linux/Termux) ----------
function portOwner(port) {
    const found = [];
    try {
        const inodes = new Set();
        for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
            let txt;
            try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
            for (const row of txt.split('\n').slice(1)) {
                const cols = row.trim().split(/\s+/);
                if (cols.length < 10) continue;
                const local = cols[1] || '';
                const hexPort = local.split(':').pop();
                if (parseInt(hexPort, 16) !== port) continue;
                if (cols[3] !== '0A') continue;            // 0A = LISTEN
                inodes.add(cols[9]);
            }
        }
        if (!inodes.size) return found;
        for (const pid of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(pid)) continue;
            let fds;
            try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
            for (const fd of fds) {
                let target;
                try { target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
                const m = target.match(/^socket:\[(\d+)\]$/);
                if (m && inodes.has(m[1])) {
                    let cmd = '';
                    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { }
                    found.push({ pid: Number(pid), cmd });
                    break;
                }
            }
        }
    } catch { /* /proc tidak tersedia — bukan masalah fatal */ }
    return found;
}

function moduleVersion(name) {
    try {
        const pkg = require.resolve(`${name}/package.json`, { paths: [ROOT] });
        return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
    } catch {
        return null;
    }
}

function main() {
    console.log('=========================================================');
    console.log(' Doctor NodelixcoreOS — pemeriksaan sebelum `npm start`');
    console.log('=========================================================');
    console.log(`Folder  : ${ROOT}`);
    console.log(`Waktu   : ${new Date().toString()}`);
    console.log('');

    // ---------- 1. Runtime ----------
    console.log('— Runtime —');
    const need = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines.node || '>=18.17'; }
        catch { return '>=18.17'; }
    })();
    const v = process.versions.node.split('.').map(Number);
    const min = [18, 17, 0];
    if (v[0] < min[0] || (v[0] === min[0] && (v[1] < min[1] || (v[1] === min[1] && v[2] < min[2])))) {
        fail('Versi Node terlalu lama', `${process.versions.node} (butuh ${need})`,
            'Perbarui Node: pkg install nodejs-lts (Termux) atau unduh Node 20/22 dari nodejs.org');
    } else {
        line(OK, 'Versi Node', `${process.versions.node} (butuh ${need})`);
    }
    const npmVer = (() => {
        const r = spawnSync('npm', ['-v'], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.trim() : null;
    })();
    line(npmVer ? OK : WARN, 'npm', npmVer || 'tidak terdeteksi di PATH');
    line(INFO, 'Sistem', `${os.type()} ${os.release()} ${os.arch()}, user ${os.userInfo().username}, cwd ${process.cwd()}`);

    // ---------- 2. Dependensi ----------
    console.log('');
    console.log('— Dependensi —');
    let depsOk = true;
    for (const dep of ['express', 'ws', 'multer']) {
        const ver = moduleVersion(dep);
        if (ver) line(OK, dep, ver);
        else {
            depsOk = false;
            fail(`Modul "${dep}" tidak ditemukan`, 'node_modules belum ada / instalasi gagal',
                'Jalankan: npm install   (harus di folder yang sama dengan package.json)');
        }
    }
    if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
        line(INFO, 'package-lock.json', 'ada — gunakan npm install (bukan npm ci yang menghapus node_modules)');
    }

    // ---------- 3. Berkas proyek ----------
    console.log('');
    console.log('— Berkas proyek —');
    const serverFile = path.join(ROOT, 'server.js');
    if (!fs.existsSync(serverFile)) {
        fail('server.js tidak ada', serverFile,
            'Pastikan Anda berada di folder project (cd ~/NodelixcoreOS), bukan folder induk.');
    } else {
        line(OK, 'server.js', 'ada');
        const chk = spawnSync(process.execPath, ['--check', serverFile], { encoding: 'utf8' });
        if (chk.status !== 0) {
            fail('server.js gagal di-parse', (chk.stderr || '').split('\n').slice(0, 4).join(' | '),
                'Berkas rusak/terpotong. Ambil ulang project: git pull, atau unduh ulang ZIP rilis.');
        } else {
            line(OK, 'Sintaks server.js', 'valid');
        }
    }
    // Termux: project di penyimpanan bersama Android (/sdcard) tidak bisa memasang
    // node_modules dengan benar — FUSE menolak symlink & izin, npm install gagal separuh.
    if (/^\/(?:storage|sdcard|mnt\/sdcard|mnt\/media_rw|mnt\/runtime)\//.test(ROOT + '/')) {
        fail('Project berada di penyimpanan bersama Android', ROOT,
            'Pindahkan ke penyimpanan internal Termux, lalu pasang ulang:\n' +
            '         mv ' + ROOT + ' ~/NodelixcoreOS && cd ~/NodelixcoreOS && npm install\n' +
            '         (di /sdcard, FUSE menolak symlink/izin sehingga node_modules gagal dibuat)');
    }
    try {
        fs.accessSync(ROOT, fs.constants.W_OK);
        line(OK, 'Folder project', 'bisa ditulis (syarat npm install)');
    } catch {
        fail('Folder project tidak bisa ditulis', ROOT,
            'Perbaiki kepemilikan/izin: chmod u+w ' + ROOT + '   (npm install butuh menulis node_modules)');
    }
    if (!depsOk && fs.existsSync(path.join(ROOT, 'node_modules'))) {
        warn('node_modules ada tapi tidak lengkap', 'kemungkinan npm install terputus',
            'Hapus lalu pasang ulang: rm -rf node_modules && npm install');
    }

    // ---------- 4. .env ----------
    console.log('');
    console.log('— Konfigurasi (.env) —');
    if (!fs.existsSync(ENV_FILE)) {
        line(INFO, '.env belum ada', 'normal pada instalasi baru — server masuk mode setup awal');
    } else {
        try {
            envMap = readEnvFile(ENV_FILE);
            line(OK, '.env terbaca', `${envMap.size} variabel`);
        } catch (e) {
            fail('.env tidak dapat dibaca', e.message, 'Periksa izin berkas: ls -l .env (harus bisa dibaca user ini)');
        }
        try {
            const st = fs.statSync(ENV_FILE);
            if (st.mode & 0o077) warn('.env dapat dibaca user lain', `mode ${(st.mode & 0o777).toString(8)}`,
                'Rapatkan izin: chmod 600 .env');
        } catch { }
        // Baris yang mirip tapi tidak sesuai format akan diabaikan server tanpa pesan.
        const bad = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
            .map((s, i) => ({ s, i: i + 1 }))
            .filter(({ s }) => s.trim() && !s.trim().startsWith('#') && !/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(s));
        if (bad.length) {
            warn('Baris .env tidak dikenali', `baris ${bad.map(b => b.i).join(', ')} (diabaikan server)`,
                'Format harus KEY=nilai tanpa spasi sebelum KEY; hapus/kutip nilai yang berisi spasi.');
        }
    }

    // ---------- 5. Transport HTTP lokal ----------
    console.log('');
    console.log('— Transport web (HTTP) —');
    line(OK, 'Mode transport', 'HTTP lokal (tanpa sertifikat)');

    // ---------- 6. Validasi keamanan yang sama dengan startup ----------
    console.log('');
    console.log('— Validasi startup (server.js menolak jalan bila gagal) —');
    const pwd = env('ADMIN_PASSWORD', '');
    if (pwd && pwd.length < 8) {
        fail('ADMIN_PASSWORD terlalu pendek', `${pwd.length} karakter (minimal 8)`,
            'Ganti di .env (ADMIN_PASSWORD=...) atau lewat tab Pengaturan setelah login.');
    } else {
        line(OK, 'ADMIN_PASSWORD', pwd ? 'memenuhi syarat' : 'belum diisi (mode setup awal)');
    }
    if (isTrue(env('TRUST_PROXY', ''))) {
        warn('TRUST_PROXY=true tidak aman', 'nilai ini akan diabaikan server',
            'Gunakan daftar IP/CIDR: TRUST_PROXY=127.0.0.1');
    }
    for (const [key, max] of [['SESSION_TTL_HOURS', 720], ['MOBILE_SESSION_TTL_HOURS', 720]]) {
        const n = Number(env(key, ''));
        if (Number.isFinite(n) && n > max) {
            fail(`${key} terlalu besar`, `${n} (maks ${max})`,
                `Sesuaikan ${key} di .env, mis. ${key}=72`);
        }
    }

    // ---------- 7. Port web ----------
    console.log('');
    console.log('— Port web —');
    const rawPort = argPort || env('PORT', '3000');
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        fail('PORT tidak valid', String(rawPort), 'Isi PORT dengan angka 1–65535, mis. PORT=3000');
    } else {
        const r = checkPortSync(port);
        if (r.ok) {
            line(OK, `Port ${port}`, 'bisa dipakai (bind 0.0.0.0 berhasil)');
        } else if (r.code === 'EADDRINUSE') {
            const who = r.who ? ` — dipakai ${r.who}` : '';
            fail(`Port ${port} sudah dipakai`, 'EADDRINUSE' + who,
                `Hentikan server lama: pkill -f "node server.js"  (atau matikan sesi Termux lain)\n` +
                `         Lalu cek: ss -ltnp 2>/dev/null | grep ${port}   dan jalankan npm start lagi.\n` +
                '         Alternatif: pakai port lain di .env, mis. PORT=3001');
        } else if (r.code === 'EACCES') {
            fail(`Tidak berhak memakai port ${port}`, 'EACCES',
                'Port < 1024 butuh root. Gunakan port >= 1024, mis. PORT=3000.');
        } else {
            warn(`Port ${port} tidak bisa diuji`, r.message || r.code || 'alasan tidak diketahui',
                'Coba lagi; bila berlanjut, pakai port lain.');
        }
    }

    // ---------- 8. Folder data ----------
    console.log('');
    console.log('— Penyimpanan runtime —');
    const dataDir = path.join(ROOT, 'data');
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        const probe = path.join(dataDir, `.doctor-${process.pid}.tmp`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        line(OK, 'Folder data', `${dataDir} (bisa ditulis)`);
    } catch (e) {
        fail('Folder data tidak bisa ditulis', e.message,
            'Perbaiki izin: chmod -R u+rw data   (atau jalankan dari folder milik user ini)');
    }

    const storageMode = env('STORAGE_MODE', process.getuid && process.getuid() === 0 ? 'direct' : 'root');
    const storageDevice = env('STORAGE_DEVICE', '');
    if (!storageDevice) {
        line(INFO, 'Flash disk (STORAGE_DEVICE)', 'belum diisi — upload/firmware ke flash disk tidak aktif (tidak fatal)');
    } else {
        line(INFO, 'Mode penyimpanan', `${storageMode}, device ${storageDevice}`);
        if (!fs.existsSync(storageDevice)) {
            warn('STORAGE_DEVICE tidak ditemukan', storageDevice,
                'Colok ulang flash disk atau perbarui STORAGE_DEVICE (lihat output: mount | grep media_rw).');
        }
        if (storageMode === 'root') {
            const su = ['/system/bin/su', '/system/xbin/su', '/sbin/su', '/debug_ramdisk/su', '/su/bin/su']
                .find(p => fs.existsSync(p));
            if (su) line(OK, 'Binary su', su);
            else warn('su tidak ditemukan', 'Mode root butuh akses root (Termux biasa tanpa root tidak bisa)',
                'Set STORAGE_MODE=direct bila server dijalankan sebagai root, atau isi STORAGE_DEVICE dengan folder biasa.');
        }
    }

    // ---------- Ringkasan ----------
    console.log('');
    console.log('=========================================================');
    if (!problems.length) {
        console.log(c(32, 'Tidak ada masalah fatal. `npm start` seharusnya bisa berjalan.'));
        if (warnings.length) console.log(`Ada ${warnings.length} peringatan (tidak menghalangi start).`);
    } else {
        console.log(c(31, `Ditemukan ${problems.length} masalah yang membuat \`npm start\` gagal:`));
        problems.forEach((p, i) => {
            console.log('');
            console.log(`${i + 1}. ${p.title}${p.detail ? ' — ' + p.detail : ''}`);
            if (p.fix) console.log(`   → ${p.fix}`);
        });
    }
    if (warnings.length) {
        console.log('');
        console.log('Peringatan:');
        warnings.forEach((p, i) => {
            console.log(`${i + 1}. ${p.title}${p.detail ? ' — ' + p.detail : ''}`);
            if (p.fix) console.log(`   → ${p.fix}`);
        });
    }
    console.log('=========================================================');
    console.log('Jika semua OK tetapi `npm start` tetap gagal, salin seluruh');
    console.log('output terminal (termasuk baris error) untuk diperiksa.');
    return problems.length ? 1 : 0;
}

// Pemeriksaan port dijalankan di proses anak agar main() tetap sinkron.
function checkPortSync(port) {
    const fd = spawnSync;
    const code = `
        const net = require('net');
        const srv = net.createServer();
        srv.once('error', e => { console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })); process.exit(0); });
        srv.listen(${port}, '0.0.0.0', () => srv.close(() => { console.log(JSON.stringify({ ok: true })); }));
    `;
    const r = fd(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
    let res;
    try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
    catch { return { ok: false, code: 'UNKNOWN', message: (r.stderr || '').trim() || 'pemeriksaan port gagal' }; }
    if (!res.ok && res.code === 'EADDRINUSE') {
        const owners = portOwner(port);
        res.who = owners.length ? owners.map(o => `PID ${o.pid}${o.cmd ? ' (' + o.cmd + ')' : ''}`).join(', ') : null;
    }
    return res;
}

process.exitCode = main();
