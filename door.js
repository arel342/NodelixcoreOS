// Modul pintu RFID: server <-> ESP8266 (lewat IP, seperti ESP32 monitor).
// Server menyimpan data kartu (data/door.json) dan mendorongnya ke ESP8266 (disimpan di flash ESP,
// jadi pintu tetap bisa dibuka kartu walau server/HP mati). Server memantau lewat polling /api/status.
const fs = require('fs');
const path = require('path');
const T = require('./lang');
const fwstate = require('./fwstate');   // penanda sedang update firmware (alarm offline ditahan)

const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const N = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const normUid = u => { u = String(u || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase(); return /^[0-9A-F]{8,20}$/.test(u) ? u : null; };
const cleanText = t => String(t || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 24);

module.exports = ({ app, broadcast, notify, verifyDashboardPassword }) => {
    const FILE = path.join(__dirname, 'data', 'door.json');
    let db = { ver: 1, openSec: 5, enabled: true, cards: [], log: [] };
    try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { }

    let saveT = null;
    const save = () => {
        clearTimeout(saveT);
        saveT = setTimeout(() => {
            try {
                fs.mkdirSync(path.dirname(FILE), { recursive: true });
                fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 1));
                fs.renameSync(FILE + '.tmp', FILE);
            } catch (e) { console.log('[Pintu] gagal menyimpan data:', e.message); }
        }, 150);
    };

    let raw = null, online = false, everOnline = false, fails = 0, lastOk = 0, boot = null, cursor = 0;
    let syncing = false, lastSync = 0, enrollUntil = 0, enrollStart = 0, pendingCardName = '', pendingTelegramEnroll = false, timer = null;
    const lastMsg = {};
    const base = () => `http://${E('DOOR_IP', '')}:${N('DOOR_PORT', 80)}`;
    const configured = () => !!E('DOOR_IP', '');

    async function call(p, method = 'GET', body) {
        const h = { 'X-API-Key': E('DOOR_API_KEY', '') };
        if (body !== undefined) h['Content-Type'] = 'text/plain';
        const r = await fetch(base() + p, { method, headers: h, body, signal: AbortSignal.timeout(2500) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    // Telegram dibatasi 1x per jenis tiap menit (kecuali offline: 5 menit)
    function tg(text, key, gap = 60000) {
        if (E('TELEGRAM_ALERTS', 'true') === 'false') return;
        if (lastMsg[key] && Date.now() - lastMsg[key] < gap) return;
        lastMsg[key] = Date.now();
        notify(text);
    }

    const snapshot = () => {
        const left = enrollUntil ? Math.max(0, Math.ceil((enrollUntil - Date.now()) / 1000)) : 0;
        return {
            configured: configured(), online, lastOk, fails, updating: fwstate.isBusy('esp8266'),
            esp: raw && { ip: raw.ip, rssi: raw.rssi, uptime: raw.uptime, fw: raw.fw },
            open: !!(raw && raw.open), left: raw ? raw.left : 0,
            enabled: db.enabled, openSec: db.openSec, synced: !!(raw && raw.ver === db.ver),
            enroll: { active: left > 0, left, total: N('DOOR_ENROLL_SECONDS', 30) },
            cards: db.cards, log: db.log.slice(0, 40)
        };
    };
    const push = () => broadcast({ type: 'DOOR', data: snapshot() });
    // Toast/log membawa key + variabel: web menampilkannya dalam bahasa yang dipilih
    const toast = (k, v, level = 'ok') => broadcast({ type: 'DOOR_NOTE', k, v: v || {}, level, text: T('dnote.' + k, v) });
    function log(type, k, v) {
        db.log.unshift({ t: Date.now(), type, k, v: v || {}, text: T('dlog.' + k, v) });
        if (db.log.length > 80) db.log.length = 80;
        save();
    }
    const nameOf = uid => (db.cards.find(c => c.uid === uid) || {}).name || uid;

    // Kirim konfigurasi + daftar UID ke ESP8266 (dipicu bila versi di ESP berbeda dengan server)
    async function sync() {
        if (syncing || !online) return false;
        syncing = true; lastSync = Date.now();
        let ok = false;
        const version = db.ver;
        try {
            const body = [`V=${version}`, `S=${db.openSec}`, `E=${db.enabled ? 1 : 0}`, ...db.cards.map(c => `${c.admin === true ? 'A' : 'C'}=${c.uid}`)].join('\n') + '\n';
            const j = await call('/api/sync', 'POST', body);
            if (j.ver !== version) throw new Error('Versi konfigurasi tidak cocok');
            if (raw) raw.ver = j.ver;
            ok = db.ver === version;
        } catch (e) {
            console.error('[Pintu] Gagal menyinkronkan konfigurasi:', e.message);
        } finally { syncing = false; push(); }
        return ok;
    }
    const bump = () => { db.ver++; save(); return sync(); };

    function handle(e) {
        const uid = normUid(e.uid);
        switch (e.type) {
            case 'ok': {
                const c = db.cards.find(c => c.uid === uid);
                if (c) { c.last = Date.now(); save(); }
                log('ok', 'open', { name: nameOf(uid) });
                if (E('DOOR_NOTIFY_OPEN', 'false') === 'true') tg(T('door.tgOpen', { name: nameOf(uid) }), 'open', 5000);
                break;
            }
            case 'locked': log('warn', 'lockedTap', { name: nameOf(uid) }); break;
            case 'unknown':
                log('bad', 'unknown', { uid });
                if (E('DOOR_NOTIFY_UNKNOWN', 'true') !== 'false') tg(T('door.tgUnknown', { uid }), 'unk_' + uid);
                break;
            case 'enroll': {
                enrollUntil = 0;
                if (!uid) break;
                if (db.cards.some(c => c.uid === uid)) {
                    pendingCardName = '';
                    if (pendingTelegramEnroll) notify(`⚠️ Kartu ${uid} sudah terdaftar sebagai "${nameOf(uid)}".`);
                    pendingTelegramEnroll = false;
                    log('info', 'dup', { name: nameOf(uid) }); toast('dupToast', { name: nameOf(uid) }, 'warn'); break;
                }
                let n = 1; while (db.cards.some(c => c.name === T('door.cardName', { n }))) n++;
                const name = pendingCardName || T('door.cardName', { n });
                const fromTelegram = pendingTelegramEnroll;
                pendingCardName = ''; pendingTelegramEnroll = false;
                db.cards.push({ uid, name, added: Date.now(), last: null });
                log('info', 'added', { name, uid });
                toast('addedToast', { name });
                if (fromTelegram) notify(`✅ Kartu "${name}" (${uid}) berhasil ditambahkan.`);
                bump();
                break;
            }
            case 'enroll_dup':
                enrollUntil = 0; pendingCardName = '';
                if (pendingTelegramEnroll) notify(`⚠️ Kartu ${uid} sudah terdaftar sebagai "${nameOf(uid)}".`);
                pendingTelegramEnroll = false; log('info', 'dup', { name: nameOf(uid) }); toast('dupToast', { name: nameOf(uid) }, 'warn'); break;
            case 'enroll_timeout':
                enrollUntil = 0; pendingCardName = '';
                if (pendingTelegramEnroll) notify('⌛ Waktu tambah kartu habis. Kirim /addcard untuk mencoba lagi.');
                pendingTelegramEnroll = false; log('info', 'enrollTimeout'); toast('timeoutToast', {}, 'warn'); break;
        }
    }

    function ingest(j) {
        raw = j; fails = 0; lastOk = Date.now();
        if (!online) {
            online = true;
            // Saat OTA, ESP memang berhenti menjawab sejenak -> jangan kirim pesan "kembali online"
            if (everOnline && !fwstate.isBusy('esp8266')) { log('info', 'backOnline'); tg(T('door.tgOn'), 'door_on', 0); }
            everOnline = true;
        }
        if (j.boot !== boot) { boot = j.boot; cursor = 0; }                     // ESP restart: nomor event mulai lagi dari 1
        for (const e of (j.events || []).slice().sort((a, b) => a.id - b.id)) {
            if (e.id > cursor) { cursor = e.id; handle({ ...e, uid: e.uid }); }
        }
        if (enrollUntil && j.enroll === 0 && Date.now() - enrollStart > 2500) enrollUntil = 0;   // ESP sudah keluar dari mode tambah kartu
        if (j.ver !== db.ver && Date.now() - lastSync > 2000) sync();
        push();
    }

    async function poll() {
        try { ingest(await call('/api/status')); }
        catch (e) {
            fails++;
            if (fails >= 3 && online) {
                online = false; enrollUntil = 0;
                log('bad', 'offline');
                if (!fwstate.isBusy('esp8266')) tg(T('door.tgOff', { e: e.message }), 'door_off', 300000);   // saat OTA wajar tidak menjawab
            }
            push();
        }
        timer = setTimeout(poll, N('DOOR_POLL_MS', 1000));
    }

    // ---------- Routes (sudah dilindungi login di server.js) ----------
    const fail = (res, code, message) => res.status(code).json({ success: false, message });
    const needOnline = (res) => online ? true : (fail(res, 502, T('door.offline')), false);
    const esp = (res, fn) => fn().catch(e => fail(res, 502, T('door.noResp', { e: e.message })));

    async function setEnabled(enabled) {
        db.enabled = !!enabled;
        log(db.enabled ? 'info' : 'warn', db.enabled ? 'lockOn' : 'lockOff');
        const synced = await bump();
        push();
        return { enabled: db.enabled, synced };
    }

    async function open() {
        if (!online) throw new Error(T('door.offline'));
        await call(`/api/open?sec=${db.openSec}`, 'POST');
        log('remote', 'remoteOpen');
        push();
    }

    async function close() {
        if (!online) throw new Error(T('door.offline'));
        await call('/api/close', 'POST');
        log('remote', 'remoteClose');
        push();
    }

    async function enroll(name = '', fromTelegram = false) {
        if (!online) throw new Error(T('door.offline'));
        const cardName = cleanText(name);
        if (name && !cardName) throw new Error(T('door.nameEmpty'));
        if (cardName && db.cards.some(c => c.name.toLowerCase() === cardName.toLowerCase())) throw new Error(T('door.nameUsed'));
        const sec = N('DOOR_ENROLL_SECONDS', 30);
        await call(`/api/enroll?sec=${sec}`, 'POST');
        pendingCardName = cardName; pendingTelegramEnroll = fromTelegram;
        enrollStart = Date.now(); enrollUntil = enrollStart + sec * 1000;
        log('info', 'enrollStart', { sec });
        push();
    }

    async function cancelEnroll() {
        if (!online) throw new Error(T('door.offline'));
        await call('/api/enroll?sec=0', 'POST');
        pendingCardName = ''; pendingTelegramEnroll = false; enrollStart = Date.now(); enrollUntil = 0;
        push();
    }

    app.get('/api/door/status', (req, res) => res.json(snapshot()));

    app.post('/api/door/open', (req, res) => {
        if (!needOnline(res)) return;
        esp(res, async () => { await open(); res.json({ success: true }); });
    });

    app.post('/api/door/close', (req, res) => {
        if (!needOnline(res)) return;
        esp(res, async () => { await close(); res.json({ success: true }); });
    });

    app.post('/api/door/lock', async (req, res) => {
        const state = await setEnabled(!!(req.body || {}).enabled);
        res.json({ success: true, ...state, message: state.enabled ? T('door.lockOnMsg') : T('door.lockOffMsg') });
    });

    app.post('/api/door/config', (req, res) => {
        const s = parseInt((req.body || {}).openSec, 10);
        if (!(s >= 0 && s <= 10)) return fail(res, 400, T('door.badSec'));
        db.openSec = s;
        log('info', s === 0 ? 'relaySetPulse' : 'relaySet', { s });
        bump(); push();
        res.json({ success: true, message: T('door.secSet', { s }) });
    });

    app.post('/api/door/enroll', (req, res) => {
        const cancel = (req.body || {}).action === 'cancel';
        if (!needOnline(res)) return;
        esp(res, async () => {
            if (cancel) await cancelEnroll();
            else await enroll();
            res.json({ success: true });
        });
    });

    app.post('/api/door/cards/rename', (req, res) => {
        const uid = normUid((req.body || {}).uid), name = cleanText((req.body || {}).name);
        const c = db.cards.find(c => c.uid === uid);
        if (!c) return fail(res, 404, T('door.cardNotFound'));
        if (!name) return fail(res, 400, T('door.nameEmpty'));
        if (db.cards.some(x => x !== c && x.name.toLowerCase() === name.toLowerCase())) return fail(res, 400, T('door.nameUsed'));
        log('info', 'renamed', { old: c.name, name });
        c.name = name; save(); push();
        res.json({ success: true });
    });

    app.post('/api/door/cards/admin', async (req, res) => {
        const { uid: value, admin } = req.body || {};
        const uid = normUid(value), c = db.cards.find(c => c.uid === uid);
        if (!c) return fail(res, 404, T('door.cardNotFound'));
        if (typeof admin !== 'boolean') return fail(res, 400, T('door.badAdmin'));
        // Password hanya diperiksa di server, tidak disimpan/dikirim ke ESP atau broadcast.
        if (admin && !verifyDashboardPassword(req, res)) return;
        c.admin = admin;
        log('info', admin ? 'adminAdded' : 'adminRemoved', { name: c.name });
        const synced = await bump();
        push();
        res.json({ success: true, synced, message: T(synced ? 'door.adminSaved' : 'door.adminPending') });
    });

    app.delete('/api/door/cards/:uid', (req, res) => {
        const uid = normUid(req.params.uid), i = db.cards.findIndex(c => c.uid === uid);
        if (i < 0) return fail(res, 404, T('door.cardNotFound'));
        const [c] = db.cards.splice(i, 1);
        log('warn', 'deleted', { name: c.name });
        bump(); push();
        res.json({ success: true });
    });

    return {
        snapshot,
        setEnabled,
        open,
        close,
        enroll,
        cancelEnroll,
        start() {
            if (!configured()) { console.log('[Pintu] DOOR_IP belum diisi di .env (modul pintu dinonaktifkan)'); return; }
            poll();
        },
        stop() { clearTimeout(timer); }
    };
};
