// Tab "Update Firmware": unggah file .bin ke server, lalu server mengirimnya ke ESP (OTA).
//  - File bukan .bin -> peringatan langsung di tab (dan server juga menolak permintaannya).
//  - Progres: persen dari browser ke server (XHR upload), lalu bilah berjalan saat server
//    mengirim ke ESP (kabar dari server lewat WebSocket {type:'FW'}).
// Semua teks lewat t() supaya mengikuti bahasa yang dipilih di Pengaturan.
const fw = { s: null, dev: '', file: null, warn: '', pct: 0, phase: '', err: '', busy: false, result: null, t0: 0, tick: null, poll: null, visible: false };
const $w = id => document.getElementById(id);

// ---------- data dari server ----------
async function loadFirmware() {
    try {
        const j = await (await fetch('/api/firmware')).json();
        fw.s = j;
        if (!fw.dev && fw.s.devices && fw.s.devices.length) fw.dev = fw.s.devices[0].key;
        // Sinkronkan tampilan dengan keadaan server: update jalan dari halaman lain, atau sudah selesai
        if (fw.s.busy && !fw.busy && !fwRunning()) { fw.phase = 'send'; fw.result = null; fw.t0 = Date.now(); }
        else if (!fw.s.busy && !fw.busy && (fw.phase === 'send' || fw.phase === 'reboot')) { fw.phase = 'done'; fw.notice = ''; }
        renderFirmware();
    } catch (e) { /* server mati / sesi habis: biarkan tampilan terakhir */ }
}

function fwOpen() {
    fw.visible = true;
    loadFirmware();
    clearInterval(fw.poll);
    fw.poll = setInterval(() => { if (!fw.busy && fw.visible) loadFirmware(); }, 10000);
}
function fwClose() { fw.visible = false; clearInterval(fw.poll); }

// ---------- tindakan ----------
function fwSelect(key) {
    if (fwRunning()) return;
    fw.dev = key;
    renderFirmware();
}

function fwPick(file) {
    fw.err = ''; fw.result = null;
    fw.file = file || null;
    fw.warn = '';
    if (file && !/\.bin$/i.test(file.name)) fw.warn = t('fw.notBin', { name: file.name });   // peringatan: bukan file .bin
    renderFirmware();
}

async function fwStart() {
    if (fw.busy) return;
    const d = fwDev();
    if (!fw.file) { uiAlert(t('fw.noFile'), { type: 'warn' }); return; }
    if (!d) { uiAlert(t('fw.noDev'), { type: 'warn' }); return; }
    if (!d.configured) { uiAlert(d.key === 'esp8266' ? t('fw.noIp', { k: 'DOOR_IP' }) : t('fw.noIp', { k: 'ESP32_IP' }), { type: 'error' }); return; }
    // Berkas bukan .bin: minta konfirmasi dulu (peringatan kedua sebelum dikirim)
    if (fw.warn && !(await uiConfirm(t('fw.confirmNotBin', { name: fw.file.name }), { title: t('fw.notBinTitle'), ok: t('fw.start'), danger: true }))) return;

    fw.busy = true; fw.pct = 0; fw.phase = 'upload'; fw.err = ''; fw.result = null; fw.notice = ''; fw.t0 = Date.now();
    clearInterval(fw.tick);
    fw.tick = setInterval(renderFirmware, 1000);   // hitung detik berjalan saat menunggu ESP
    renderFirmware();

    try {
        const j = await fwPost(d.key, fw.file, p => { fw.pct = p; if (p >= 100 && fw.phase === 'upload') fw.phase = 'send'; renderFirmware(); });
        fw.result = { ok: true, message: j.message || t('fw.done', { dev: d.label, fw: j.fw ? t('fw.okFw', { fw: j.fw }) : '' }) };
        fw.phase = 'done';
        uiToast(fw.result.message, j.warning ? 'warn' : 'ok');
    } catch (e) {
        fw.result = { ok: false, message: e.message };
        fw.phase = 'error';
        uiAlert(t('fw.fail', { e: e.message }), { type: 'error', title: t('fw.failed') });
    } finally {
        fw.busy = false;
        clearInterval(fw.tick); fw.tick = null;
        renderFirmware();
        loadFirmware();
    }
}

function fwReset() {
    if (fwRunning()) return;
    fw.file = null; fw.warn = ''; fw.pct = 0; fw.phase = ''; fw.err = ''; fw.result = null;
    const inp = $w('fw-file'); if (inp) inp.value = '';
    renderFirmware();
}

// Unggah ke server sambil melaporkan persen (browser -> server)
function fwPost(device, file, onPct) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/firmware/flash');
        xhr.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.min(100, Math.round(e.loaded / e.total * 100))); };
        xhr.onload = () => {
            let j = {};
            try { j = JSON.parse(xhr.responseText); } catch (e) { }
            if (xhr.status === 401) return reject(new Error(t('fw.needLogin')));
            if (xhr.status >= 200 && xhr.status < 300 && j.success) return resolve(j);
            reject(new Error(j.error || j.message || ('HTTP ' + xhr.status)));
        };
        xhr.onerror = () => reject(new Error(t('fw.notWithThis')));
        xhr.ontimeout = () => reject(new Error(t('fw.notWithThis')));
        const fd = new FormData();
        fd.append('device', device);
        fd.append('file', file);
        xhr.send(fd);
    });
}

// Update sedang berjalan? (dari halaman ini atau dari halaman lain yang mengirim firmware)
const fwRunning = () => fw.busy || fw.phase === 'send' || fw.phase === 'reboot';

// Kabar dari server (WebSocket): {device, phase:'send'|'reboot'|'done'|'error', message}
function fwEvent(d) {
    if (!d || !d.device) return;
    const selesai = d.phase === 'done' || d.phase === 'error';
    if (!fw.busy) {
        // Update dijalankan halaman/perangkat lain: tampilkan juga, tapi tanpa hasil unggahan sendiri
        if (!selesai && !fwRunning()) { fw.result = null; fw.t0 = Date.now(); }
        if (selesai) { clearInterval(fw.tick); fw.tick = null; }
        else if (!fw.tick) fw.tick = setInterval(renderFirmware, 1000);
    }
    // Saat kita sendiri yang mengunggah, hasil akhirnya diambil dari jawaban server
    fw.phase = (d.phase === 'done' && fw.busy) ? fw.phase : d.phase;
    if (d.message) fw.notice = d.message;
    renderFirmware();
    if (selesai) loadFirmware();
}

// ---------- tampilan ----------
const fwDev = () => (fw.s && fw.s.devices ? fw.s.devices.find(d => d.key === fw.dev) : null);
const fwDevName = key => { const d = fw.s && fw.s.devices ? fw.s.devices.find(x => x.key === key) : null; return d ? d.label : key; };

function renderFirmware() {
    const box = $w('fw-devs'), list = fw.s ? fw.s.devices : null;
    const dev = fwDev();

    // Kartu perangkat
    if (box) box.innerHTML = !list ? `<div class="dr-empty">${escapeHtml(t('fw.stateConn'))}</div>` : list.map(d => {
        const chip = !d.configured ? ['', t('fw.noCfg')] : d.updating ? ['warn', t('fw.updating')] : d.online ? ['on', t('fw.online')] : ['off', t('fw.offline')];
        return `<button type="button" class="fw-dev" aria-pressed="${fw.dev === d.key}" ${fwRunning() || !d.configured ? 'disabled' : ''} onclick="fwSelect('${d.key}')">
            <i class="fa-solid ${d.key === 'esp8266' ? 'fa-door-closed' : 'fa-microchip'}" aria-hidden="true"></i>
            <span class="fw-g">
                <b>${escapeHtml(d.label)}</b>
                <span class="dr-sub">${escapeHtml(d.host || '-')} · ${escapeHtml(d.fw ? t('fw.ver', { fw: d.fw }) : t('fw.verUnknown'))}</span>
            </span>
            <span class="fw-chip ${chip[0]}">${escapeHtml(chip[1])}</span>
        </button>`;
    }).join('');

    // Berkas terpilih + peringatan
    const info = $w('fw-fileinfo');
    if (info) {
        info.hidden = !fw.file;
        if (fw.file) info.innerHTML = `<i class="fa-solid fa-file-lines" aria-hidden="true"></i>
            <span class="fw-g"><b class="fw-nm">${escapeHtml(fw.file.name)}</b><span class="dr-sub">${escapeHtml(t('fw.selected'))} · ${formatBytes(fw.file.size)}</span></span>`;
    }
    const warn = $w('fw-warn');
    if (warn) {
        warn.hidden = !fw.warn;
        if (fw.warn) warn.innerHTML = `<b><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(t('fw.notBinTitle'))}</b><br>${escapeHtml(fw.warn)}`;
    }

    // Bilah kemajuan
    const bar = $w('fw-bar'), fill = $w('fw-fill'), line = $w('fw-line');
    if (bar) {
        bar.className = 'fw-bar' + (fw.phase === 'done' ? ' done' : fw.phase === 'error' ? ' fail' : ((fwRunning() && fw.phase !== 'upload') ? ' busy' : ''));
        bar.hidden = !fw.phase;
    }
    if (fill) fill.style.width = (fw.phase === 'done' ? 100 : fw.phase === 'upload' ? fw.pct : (fw.phase && fw.phase !== 'error' ? 100 : 0)) + '%';
    if (line) line.textContent = fwLine(dev);

    // Tombol
    const start = $w('fw-start'), reset = $w('fw-reset');
    if (start) {
        start.disabled = fwRunning() || !fw.file || !dev || !dev.configured;
        start.textContent = !fwRunning() ? t('fw.start') : (fw.busy && fw.phase === 'upload' ? t('fw.uploading', { p: fw.pct }) : t('fw.waitBack'));
    }
    if (reset) reset.disabled = fwRunning();

    // Hasil terakhir (dari sisi perangkat yang dipilih)
    const last = $w('fw-last');
    if (last) {
        const l = fw.s && fw.s.last;
        last.textContent = l ? `${t('fw.last')}: ${clock(l.at)} · ${fwDevName(l.device)} · ${l.ok ? t('fw.lastOk') : t('fw.lastFail')}${l.fw ? t('fw.okFw', { fw: l.fw }) : ''}` : '';
    }
    const max = $w('fw-max');
    if (max && fw.s) max.textContent = t('fw.maxSize', { m: fw.s.maxMB });
}

// Teks status: keterangan + detik berjalan
function fwLine(dev) {
    const secs = fw.t0 && (fwRunning() || fw.phase) ? Math.round((Date.now() - fw.t0) / 1000) : 0;
    const el = secs > 1 ? ` (${secs}s)` : '';
    if (fw.busy && fw.phase === 'upload') return t('fw.uploading', { p: fw.pct });
    if (fw.result) return fw.result.message;
    if (fw.phase === 'send') return (fw.notice || t('fw.sending', { dev: fwDevName(fw.dev) })) + el;
    if (fw.phase === 'reboot') return t('fw.reboot', { dev: fwDevName(fw.dev) }) + el;
    if (fw.phase === 'done') return t('fw.doneShort');
    if (!dev) return t('fw.noDev');
    if (!dev.configured) return t('fw.noCfg');
    if (!dev.online) return t('fw.offlineWarn');
    return '';
}

// Pilih / seret berkas
document.addEventListener('DOMContentLoaded', () => {
    const inp = $w('fw-file'), drop = $w('fw-drop');
    if (inp) inp.addEventListener('change', () => fwPick(inp.files && inp.files[0]));
    if (drop) {
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', e => {
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (inp && f) { try { inp.files = e.dataTransfer.files; } catch (err) { } }   // biar tombol tetap mengirim berkas yang sama
            if (f) fwPick(f);
        });
    }
});
