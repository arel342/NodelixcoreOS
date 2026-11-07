// ============================================================================
// tests/update-ui.test.js — perilaku notifikasi update di dashboard (DOM).
//
// Memakai jsdom bila tersedia (opsional, bukan dependency produksi):
//     npm install --no-save jsdom
// Kalau jsdom tidak terpasang, test ini dilewati (skip) supaya `npm test` tetap jalan
// di Termux tanpa dependency tambahan.
//
// Yang diperiksa:
//   • login membaca status tersimpan sekali, tanpa memanggil /api/update/check
//   • lencana header + kartu dashboard muncul saat ada update
//   • popup memuat commit terpasang/terbaru, daftar commit, tautan repo, perintah manual
//   • pesan commit di-escape (tidak ada HTML mentah dari GitHub)
//   • toast login hanya sekali per commit walau dashboard dimuat ulang
//   • pesan WebSocket {type:'UPDATE'} dengan commit baru memunculkan toast baru
//   • saat tidak ada update, lencana & kartu disembunyikan
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const HASH_A = 'a'.repeat(40), HASH_B = 'b'.repeat(40), HASH_C = 'c'.repeat(40);

const state = {
    success: true, enabled: true, repo: 'arel342/NodelixcoreOS', branch: 'main',
    repoUrl: 'https://github.com/arel342/NodelixcoreOS',
    installedCommit: HASH_A, installedShort: 'aaaaaaa',
    latestCommit: HASH_B, latestShort: 'bbbbbbb',
    updateAvailable: true, detectedAt: Date.parse('2026-11-01T10:00:00Z'),
    lastCheckedAt: Date.parse('2026-11-01T10:00:00Z'), lastCheckError: '',
    commits: [{ hash: HASH_B, short: 'bbbbbbb', subject: 'Improved dashboard <b>x</b>', author: 'dev', date: '2026-11-01T09:00:00Z' }],
    latestCommitInfo: null, notifyStatus: 'sent', pendingNotify: false,
    lastNotifiedCommit: HASH_B, lastNotifiedAt: Date.parse('2026-11-01T10:00:00Z'),
    intervalMs: 43200000, telegram: true
};

function boot() {
    const fetches = [], toasts = [];
    const dom = new JSDOM(read('public/index.html').replace(/<script src="[^"]+"><\/script>/g, ''), {
        runScripts: 'dangerously', url: 'http://127.0.0.1:3210/', pretendToBeVisual: true,
        beforeParse(window) {
            window.fetch = async u => {
                fetches.push(String(u));
                if (String(u).includes('/api/update/status')) return { ok: true, status: 200, json: async () => state };
                if (String(u).includes('/api/setup/status')) return { ok: true, status: 200, json: async () => ({ required: false, authed: false }) };
                if (String(u).includes('/api/session')) return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
                return { ok: true, status: 200, json: async () => ({}) };
            };
            window.WebSocket = class { constructor() { this.readyState = 0; } close() { } };
            window.eval('window.t = (k, v) => k + (v ? " " + JSON.stringify(v) : "")');
        }
    });
    const { window } = dom;
    window.eval(read('public/i18n.js'));
    window.eval(read('public/update.js'));
    window.uiToast = (m, type) => toasts.push({ m, type });
    return { window, fetches, toasts, $: id => window.document.getElementById(id) };
}

test('dashboard: notifikasi update saat login, popup detail, dan status WebSocket', { skip: !JSDOM && 'jsdom tidak terpasang' }, async () => {
    const { window, fetches, toasts, $ } = boot();

    await window.updateOnLogin();
    assert.equal(fetches.filter(f => f.includes('/api/update/status')).length, 1, 'status dibaca sekali saat login');
    assert.equal(fetches.filter(f => f.includes('/api/update/check')).length, 0, 'login tidak memicu cek GitHub');
    assert.equal($('update-badge').style.display, 'inline-flex', 'lencana header tampil');
    assert.equal($('update-banner').classList.contains('hidden'), false, 'kartu dashboard tampil');
    assert.match($('update-banner-meta').textContent, /aaaaaaa/);
    assert.match($('update-banner-meta').textContent, /bbbbbbb/);
    assert.equal(toasts.length, 1, 'satu toast saat login');

    await window.updateOnLogin();                       // dashboard dimuat ulang
    assert.equal(toasts.length, 1, 'toast tidak berulang untuk commit yang sama');

    window.updateOpenDetails();
    assert.equal($('modal-update').classList.contains('hidden'), false, 'popup terbuka');
    assert.equal($('upd-modal-current').textContent, 'aaaaaaa');
    assert.equal($('upd-modal-latest').textContent, 'bbbbbbb');
    assert.match($('upd-modal-list').textContent, /Improved dashboard/);
    assert.ok(!$('upd-modal-list').innerHTML.includes('<b>x</b>'), 'pesan commit di-escape');
    assert.match($('upd-modal-cmd').textContent, /git pull origin main/);
    assert.equal($('upd-modal-repo').href, 'https://github.com/arel342/NodelixcoreOS');

    window.updateFromServer({ ...state, latestCommit: HASH_C, latestShort: 'ccccccc', commits: [] });
    assert.equal($('upd-modal-latest').textContent, 'ccccccc', 'popup ikut status WebSocket');
    assert.equal(toasts.length, 2, 'commit baru memicu satu toast');

    window.updateFromServer({ ...state, updateAvailable: false, commits: [] });
    assert.equal($('update-badge').style.display, 'none', 'lencana hilang saat tidak ada update');
    assert.equal($('update-banner').classList.contains('hidden'), true, 'kartu hilang saat tidak ada update');

    window.updateCloseDetails();
    assert.equal($('modal-update').classList.contains('hidden'), true, 'popup bisa ditutup');
});
