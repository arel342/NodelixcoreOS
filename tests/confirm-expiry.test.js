// ============================================================================
// tests/confirm-expiry.test.js — penyapu konfirmasi (confirm.js)
//
// Bug yang diperbaiki: rekaman yang kedaluwarsa tetapi tidak pernah dibuka tetap
// berstatus 'pending'. Akibatnya /api/ai/confirmations terus menampilkan tombol
// konfirmasi lama yang selalu gagal (410) dan jumlah antrean tidak pernah turun.
// Sekarang penyapu menandai 'expired' dan hanya membuang rekaman yang sudah lewat
// masa retensi.
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createConfirm = require('../confirm');

// Waktu palsu supaya kedaluwarsa bisa diuji tanpa menunggu.
function clockAt(start = 1_700_000_000_000) {
    let t = start;
    return { now: () => t, advance: ms => { t += ms; } };
}

test('konfirmasi: penyapu menandai kedaluwarsa sehingga hilang dari daftar pending', () => {
    const c = clockAt();
    const store = createConfirm({ env: (k, d) => (k === 'CONFIRM_TTL_S' ? '30' : d), now: c.now, log: () => { } });
    try {
        const rec = store.create({ skill: 'door.open', summary: 'Buka pintu', channel: 'web', sessionId: 'sid-1' });
        assert.equal(store.list({ sessionId: 'sid-1' }).length, 1);

        c.advance(30_000 + 1);                    // TTL 30 detik sudah lewat
        assert.equal(store.list({ sessionId: 'sid-1' }).length, 0,
            'daftar pending tidak boleh memuat konfirmasi kedaluwarsa (sebelum perbaikan: masih muncul)');

        store.sweep();
        assert.equal(store.get(rec.id).status, 'expired');
        assert.throws(() => store.approve(rec.id, { sessionId: 'sid-1' }), /kedaluwarsa/i);
    } finally { store.stop(); }
});

test('konfirmasi: penyapu tidak membuang konfirmasi yang masih berlaku', () => {
    const c = clockAt();
    const store = createConfirm({ env: (k, d) => (k === 'CONFIRM_TTL_S' ? '300' : d), now: c.now, log: () => { } });
    try {
        const keep = store.create({ skill: 'door.open', summary: 'Buka pintu', channel: 'web', sessionId: 'sid-1' });
        const old = store.create({ skill: 'door.open', summary: 'Lama', channel: 'web', sessionId: 'sid-1' });

        c.advance(60_000);
        store.sweep();
        assert.equal(store.get(keep.id).status, 'pending', 'konfirmasi yang masih berlaku harus tetap pending');
        assert.equal(store.list({ sessionId: 'sid-1' }).length, 2, 'retensi 15 menit: rekaman lama tetap ada sebentar');

        // Lewat masa retensi -> rekaman dibuang dari memori (tidak tumbuh tanpa batas).
        c.advance(300_000 + 15 * 60_000 + 1000);
        store.sweep();
        assert.equal(store.get(keep.id), null);
        assert.equal(store.get(old.id), null);
        assert.equal(store.stats().total, 0);
    } finally { store.stop(); }
});

test('konfirmasi: identitas peminta tetap ditegakkan setelah penyapu berjalan', () => {
    const c = clockAt();
    const store = createConfirm({ env: (k, d) => (k === 'CONFIRM_TTL_S' ? '300' : d), now: c.now, log: () => { } });
    try {
        const rec = store.create({ skill: 'door.open', summary: 'Buka pintu', channel: 'web', sessionId: 'sid-1' });
        store.sweep();
        assert.throws(() => store.approve(rec.id, { sessionId: 'sid-lain' }), /sesi web lain/i);
        assert.equal(store.approve(rec.id, { sessionId: 'sid-1' }).status, 'executing');
    } finally { store.stop(); }
});
