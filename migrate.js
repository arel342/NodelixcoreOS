// Pindahkan isi folder ./uploads (penyimpanan internal lama) ke flash disk.
//   node migrate.js          -> salin saja (aman)
//   node migrate.js --hapus  -> salin, lalu hapus yang di internal (hanya jika semua berhasil disalin)
const fs = require('fs'), path = require('path');
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const storage = require('./storage');

(async () => {
    const src = path.join(__dirname, 'uploads');
    const items = fs.existsSync(src) ? fs.readdirSync(src) : [];
    if (!items.length) return console.log('Tidak ada file di', src);
    const st = await storage.status();
    if (!st.ready) return console.log('Penyimpanan belum siap:', st.message);
    console.log(`Menyalin ${items.length} item ke ${st.root} (bisa lama untuk file besar)...`);
    try { await storage.importFrom(src, items); } catch (e) { return console.log('Gagal:', e.message, '\nTidak ada yang dihapus.'); }
    console.log('Selesai disalin.');
    if (process.argv.includes('--hapus')) {
        items.forEach(i => fs.rmSync(path.join(src, i), { recursive: true, force: true }));
        console.log('File lama di penyimpanan internal sudah dihapus.');
    } else console.log('File lama di internal belum dihapus. Cek di dashboard, lalu jalankan: node migrate.js --hapus');
})();
