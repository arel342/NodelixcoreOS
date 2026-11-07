// Tab "Sistem": CPU, RAM, dan flash disk perangkat server + diagram garis penggunaan
// CPU & RAM (90 sampel terakhir, ±3 menit). Data masuk lewat WebSocket {type:'SYSTEM'}.
// Semua teks lewat t() supaya mengikuti bahasa yang dipilih di Pengaturan.
const sys = { hist: [], snap: null };
const $s = id => document.getElementById(id);
const fmtB2 = b => { if (b == null) return '--'; const u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(4, Math.floor(Math.log(Math.max(1, b)) / Math.log(1024))); return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i]; };

// Diagram garis skala tetap 0-100% dengan garis grid 25/50/75 dan titik nilai terakhir
function lineChart(id, arr, color) {
    const el = $s(id), W = 600, H = 160, P = 8;
    if (!el) return;
    if (!arr || arr.length < 2) {
        el.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9aa6bb" font-size="14">${escapeHtml(t('sys.waiting'))}</text>`;
        return;
    }
    const X = i => P + i / (Math.max(arr.length, 90) - 1) * (W - P * 2);
    const Y = v => H - P - Math.max(0, Math.min(100, v)) / 100 * (H - P * 2);
    const pts = arr.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const grid = [25, 50, 75].map(g =>
        `<line x1="${P}" y1="${Y(g)}" x2="${W - P}" y2="${Y(g)}" stroke="#e8edf6" stroke-width="1"/><text x="${P + 2}" y="${Y(g) - 3}" fill="#b7c2d4" font-size="10">${g}%</text>`).join('');
    const lx = X(arr.length - 1), ly = Y(arr[arr.length - 1]);
    el.innerHTML = grid +
        `<polygon points="${X(0)},${H - P} ${pts} ${lx},${H - P}" fill="${color}" opacity=".12"/>` +
        `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
        `<circle cx="${lx}" cy="${ly}" r="4" fill="${color}"/>`;
}

function renderSystem(s) {
    if (s) {
        sys.snap = s;
        if (s.cpu != null || (s.ram && s.ram.pct != null)) {
            sys.hist.push({ cpu: s.cpu, ram: s.ram ? s.ram.pct : null });
            if (sys.hist.length > 90) sys.hist.shift();
        }
    }
    s = sys.snap;
    const online = s && (s.cpu != null || s.ram);
    $s('s-dot').className = 'dot ' + (online ? 'on' : 'off');
    $s('s-state').textContent = online ? t('sys.cpu') + ' / ' + t('sys.ram') : t('sys.unavail');
    $s('s-meta').textContent = online && s.uptime != null ? t('sys.uptime', { t: s.uptime >= 3600 ? t('tm.hm', { h: Math.floor(s.uptime / 3600), m: Math.floor(s.uptime % 3600 / 60) }) : t('tm.m', { m: Math.floor(s.uptime / 60) }) }) : '';

    // CPU
    $s('s-cpu').textContent = s && s.cpu != null ? Math.round(s.cpu) : '--';
    $s('s-cpug').style.width = (s && s.cpu != null ? s.cpu : 0) + '%';
    $s('s-cpug').classList.toggle('hot', !!(s && s.cpu >= 85));
    $s('s-cpuinfo').textContent = s ? [s.model || '', s.cores ? t('sys.cores', { n: s.cores }) : ''].filter(Boolean).join(' · ') || '-' : '-';
    $s('s-cpuload').textContent = s && s.load != null ? t('sys.load', { l: s.load }) : '';

    // RAM
    const rp = s && s.ram ? s.ram.pct : null;
    $s('s-rampct').textContent = rp != null ? Math.round(rp) : '--';
    $s('s-ramg').style.width = (rp || 0) + '%';
    $s('s-ramg').classList.toggle('hot', rp >= 85);
    $s('s-raminfo').textContent = s && s.ram ? t('sys.usedOf', { used: fmtB2(s.ram.used), total: fmtB2(s.ram.total) }) : '-';

    // Flash disk
    const f = s && s.flash;
    const fp = f && f.ready && f.total ? (1 - f.free / f.total) * 100 : null;
    $s('s-flashpct').textContent = fp != null ? Math.round(fp) : '--';
    $s('s-flashg').style.width = (fp || 0) + '%';
    $s('s-flashg').classList.toggle('hot', fp >= 90);
    $s('s-flashinfo').textContent = !f ? '-' : f.ready
        ? t('sys.usedOf', { used: fmtB2(f.total - f.free), total: fmtB2(f.total) }) + ' · ' + t('up.barFree', { free: fmtB2(f.free), total: fmtB2(f.total) })
        : (f.message || t('up.notReady'));

    // Diagram garis CPU & RAM (0-100%)
    lineChart('s-cpuv', sys.hist.map(h => h.cpu).filter(v => v != null), '#34d399');
    lineChart('s-ramv', sys.hist.map(h => h.ram).filter(v => v != null), '#2f78be');
    $s('s-cpuhint').textContent = t('sys.samples', { n: sys.hist.length });
    $s('s-ramhint').textContent = t('sys.samples', { n: sys.hist.length });
}

// Isi riwayat awal dari server (dipanggil saat tab Sistem dibuka)
async function loadSystem() {
    try {
        const j = await (await fetch('/api/system')).json();
        if (Array.isArray(j.history) && j.history.length) {
            sys.hist = j.history.map(h => ({ cpu: h.cpu, ram: h.ram })).slice(-90);
        }
        // Snapshot lengkap dari server dipakai jika WebSocket belum mengirim data.
        if (j.snapshot && (!sys.snap || (j.snapshot.t || 0) > (sys.snap.t || 0))) sys.snap = j.snapshot;
        renderSystem();
    } catch (e) { renderSystem(); }
}
