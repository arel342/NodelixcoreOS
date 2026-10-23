const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createHistory = require('../ai-history');

const env = (k, d) => k === 'AI_HISTORY_PERSIST' ? 'true' : d;
const turn = () => [
    { role: 'user', parts: [{ text: 'cek storage' }] },
    { role: 'model', parts: [
        { text: 'Periksa flashdisk.', thought: true },
        { functionCall: { name: 'list_files', args: { dir: '' }, id: 'files-1' }, thoughtSignature: Buffer.alloc(3600, 7).toString('base64') }
    ] },
    { role: 'user', parts: [{ functionResponse: { id: 'files-1', name: 'list_files', response: { result: { files: ['laporan.txt'] } } } }] },
    { role: 'model', parts: [{ text: 'Ada laporan.txt.', thoughtSignature: 'signed-final' }] }
];

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-signature-'));
    const file = path.join(dir, 'ai-history.json');
    const histories = [];
    t.after(() => {
        for (const h of histories) h.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { file, load() { const h = createHistory({ env, file, log() {} }); histories.push(h); return h; } };
}

test('history: signature panjang, seluruh parts, dan ID tetap utuh setelah save/load; pembaca mendapat salinan', t => {
    const f = fixture(t), h = f.load(), entries = turn();
    h.push('web:s1', entries);
    assert.deepEqual(h.contents('web:s1'), entries);
    const copy = h.contents('web:s1');
    copy[1].parts[1].thoughtSignature = 'changed';
    copy[1].parts[1].functionCall.args.dir = 'changed';
    assert.deepEqual(h.contents('web:s1'), entries);
    h.save();
    assert.deepEqual(f.load().contents('web:s1'), entries);
});

test('history: riwayat lama tanpa signature dimigrasikan ke teks yang menyimpan hasil tool', t => {
    const f = fixture(t), entries = turn();
    delete entries[1].parts[1].thoughtSignature;
    delete entries[3].parts[0].thoughtSignature;
    fs.writeFileSync(f.file, JSON.stringify({ ver: 1, sessions: { 'telegram:555': { at: 1, turns: [{ at: 1, entries }] } } }));
    const h = f.load();
    const contents = h.contents('telegram:555');
    assert.equal(contents.some(c => c.parts.some(p => p.functionCall || p.functionResponse)), false);
    assert.match(JSON.stringify(contents), /laporan\.txt/);
    assert.match(JSON.stringify(contents), /cek storage/);
    h.save();
    assert.deepEqual(f.load().contents('telegram:555'), contents);
});

test('history: redaksi rahasia tidak meninggalkan functionCall bertanda tangan yang sudah diubah', t => {
    const f = fixture(t), h = f.load(), entries = turn();
    entries[1].parts[1].functionCall.args.password = 'sensitive-value-test-only';
    h.push('web:s1', entries);
    const contents = h.contents('web:s1');
    assert.equal(contents.some(c => c.parts.some(p => p.functionCall || p.functionResponse)), false);
    h.save();
    assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /sensitive-value-test-only/);
    assert.match(JSON.stringify(contents), /laporan\.txt/);
});

test('history: giliran terlalu besar diringkas utuh, tanpa signature terpotong atau tool yatim', t => {
    const f = fixture(t), h = f.load(), entries = turn();
    entries[1].parts[1].thoughtSignature = Buffer.alloc(20000, 7).toString('base64');
    h.push('web:s1', entries);
    const contents = h.contents('web:s1');
    assert.equal(contents.some(c => c.parts.some(p => p.functionCall || p.functionResponse || p.thoughtSignature)), false);
    assert.match(JSON.stringify(contents), /laporan\.txt/);
});
