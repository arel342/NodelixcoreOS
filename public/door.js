// Tab "Pintu RFID": status, buka/kunci, waktu relay, tambah kartu (30 detik), daftar kartu, riwayat akses.
// Semua teks lewat t() supaya mengikuti bahasa yang dipilih di Pengaturan.
const dr = { s: null, dirty: false, sigC: '', sigL: '' };
const $d = id => document.getElementById(id);
const ago = t0 => {
    if (!t0) return t('d.never');
    const s = Math.max(0, (Date.now() - t0) / 1000);
    return s < 60 ? t('d.justNow') : s < 3600 ? t('d.minAgo', { n: Math.floor(s / 60) }) : s < 86400 ? t('d.hrAgo', { n: Math.floor(s / 3600) }) : t('d.dayAgo', { n: Math.floor(s / 86400) });
};
const clock = t0 => new Date(t0).toLocaleTimeString(t('locale'), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const logText = l => l.k ? t('dlog.' + l.k, l.v) : (l.text || '');

async function dpost(url, body, okMsg) {
    try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await r.json();
        if (j.success) { if (okMsg || j.message) uiToast(okMsg || j.message); } else uiAlert(j.message || t('d.failCode', { c: r.status }), { type: 'error' });
        return j;
    } catch (e) { uiAlert(t('c.serverOff'), { type: 'error' }); return {}; }
}

function renderDoor(s) {
    dr.s = s;
    let st = 'locked', big = t('d.locked'), sub = t('d.lockedSub');
    if (!s.online) { st = 'off'; big = t('d.offlineBig'); sub = s.configured ? t('d.offSub') : t('d.noCfgSub'); }
    else if (s.open) { st = 'open'; big = t('d.openBig'); sub = t('d.openSub', { s: Math.ceil(s.left / 1000) }); }
    else if (!s.enabled) { st = 'dead'; big = t('d.deadBig'); sub = t('d.deadSub'); }
    $d('d-hero').dataset.state = st;
    $d('d-big').textContent = big; $d('d-sub').textContent = sub;
    const total = (s.openSec ? s.openSec * 1000 : 300);
    $d('d-barfill').style.width = (s.open ? Math.max(0, Math.min(100, (s.left - 1000) / total * 100)) : 0) + '%';

    $d('d-dot').className = 'dot ' + (s.online ? 'on' : 'off');
    $d('d-state').textContent = s.online ? t('d.stateOnline') : (s.configured ? t('d.stateOffline') : t('d.stateNoCfg'));
    const upT = s.esp ? (s.esp.uptime >= 3600 ? t('tm.h', { h: Math.floor(s.esp.uptime / 3600) }) : t('tm.m', { m: Math.floor(s.esp.uptime / 60) })) : '';
    $d('d-meta').textContent = s.esp ? `${s.esp.ip} · ${s.esp.rssi} dBm · ${t('d.metaUp', { t: upT })}${s.synced ? '' : ' · ' + t('d.syncing')}` : '';

    $d('d-open').textContent = t('d.openBtn');
    $d('d-close').textContent = t('d.closeBtn');
    $d('d-open').disabled = !s.online;
    $d('d-close').hidden = !s.open;
    const lk = $d('d-lock');
    lk.textContent = s.enabled ? t('d.lockOffBtn') : t('d.lockOnBtn');
    lk.disabled = !s.configured;

    const rng = $d('d-sec');
    if (!dr.dirty) rng.value = s.openSec;
    $d('d-secv').textContent = rng.value;
    $d('d-secunit').textContent = ' ' + t('d.secUnit');
    $d('d-save').textContent = t('d.save');
    $d('d-save').disabled = !dr.dirty || !s.online;
    $d('d-sechint').textContent = rng.value === '0' ? t('d.secHint0') : t('d.secHintN', { s: rng.value });

    const e = s.enroll;
    $d('d-eidle').hidden = e.active; $d('d-erun').hidden = !e.active;
    $d('d-eadd').disabled = !s.online;
    $d('d-etotal').textContent = e.total;
    if (e.active) { $d('d-ecount').textContent = e.left; $d('d-ering').style.setProperty('--p', (e.left / e.total * 100) + '%'); }

    const sigC = JSON.stringify(s.cards) + Math.floor(Date.now() / 30000) + getLang();
    if (sigC !== dr.sigC) {
        const openMenu = $d('d-cards').querySelector('.dr-menu[open]');
        const openUid = openMenu && openMenu.closest('[data-uid]').dataset.uid;
        const focusIndex = openMenu ? [...openMenu.querySelectorAll('summary,button')].indexOf(document.activeElement) : -1;
        dr.sigC = sigC;
        $d('d-count').textContent = s.cards.length;
        $d('d-cards').innerHTML = s.cards.length ? s.cards.map(c => `<li class="dr-card" data-uid="${c.uid}">
            <div class="dr-av"><i class="fa-solid fa-id-card"></i></div>
            <div class="dr-grow"><div class="dr-nm">${escapeHtml(c.name)}${c.admin === true ? ` <span class="dr-admin">${escapeHtml(t('d.adminBadge'))}</span>` : ''}</div><div class="dr-sub"><span class="dr-uid">${c.uid}</span> · ${ago(c.last)}</div></div>
            <details class="dr-menu" onclick="doorCardMenu(event)">
                <summary class="ib" title="${escapeHtml(t('d.cardMenu'))}" aria-label="${escapeHtml(t('d.cardMenu') + ' ' + c.name)}"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></summary>
                <div class="dr-menu-items">
                    <button type="button" onclick="doorRename('${c.uid}')"><i class="fa-solid fa-pen" aria-hidden="true"></i>${escapeHtml(t('d.ariaRename'))}</button>
                    <button type="button" onclick="doorAdmin('${c.uid}')"><i class="fa-solid fa-user-shield" aria-hidden="true"></i>${escapeHtml(t(c.admin === true ? 'd.removeAdmin' : 'd.makeAdmin'))}</button>
                    <button type="button" class="del" onclick="doorDelete('${c.uid}')"><i class="fa-solid fa-trash" aria-hidden="true"></i>${escapeHtml(t('d.ariaDel'))}</button>
                </div>
            </details></li>`).join('')
            : `<li class="dr-empty">${escapeHtml(t('d.emptyCards'))}</li>`;
        if (openUid) {
            const menu = [...$d('d-cards').querySelectorAll('.dr-menu')].find(m => m.closest('[data-uid]').dataset.uid === openUid);
            if (menu) {
                menu.open = true;
                if (focusIndex >= 0) menu.querySelectorAll('summary,button')[focusIndex].focus();
            }
        }
    }
    const sigL = JSON.stringify(s.log) + getLang();
    if (sigL !== dr.sigL) {
        dr.sigL = sigL;
        $d('d-log').innerHTML = s.log.length ? s.log.map(l => `<li class="${l.type}"><span class="dr-t">${clock(l.t)}</span><span>${escapeHtml(logText(l))}</span></li>`).join('') : `<li class="dr-empty">${escapeHtml(t('d.emptyLog'))}</li>`;
    }

    const dot = $d('topo-door-dot'), txt = $d('topo-door-txt'), pt = $d('topo-pt-door');
    if (dot) {
        dot.setAttribute('fill', s.online ? '#1e5a36' : '#c2410c'); pt.setAttribute('fill', s.online ? '#1e5a36' : '#c2410c');
        txt.textContent = s.online ? t('topo.online') : t('topo.offline'); txt.setAttribute('fill', s.online ? '#15803d' : '#dc2626');
    }
}

// Native details/summary mendukung klik, Enter/Space, dan navigasi Tab.
function doorCardMenu(e) {
    const menu = e.currentTarget;
    document.querySelectorAll('.dr-menu[open]').forEach(m => { if (m !== menu) m.open = false; });
    if (e.target.closest('button')) { menu.open = false; menu.querySelector('summary').focus(); }
}
document.addEventListener('click', e => {
    if (!e.target.closest('.dr-menu')) document.querySelectorAll('.dr-menu[open]').forEach(m => { m.open = false; });
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.dr-menu[open]').forEach(m => { m.open = false; m.querySelector('summary').focus(); });
});
async function doorAdmin(uid) {
    const c = dr.s.cards.find(x => x.uid === uid); if (!c) return;
    const admin = c.admin !== true;
    let password;
    if (admin) {
        password = await uiPrompt(t('d.adminPasswordPrompt', { name: c.name }), '', { title: t('d.makeAdmin'), inputType: 'password', maxLength: 4096 });
        if (password === null || password === '') return;
    } else if (!(await uiConfirm(t('d.removeAdminMsg', { name: c.name }), { title: t('d.removeAdmin'), danger: true }))) return;
    const j = await dpost('/api/door/cards/admin', { uid, admin, ...(admin ? { password } : {}) });
    if (j.success) await loadDoor();
}

async function doorOpen() { $d('d-open').disabled = true; await dpost('/api/door/open', {}, t('d.opened')); }
async function doorClose() { await dpost('/api/door/close', {}, t('d.closed')); }
async function doorLockToggle() {
    const next = !dr.s.enabled;
    if (!next && !(await uiConfirm(t('d.lockConfirmMsg'), { title: t('d.lockConfirmTitle'), ok: t('d.lockConfirmOk'), danger: true }))) return;
    await dpost('/api/door/lock', { enabled: next });
}
async function doorSaveSec() { const j = await dpost('/api/door/config', { openSec: +$d('d-sec').value }); if (j.success) dr.dirty = false; }
async function doorEnroll() { await dpost('/api/door/enroll', { action: 'start' }, t('d.enrollOk')); }
async function doorEnrollCancel() { await dpost('/api/door/enroll', { action: 'cancel' }, t('d.enrollCancelOk')); }
async function doorRename(uid) {
    const c = dr.s.cards.find(x => x.uid === uid); if (!c) return;
    const name = await uiPrompt(t('d.renamePrompt'), c.name, { title: t('d.renameTitle'), maxLength: 24 });
    if (name === null || !name.trim() || name.trim() === c.name) return;
    await dpost('/api/door/cards/rename', { uid, name: name.trim() }, t('d.renamed'));
}
async function doorDelete(uid) {
    const c = dr.s.cards.find(x => x.uid === uid); if (!c) return;
    if (!(await uiConfirm(t('d.delMsg', { name: c.name }), { title: t('d.delTitle'), ok: t('d.delOk'), danger: true }))) return;
    try { const j = await (await fetch('/api/door/cards/' + uid, { method: 'DELETE' })).json(); j.success ? uiToast(t('d.deleted')) : uiAlert(j.message, { type: 'error' }); } catch (e) { uiAlert(t('c.serverOff'), { type: 'error' }); }
}
async function loadDoor() { try { renderDoor(await (await fetch('/api/door/status')).json()); } catch (e) { } }

document.addEventListener('DOMContentLoaded', () => { $d('d-sec').addEventListener('input', () => { dr.dirty = true; if (dr.s) renderDoor(dr.s); }); });
