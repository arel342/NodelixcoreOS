// Dashboard monitor ESP32 (PLTS 3S). Data masuk lewat WebSocket {type:'SENSOR'} dari server.
// Semua teks lewat t() supaya mengikuti bahasa yang dipilih di Pengaturan.
const mon = { hist: [], snap: null, calKey: '' };
const TAP_NAME = { s1: 'Tap 1S', s2: 'Tap 2S', s3: 'Pack 3S' };
const $m = id => document.getElementById(id);
const fx = (n, d = 2) => (n == null || isNaN(n)) ? '--' : Number(n).toFixed(d);
const upt = s => s >= 3600 ? t('tm.hm', { h: Math.floor(s / 3600), m: Math.floor(s % 3600 / 60) }) : t('tm.m', { m: Math.floor(s / 60) });

function toast(text) {
    const e = $m('m-toast');
    e.textContent = text;
    e.classList.add('show');
    clearTimeout(e._t);
    e._t = setTimeout(() => e.classList.remove('show'), 3500);
}

async function post(url, body, quiet) {
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!(quiet && j.success)) toast(j.message || (j.success ? t('mon.ok') : t('c.failed')));
        return j;
    } catch { toast(t('c.serverOff')); return {}; }
}

function spark(id, arr, color, lo) {
    const el = $m(id), W = 300, H = 56;
    if (arr.length < 2) { el.innerHTML = ''; return; }
    const min = lo !== undefined ? lo : Math.min(...arr);
    const max = Math.max(...arr, min + 0.05);
    const pts = arr.map((v, i) => `${(i / (arr.length - 1) * W).toFixed(1)},${(H - 4 - (v - min) / (max - min) * (H - 8)).toFixed(1)}`).join(' ');
    el.innerHTML = `<polygon points="0,${H} ${pts} ${W},${H}" fill="${color}" opacity=".15"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
}

// Teks status baterai & alarm: pakai key dari server kalau ada (mengikuti bahasa web)
const batText = b => b.statusKey ? t('bat.' + b.statusKey) : (b.status || '–');
const alertText = a => a.k ? t('esp.alert.' + a.k, a.v) : a.msg;

function renderMonitor(s) {
    mon.snap = s;
    if (s.history) mon.hist = s.history;
    else if (s.online && s.current) {
        mon.hist.push({ v: s.battery ? s.battery.pack : null, i: s.current.a, tc: s.dht ? s.dht.t : null, h: s.dht ? s.dht.h : null });
        if (mon.hist.length > 300) mon.hist.shift();
    }

    // Status koneksi
    $m('m-dot').className = 'dot ' + (s.online ? 'on' : 'off');
    $m('m-state').textContent = s.online ? t('mon.online') : (s.fails ? t('mon.noResp') : t('mon.connecting'));
    $m('m-meta').textContent = s.esp ? `${s.esp.ip} · ${s.esp.rssi} dBm · ${t('mon.up', { t: upt(s.esp.uptime) })}` : '';

    // Baterai
    const b = s.battery, cur = s.current;
    $m('m-pack').textContent = fx(b && b.pack);
    $m('m-soc').textContent = b ? Math.round(b.soc) : '--';
    const chip = $m('m-status');
    chip.textContent = b ? batText(b) : '–';
    chip.className = 'chip ' + (b ? b.level : '');
    for (let k = 0; k < 3; k++) {
        const el = $m('m-c' + k), p = b ? b.socs[k] : 0;
        el.style.setProperty('--lvl', p + '%');
        el.style.setProperty('--clr', p < 15 ? '#ef4444' : p < 35 ? '#f5a524' : '#34d399');
        el.querySelector('span').textContent = fx(b && b.cells[k]);
    }
    $m('m-note').textContent = !b ? '' : b.mode === 'pack'
        ? t('mon.notePack')
        : t('mon.noteDelta', { v: fx(b.delta, 3) });

    // Arus AC
    const i = cur ? cur.a : 0, warn = s.limits.iWarn, gmax = warn * 1.25;
    $m('m-i').textContent = fx(i);
    $m('m-p').textContent = Math.round(cur ? cur.va : 0);
    $m('m-pk').textContent = fx(cur && cur.peak);
    const g = $m('m-ig');
    g.style.width = Math.min(100, i / gmax * 100) + '%';
    g.classList.toggle('hot', i >= warn);
    $m('m-iw').style.left = (warn / gmax * 100) + '%';
    spark('m-sv', mon.hist.map(h => h.v).filter(v => v != null), '#6ee7b7');
    spark('m-iv', mon.hist.map(h => h.i), '#f5a524', 0);

    // Relay (tombol dibuat sekali, setelah itu hanya diperbarui)
    const box = $m('m-relays');
    if (box.children.length !== s.relays.length) {
        box.innerHTML = s.relays.map(r => `<button class="rl" data-id="${r.id}" aria-pressed="false" onclick="toggleRelay(${r.id})"><span><b></b><br><small class="mut"></small></span><span class="sw"></span></button>`).join('');
    }
    s.relays.forEach((r, k) => {
        const el = box.children[k];
        el.setAttribute('aria-pressed', r.on ? 'true' : 'false');
        el.querySelector('b').textContent = r.name;
        el.querySelector('small').textContent = `GPIO ${r.pin} · ${r.on ? t('mon.on') : t('mon.off')}`;
        el.disabled = !s.online;
    });
    // Keluaran pendamping Relay 1 & 2: GPIO 12 = ON, GPIO 13 = OFF (selalu berlawanan)
    const ax = s.aux;
    $m('m-aux').textContent = ax
        ? `${t('mon.aux')}: GPIO ${ax.on_pin} ${ax.on ? t('mon.on') : t('mon.off')} · GPIO ${ax.off_pin} ${ax.off ? t('mon.on') : t('mon.off')}`
        : '';

    // DHT11: suhu & kelembapan
    const dh = s.online ? s.dht : null, dok = !!(dh && dh.ok);
    $m('m-temp').textContent = dok ? fx(dh.t, 1) : '--';
    $m('m-hum').textContent = dok ? fx(dh.h, 0) : '--';
    const dchip = $m('m-dht-chip');
    if (!s.online || !s.esp) { dchip.textContent = '–'; dchip.className = 'chip'; }
    else if (!s.dht) { dchip.textContent = t('mon.dhtOld'); dchip.className = 'chip warn'; }   // firmware lama
    else if (s.dht.ok) { dchip.textContent = t('mon.dhtOk'); dchip.className = 'chip ok'; }
    else { dchip.textContent = t('mon.dhtErr'); dchip.className = 'chip bad'; }
    $m('m-dht-meta').textContent = s.dht ? `GPIO ${s.dht.pin}` + (s.dht.err ? ' · ' + t('mon.dhtFail', { n: s.dht.err }) : '') : '';
    spark('m-tv', mon.hist.map(h => h.tc).filter(v => v != null), '#ef6c3a');
    spark('m-hv', mon.hist.map(h => h.h).filter(v => v != null), '#2f78be');

    // Peringatan
    $m('m-alerts').innerHTML = s.alerts.length
        ? s.alerts.map(a => `<li class="${a.level === 'crit' ? 'crit' : ''}">${escapeHtml(alertText(a))}</li>`).join('')
        : `<li class="none">${escapeHtml(t('mon.allNormal'))}</li>`;

    // Kalibrasi: baris input dibuat sekali supaya tidak terhapus saat data masuk
    const taps = b ? Object.keys(b.raw) : [], key = taps.join() + getLang();
    if (key !== mon.calKey) {
        mon.calKey = key;
        $m('m-calrows').innerHTML = taps.map(id => `<div class="calrow" data-id="${id}"><span>${escapeHtml(t('mon.tapRead', { name: TAP_NAME[id] }))} <b class="num" data-v>--</b> V</span><input type="number" step="0.01" placeholder="${escapeHtml(t('mon.tapPh'))}"><button class="btn" onclick="calTap('${id}')">${escapeHtml(t('mon.calBtn'))}</button></div>`).join('');
    }
    taps.forEach(id => {
        const c = s.cal.taps[id], v = document.querySelector(`#m-calrows [data-id="${id}"] [data-v]`);
        if (v) v.textContent = fx(b.raw[id] * c.gain + c.offset);
    });
    $m('m-izero').textContent = s.zeroing ? t('mon.measuring') : t('mon.izeroBtn');
    $m('m-cali').textContent = t('mon.noiseScale', { f: fx(s.cal.i.floor, 3), g: fx(s.cal.i.gain, 3) });

    // Node sensor di peta topologi (tab Dashboard)
    const dot = document.getElementById('topo-dot'), txt = document.getElementById('topo-txt'), pt = document.getElementById('topo-pt-sensor');
    if (dot) {
        const c = s.online ? '#1e5a36' : '#c2410c';
        dot.setAttribute('fill', c); if (pt) pt.setAttribute('fill', c);
        txt.textContent = s.online ? t('topo.online') : t('topo.offline');
        txt.setAttribute('fill', s.online ? '#15803d' : '#dc2626');
    }
}

async function toggleRelay(id) {
    const r = mon.snap.relays.find(x => x.id === id);
    const el = document.querySelector(`#m-relays [data-id="${id}"]`);
    el.classList.add('wait');
    await post('/api/esp32/relay', { id, state: !r.on }, true);
    el.classList.remove('wait');
}
async function relayAllOff() { if (await uiConfirm(t('mon.allOffMsg'), { title: t('mon.allOffTitle'), ok: t('mon.allOffOk'), danger: true })) post('/api/esp32/relay', { id: 'all', state: false }, true); }
function calTap(id) { post('/api/esp32/calibrate', { type: 'tap', id, actual: document.querySelector(`#m-calrows [data-id="${id}"] input`).value }); }
function calI(type) { post('/api/esp32/calibrate', { type, actual: $m('m-igain').value }); }
async function calReset() { if (await uiConfirm(t('mon.calResetMsg'), { title: t('mon.calResetTitle'), ok: t('mon.calResetOk'), danger: true })) post('/api/esp32/calibrate', { type: 'reset' }); }

async function loadMonitor() {
    try { renderMonitor(await (await fetch('/api/esp32/status')).json()); } catch { }
}
