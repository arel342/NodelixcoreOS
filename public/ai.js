// ============================================================================
// public/ai.js — halaman AI Agent sederhana.
// Semua keputusan izin tetap di backend: halaman ini hanya menampilkan tombol
// konfirmasi yang dibuat server dan mengirim persetujuan lewat route terautentikasi.
// ============================================================================
(function () {
    const $ = id => document.getElementById(id);
    const messages = $('messages');
    const confirmations = $('confirmations');
    const input = $('input');
    const state = $('state');
    const sendBtn = $('btn-send');

    async function api(path, options = {}) {
        const r = await fetch(path, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        let body = null;
        try { body = await r.json(); } catch { }
        return { ok: r.ok, status: r.status, body };
    }

    function bubble(text, kind) {
        const div = document.createElement('div');
        div.className = 'msg ' + (kind || 'assistant');
        div.textContent = String(text == null ? '' : text);
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div;
    }

    function badge(el, text, kind) {
        el.textContent = text;
        el.className = 'badge' + (kind ? ' ' + kind : '');
    }

    function renderConfirmations(list) {
        confirmations.innerHTML = '';
        for (const cf of list || []) {
            const box = document.createElement('div');
            box.className = 'confirm';
            const h = document.createElement('h3');
            h.textContent = '🔐 Butuh konfirmasi';
            const pre = document.createElement('pre');
            pre.textContent = cf.summary || cf.target || cf.id;
            const meta = document.createElement('div');
            meta.className = 'muted';
            meta.textContent = `ID ${cf.id} · berlaku ${cf.expiresIn || cf.expires_in || '?'} detik`;
            const row = document.createElement('div');
            row.className = 'row';
            const yes = document.createElement('button');
            yes.textContent = 'Setujui & jalankan';
            const no = document.createElement('button');
            no.className = 'secondary';
            no.textContent = 'Batalkan';
            yes.onclick = () => act(cf.id, 'approve', box, yes, no);
            no.onclick = () => act(cf.id, 'cancel', box, yes, no);
            row.appendChild(yes);
            row.appendChild(no);
            box.append(h, pre, meta, row);
            confirmations.appendChild(box);
        }
    }

    async function act(id, action, box, yes, no) {
        yes.disabled = true;
        no.disabled = true;
        state.textContent = action === 'approve' ? 'Menjalankan tindakan…' : 'Membatalkan…';
        const r = await api(`/api/ai/confirmations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
        state.textContent = '';
        if (r.ok && (r.body.success || action === 'cancel')) {
            box.remove();
            if (action === 'approve') {
                const res = r.body.result;
                bubble(res && res.status === 'ok'
                    ? '✅ Dijalankan: ' + JSON.stringify(res.result, null, 1)
                    : '⚠️ Gagal: ' + ((res && res.message) || r.body.message || 'tidak diketahui'), res && res.status === 'ok' ? 'assistant' : 'error');
            } else {
                bubble('❌ Dibatalkan.', 'assistant');
            }
            refreshConfirmations();
        } else {
            bubble('⚠️ ' + ((r.body && r.body.message) || 'Konfirmasi tidak dapat dipakai.'), 'error');
            // Tampilkan ulang status tombol agar pengguna bisa mencoba konfirmasi lain.
            yes.disabled = false;
            no.disabled = false;
            refreshConfirmations();
        }
    }

    async function refreshConfirmations() {
        const r = await api('/api/ai/confirmations');
        if (r.ok && r.body) renderConfirmations(r.body.confirmations || []);
    }

    async function loadStatus() {
        const r = await api('/api/ai/status');
        if (r.status === 401) {
            $('blocked').classList.remove('hidden');
            sendBtn.disabled = true;
            return;
        }
        $('blocked').classList.add('hidden');
        const s = r.body || {};
        badge($('badge-model'), 'model: ' + (s.model || '-'), s.hasKey ? 'ok' : 'warn');
        badge($('badge-terminal'), 'terminal: ' + (s.terminalEnabled ? 'aktif' : 'nonaktif'), s.terminalEnabled ? 'ok' : 'bad');
        badge($('badge-history'), 'riwayat: ' + ((s.history && s.history.sessions) || 0) + ' sesi');
        const feat = s.features || {};
        const parts = [];
        for (const [key, f] of Object.entries(feat)) {
            if (!f) continue;
            parts.push(`${key === 'document' ? 'Dokumen' : 'Suara'}: ${f.available ? 'siap (' + (f.model || '') + ')' : 'nonaktif'}`);
        }
        $('features').textContent = (s.enabled ? '' : 'AI Agent dinonaktifkan. ') +
            (s.hasKey ? '' : 'GEMINI_API_KEY belum diisi. ') +
            (parts.length ? parts.join(' · ') : 'Fitur dokumen/suara nonaktif secara default.');
        if (s.conversation) { /* tidak dipakai */ }
    }

    $('form').addEventListener('submit', async e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        bubble(text, 'user');
        sendBtn.disabled = true;
        state.textContent = 'Menunggu AI…';
        try {
            const r = await api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
            state.textContent = '';
            if (!r.ok) {
                bubble('⚠️ ' + ((r.body && r.body.reply) || 'Gagal menghubungi server.'), 'error');
                return;
            }
            const body = r.body || {};
            bubble(body.reply || '(tidak ada jawaban)', body.success ? 'assistant' : 'error');
            if (body.confirmations && body.confirmations.length) {
                renderConfirmations(body.confirmations.map(cf => ({
                    ...cf,
                    id: cf.confirmation_id,
                    expiresIn: cf.expires_in_sec
                })));
                await refreshConfirmations();
            }
        } catch (err) {
            state.textContent = '';
            bubble('⚠️ ' + err.message, 'error');
        } finally {
            sendBtn.disabled = false;
            input.focus();
        }
    });

    $('btn-clear').addEventListener('click', async () => {
        const r = await api('/api/ai/history/clear', { method: 'POST', body: '{}' });
        state.textContent = r.ok ? 'Riwayat dihapus.' : 'Gagal menghapus riwayat.';
        setTimeout(() => { state.textContent = ''; }, 2500);
        loadStatus();
    });

    loadStatus();
    refreshConfirmations();
    setInterval(refreshConfirmations, 15000);
})();
