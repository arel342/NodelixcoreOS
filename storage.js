// Penyimpanan file di flash disk lewat root (su).
// Server tetap jalan sebagai user Termux biasa dari penyimpanan internal;
// hanya perintah file (stat/cat/mv/cp/rm/mkdir) yang dijalankan lewat `su -c`.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const T = require('./lang');   // pesan error sesuai bahasa aktif (LANGUAGE di .env)
const DEVICE = E('STORAGE_DEVICE', '');
const FOLDER = E('STORAGE_FOLDER', 'upload');
// Volume dipilih saat runtime agar flash disk dengan ID mount berbeda tetap bisa dipakai.
const isMountPath = p => /^\/(?:mnt\/media_rw|mnt\/runtime\/(?:write|default)|mnt\/pass_through\/0|storage)\/[^/]+(?:\/|$)/.test(p);
let dev = DEVICE, ROOT = DEVICE ? DEVICE + '/' + FOLDER : '', mountRequired = isMountPath(DEVICE), lastDiag = '', okAt = 0, resolving = null;
// root = lewat su | direct = tanpa su (node sudah root, atau folder biasa)
const MODE = E('STORAGE_MODE', (process.getuid && process.getuid() === 0) ? 'direct' : 'root');
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const SU = E('SU_BIN', ['/system/bin/su', '/system/xbin/su', '/sbin/su', '/su/bin/su'].find(p => fs.existsSync(p)) || 'su');
const ZIP = E('ZIP_BIN', fs.existsSync(PREFIX + '/bin/zip') ? PREFIX + '/bin/zip' : 'zip');

// File yang sudah terkompresi hanya disimpan (store) supaya CPU HP tidak terbuang; sisanya deflate cepat (-1)
const ZIPOPT = '-1 -qr -n .zip:.7z:.rar:.gz:.tgz:.bz2:.xz:.mp4:.mkv:.avi:.mov:.webm:.mp3:.aac:.ogg:.m4a:.jpg:.jpeg:.png:.gif:.webp:.apk';
const zipCmd = word => `LD_LIBRARY_PATH=${q(PREFIX + '/lib')} ${q(ZIP)} ${ZIPOPT} - ${word}`;
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;                      // quoting aman untuk shell
// Jangan pernah menulis kalau flash disk belum terpasang (kalau tidak, file masuk ke RAM /mnt)
const G = () => `[ -d ${q(dev)} ]${mountRequired ? ` && grep -F ${q(' ' + dev + ' ')} /proc/mounts >/dev/null` : ''} || exit 3; `;
const sh = cmd => MODE === 'direct' ? ['sh', ['-c', cmd]] : [SU, ['-c', cmd]];

// Path relatif dari UI -> path absolut di flash disk, tidak bisa keluar dari folder upload
function abs(rel = '') {
  rel = String(rel);
  if (rel.includes('\0')) rel = '';
  const p = path.posix.normalize('/' + rel.replace(/\\/g, '/'));
  return p === '/' ? ROOT : ROOT + p.replace(/\/$/, '');
}
const cleanName = n => {
  n = String(n || '').trim();
  return (n && n === path.basename(n) && n !== '.' && n !== '..' && !/[\x00-\x1f]/.test(n)) ? n : null;
};

// multer membaca nama file multipart sebagai latin1, sehingga "é" / emoji / huruf non-Latin rusak. Kembalikan ke UTF-8
// (hanya jika hasilnya valid; nama yang sudah benar dibiarkan).
function fixName(n) {
  n = String(n || '');
  if (/[^\x00-\xff]/.test(n)) return n;
  const u = Buffer.from(n, 'latin1').toString('utf8');
  return (!u.includes('\ufffd') && Buffer.from(u, 'utf8').toString('latin1') === n) ? u : n;
}

function run(cmd, timeout = 30000) {
  return new Promise(resolve => {
    const [bin, args] = sh(cmd);
    let out = '', err = '', done = false, t, killT;
    const end = r => { if (!done) { done = true; clearTimeout(t); clearTimeout(killT); resolve(r); } };
    // detached: proses jadi pemimpin grup supaya timeout mematikan juga anak-anaknya
    // (find/grep/zip lewat su tidak boleh tertinggal saat batas waktu habis).
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
    c.stdout.on('data', d => out += d);
    c.stderr.on('data', d => err += d);
    const killTree = sig => {
      try { if (c.pid) process.kill(-c.pid, sig); else c.kill(sig); }
      catch { try { c.kill(sig); } catch { } }
    };
    t = setTimeout(() => {
      killTree('SIGTERM');
      killT = setTimeout(() => killTree('SIGKILL'), 1500);
      end({ code: -2, out, err: T('st.timeout') });
    }, Math.max(1000, timeout));
    c.on('error', e => end({ code: -1, out, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }));
    c.on('close', code => end({ code, out, err }));
  });
}

function explain(r, fb) {
  fb = fb || T('st.fail');
  if (r.err === 'ENOENT') return T('st.noSu');
  if (r.code === 3) return lastDiag || T('st.noDisk');
  if (r.code === 127) return T('st.noZip');
  if (r.code === 4) return T('st.notFound');
  if (r.code === 17) return T('st.exists');
  if (/denied|not allowed/i.test(r.err)) return T('st.denied');
  return fb + (r.err ? ': ' + r.err.trim().split('\n').pop() : '');
}
function fail(r, fb) {
  const e = new Error(explain(r, fb));
  if (r.code === 3) okAt = 0;
  e.code = r.code; e.status = { 3: 503, 4: 404, 17: 400 }[r.code] || 500;
  return e;
}
async function exec(cmd, fb, timeout) { const r = await run(cmd, timeout); if (r.code !== 0) throw fail(r, fb); return r; }

// Deteksi satu volume eksternal terpasang tanpa mengandalkan ID mount yang tetap.
async function resolveDevice() {
  const id = DEVICE ? path.posix.basename(DEVICE) : '';
  const cands = DEVICE ? [...new Set([DEVICE, `/storage/${id}`, `/mnt/runtime/write/${id}`, `/mnt/runtime/default/${id}`, `/mnt/pass_through/0/${id}`])] : [];
  const probe = cands.map(c => `[ -d ${q(c)} ] && { echo "FOUND ${c}"; exit 0; }`).join('; ');
  const r = await run(`echo "UID $(id -u 2>&1)"; echo "MR $(ls -1 /mnt/media_rw 2>&1 | tr '\\n' ' ')"; found=0; for c in /mnt/media_rw/*; do [ -d "$c" ] || continue; found=1; printf 'VOL %s\\n' "$c"; done; if [ "$found" = 0 ]; then for c in /storage/*; do case "\${c##*/}" in emulated|self|primary|sdcard0) continue ;; esac; [ -d "$c" ] && printf 'VOL %s\\n' "$c"; done; fi; echo "ST $(ls -1 /storage 2>&1 | head -8 | tr '\\n' ' ')"; ${probe ? probe + '; ' : ''}exit 3`, 45000);
  const vols = [...r.out.matchAll(/^VOL (.+)$/gm)].map(m => m[1]);
  const configured = /^FOUND (.+)$/m.exec(r.out);
  let selected = '';
  if (vols.length === 1) selected = vols[0];
  else if (vols.length > 1 && configured) selected = configured[1];
  else if (!vols.length && configured) selected = configured[1];
  if (selected) {
    mountRequired = vols.includes(selected) || isMountPath(selected);
    if (selected !== dev) { dev = selected; ROOT = dev + '/' + FOLDER; console.log(`[Penyimpanan] Flash disk dipakai dari ${dev}`); }
    lastDiag = ''; okAt = Date.now();
    return { ok: true };
  }
  okAt = 0;
  if (!DEVICE) { dev = ''; ROOT = ''; mountRequired = false; }
  if (r.code !== 3) { lastDiag = ''; return { ok: false, message: explain(r) }; }
  const g = k => ((new RegExp('^' + k + ' (.*)$', 'm')).exec(r.out) || [])[1] || '';
  const uid = g('UID').trim(), mr = g('MR').trim(), stg = g('ST').trim();
  let msg = T('rd.notFound');
  if (uid && uid !== '0') msg += MODE === 'direct' ? T('rd.notRoot') : T('rd.suDenied', { uid });
  else if (/no such|denied|not found|can't/i.test(mr)) msg += T('rd.noMr');
  else if (vols.length > 1) msg += T('rd.vols', { vols: vols.map(v => path.posix.basename(v)).join(', ') });
  else msg += T('rd.empty') + (stg && !/no such|denied|cannot|can't/i.test(stg) ? T('rd.storageIs', { stg }) : '') + '.';
  lastDiag = msg;
  return { ok: false, message: msg };
}
async function ensure() {
  if (Date.now() - okAt < 20000) {
    const live = await run(`${G()}exit 0`);
    if (live.code === 0) return;
    okAt = 0;
  }
  if (!resolving) resolving = resolveDevice().finally(() => { resolving = null; });
  await resolving;
}

// ---------- Pemeriksaan jalur (mencegah keluar dari root lewat .. atau symlink) ----------
const insidePath = (real, root) => {
  if (!real || !root) return false;
  const r = root.endsWith('/') ? root : root + '/';
  return real === root.replace(/\/$/, '') || real.startsWith(r);
};
let rootRealCache = { at: 0, value: '' };
async function rootReal(force = false) {
  if (!force && rootRealCache.value && Date.now() - rootRealCache.at < 30000) return rootRealCache.value;
  const r = await run(`${G()}mkdir -p ${q(ROOT)}; readlink -f ${q(ROOT)} 2>/dev/null || echo ${q(ROOT)}`);
  const value = r.code === 0 ? (r.out.trim().split('\n').pop() || ROOT) : '';
  rootRealCache = { at: Date.now(), value };
  return value;
}

// Info satu jalur: jalur absolut, hasil readlink -f (symlink diselesaikan), dan
// apakah hasilnya masih di dalam folder penyimpanan. Dipakai sebelum membaca/menulis.
async function inspect(rel) {
  await ensure();
  const p = abs(rel);
  const r = await run(`${G()}if [ -e ${q(p)} ] || [ -L ${q(p)} ]; then readlink -f ${q(p)} 2>/dev/null || echo ${q(p)}; stat -c '%F|%s|%Y' ${q(p)} 2>/dev/null || exit 4; else exit 4; fi`);
  if (r.code !== 0) return { ok: false, code: r.code, abs: p };
  const lines = r.out.trim().split('\n');
  const meta = (lines.pop() || '').split('|');
  const real = lines.pop() || p;
  const root = await rootReal();
  const dir = String(meta[0] || '').startsWith('directory');
  return {
    ok: true, abs: p, real, root, inside: insidePath(real, root),
    isDirectory: dir, isFile: String(meta[0] || '').startsWith('regular'),
    kind: meta[0] || '', size: Number(meta[1]) || 0, mtime: Number(meta[2]) || 0
  };
}

class PathDenied extends Error {
  constructor(message) { super(message); this.status = 403; this.code = 'PATH_DENIED'; }
}
class PathNotFound extends Error {
  constructor(message) { super(message); this.status = 404; this.code = 'PATH_NOT_FOUND'; }
}
class PathExists extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'PATH_EXISTS'; }
}

// Pastikan jalur ada DAN berada di dalam root penyimpanan (symlink ikut diperiksa).
async function checked(rel, { mustExist = true } = {}) {
  const info = await inspect(rel);
  if (!info.ok) {
    if (!mustExist) return info;
    throw new PathNotFound(T('st.notFound'));
  }
  if (!info.inside) throw new PathDenied('Jalur keluar dari folder penyimpanan (symlink) ditolak.');
  return info;
}

// Cari file di dalam satu subfolder. Nama file diperlakukan sebagai pola pencarian
// (bukan perintah shell) dan selalu dikutip oleh q().
async function search(relDir, { name = '', maxDepth = 3, limit = 25, offset = 0, timeoutMs = 5000 } = {}) {
  await ensure();
  const base = await checked(relDir || '', { mustExist: true });
  if (!base.isDirectory) throw Object.assign(new Error('Jalur pencarian bukan folder.'), { status: 400 });
  const depth = Math.max(1, Math.min(8, Math.floor(maxDepth) || 3));
  const take = Math.max(1, Math.min(100, Math.floor(limit) || 25));
  const skip = Math.max(0, Math.min(5000, Math.floor(offset) || 0));
  const pattern = String(name || '').replace(/[\x00-\x1f]/g, '').slice(0, 100);
  const glob = '*' + pattern + '*';
  // find tidak mengikuti symlink (default -P); hasil diurutkan agar pagination stabil.
  const cmd = `${G()}cd ${q(base.abs)} 2>/dev/null || exit 4; find . -maxdepth ${depth} -type f -iname ${q(glob)} -print 2>/dev/null | LC_ALL=C sort | head -n ${skip + take + 1}; exit 0`;
  const r = await run(cmd, Math.max(1000, Math.min(10000, timeoutMs)));
  if (r.code !== 0) throw fail(r, T('st.listFail'));
  const all = r.out.split('\n').map(l => l.trim()).filter(Boolean);
  const more = all.length > skip + take;
  const page = all.slice(skip, skip + take).map(p => {
    const clean = p.replace(/^\.\//, '');
    return { path: (relDir ? String(relDir).replace(/\/+$/, '') + '/' : '') + clean, name: path.posix.basename(clean) };
  });
  return { results: page, offset: skip, limit: take, hasMore: more, scanned: all.length, dir: relDir || '' };
}

// Baca file teks dengan batas ukuran; file biner & konfigurasi rahasia ditolak.
const TEXT_EXT = new Set(['txt', 'log', 'json', 'jsonl', 'js', 'mjs', 'cjs', 'ts', 'ino', 'md', 'csv', 'tsv', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'sh', 'bash', 'py', 'html', 'htm', 'css', 'xml', 'properties', 'h', 'hpp', 'c', 'cpp', 'env', 'example', 'sql']);
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\..*)?)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg)$/i;

function protectName(name) {
  return SECRET_FILE.test(String(name)) || SECRET_EXT.test(String(name));
}

async function readTextFile(rel, { maxBytes = 200 * 1024 } = {}) {
  const cap = Math.max(1024, Math.min(1024 * 1024, Math.floor(maxBytes) || 200 * 1024));
  const info = await checked(rel, { mustExist: true });
  if (info.isDirectory) throw Object.assign(new Error('Jalur tersebut adalah folder, bukan file.'), { status: 400 });
  if (protectName(path.posix.basename(rel))) throw new PathDenied('File konfigurasi rahasia (mis. .env/private key) tidak boleh dibaca melalui AI.');
  const ext = path.posix.extname(String(rel)).slice(1).toLowerCase();
  if (ext === 'bin' || ext === 'part') throw Object.assign(new Error('File biner tidak dapat dibaca sebagai teks.'), { status: 415 });
  // head -c mengambil batas + 1 byte, base64 membuat isi aman melewati stdout shell.
  const r = await run(`${G()}head -c ${cap + 1} ${q(info.abs)} 2>/dev/null | base64 | tr -d '\\n'; exit 0`, 30000);
  if (r.code !== 0) throw fail(r, T('st.readFail'));
  let buf;
  try { buf = Buffer.from(String(r.out || '').trim(), 'base64'); }
  catch { throw Object.assign(new Error('File tidak dapat dibaca sebagai teks.'), { status: 415 }); }
  const truncated = buf.length > cap;
  if (truncated) buf = buf.subarray(0, cap);
  // Deteksi biner: byte NUL atau karakter kontrol yang tidak lazim.
  let binary = false;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) { binary = true; break; }
    if (b < 9 || (b > 13 && b < 32)) binary = true;
  }
  if (binary) throw Object.assign(new Error('File terdeteksi biner, bukan teks.'), { status: 415 });
  const text = buf.toString('utf8');
  if (/\uFFFD/.test(text.slice(0, 4096)) && !/[^\x00-\x7F]/.test(text)) {
    throw Object.assign(new Error('File tidak dapat dibaca sebagai UTF-8.'), { status: 415 });
  }
  return {
    path: String(rel), size: info.size, bytesRead: buf.length, truncated, text,
    modified: info.mtime ? new Date(info.mtime * 1000).toISOString() : null
  };
}

// Buat folder relatif (boleh bertingkat). Tidak menimpa folder yang sudah ada.
async function mkdirPath(rel) {
  const info = await inspect(rel);
  if (info.ok) throw new PathExists(T('st.exists'));
  if (!info.abs) throw new PathDenied('Jalur tidak valid.');
  // Periksa setiap komponen yang SUDAH ada (termasuk symlink) sebelum mkdir -p,
  // supaya folder baru tidak dibuat di luar root lewat symlink perantara.
  const parts = String(rel).replace(/\/+$/, '').split('/');
  let prefix = '';
  for (let i = 0; i < parts.length; i++) {
    prefix = prefix ? prefix + '/' + parts[i] : parts[i];
    const cur = await inspect(prefix);
    if (!cur.ok) continue;                          // komponen berikutnya akan dibuat baru
    if (!cur.inside) throw new PathDenied('Jalur keluar dari folder penyimpanan (symlink) ditolak.');
    if (i < parts.length - 1 && !cur.isDirectory)
      throw Object.assign(new Error(`"${prefix}" bukan folder, jadi subfolder tidak dapat dibuat.`), { status: 400 });
  }
  await exec(`${G()}mkdir -p ${q(info.abs)}`, T('st.mkdirFail'));
  return { path: String(rel) };
}

// Salin / pindahkan satu file atau folder. Tujuan tidak boleh sudah ada (tidak menimpa
// secara diam-diam) dan folder tidak boleh dipindah ke dalam dirinya sendiri.
async function transfer(kind, srcRel, dstRel) {
  const src = await checked(srcRel, { mustExist: true });
  const dstAbs = abs(dstRel);
  if (dstAbs === ROOT) throw new PathDenied('Tidak boleh menimpa folder utama.');
  if (src.abs === dstAbs) throw Object.assign(new Error('Sumber dan tujuan sama.'), { status: 400 });
  if (dstAbs.startsWith(src.abs + '/')) throw Object.assign(new Error('Folder tidak boleh dipindah ke dalam dirinya sendiri.'), { status: 400 });
  const parentRel = path.posix.dirname(String(dstRel).replace(/\/+$/, ''));
  const parent = await checked(parentRel === '.' ? '' : parentRel, { mustExist: true });
  if (!parent.isDirectory) throw Object.assign(new Error('Folder tujuan bukan folder.'), { status: 400 });
  const exists = await inspect(dstRel);
  if (exists.ok) throw new PathExists(T('st.exists'));
  // Tujuan belum ada: pastikan folder induknya (yang sudah diselesaikan symlink-nya)
  // tetap berada di dalam root.
  if (!insidePath(parent.real, parent.root)) throw new PathDenied('Folder tujuan keluar dari folder penyimpanan.');
  const op = kind === 'move' ? 'mv' : 'cp -r';
  const r = await run(`${G()}[ -e ${q(dstAbs)} ] && exit 17; ${op} ${q(src.abs)} ${q(dstAbs)}`, 30 * 60 * 1000);
  if (r.code !== 0) throw fail(r, kind === 'move' ? T('st.pasteFail') : T('st.pasteFail'));
  return { from: String(srcRel), to: String(dstRel), kind };
}

const copyPath = (srcRel, dstRel) => transfer('copy', srcRel, dstRel);
const movePath = (srcRel, dstRel) => transfer('move', srcRel, dstRel);

// Pastikan folder upload ada (dibuat kalau belum ada), cek bisa ditulis, ambil sisa ruang
async function status() {
  const rd = await resolveDevice();
  const base = { mode: MODE, root: ROOT };
  if (!rd.ok) return { ...base, ready: false, message: rd.message };
  const r = await run(`${G()}mkdir -p ${q(ROOT)} && [ -w ${q(ROOT)} ] || exit 6; df -k ${q(ROOT)} 2>/dev/null | tail -n 1; exit 0`, 45000);
  if (r.code !== 0) return { ...base, ready: false, message: r.code === 6 ? T('st.notWritable') : explain(r) };
  const f = r.out.trim().split(/\s+/);
  const kb = f.length >= 6 ? { total: +f[f.length - 5] * 1024, free: +f[f.length - 3] * 1024 } : {};
  return { ...base, ready: true, message: T('st.ready'), total: kb.total || null, free: kb.free || null };
}

async function list(rel) {
  await ensure();
  const r = await run(`${G()}cd ${q(abs(rel))} 2>/dev/null || exit 4; stat -c '%F|%s|%Y|%n' ./.[!.]* ./..?* ./* 2>/dev/null; exit 0`);
  if (r.code !== 0) throw fail(r, T('st.listFail'));
  return r.out.split('\n').map(l => /^([^|]*)\|(\d+)\|(\d+)\|\.\/(.+)$/.exec(l)).filter(Boolean).map(m => ({
    name: m[4], isDirectory: m[1].startsWith('directory'), size: m[1].startsWith('directory') ? 0 : +m[2], modified: new Date(+m[3] * 1000)
  })).sort((a, b) => (b.isDirectory - a.isDirectory) || a.name.localeCompare(b.name));
}

const mkdir = async (rel, name) => { await ensure(); return exec(`${G()}t=${q(abs(rel) + '/' + name)}; [ -e "$t" ] && exit 17; mkdir -p "$t"`, T('st.mkdirFail')); };

const rename = async (rel, a, b) => {
  await ensure();
  const d = abs(rel);
  return exec(`${G()}[ -e ${q(d + '/' + a)} ] || exit 4; [ -e ${q(d + '/' + b)} ] && exit 17; mv ${q(d + '/' + a)} ${q(d + '/' + b)}`, T('st.renameFail'));
};

async function remove(rel) {
  await ensure();
  const p = abs(rel);
  if (p === ROOT) throw Object.assign(new Error(T('st.rootNoDelete')), { status: 400 });
  return exec(`${G()}[ -e ${q(p)} ] || exit 4; rm -rf ${q(p)}`, T('st.removeFail'), 600000);
}

async function paste(action, srcRel, dstRel, items) {
  if (!['cut', 'copy'].includes(action) || !Array.isArray(items) || !items.length)
    throw Object.assign(new Error(T('st.pasteEmpty')), { status: 400 });
  await ensure();
  const src = abs(srcRel), dst = abs(dstRel), op = action === 'cut' ? 'mv -f' : 'cp -r';
  const cmds = items.map(cleanName).filter(Boolean).map(n => src + '/' + n)
    .filter(from => from !== dst + '/' + path.posix.basename(from) && !(dst + '/').startsWith(from + '/'))   // tidak ke diri sendiri / ke dalam dirinya
    .map(from => `[ -e ${q(from)} ] && { ${op} ${q(from)} ${q(dst + '/')} || f=1; }; `);
  if (cmds.length) await exec(`${G()}f=0; ${cmds.join('')}exit $f`, T('st.pasteFail'), 3600000);
}

// Salin isi folder internal (uploads lama) ke flash disk — dipakai migrate.js
function importFrom(srcDir, names) {
  const cmds = names.map(n => `cp -r ${q(path.join(srcDir, n))} ${q(ROOT + '/')} || f=1; `);
  return exec(`${G()}mkdir -p ${q(ROOT)}; f=0; ${cmds.join('')}exit $f`, T('st.importFail'), 6 * 3600000);
}

// Kompres file/folder jadi <nama>.zip di folder yang sama (nama dibuat unik, ditulis ke .part dulu)
async function compress(rel) {
  const info = await checked(rel, { mustExist: true });
  const p = info.abs;
  if (p === ROOT) throw Object.assign(new Error(T('st.rootNoCompress')), { status: 400 });
  // Semua nama diberi awalan ./ supaya file yang namanya diawali "-" tidak dianggap opsi oleh mv/zip/rm
  const r = await exec(`${G()}cd ${q(path.posix.dirname(p))} 2>/dev/null || exit 4; n=${q(path.posix.basename(p))}; [ -e "./$n" ] || exit 4; ` +
    `if [ -d "./$n" ]; then b="$n"; else b="\${n%.*}"; [ -n "$b" ] || b="$n"; fi; z="$b.zip"; i=2; while [ -e "./$z" ]; do z="$b ($i).zip"; i=$((i+1)); done; t="$z.part"; ` +
    `if ${zipCmd('./"$n"')} > "./$t"; then mv -f "./$t" "./$z" && echo "$z"; else rm -f "./$t"; exit 5; fi`, T('st.compressFail'), 6 * 3600000);
  return r.out.trim().split('\n').pop();
}

// Download: file di-stream langsung dari flash disk; folder dikompres (zip) dan di-stream
async function send(res, rel, { inline = false, zip = false } = {}) {
  await ensure();
  const p = abs(rel);
  if (p === ROOT) throw fail({ code: 4, err: '' });
  // Konten tidak boleh diambil lewat symlink yang keluar dari folder penyimpanan.
  const info = await checked(rel, { mustExist: true });
  const isDir = info.isDirectory, name = path.posix.basename(p);
  let cmd;
  if (isDir || zip) {   // folder selalu di-zip; file di-zip bila diminta (zip=1)
    if (inline) throw fail({ code: 4, err: '' });
    res.attachment(name + '.zip');
    cmd = `${G()}cd ${q(path.posix.dirname(p))} && ${zipCmd(q('./' + name))}`;
  } else {
    res.type(path.extname(name) || 'bin');
    // tampil langsung hanya untuk gambar/video/audio (bukan svg/html, supaya tidak menjalankan script)
    if (!inline || !/^(image\/(?!svg)|video\/|audio\/)/.test(res.get('Content-Type') || '')) res.attachment(name);
    res.set({ 'Content-Length': String(info.size), 'Accept-Ranges': 'none', 'X-Content-Type-Options': 'nosniff' });
    cmd = `${G()}cat ${q(p)}`;
  }
  const [bin, args] = sh(cmd);
  const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', sent = false;
  c.stderr.on('data', d => err += d);
  c.stdout.on('data', () => { sent = true; });
  c.stdout.pipe(res, { end: false });
  c.on('error', e => { if (!res.headersSent) res.status(500).json({ error: explain({ code: -1, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }) }); else res.destroy(); });
  c.on('close', code => {
    if (code === 0) return res.end();
    if (!sent && !res.headersSent) {
      res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition');
      res.status(500).json({ error: explain({ code, err }, T('st.dlFail')) });
    } else res.destroy();
  });
  res.on('close', () => { if (c.exitCode === null) c.kill(); });
}

// Simpan stream (mis. file yang dikirim ke bot Telegram) langsung ke flash disk.
// Nama yang sudah ada tidak ditimpa dan file parsial dibersihkan jika transfer gagal.
async function saveStream(relDir, rawName, stream, maxBytes = 20 * 1024 * 1024) {
  await ensure();
  const name = cleanName(rawName);
  if (!name) throw Object.assign(new Error(T('st.badFileName')), { status: 400 });
  const dir = abs(relDir || ''), dest = dir + '/' + name, tmp = `${dest}.${Date.now().toString(36)}.part`;
  const prep = await run(`${G()}[ ! -e ${q(dest)} ] || exit 17; mkdir -p ${q(dir)}`);
  if (prep.code !== 0) throw fail(prep, T('st.saveFileFail'));
  const [bin, args] = sh(`${G()}cat > ${q(tmp)}`);
  const c = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let bytes = 0, err = '';
  c.stderr.on('data', d => { err += d; });
  const { Transform } = require('stream');
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(Object.assign(new Error(`File terlalu besar (maksimum ${Math.ceil(maxBytes / 1024 / 1024)} MB).`), { status: 413 }));
    callback(null, chunk);
  }});
  const closedPromise = new Promise(resolve => c.once('close', code => resolve(code)));
  try {
    await new Promise((resolve, reject) => {
      const { pipeline } = require('stream');
      pipeline(stream, limiter, c.stdin, e => e ? reject(e) : resolve());
      c.once('error', e => reject(fail({ code: -1, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }, T('st.saveFail'))));
    });
    const closed = await closedPromise;
    if (closed !== 0) throw fail({ code: closed, err }, T('st.saveFail'));
    const r = await run(`${G()}[ ! -e ${q(dest)} ] || exit 17; [ "$(stat -c %s ${q(tmp)} 2>/dev/null)" = "${bytes}" ] && mv ${q(tmp)} ${q(dest)}`, 120000);
    if (r.code !== 0) throw fail(r, T('st.saveFileFail'));
    return { filename: name, size: bytes };
  } catch (e) {
    try { c.kill(); } catch { }
    await run(`${G()}rm -f ${q(tmp)}`);
    throw e;
  }
}

// Membaca file ke memori hanya untuk pengiriman Telegram; batas ukuran diperiksa
// sebelum cat dimulai agar file besar tidak menghabiskan RAM perangkat.
async function fileStream(rel) {
  const info = await checked(rel, { mustExist: true });
  const p = info.abs;
  if (info.isDirectory) throw Object.assign(new Error('Jalur tersebut adalah folder, bukan file.'), { status: 400 });
  const size = info.size;
  if (!Number.isSafeInteger(size)) throw new Error(T('st.readFail'));
  const { PassThrough } = require('stream');
  const output = new PassThrough();
  const [bin, args] = sh(`${G()}cat ${q(p)}`);
  const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  c.stderr.on('data', d => { err += d; });
  c.stdout.pipe(output);
  c.once('error', e => output.destroy(fail({ code: -1, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }, T('st.readFail'))));
  c.once('close', code => { if (code !== 0 && !output.destroyed) output.destroy(fail({ code, err }, T('st.readFail'))); });
  output.once('close', () => { if (c.exitCode === null) c.kill(); });
  return { stream: output, size };
}

async function readBuffer(rel, maxBytes = 49 * 1024 * 1024) {
  const info = await checked(rel, { mustExist: true });
  const p = info.abs;
  const size = info.size;
  if (info.isDirectory) throw Object.assign(new Error('Jalur tersebut adalah folder, bukan file.'), { status: 400 });
  if (!Number.isSafeInteger(size) || size > maxBytes) throw Object.assign(new Error(`File melebihi batas Telegram (${Math.floor(maxBytes / 1024 / 1024)} MB).`), { status: 413 });
  return new Promise((resolve, reject) => {
    const [bin, args] = sh(`${G()}cat ${q(p)}`);
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, err = '';
    c.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { c.kill(); return reject(Object.assign(new Error('File melebihi batas Telegram.'), { status: 413 })); }
      chunks.push(chunk);
    });
    c.stderr.on('data', d => { err += d; });
    c.once('error', e => reject(fail({ code: -1, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }, T('st.readFail'))));
    c.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(fail({ code, err }, T('st.readFail'))));
  });
}

// Storage engine multer: byte upload langsung dialirkan ke flash disk (tanpa file sementara di internal).
// Ditulis ke "<nama>.part" dulu, baru dipindah ke nama final setelah ukuran cocok.
function engine() {
  return {
    _handleFile(req, file, cb) {
      ensure().then(() => {
        const dir = abs(req.query.dir || ''), name = cleanName(fixName(file.originalname));
        if (!name) return cb(new Error(T('st.badFileName')));
        const dest = dir + '/' + name, tmp = `${dest}.${Date.now().toString(36)}.part`;
        const [bin, args] = sh(`${G()}mkdir -p ${q(dir)} && cat > ${q(tmp)}`);
        const c = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let bytes = 0, err = '', ended = false, finished = false;
        const finish = (e, info) => { if (finished) return; finished = true; if (e) { c.kill(); run(`${G()}rm -f ${q(tmp)}`); } cb(e, info); };
        c.stderr.on('data', d => err += d);
        c.stdin.on('error', () => { });
        c.on('error', e => finish(fail({ code: -1, err: e.code === 'ENOENT' ? 'ENOENT' : e.message }, T('st.saveFail'))));
        file.stream.on('data', d => { bytes += d.length; });
        file.stream.on('end', () => { ended = true; });
        file.stream.on('error', e => finish(e));
        file.stream.pipe(c.stdin);
        req.on('close', () => { if (!req.complete) finish(new Error(T('st.uploadCancel'))); });
        c.on('close', async code => {
          if (finished) return;
          if (code !== 0 || !ended) return finish(fail({ code: code || 5, err }, T('st.writeFail')));
          const r = await run(`${G()}[ "$(stat -c %s ${q(tmp)})" = "${bytes}" ] && mv -f ${q(tmp)} ${q(dest)}`, 120000);
          r.code === 0 ? finish(null, { path: dest, filename: name, size: bytes }) : finish(fail(r, T('st.saveFileFail')));
        });
      }).catch(cb);
    },
    _removeFile(req, file, cb) { exec(`${G()}rm -f ${q(file.path)}`, T('st.removeFail')).then(() => cb(null), cb); }
  };
}

module.exports = { get ROOT() { return ROOT; }, DEVICE, MODE, SU, compress, status, list, mkdir, rename, remove, paste, send, engine, importFrom, cleanName, abs, saveStream, readBuffer, fileStream, inspect, checked, search, readTextFile, mkdirPath, copyPath, movePath, protectName, insidePath, PathDenied, PathNotFound, PathExists };
