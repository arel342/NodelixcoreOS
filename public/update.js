// ============================================================================
// public/update.js — notifikasi update GitHub di dashboard.
//
// Semua data berasal dari STATUS TERSIMPAN di server (data/update-state.json):
//   • saat login / dashboard dimuat  -> GET /api/update/status (tanpa request GitHub)
//   • saat pemeriksaan 12 jam selesai -> WebSocket {type:'UPDATE'}
// Jadi membuka dashboard dari banyak perangkat tidak pernah memicu pemeriksaan baru.
//
// Yang ditampilkan: lencana di header, kartu/banner di tab Dashboard, popup detail
// (commit terpasang, commit terbaru, pesan commit, waktu deteksi, status Telegram),
// dan tombol periksa manual. Pemasangan update TIDAK dilakukan dari browser — server
// tidak pernah memasang update sendiri; perintahnya disalin ke Termux oleh admin.
// ============================================================================
(function () {
    const $ = id => document.getElementById(id);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const MANUAL_CMD = 'git pull origin main && npm install';

    const st = { data: null, checking: false, loaded: false };
    const shownKey = 'nodelix.upd.shown';       // commit yang toast-nya sudah tampil di perangkat ini
    const STATUS_KEY = {
        sent: 'upd.stSent',
        pending: 'upd.stPending',
        unconfigured: 'upd.stUnconfigured',
        disabled: 'upd.stDisabled',
        failed: 'upd.stFailed',
        none: 'upd.stNone'
    };

    function lang() {
        try { return typeof getLang === 'function' ? getLang() : 'id'; } catch { return 'id'; }
    }
    function fmtTime(ts) {
        if (!ts) return t('upd.never');
        try {
            const l = lang() === 'zh' ? 'zh-CN' : lang() === 'en' ? 'en-GB' : 'id-ID';
            return new Date(ts).toLocaleString(l, { dateStyle: 'medium', timeStyle: 'short' });
        } catch { return new Date(ts).toLocaleString(); }
    }
    function errText(code) {
        const map = { not_repo: 'upd.notRepo', network: 'upd.network', rate_limited: 'upd.rateLimited', git_error: 'upd.gitError', auth: 'upd.gitError' };
        return map[code] ? t(map[code]) : '';
    }
    function statusText(s) {
        return t(STATUS_KEY[s] || STATUS_KEY.none);
    }
    function toastShown(commit) {
        try { return sessionStorage.getItem(shownKey) === String(commit || ''); } catch { return false; }
    }
    function markToastShown(commit) {
        try { sessionStorage.setItem(shownKey, String(commit || '')); } catch { }
    }

    // ---------- Gambar ulang lencana, banner, dan isi popup ----------
    function render() {
        const s = st.data;
        const badge = $('update-badge');
        const banner = $('update-banner');
        const meta = $('update-banner-meta');
        const show = !!(s && s.updateAvailable);

        if (badge) badge.style.display = show ? 'inline-flex' : 'none';
        if (banner) banner.classList.toggle('hidden', !show);
        if (meta && show) {
            meta.textContent = t('upd.bannerMeta', { a: s.installedShort || '?', b: s.latestShort || '?' });
        }

        // Tombol/teks di popup
        const cur = $('upd-modal-current'), lat = $('upd-modal-latest');
        if (cur) cur.textContent = s && s.installedShort ? s.installedShort : '-';
        if (lat) lat.textContent = s && s.latestShort ? s.latestShort : '-';

        const sub = $('upd-modal-sub');
        if (sub) {
            if (!s) sub.textContent = '';
            else if (s.updateAvailable) sub.textContent = t('upd.sub');
            else if (s.lastCheckError) sub.textContent = errText(s.lastCheckError) || t('upd.gitError');
            else sub.textContent = t('upd.upToDate');
        }

        const list = $('upd-modal-list');
        if (list) {
            const commits = (s && Array.isArray(s.commits)) ? s.commits : [];
            if (!commits.length) {
                list.innerHTML = `<li class="text-slate-500">${esc(t('upd.noCommits'))}</li>`;
            } else {
                list.innerHTML = commits.slice(0, 10).map(c => {
                    const meta2 = [c.author, c.date ? String(c.date).slice(0, 10) : ''].filter(Boolean).join(' · ');
                    return `<li class="flex gap-2"><code class="text-[11px] text-amber-700 shrink-0">${esc(c.short || String(c.hash || '').slice(0, 7))}</code>` +
                        `<span class="flex-1">${esc(c.subject || t('upd.noCommits'))}` +
                        (meta2 ? `<span class="block text-[10px] text-slate-400">${esc(meta2)}</span>` : '') + `</span></li>`;
                }).join('');
            }
        }

        const p = id => $(id);
        if (p('upd-modal-detected')) p('upd-modal-detected').textContent = fmtTime(s && s.detectedAt);
        if (p('upd-modal-checked')) p('upd-modal-checked').textContent = fmtTime(s && s.lastCheckedAt);
        if (p('upd-modal-notify')) p('upd-modal-notify').textContent = s ? statusText(s.notifyStatus) : '-';
        if (p('upd-modal-repo')) {
            const a = p('upd-modal-repo');
            const url = (s && /^https?:\/\//.test(String(s.repoUrl || ''))) ? s.repoUrl : 'https://github.com/arel342/NodelixcoreOS';
            a.textContent = url;
            a.href = url;
        }
        const cmd = $('upd-modal-cmd');
        if (cmd) cmd.textContent = MANUAL_CMD;
        const btn = $('upd-check-btn');
        if (btn) btn.textContent = st.checking ? t('upd.checking') : t('upd.checkNow');
        if (btn) btn.disabled = st.checking;
    }

    // ---------- Ambil status tersimpan (tanpa akses GitHub di server) ----------
    async function load({ login = false } = {}) {
        // Satu pembacaan status per muat halaman: login otomatis & WebSocket memakai
        // data yang sama, jadi tidak ada permintaan berulang ke server.
        if (st.loaded && st.data) {
            render();
            if (login) notifyLogin(st.data);
            return st.data;
        }
        try {
            const r = await fetch('/api/update/status', { headers: { 'Accept': 'application/json' } });
            if (!r.ok) return null;
            const j = await r.json();
            if (!j || j.success !== true) return null;
            st.data = j;
            st.loaded = true;
            render();
            if (login) notifyLogin(j);
            return j;
        } catch (e) { return null; }
    }

    // Notifikasi saat admin/perangkat login: hanya sekali per commit per sesi browser,
    // dan hanya bila status tersimpan menyatakan ada update.
    function notifyLogin(s) {
        if (!s || !s.updateAvailable || !s.latestCommit) return;
        if (toastShown(s.latestCommit)) return;
        markToastShown(s.latestCommit);
        if (window.uiToast) {
            uiToast(t('upd.loginToast', { a: s.installedShort || '?', b: s.latestShort || '?' }), 'warn');
        }
    }

    // ---------- API publik untuk index.html ----------
    window.updateOnLogin = () => load({ login: true });

    window.updateFromServer = data => {
        if (!data) return;
        const before = st.data && st.data.latestCommit;
        st.data = data;
        render();
        // Commit baru terdeteksi saat perangkat terhubung -> tampilkan sekali.
        if (data.updateAvailable && data.latestCommit && before !== data.latestCommit && !toastShown(data.latestCommit)) {
            markToastShown(data.latestCommit);
            if (window.uiToast) uiToast(t('upd.loginToast', { a: data.installedShort || '?', b: data.latestShort || '?' }), 'warn');
        }
    };

    // Dipanggil applyLang() saat bahasa diganti
    window.updateRender = render;

    window.updateOpenDetails = async () => {
        $('modal-update').classList.remove('hidden');
        render();
        if (!st.data) await load();
    };
    window.updateCloseDetails = () => $('modal-update').classList.add('hidden');

    window.updateCopyCmd = async () => {
        try {
            await navigator.clipboard.writeText(MANUAL_CMD);
            if (window.uiToast) uiToast(t('upd.copied'), 'ok');
        } catch (e) {
            const el = $('upd-modal-cmd');
            if (el) {
                const r = document.createRange();
                r.selectNodeContents(el);
                const sel = window.getSelection();
                sel.removeAllRanges(); sel.addRange(r);
                if (window.uiToast) uiToast(t('upd.copied'), 'ok');
            }
        }
    };

    // Pemeriksaan manual hanya untuk administrator yang sudah login (server memeriksa sesi
    // lewat requireAuth dan membatasi frekuensinya).
    window.updateCheckNow = async () => {
        if (st.checking) return;
        st.checking = true; render();
        try {
            const r = await fetch('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const j = await r.json().catch(() => null);
            if (j) {
                const { success, message, ...state } = j;
                if (state && state.repo) { st.data = state; render(); }
                if (window.uiToast) uiToast(message || t('upd.checkDone'), success === false && r.status >= 400 ? 'warn' : 'ok');
            } else if (window.uiToast) {
                uiToast(t('upd.error'), 'error');
            }
        } catch (e) {
            if (window.uiToast) uiToast(t('upd.error'), 'error');
        } finally {
            st.checking = false;
            render();
        }
    };

    // ---------- Awal ----------
    // Bila dashboard sudah login sebelum skrip ini selesai dimuat (sesi lama), status
    // tetap dibaca sekali — jadi notifikasi login tidak bergantung urutan pemuatan skrip.
    function autoInit() {
        const shell = $('app-shell');
        if (!st.loaded && shell && !shell.classList.contains('hidden')) load({ login: true });
    }

    window.addEventListener('load', () => {
        autoInit();
        // Bila dibuka lewat tautan Telegram (…/#update), popup detail langsung dibuka.
        if (location.hash === '#update' && window.updateOpenDetails) window.updateOpenDetails();
    });
})();
