// Dialog sendiri pengganti popup bawaan browser (alert / confirm / prompt) + toast + dialog "sedang bekerja".
// Semua mengembalikan Promise:  await uiConfirm('Hapus?')  ->  true / false
(function () {
    const css = `
.dlg-back{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.45);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:dlgf .15s ease-out}
.dlg{width:100%;max-width:380px;background:#fff;color:#0f172a;border-radius:24px;padding:26px 24px 20px;box-shadow:0 25px 60px -12px rgba(15,23,42,.4);animation:dlgp .2s cubic-bezier(.2,.9,.3,1.15);text-align:left}
.dlg-ic{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;margin-bottom:14px}
.dlg-ic svg{width:24px;height:24px}
.dlg-info{background:#e8f1fb;color:#2f78be}.dlg-ok{background:#e3f6ec;color:#15803d}.dlg-error{background:#fde8e8;color:#dc2626}.dlg-warn{background:#fff3d6;color:#b45309}.dlg-ask{background:#e8f1fb;color:#2f78be}
.dlg h3{margin:0 0 6px;font-size:18px;font-weight:700;line-height:1.25}
.dlg p{margin:0;font-size:14px;line-height:1.5;color:#475569;white-space:pre-wrap;word-break:break-word}
.dlg-in{width:100%;margin-top:14px;padding:11px 14px;border:1.5px solid #dbe2ee;border-radius:12px;font:inherit;font-size:15px;color:#0f172a;outline:none}
.dlg-in:focus{border-color:#2f78be;box-shadow:0 0 0 3px #2f78be26}
.dlg-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
.dlg-b{border:0;border-radius:12px;padding:10px 20px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.dlg-c{background:transparent;color:#64748b}.dlg-c:hover{background:#f1f5f9}
.dlg-y{background:#2f78be;color:#fff}.dlg-y:hover{background:#27669f}
.dlg-y.dlg-danger{background:#dc2626}.dlg-y.dlg-danger:hover{background:#b91c1c}
.dlg-b:focus-visible,.dlg-in:focus-visible{outline:2px solid #4aa3ff;outline-offset:2px}
.dlg-spin{width:34px;height:34px;border:4px solid #e2e8f0;border-top-color:#2f78be;border-radius:50%;margin:18px auto 4px;animation:dlgs .8s linear infinite}
.dlg-toast{position:fixed;left:50%;bottom:24px;z-index:110;transform:translate(-50%,20px);max-width:92vw;padding:11px 18px;border-radius:14px;background:#0f172a;color:#fff;font-size:14px;font-weight:500;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;box-shadow:0 10px 30px rgba(15,23,42,.3)}
.dlg-toast.show{opacity:1;transform:translate(-50%,0)}
.dlg-toast.ok{background:#166534}.dlg-toast.error{background:#b91c1c}.dlg-toast.warn{background:#b45309}
@keyframes dlgf{from{opacity:0}}@keyframes dlgp{from{opacity:0;transform:translateY(10px) scale(.96)}}@keyframes dlgs{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.dlg-back,.dlg,.dlg-spin,.dlg-toast{animation:none!important;transition:none!important}}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    const IC = {
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
        ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16 9.5"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
        warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.5h.01"/></svg>',
        ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5M12 16.5h.01"/></svg>'
    };
    // Judul & label tombol mengikuti bahasa yang dipilih (t() dari i18n.js)
    const TITLE = { info: () => t('ui.info'), ok: () => t('ui.ok'), error: () => t('ui.error'), warn: () => t('ui.warn'), ask: () => t('ui.ask') };
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const guess = m => /gagal|error|tidak (dapat|bisa|valid|ditemukan|terdeteksi|merespons|terjangkau)|ditolak|salah|kedaluwarsa|habis|terputus/i.test(m) ? 'error' : 'info';

    let chain = Promise.resolve();
    const open = new Set();    // pesan yang sedang tampil/antri: mencegah alert kembar menumpuk

    function show(o) {
        return new Promise(resolve => {
            const prev = document.activeElement;
            const el = document.createElement('div');
            el.className = 'dlg-back';
            el.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
                <div class="dlg-ic dlg-${o.type}">${IC[o.type]}</div>
                <h3 id="dlg-t">${esc(o.title)}</h3>${o.message ? `<p>${esc(o.message)}</p>` : ''}
                ${o.input ? '<input class="dlg-in" type="text" autocomplete="off" spellcheck="false">' : ''}
                <div class="dlg-btns">${o.cancel ? `<button type="button" class="dlg-b dlg-c">${esc(o.cancel)}</button>` : ''}<button type="button" class="dlg-b dlg-y${o.danger ? ' dlg-danger' : ''}">${esc(o.ok)}</button></div></div>`;
            const inp = el.querySelector('.dlg-in'), yes = el.querySelector('.dlg-y'), no = el.querySelector('.dlg-c');
            if (inp) { inp.type = o.inputType === 'password' ? 'password' : 'text'; inp.value = o.value || ''; inp.placeholder = o.placeholder || ''; inp.maxLength = o.maxLength || 120; }
            const done = v => { el.remove(); document.removeEventListener('keydown', key, true); if (prev && prev.focus) try { prev.focus(); } catch (e) { } resolve(v); };
            const accept = () => done(inp ? inp.value : true), reject = () => done(inp ? null : false);
            const key = e => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); reject(); }
                else if (e.key === 'Enter' && (inp ? e.target === inp : e.target === document.body)) { e.preventDefault(); accept(); }
                else if (e.key === 'Tab') {   // fokus tidak keluar dari dialog
                    const f = [...el.querySelectorAll('input,button')], i = f.indexOf(document.activeElement);
                    e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
                }
            };
            yes.onclick = accept; if (no) no.onclick = reject;
            el.addEventListener('mousedown', e => { if (e.target === el) reject(); });
            document.addEventListener('keydown', key, true);
            document.body.appendChild(el);
            (inp || yes).focus(); if (inp) inp.select();
        });
    }
    const queue = o => { const p = chain.then(() => show(o)); chain = p.catch(() => { }); return p; };

    window.uiAlert = (message, o = {}) => {
        message = String(message == null ? '' : message);
        if (open.has(message)) return Promise.resolve();
        open.add(message);
        const type = o.type || guess(message);
        return queue({ type, title: o.title || TITLE[type](), message, ok: o.ok || t('ui.okBtn') }).then(() => { open.delete(message); });
    };
    window.uiConfirm = (message, o = {}) => queue({ type: o.type || (o.danger ? 'warn' : 'ask'), title: o.title || TITLE.ask(), message, ok: o.ok || t('ui.yes'), cancel: o.cancel || t('ui.cancel'), danger: o.danger });
    window.uiPrompt = (message, value = '', o = {}) => queue({ type: 'ask', title: o.title || t('ui.input'), message, input: true, inputType: o.inputType, value, placeholder: o.placeholder, maxLength: o.maxLength, ok: o.ok || t('ui.save'), cancel: t('ui.cancel') });

    // Dialog "sedang bekerja" (tanpa tombol) untuk proses panjang, mis. kompres ZIP:  const b = uiBusy('Mengompres', 'video.mp4'); ... b.close();
    window.uiBusy = (title, message) => {
        const el = document.createElement('div');
        el.className = 'dlg-back';
        el.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-bt" style="text-align:center"><div class="dlg-spin"></div><h3 id="dlg-bt" style="margin-top:14px">${esc(title)}</h3><p data-m>${esc(message || '')}</p></div>`;
        document.body.appendChild(el);
        return { close: () => el.remove(), update: m => { el.querySelector('[data-m]').textContent = m; } };
    };

    let tT;
    window.uiToast = (message, type = 'ok') => {
        let t = document.getElementById('dlg-toast');
        if (!t) { t = document.createElement('div'); t.id = 'dlg-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
        t.className = 'dlg-toast ' + type; t.textContent = message;
        void t.offsetWidth; t.classList.add('show');
        clearTimeout(tT); tT = setTimeout(() => t.classList.remove('show'), 3500);
    };

    // Sisa pemanggilan alert() lama tidak lagi memunculkan popup Chrome
    window.alert = m => { window.uiAlert(m); };
})();
