// Upload dengan popup progres: persentase, kecepatan (Mbps), ukuran, sisa waktu.
// fetch() tidak punya progres upload, jadi memakai XMLHttpRequest.
// Semua teks lewat t() supaya mengikuti bahasa yang dipilih di Pengaturan.
(function () {
    const $ = id => document.getElementById(id);
    const fmtB = b => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i]; };
    const fmtT = s => !isFinite(s) ? '' : s < 60 ? t('up.tS', { s: Math.ceil(s) }) : s < 3600 ? t('up.tMS', { m: Math.floor(s / 60), s: Math.ceil(s % 60) }) : t('up.tHM', { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60) });

    document.body.insertAdjacentHTML('beforeend', `
    <div id="up-modal" class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 hidden">
        <div class="bg-white rounded-3xl p-7 w-full max-w-sm shadow-2xl mx-4 border border-slate-100">
            <h3 id="up-title" class="text-lg font-bold text-slate-800" data-i18n="up.title">Mengunggah file</h3>
            <p id="up-name" class="text-xs text-slate-500 truncate mt-1 mb-5"></p>
            <div class="flex items-end justify-between mb-2">
                <span id="up-pct" class="text-4xl font-bold text-slate-800" style="font-variant-numeric:tabular-nums">0%</span>
                <span id="up-speed" class="text-sm font-semibold text-blue-600" style="font-variant-numeric:tabular-nums">0.0 Mbps</span>
            </div>
            <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden"><div id="up-bar" class="h-full bg-blue-600 rounded-full" style="width:0%;transition:width .15s linear"></div></div>
            <div class="flex justify-between text-xs text-slate-500 mt-2"><span id="up-size"></span><span id="up-eta"></span></div>
            <p id="up-msg" class="text-xs font-semibold text-slate-600 mt-4" style="min-height:1rem"></p>
            <div class="flex justify-end mt-4"><button id="up-btn" type="button" class="text-slate-500 hover:text-slate-700 font-semibold text-sm px-5 py-2 rounded-xl" data-i18n="up.cancel">Batalkan</button></div>
        </div>
    </div>`);

    let xhr = null, closeTimer = null;
    const setMsg = (t0, cls) => { const m = $('up-msg'); m.textContent = t0; m.className = 'text-xs font-semibold mt-4 ' + (cls || 'text-slate-600'); };
    const close = () => { clearTimeout(closeTimer); $('up-modal').classList.add('hidden'); xhr = null; };
    $('up-btn').onclick = () => { if (xhr) xhr.abort(); else close(); };

    function upload(file, dir) {
        return new Promise((resolve, reject) => {
            const t0 = performance.now(), samples = [[t0, 0]];
            let lastPaint = 0;
            xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload?dir=' + encodeURIComponent(dir));

            xhr.upload.onprogress = e => {
                const now = performance.now();
                samples.push([now, e.loaded]);
                while (samples.length > 2 && now - samples[0][0] > 3000) samples.shift();   // kecepatan = rata-rata 3 detik terakhir
                if (now - lastPaint < 120 && e.loaded < e.total) return;
                lastPaint = now;
                const [ta, la] = samples[0], bps = (e.loaded - la) / Math.max(0.001, (now - ta) / 1000);
                const pct = e.lengthComputable ? e.loaded / e.total * 100 : 0;
                $('up-pct').textContent = Math.floor(pct) + '%';
                $('up-bar').style.width = pct + '%';
                $('up-speed').textContent = (bps * 8 / 1e6).toFixed(1) + ' Mbps';
                $('up-size').textContent = fmtB(e.loaded) + ' / ' + fmtB(e.total);
                $('up-eta').textContent = bps > 0 ? t('up.remain', { t: fmtT((e.total - e.loaded) / bps) }) : '';
            };
            xhr.upload.onload = () => {       // semua byte sudah terkirim; server masih menyelesaikan penyimpanan
                $('up-pct').textContent = '100%'; $('up-bar').style.width = '100%'; $('up-eta').textContent = '';
                setMsg(t('up.saving')); $('up-btn').disabled = true; $('up-btn').style.opacity = .4;
            };
            xhr.onload = () => {
                let j = {}; try { j = JSON.parse(xhr.responseText); } catch (e) { }
                if (xhr.status === 200 && j.success) {
                    const avg = file.size * 8 / 1e6 / Math.max(0.001, (performance.now() - t0) / 1000);
                    resolve(avg);
                } else reject(new Error(j.error || (xhr.status === 401 ? t('up.sessExp') : t('up.failHttp', { c: xhr.status }))));
            };
            xhr.onerror = () => reject(new Error(t('up.lost')));
            xhr.onabort = () => reject(new Error(t('up.aborted')));

            const fd = new FormData();
            fd.append('file', file);
            xhr.send(fd);
        });
    }

    window.uploadSelectedFile = async function () {
        const input = $('file-input'), file = input.files && input.files[0];
        if (!file) return;
        clearTimeout(closeTimer);
        $('up-name').textContent = file.name;
        $('up-title').textContent = t('up.title');
        $('up-pct').textContent = '0%'; $('up-bar').style.width = '0%'; $('up-bar').className = 'h-full bg-blue-600 rounded-full';
        $('up-speed').textContent = '0.0 Mbps'; $('up-size').textContent = '0 B / ' + fmtB(file.size); $('up-eta').textContent = '';
        $('up-btn').textContent = t('up.cancel'); $('up-btn').disabled = false; $('up-btn').style.opacity = 1;
        setMsg(t('up.checking'));
        $('up-modal').classList.remove('hidden');
        try {
            const s = await (await fetch('/api/storage/status')).json();
            if (!s.ready) throw new Error(s.message || t('up.notReady'));
            if (s.free && file.size > s.free) throw new Error(t('up.noSpace', { free: fmtB(s.free) }));
            setMsg(t('up.sending'));
            const avg = await upload(file, typeof currentPath === 'string' ? currentPath : '');
            $('up-title').textContent = t('up.done');
            setMsg(t('up.doneMsg', { v: avg.toFixed(1) }), 'text-green-600');
            $('up-btn').textContent = t('up.close'); $('up-btn').disabled = false; $('up-btn').style.opacity = 1;
            closeTimer = setTimeout(close, 1800);
            loadFileList(); loadStorageStatus();
        } catch (e) {
            $('up-title').textContent = t('up.fail');
            $('up-bar').className = 'h-full bg-red-500 rounded-full';
            setMsg(e.message, 'text-red-500');
            $('up-btn').textContent = t('up.close'); $('up-btn').disabled = false; $('up-btn').style.opacity = 1;
            xhr = null;
        }
        input.value = '';
    };

    // Baris status penyimpanan di tab Storage
    window.loadStorageStatus = async function () {
        const el = $('storage-bar');
        if (!el) return;
        try {
            const s = await (await fetch('/api/storage/status')).json();
            el.innerHTML = s.ready
                ? `<span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>${escapeHtml(t('up.barReady'))} · <span class="text-gray-400">${escapeHtml(s.root)}</span>${s.free ? ` · ${escapeHtml(t('up.barFree', { free: fmtB(s.free), total: fmtB(s.total) }))}` : ''}`
                : `<span class="inline-block w-2 h-2 rounded-full bg-red-500 mr-2"></span><span class="text-red-600">${escapeHtml(s.message)}</span> <button onclick="loadStorageStatus()" class="text-blue-600 underline ml-1">${escapeHtml(t('up.recheck'))}</button>`;
        } catch (e) { el.textContent = t('up.barFail'); }
    };
})();
