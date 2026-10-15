// ============================================================================
// setup.js (halaman) — panduan setup awal NodelixcoreOS, langkah demi langkah.
//
//   Langkah 1  Akun admin (username + password)      -> POST /api/setup/account
//   Langkah 2  Alamat web server Termux (IP + port)  -> POST /api/setup/server
//   Langkah 3  ESP32: IP, port, kunci API            -> POST /api/setup/device
//   Langkah 4  ESP8266 (pintu): IP, port, kunci API  -> POST /api/setup/device
//   Langkah 5  Bot Telegram (opsional)               -> POST /api/setup/telegram
//   Langkah 6  Kunci API Gemini (opsional)           -> POST /api/setup/ai (+ /api/setup/ai/test)
//   Langkah 7  Selesai                               -> POST /api/setup/finish (login otomatis)
//
// Semua nilai yang diisi di sini dikirim ke server lalu ditulis ke .env, jadi pemakaian
// berikutnya tidak perlu mengedit file apa pun di Termux. Kunci API Gemini boleh dikosongkan:
// nilai yang sudah tersimpan tidak dihapus oleh panduan setup, hanya diganti bila diisi baru.
// ============================================================================
const WZ = { s: null, step: 1, total: 7, locked: false };

const $ = id => document.getElementById(id);

function wzMsg(n, text, type) {
    const el = $('msg-' + n);
    if (!el) return;
    el.className = 'msg ' + (type || '');
    el.textContent = text || '';
}

// ---------- Bahasa ----------
async function wzLang(l) {
    if (window.setLang) await window.setLang(l);
    if (window.syncLang) await window.syncLang();
    wzRender();
}

function wzMarks() {
    ['id', 'en', 'zh'].forEach(l => {
        const b = $('lg-' + l);
        if (b) b.classList.toggle('on', (window.getLang ? getLang() : 'id') === l);
    });
}

// ---------- Tampilan ----------
function wzStep(n) {
    WZ.step = Math.max(1, Math.min(WZ.total, n));
    for (let i = 1; i <= WZ.total; i++) {
        const sec = $('st-' + i);
        if (sec) sec.classList.toggle('hid', i !== WZ.step);
    }
    wzRender();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
const wzGo = d => wzStep(WZ.step + d);

function wzRender() {
    document.title = t('wz.title');
    document.documentElement.lang = (window.getLang ? getLang() : 'id');
    wzMarks();

    const bars = $('bars');
    if (bars) bars.innerHTML = Array.from({ length: WZ.total }, (_, i) => `<i class="${i < WZ.step ? 'on' : ''}"></i>`).join('');
    for (let i = 1; i <= WZ.total; i++) {
        const of = $('of-' + i);
        if (of) of.textContent = t('wz.stepOf', { n: i, total: WZ.total });
    }

    // Petunjuk pengisian di portal ESP: nama WiFi mode setup berbeda per perangkat
    [['st-3', 'Nodelix-ESP32'], ['st-4', 'Nodelix-DOOR']].forEach(([id, ap]) => {
        const lis = document.querySelectorAll('#' + id + ' .note ol li');
        const txt = [t('wz.howEsp1'), t('wz.howEsp2', { ap }), t('wz.howEsp3'), t('wz.howEsp4')];
        lis.forEach((li, i) => { if (txt[i]) li.textContent = txt[i]; });
    });

    wzSummary();
}

function wzSummary() {
    const el = $('summary');
    if (!el || !WZ.s) return;
    const s = WZ.s, dash = (s.server.ips && s.server.ips[0] ? `http://${s.server.ips[0]}:${s.server.port}` : '');
    const key = v => v ? v : t('wz.notFilled');
    const row = (k, v) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`;
    el.innerHTML =
        row(t('wz.sumDone'), dash || key('')) +
        row('ESP32 · IP', key(s.esp32.ip) + (s.esp32.ip ? `:${s.esp32.port}` : '')) +
        row('ESP32 · API', s.esp32.apiKey ? '••••••' : t('wz.notFilled')) +
        row('ESP8266 · IP', key(s.door.ip) + (s.door.ip ? `:${s.door.port}` : '')) +
        row('ESP8266 · API', s.door.apiKey ? '••••••' : t('wz.notFilled')) +
        row('Telegram', s.telegram.token ? (s.telegram.chatId ? t('cfg.on') : t('wz.notFilled')) : t('cfg.off')) +
        row(t('wz.sumAi'), (s.ai && s.ai.hasKey) ? '••••••' + ((s.ai.enabled === false) ? ' · ' + t('cfg.off') : '') : t('wz.notFilled'));
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Muat status ----------
async function wzLoad() {
    try {
        const r = await fetch('/api/setup/status');
        WZ.s = await r.json();
    } catch (e) {
        $('st-1').innerHTML = `<h2>${esc(t('wz.offline'))}</h2><p class="lead">${esc(e.message)}</p>`;
        return;
    }
    const s = WZ.s;
    if (!s.required && !s.authed) {           // sudah pernah di-setup dan belum login
        WZ.locked = true;
        $('st-1').innerHTML =
            `<h2 data-i18n="wz.title"></h2><p class="lead">${esc(t('setup.locked'))}</p>
             <div class="acts"><a class="btn amber grow" style="text-align:center;text-decoration:none" href="/">${esc(t('wz.openDash'))}</a></div>`;
        for (let i = 2; i <= WZ.total; i++) $('st-' + i).classList.add('hid');
        $('bars').classList.add('hid');
        $('foot').textContent = location.host;
        return;
    }

    // Isi nilai yang sudah ada (kalau setup dijalankan ulang dari Pengaturan)
    if (s.account.username) $('in-user').value = s.account.username;
    $('in-port').value = s.server.port;
    $('addr-list').innerHTML = (s.server.ips || []).map(ip =>
        `<span>http://${esc(ip)}:${esc(String(s.server.port))}</span><button type="button" onclick="wzCopyText('http://${esc(ip)}:${esc(String(s.server.port))}')">${esc(t('wz.copy'))}</button>`).join('');
    $('in-e32-ip').value = s.esp32.ip || '';
    $('in-e32-port').value = s.esp32.port || 80;
    $('in-e32-key').value = s.esp32.apiKey || '';
    if (!s.esp32.apiKey) wzGen('in-e32-key');
    $('in-d-ip').value = s.door.ip || '';
    $('in-d-port').value = s.door.port || 80;
    $('in-d-key').value = s.door.apiKey || '';
    if (!s.door.apiKey) wzGen('in-d-key');
    $('in-tg-alerts').checked = s.telegram.alerts !== false;
    $('in-tg-token').value = s.telegram.token || '';
    $('in-tg-chat').value = s.telegram.chatId || '';
    const ai = s.ai || {};
    $('in-ai-enabled').checked = ai.enabled !== false;
    $('in-ai-model').value = ai.model || '';
    // Kunci lama tidak ikut dikirim (kolom dibiarkan kosong) supaya menyimpan langkah ini
    // tanpa mengetik apa pun tidak menimpa kunci yang sudah tersimpan di .env.
    $('in-ai-key').value = '';
    $('in-ai-key').placeholder = ai.hasKey ? t('wz.aiStored') : 'AQ....';
    $('foot').textContent = `NodelixcoreOS ${s.server.version || ''} · Node ${s.server.node || ''} · ${s.server.env || '.env'}`;

    wzStep(1);
}

// ---------- Aksi tiap langkah ----------
async function wzPost(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) throw new Error(j.message || ('HTTP ' + r.status));
    return j;
}

async function wzSaveAccount() {
    const username = $('in-user').value.trim();
    const password = $('in-pass').value;
    const confirmPassword = $('in-confirm').value;
    if (username.length < 3 || password.length < 8) return wzMsg(1, t('wz.needUser'), 'err');
    wzMsg(1, '…');
    try {
        await wzPost('/api/setup/account', { username, password, confirmPassword });
        wzMsg(1, t('wz.saved'), 'ok');
        WZ.s.account.username = username;
        WZ.s.account.hasPassword = true;
        wzStep(2);
    } catch (e) { wzMsg(1, t('wz.err', { e: e.message }), 'err'); }
}

async function wzSaveServer() {
    const port = $('in-port').value;
    wzMsg(2, '…');
    try {
        await wzPost('/api/setup/server', { server: { port } });
        WZ.s.server.port = String(port);
        wzMsg(2, t('wz.saved'), 'ok');
        wzStep(3);
    } catch (e) { wzMsg(2, t('wz.err', { e: e.message }), 'err'); }
}

async function wzSaveDevice(kind) {
    const step = kind === 'esp32' ? 3 : 4;
    const body = kind === 'esp32'
        ? { device: 'esp32', ip: $('in-e32-ip').value.trim(), port: $('in-e32-port').value || 80, apiKey: $('in-e32-key').value.trim() }
        : { device: 'esp8266', ip: $('in-d-ip').value.trim(), port: $('in-d-port').value || 80, apiKey: $('in-d-key').value.trim() };
    if (!body.ip) return wzGo(1);                       // dibiarkan kosong = dilewati
    wzMsg(step, '…');
    try {
        await wzPost('/api/setup/device', body);
        if (kind === 'esp32') { WZ.s.esp32.ip = body.ip; WZ.s.esp32.port = String(body.port); WZ.s.esp32.apiKey = body.apiKey; }
        else { WZ.s.door.ip = body.ip; WZ.s.door.port = String(body.port); WZ.s.door.apiKey = body.apiKey; }
        wzMsg(step, t('wz.saved'), 'ok');
        wzStep(step + 1);
    } catch (e) { wzMsg(step, t('wz.err', { e: e.message }), 'err'); }
}

async function wzSaveTg() {
    wzMsg(5, '…');
    try {
        await wzPost('/api/setup/telegram', {
            alerts: $('in-tg-alerts').checked,
            token: $('in-tg-token').value.trim(),
            chatId: $('in-tg-chat').value.trim()
        });
        WZ.s.telegram = { alerts: $('in-tg-alerts').checked, token: $('in-tg-token').value.trim(), chatId: $('in-tg-chat').value.trim() };
        wzMsg(5, t('wz.saved'), 'ok');
        wzStep(6);
    } catch (e) { wzMsg(5, t('wz.err', { e: e.message }), 'err'); }
}

// Nilai langkah AI: kunci yang diketik saja yang dikirim, supaya mengosongkan kolom
// tidak menghapus kunci yang sudah tersimpan di .env (server juga mengabaikannya).
function wzAiBody() {
    const body = { enabled: $('in-ai-enabled').checked };
    const model = $('in-ai-model').value.trim();
    const key = $('in-ai-key').value.trim();
    if (model) body.model = model;            // kosong = pakai default server (GEMINI_MODEL)
    if (key) body.apiKey = key;              // kosong = kunci yang sudah ada tidak diubah
    return body;
}

// Simpan langkah AI lalu perbarui status di dalam WZ.s supaya ringkasan langkah terakhir
// ikut benar. Dipakai tombol "Simpan & lanjut" dan tombol "Uji kunci".
async function wzAiSave() {
    const j = await wzPost('/api/setup/ai', wzAiBody());
    const st = j && j.ai;
    if (st) {
        WZ.s.ai = { enabled: st.enabled, hasKey: st.hasKey, model: st.model, apiKey: (WZ.s.ai && WZ.s.ai.apiKey) || '' };
        $('in-ai-key').value = '';
        if (st.hasKey) $('in-ai-key').placeholder = t('wz.aiStored');
    }
    return j;
}

async function wzSaveAi() {
    wzMsg(6, '…');
    try {
        await wzAiSave();
        wzMsg(6, t('wz.saved'), 'ok');
        wzStep(7);
    } catch (e) { wzMsg(6, t('wz.err', { e: e.message }), 'err'); }
}

// Uji kunci ke Gemini sebelum lanjut: kunci/model yang sedang diketik dikirim sebagai
// override, jadi kunci yang terbukti benar langsung tersimpan walau langkah berikutnya
// menekan "Lewati".
async function wzTestAi() {
    const b = $('btn-aitest');
    b.disabled = true; wzMsg(6, '…');
    const typed = $('in-ai-key').value.trim();
    try {
        const r = await fetch('/api/setup/ai/test', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: typed, model: $('in-ai-model').value.trim() })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.success) throw new Error(j.message || ('HTTP ' + r.status));
        if (typed) await wzAiSave();
        wzMsg(6, j.message || t('wz.saved'), 'ok');
    } catch (e) { wzMsg(6, e.message, 'err'); }
    b.disabled = false;
}

async function wzTestTg() {
    const b = $('btn-tgtest');
    b.disabled = true; wzMsg(5, '…');
    try {
        // Simpan dulu supaya pesan uji memakai token/chat ID yang baru diketik
        await wzPost('/api/setup/telegram', {
            alerts: $('in-tg-alerts').checked,
            token: $('in-tg-token').value.trim(),
            chatId: $('in-tg-chat').value.trim()
        });
        const j = await wzPost('/api/settings/telegram/test', {});
        wzMsg(5, j.message || t('set.tgTestOk'), 'ok');
    } catch (e) { wzMsg(5, e.message, 'err'); }
    b.disabled = false;
}

async function wzFinish() {
    const b = $('btn-finish');
    b.disabled = true; wzMsg(7, '…');
    try {
        const j = await wzPost('/api/setup/finish', {});
        wzMsg(7, j.message || t('setup.ok'), 'ok');
        setTimeout(() => { location.href = j.redirect || '/'; }, 900);
    } catch (e) { wzMsg(7, t('wz.err', { e: e.message }), 'err'); b.disabled = false; }
}

// ---------- Alat bantu kecil ----------
function wzGen(id) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const a = new Uint8Array(24);
    crypto.getRandomValues(a);
    $(id).value = 'nlx-' + Array.from(a, x => abc[x % abc.length]).join('');
}

async function wzCopy(id) { wzCopyText($(id).value); }
async function wzCopyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        if (window.uiToast) uiToast(t('wz.copied'), 'ok');
    } catch (e) {
        const i = document.createElement('input');
        i.value = text; document.body.appendChild(i); i.select();
        try { document.execCommand('copy'); if (window.uiToast) uiToast(t('wz.copied'), 'ok'); } catch { }
        i.remove();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (window.syncLang) await window.syncLang();
    wzRender();
    wzLoad();
});
