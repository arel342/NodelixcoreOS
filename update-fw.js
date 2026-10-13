#!/usr/bin/env node
// Menu update firmware ESP dari Termux (tanpa membuka web).
//
//   node update-fw.js          atau      npm run update-fw
//
// Menu -> pilih ESP8266 (pintu) / ESP32 (monitor) -> masukkan path file .bin.
// Kalau file yang dipilih bukan .bin (atau isinya bukan gambar firmware ESP), muncul peringatan
// dan file itu tidak dikirim. Alamat/API key perangkat dibaca dari .env, jadi isi dulu DOOR_IP /
// ESP32_IP beserta API key-nya seperti saat memakai web.
//
// Opsi tanpa menu (langsung kirim):
//   node update-fw.js esp8266 ~/storage/downloads/esp8266.bin
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ---------- .env (sama seperti server.js: tanpa dependency tambahan) ----------
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}
const E = (k, d = '') => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };

const fw = require('./firmware');
const T = require('./lang');

const MENU = [
    { key: 'esp8266', title: 'ESP8266  (pintu RFID / lock door)', env: 'DOOR_IP' },
    { key: 'esp32', title: 'ESP32    (monitor PLTS)', env: 'ESP32_IP' }
];
const fmt = b => `${(b / 1024).toFixed(1)} KB`;
const line = '-' .repeat(58);

const warna = (kode, s) => `${kode}${s}\x1b[0m`;

// Baris masukan diantre sendiri (readline.question bawaan kehilangan jawaban kalau input
// dikirim sekaligus lewat pipe). ask() mengembalikan \"\" saat kosong dan null saat input habis.
const rl = readline.createInterface({ input: process.stdin });
const antre = [], tunggu = [];
let habis = false;
rl.on('line', l => { const w = tunggu.shift(); if (w) w(l); else antre.push(l); });
rl.on('close', () => { habis = true; while (tunggu.length) tunggu.shift()(null); });
rl.on('SIGINT', () => { rl.close(); console.log('\nDibatalkan.'); process.exit(130); });
function ask(q) {
    process.stdout.write(q);
    if (antre.length) return Promise.resolve(antre.shift());
    if (habis) return Promise.resolve(null);
    return new Promise(res => tunggu.push(res));
}
const ya = a => /^(y|ya)$/i.test(String(a == null ? '' : a).trim());

// ---------- pilih file .bin ----------
function expand(p) {
    p = String(p || '').trim().replace(/^['"]|['"]$/g, '');                      // buang tanda kutip
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    return path.resolve(p);
}

// Folder -> tampilkan daftar .bin di dalamnya supaya tinggal pilih nomornya
function daftarBin(dir) {
    let items = [];
    try { items = fs.readdirSync(dir).filter(f => /\.bin$/i.test(f)); } catch { return []; }
    return items.map(f => path.join(dir, f));
}

async function pilihFile(prompt) {
    while (true) {
        const jawab = await ask(prompt);
        if (jawab === null) return null;                       // input habis (Ctrl+D / pipe selesai)
        const raw = jawab.trim();
        if (!raw) { console.log('  (kosong) Tulis path file .bin, atau ketik batal.'); continue; }
        if (/^(batal|cancel|q|kembali)$/i.test(raw)) return null;
        let p = expand(raw);

        let st = null;
        try { st = fs.statSync(p); } catch { }
        if (!st) { console.log(warna('\x1b[31m', `  Peringatan: file "${p}" tidak ditemukan.`)); continue; }
        if (st.isDirectory()) {
            const bins = daftarBin(p);
            if (!bins.length) { console.log(warna('\x1b[33m', `  Tidak ada file .bin di folder ${p}`)); continue; }
            bins.forEach((f, i) => console.log(`   ${i + 1}) ${path.basename(f)}  (${fmt(fs.statSync(f).size)})`));
            const pilih = await ask('  Pilih nomor file (0 = batal): ');
            if (pilih === null) return null;
            const n = parseInt(pilih.trim(), 10);
            if (!n) return null;
            if (!(n >= 1 && n <= bins.length)) { console.log(warna('\x1b[31m', '  Peringatan: nomor tidak ada di daftar.')); continue; }
            return bins[n - 1];
        }
        if (!/\.bin$/i.test(p)) {
            // PERINGATAN: file bukan .bin -> tanya dulu sebelum dikirim
            console.log(warna('\x1b[33m', `  ⚠ PERINGATAN: "${path.basename(p)}" bukan file .bin.`));
            console.log(warna('\x1b[33m', '    Firmware ESP hasil kompilasi Arduino selalu berekstensi .bin.'));
            const lanjut = await ask('    Tetap coba kirim file ini? (y/N): ');
            if (lanjut === null) return null;
            if (!ya(lanjut)) continue;
        }
        return p;
    }
}

// ---------- kirim ke ESP ----------
async function kirim(device, file) {
    const d = MENU.find(m => m.key === device);
    const buf = fs.readFileSync(file);
    console.log(line);
    console.log(`  Perangkat : ${d.title}`);
    console.log(`  Alamat    : ${E(d.env, '(belum diisi di .env)')}`);
    console.log(`  File      : ${path.basename(file)} (${fmt(buf.length)})`);
    console.log(line);

    const cek = fw.checkFile(path.basename(file), buf);
    if (!cek.ok) {
        console.log(warna('\x1b[33m', `  ⚠ ${cek.message}`));
        if (cek.code === 'ext') console.log(warna('\x1b[33m', '    (kunci API/alamat tetap tidak diubah, jadi kirim hanya kalau kamu yakin filenya benar)'));
        const lanjut = await ask('  Kirim tetap? (y/N): ');
        if (!ya(lanjut)) return false;
    }
    if (buf.length > fw.maxBytes()) {
        console.log(warna('\x1b[31m', `  File terlalu besar (maksimal ${N('OTA_MAX_MB', 4)} MB, lihat OTA_MAX_MB di .env).`));
        return false;
    }
    if (!E(d.env, '')) {
        console.log(warna('\x1b[31m', `  ${d.env} belum diisi di .env, jadi perangkat tidak bisa dihubungi.`));
        return false;
    }

    const mulai = Date.now();
    let pesan = 'Menyiapkan…';
    const tick = setInterval(() => {
        const s = Math.round((Date.now() - mulai) / 1000);
        process.stdout.write(`\r  ${pesan}  (${s}s)   `);
    }, 1000);
    let hasil = null, err = null;
    try {
        hasil = await fw.flash(device, buf, { onPhase: p => { pesan = p.message || p.phase; } });
    } catch (e) { err = e; }
    clearInterval(tick);
    process.stdout.write('\r' + ' '.repeat(70) + '\r');

    if (err) { console.log(warna('\x1b[31m', `  ✗ Gagal: ${err.message}`)); return true; }
    console.log(warna('\x1b[32m', `  ✓ ${T('fw.doneMsg', { dev: d.title.trim() })}${hasil.fw ? T('fw.okFw', { fw: hasil.fw }) : ''} (${Math.round(hasil.ms / 1000)}s)`));
    if (hasil.warning) console.log(warna('\x1b[33m', `  ⚠ ${hasil.warning}`));
    return true;
}

async function menu() {
    console.log('');
    console.log('==========================================================');
    console.log('        NodelixcoreOS - Update Firmware ESP (OTA)');
    console.log('==========================================================');
    MENU.forEach((m, i) => console.log(`  ${i + 1}) ${m.title}${E(m.env, '') ? '' : warna('\x1b[33m', `   [${m.env} belum diisi di .env]`)}`));
    console.log('  0) Keluar');
    console.log(line);
    const jawab = await ask('Pilih menu [0-2]: ');
    if (jawab === null) return false;
    const pilih = jawab.trim();
    if (/^(0|q|keluar|exit)$/i.test(pilih)) return false;
    const idx = parseInt(pilih, 10);
    if (!(idx >= 1 && idx <= MENU.length)) { console.log('Pilihan tidak valid.'); return true; }

    const dev = MENU[idx - 1].key;
    const file = await pilihFile(`Path file .bin untuk ${dev} (ketik batal untuk kembali): `);
    if (!file) return true;
    await kirim(dev, file);

    console.log('');
    const ulang = await ask('Update firmware lagi? (y/N): ');
    return ulang === null ? false : ya(ulang);
}

(async () => {
    // Mode langsung: node update-fw.js <esp8266|esp32> <file.bin>
    const [argDev, argFile] = process.argv.slice(2);
    try {
        if (argDev) {
            if (!fw.isDevice(argDev)) {
                console.log(`Perangkat tidak dikenal: ${argDev}. Pakai esp8266 atau esp32.`);
                process.exitCode = 1;
                return;
            }
            if (!argFile) { console.log('Sertakan path file .bin: node update-fw.js ' + argDev + ' /path/firmware.bin'); process.exitCode = 1; return; }
            const p = expand(argFile);
            if (!fs.existsSync(p)) { console.log('File tidak ditemukan: ' + p); process.exitCode = 1; return; }
            await kirim(argDev, p);
            return;
        }
        while (await menu()) { /* ulangi menu sampai user keluar */ }
        console.log('Selesai.');
    } catch (e) {
        console.log('Gagal: ' + (e && e.message ? e.message : e));
        process.exitCode = 1;
    } finally {
        rl.close();
    }
})();
