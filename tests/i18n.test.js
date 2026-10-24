// Isolated tests: memastikan setiap kunci terjemahan yang dipakai halaman/JS benar-benar ada.
//
// Kalau ada kunci yang hilang, t() mengembalikan nama kuncinya sendiri (mis. tulisan
// "nav.storage" muncul di layar), jadi kesalahan seperti itu harus ketahuan lewat test —
// bukan setelah dibuka di HP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const LANGS = ['id', 'en', 'zh'];
const KEY_RE = /'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'\s*:\s*(?='|`)/g;

// Ambil isi tiap blok bahasa dari sebuah file kamus.
function blocks(src, header, endMarker) {
    const out = {};
    const idx = [];
    for (const l of LANGS) {
        const re = new RegExp(`^${header}${l}: \\{`, 'm');
        const m = re.exec(src);
        assert.ok(m, `blok bahasa ${l} tidak ditemukan`);
        idx.push([l, m.index + m[0].length]);
    }
    idx.forEach(([l, start], i) => {
        const stop = i + 1 < idx.length ? src.lastIndexOf('\n', idx[i + 1][1]) : src.indexOf(endMarker, start);
        assert.ok(stop > start, `blok ${l} tidak bisa dipotong`);
        out[l] = src.slice(start, stop);
    });
    return out;
}

const keysOf = seg => {
    const set = new Set();
    for (const m of seg.matchAll(KEY_RE)) set.add(m[1]);
    return set;
};

// Kunci yang dipakai file web: data-i18n / data-i18n-ph / t('...')
function usedIn(files) {
    const used = new Map();
    for (const f of files) {
        const src = read(f);
        for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) used.set(m[1], f);
        for (const m of src.matchAll(/data-i18n(?:-ph)?=["']([A-Za-z0-9_.]+)["']/g)) used.set(m[1], f);
    }
    return used;
}

const webFiles = [
    'public/index.html', 'public/setup.html',
    'public/monitor.js', 'public/door.js', 'public/system.js', 'public/firmware.js',
    'public/terminal.js', 'public/upload.js', 'public/ui.js', 'public/settings.js',
    'public/setup.js', 'public/i18n.js', 'public/media.js'
];

test('i18n web: tiga bahasa punya daftar kunci yang sama', () => {
    const blok = blocks(read('public/i18n.js'), ' {8}', '\n    };');
    const sets = {};
    for (const l of LANGS) sets[l] = keysOf(blok[l]);
    assert.ok(sets.id.size > 300, `kunci id terlalu sedikit: ${sets.id.size}`);
    for (const l of ['en', 'zh']) {
        const beda = [...sets.id].filter(k => !sets[l].has(k)).concat([...sets[l]].filter(k => !sets.id.has(k)));
        assert.deepEqual(beda, [], `kunci ${l} tidak sama dengan id`);
    }
});

test('i18n web: semua kunci yang dipakai halaman/JS tersedia', () => {
    const blok = blocks(read('public/i18n.js'), ' {8}', '\n    };');
    const sets = {};
    for (const l of LANGS) sets[l] = keysOf(blok[l]);
    const missing = [];
    for (const [key, file] of usedIn(webFiles)) {
        if (key.endsWith('.')) continue;            // kunci disusun dari potongan, mis. t('dlog.' + k)
        for (const l of LANGS) if (!sets[l].has(key)) missing.push(`${key} (${file}, ${l})`);
    }
    assert.deepEqual(missing.sort(), []);
});

test('i18n server: semua pesan yang dipakai modul server tersedia', () => {
    const blok = blocks(read('lang.js'), ' {4}', '\n};');
    const sets = {};
    for (const l of LANGS) sets[l] = keysOf(blok[l]);
    assert.ok(sets.id.size > 100, `pesan id terlalu sedikit: ${sets.id.size}`);
    for (const l of ['en', 'zh']) {
        const beda = [...sets.id].filter(k => !sets[l].has(k)).concat([...sets[l]].filter(k => !sets.id.has(k)));
        assert.deepEqual(beda, [], `pesan ${l} tidak sama dengan id`);
    }

    const modul = ['server.js', 'settings.js', 'setup.js', 'esp32.js', 'door.js', 'telegram.js', 'firmware.js', 'system.js', 'terminal.js', 'storage.js', 'update-fw.js'];
    const missing = [];
    for (const f of modul) {
        const src = read(f);
        for (const m of src.matchAll(/\bT\(\s*'([A-Za-z0-9_.]+)'/g)) {
            if (m[1].endsWith('.')) continue;        // kunci disusun dari potongan, mis. T('esp.alert.' + k)
            for (const l of LANGS) if (!sets[l].has(m[1])) missing.push(`${m[1]} (${f}, ${l})`);
        }
    }
    assert.deepEqual(missing.sort(), []);
});

test('i18n: pesan pengganti (variabel) yang dipakai tersedia di ketiga bahasa', () => {
    const blok = blocks(read('lang.js'), ' {4}', '\n};');
    // Pesan dengan {variabel} harus punya variabel yang sama di semua bahasa
    const vars = seg => new Map([...seg.matchAll(/'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)'\s*:\s*'([^']*)'/g)]
        .map(m => [m[1], [...m[2].matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',')]));
    const a = vars(blok.id);
    const beda = [];
    for (const l of ['en', 'zh']) {
        const b = vars(blok[l]);
        for (const [k, v] of a) if (b.has(k) && b.get(k) !== v) beda.push(`${k} (${l}: ${b.get(k)} != id: ${v})`);
    }
    assert.deepEqual(beda.sort(), []);
});
