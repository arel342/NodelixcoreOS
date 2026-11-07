// Panel Terminal di tab Pengaturan: perintah dijalankan di HP server (Termux) lewat /api/terminal/*.
// Output diambil dengan polling ±0,4 dtk. Perintah tetap berjalan di server walau halaman di-refresh
// (web tersambung lagi saat tab Pengaturan dibuka). Semua teks lewat t() supaya mengikuti bahasa pilihan.
// Output SELALU dimasukkan lewat textContent (bukan innerHTML), jadi aman dari injeksi HTML.
const tm = {
    info: null, enabled: true, cwd: '', job: null, after: 0, busy: false, timer: null, fails: 0,
    hist: [], hi: 0, draft: '', line: null, carry: '', stopAsked: false, welcomed: false, gen: 0
};
const TM_QUICK = ['ls -la', 'pwd', 'df -h', 'uname -a', 'uptime', 'pkg update'];
const TM_MAX_LINES = 2000;
const $tm = id => document.getElementById(id);

try { tm.hist = JSON.parse(localStorage.getItem('srv7.termhist') || '[]').filter(x => typeof x === 'string').slice(-100); } catch (e) { }
tm.hi = tm.hist.length;

// ---------- layar ----------
function tmNew() {
    const out = $tm('term-out');
    tm.line = document.createElement('div');
    tm.line.className = 'tm-ln';
    out.appendChild(tm.line);
    while (out.childElementCount > TM_MAX_LINES) out.firstChild.remove();
}

// Tulis teks ke layar: \n pindah baris, \r (tanpa \n) menimpa baris saat ini (progress bar)
function tmPut(text, cls) {
    const out = $tm('term-out');
    if (!out || !text) return;
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    text = (tm.carry + text).replace(/\r\n/g, '\n');
    tm.carry = '';
    if (text.endsWith('\r')) { tm.carry = '\r'; text = text.slice(0, -1); }   // \r di ujung potongan bisa jadi bagian dari \r\n
    text.split('\n').forEach((p, i) => {
        if (i > 0) { if (!tm.line) tmNew(); tm.line = null; }
        const k = p.lastIndexOf('\r');
        if (k >= 0) { if (tm.line) tm.line.textContent = ''; p = p.slice(k + 1); }
        if (p) {
            if (!tm.line) tmNew();
            const sp = document.createElement('span');
            if (cls) sp.className = cls;
            sp.textContent = p;
            tm.line.appendChild(sp);
        }
    });
    if (stick) out.scrollTop = out.scrollHeight;
}
const tmInfoLine = (text, cls) => { tm.line = null; tmPut(text + '\n', cls || 'tm-m'); };

function termClear() {
    const out = $tm('term-out');
    if (out) out.textContent = '';
    tm.line = null; tm.carry = '';
    const i = $tm('term-in'); if (i) i.focus();
}

// ---------- tampilan ----------
const tmHome = () => (tm.info && tm.info.home) || '';
function tmShort(p) {
    const h = tmHome();
    if (h && p === h) return '~';
    if (h && p && p.startsWith(h + '/')) return '~' + p.slice(h.length);
    return p || '/';
}
const tmWho = () => ((tm.info && tm.info.user) || 'termux') + '@' + ((tm.info && tm.info.host) || 'server');
const tmPrompt = () => tmWho() + ':' + tmShort(tm.cwd) + '$';

function termRender() {
    const on = tm.enabled;
    const sw = $tm('term-switch');
    if (!sw) return;
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('aria-label', t('term.switch')); sw.title = t('term.switch');
    $tm('term-clear').setAttribute('aria-label', t('term.clear')); $tm('term-clear').title = t('term.clear');
    $tm('term-up').setAttribute('aria-label', t('term.histUp')); $tm('term-up').title = t('term.histUp');
    $tm('term-down').setAttribute('aria-label', t('term.histDown')); $tm('term-down').title = t('term.histDown');
    $tm('term-chips').setAttribute('aria-label', t('term.quick'));
    $tm('term-body').hidden = !on;
    $tm('term-offmsg').hidden = on;
    $tm('term-ps').textContent = tmShort(tm.cwd) + ' $';
    $tm('term-ps').title = tmPrompt();
    $tm('term-in').placeholder = t(tm.busy ? 'term.phInput' : 'term.ph');
    $tm('term-run').textContent = t(tm.busy ? 'term.send' : 'term.run');
    $tm('term-stop').hidden = !tm.busy;
    $tm('term-stop').textContent = t('term.stop');
}

function tmChips() {
    const box = $tm('term-chips');
    if (!box || box.childElementCount) return;
    TM_QUICK.forEach(c => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'tm-chip'; b.textContent = c;
        b.onclick = () => { const i = $tm('term-in'); i.value = c; i.focus(); };   // hanya mengisi, tidak langsung menjalankan
        box.appendChild(b);
    });
}

// ---------- API ----------
async function tmApi(url, body) {
    const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch (e) { }
    if (r.status === 401) { const e = new Error(t('term.sessionEnd')); e.status = 401; throw e; }
    if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
}

// Dipanggil tiap tab Pengaturan dibuka
async function loadTerminal() {
    tmChips();
    try {
        tm.info = await tmApi('/api/terminal/info');
        tm.enabled = !!tm.info.enabled;
        if (!tm.cwd) tm.cwd = tm.info.home;
        if (tm.enabled && !tm.welcomed) {
            tm.welcomed = true;
            tmInfoLine(t('term.ready', { who: tmWho(), shell: tm.info.shell }));
        }
        // Halaman baru dibuka tapi masih ada perintah berjalan di server -> sambungkan lagi
        const run = tm.info.running || [];
        if (tm.enabled && !tm.job && run.length) {
            const j = run[run.length - 1];
            tm.cwd = j.cwd || tm.cwd;
            tmInfoLine(t('term.attached'));
            tmEcho(j.cmd);
            tmStart(j.id, 0);
        }
    } catch (e) {
        if (e.status === 401) tmInfoLine(e.message, 'tm-e');
    }
    termRender();
}

async function termToggle() {
    const want = !tm.enabled;
    try {
        const j = await tmApi('/api/terminal/enabled', { enabled: want });
        tm.enabled = j.enabled;
        if (!tm.enabled) tmStopPolling(true);
        if (window.uiToast) uiToast(j.message, 'ok');
    } catch (e) {
        if (window.uiToast) uiToast(e.message || t('term.toggleFail'), 'error');
    }
    termRender();
}

// ---------- menjalankan perintah ----------
function tmEcho(cmd) { tm.line = null; tmPut(tmPrompt() + ' ' + cmd + '\n', 'tm-c'); }

function tmSaveHist(cmd) {
    if (tm.hist[tm.hist.length - 1] !== cmd) tm.hist.push(cmd);
    if (tm.hist.length > 100) tm.hist.shift();
    tm.hi = tm.hist.length; tm.draft = '';
    try { localStorage.setItem('srv7.termhist', JSON.stringify(tm.hist)); } catch (e) { }
}

function termHist(dir) {
    const inp = $tm('term-in');
    if (tm.hi === tm.hist.length) tm.draft = inp.value;
    tm.hi = Math.max(0, Math.min(tm.hist.length, tm.hi + dir));
    inp.value = tm.hi === tm.hist.length ? tm.draft : tm.hist[tm.hi];
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) { }
}

async function termSubmit(e) {
    if (e) e.preventDefault();
    const inp = $tm('term-in'), val = inp.value;
    // Ada perintah berjalan: isi kolom dikirim sebagai stdin (mis. jawaban y/n)
    if (tm.busy) {
        inp.value = '';
        tmInfoLine(val, 'tm-c');
        try { await tmApi('/api/terminal/input', { id: tm.job, data: val }); }
        catch (err) { tmInfoLine(err.message, 'tm-e'); }
        inp.focus();
        return;
    }
    const cmd = val.trim();
    if (!cmd) return;
    inp.value = '';
    tmSaveHist(cmd);
    if (/^(clear|cls)$/.test(cmd)) { termClear(); return; }
    tmEcho(cmd);
    try {
        const j = await tmApi('/api/terminal/run', { cmd: val, cwd: tm.cwd });
        tmStart(j.id, 0);
    } catch (err) {
        tmInfoLine(err.message, 'tm-e');
        if (err.status === 403) { tm.enabled = false; termRender(); }
    }
    inp.focus();
}

function tmStart(id, after) {
    tmStopPolling(false);
    tm.job = id; tm.after = after; tm.busy = true; tm.fails = 0; tm.stopAsked = false;
    termRender();
    tmPoll();
}

function tmStopPolling(finished) {
    clearTimeout(tm.timer); tm.timer = null; tm.gen++;   // gen: hasil poll lama yang masih di jalan diabaikan
    if (finished) { tm.job = null; tm.busy = false; }
}

async function tmPoll() {
    const id = tm.job, gen = tm.gen;
    if (!id) return;
    try {
        const j = await tmApi('/api/terminal/job/' + id + '?after=' + tm.after);
        if (gen !== tm.gen) return;
        tm.fails = 0;
        if (j.truncated && tm.after === 0) tmInfoLine(t('term.cut'));
        j.chunks.forEach(c => { tmPut(c.d, c.s === 'e' ? 'tm-e' : ''); tm.after = c.i; });
        if (j.done) {
            tm.carry = '';
            tm.cwd = j.cwd || tm.cwd;
            const time = t('up.tS', { s: (j.ms / 1000).toFixed(1) });
            if (j.signal) tmInfoLine(t('term.killed', { s: j.signal, t: time }), 'tm-e');
            else tmInfoLine(t('term.done', { c: j.code, t: time }), j.code === 0 ? 'tm-ok' : 'tm-e');
            tmStopPolling(true);
            termRender();
            const inp = $tm('term-in'); if (inp && $tm('view-settings') && !$tm('view-settings').classList.contains('hidden')) inp.focus();
            return;
        }
    } catch (e) {
        if (gen !== tm.gen) return;
        if (e.status === 401 || e.status === 404 || e.status === 403) {   // sesi habis / job hilang / terminal dimatikan
            tmInfoLine(e.message, 'tm-e'); tmStopPolling(true); termRender(); return;
        }
        // Koneksi putus sebentar (mis. layar HP mati): perintah tetap jalan di server, coba lagi
        if (++tm.fails === 3) tmInfoLine(t('term.lost'), 'tm-e');
    }
    tm.timer = setTimeout(tmPoll, tm.fails ? Math.min(5000, 400 * tm.fails) : 400);
}

async function termStop() {
    if (!tm.busy) return;
    try { await tmApi('/api/terminal/kill', { id: tm.job, force: tm.stopAsked }); }   // ketukan kedua = paksa (SIGKILL)
    catch (e) { tmInfoLine(e.message, 'tm-e'); }
    tm.stopAsked = true;
}

// Keluar dari akun: kosongkan layar dan hentikan polling (perintah di server tidak ikut dihentikan)
function termReset() {
    tmStopPolling(true);
    tm.info = null; tm.cwd = ''; tm.welcomed = false;
    termClear();
    const i = $tm('term-in'); if (i) i.value = '';
}

// Tombol keyboard: ↑/↓ riwayat, Ctrl+C hentikan, Ctrl+L bersihkan
document.addEventListener('DOMContentLoaded', () => {
    const inp = $tm('term-in');
    if (!inp) return;
    inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowUp') { e.preventDefault(); termHist(-1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); termHist(1); }
        else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && tm.busy && inp.selectionStart === inp.selectionEnd) { e.preventDefault(); termStop(); }
        else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); termClear(); }
    });
    termRender();
});

// Layar HP kembali menyala: langsung ambil output terbaru
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && tm.job) { clearTimeout(tm.timer); tm.gen++; tmPoll(); }
});
