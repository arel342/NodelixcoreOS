// ============================================================================
// scheduler.js — jadwal tindakan & otomasi kondisi yang bertahan setelah restart.
//
// • Zona waktu interaksi: SCHEDULE_TZ (default Asia/Jakarta). Semua waktu yang
//   ditampilkan ke pengguna memakai zona ini; waktu internal disimpan sebagai epoch.
// • Penyimpanan: data/schedules.json, ditulis ATOMIK (tmp + rename) dengan antrean
//   penulisan supaya tidak setengah tertulis saat HP mati.
// • Jadwal terlewat saat server mati TIDAK dijalankan otomatis. Kebijakan eksplisit:
//     SCHEDULE_MISSED_POLICY=skip (default) | run-once
//     SCHEDULE_MAX_LATE_S=300   (batas "masih wajar" untuk menjalankan jadwal telat)
// • Otomasi hanya memakai data sensor yang SEGAR (SENSOR_STALE_S, default 120 detik).
//   Data offline/kedaluwarsa tidak pernah memicu tindakan.
// • Tindakan otomasi dijalankan lewat registry yang sama (pemeriksaan izin + audit),
//   dengan `confirmed` dari konfirmasi saat aturan DIBUAT. Aturan baru yang menyentuh
//   tindakan sensitif karena itu wajib dikonfirmasi lebih dulu.
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPERATORS = ['>', '>=', '<', '<=', '=='];
const SENSORS = { temperature: 'temp', humidity: 'hum', battery_soc: 'soc', battery_voltage: 'battery', current: 'current' };

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
const pad = n => String(n).padStart(2, '0');

// ---------- Utilitas zona waktu (Intl, tanpa dependensi) ----------
function tzParts(ts, tz) {
    const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const out = {};
    for (const p of dtf.formatToParts(new Date(ts))) if (p.type !== 'literal') out[p.type] = Number(p.value);
    return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

function tzOffsetMs(ts, tz) {
    const p = tzParts(ts, tz);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    return asUtc - Math.floor(ts / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    let off = tzOffsetMs(guess, tz);
    let t = guess - off;
    const off2 = tzOffsetMs(t, tz);
    if (off2 !== off) t = guess - off2;
    return t;
}

function tzAbbr(ts, tz) {
    try {
        const p = new Intl.DateTimeFormat('id-ID', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ts));
        return (p.find(x => x.type === 'timeZoneName') || {}).value || tz;
    } catch { return tz; }
}

function localLabel(ts, tz) {
    const p = tzParts(ts, tz);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} ${tzAbbr(ts, tz)}`;
}

function parseTime(str) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(str || '').trim());
    if (!m) throw Object.assign(new Error('Format waktu harus "HH:MM" (24 jam), mis. 22:00.'), { code: 'BAD_TIME', status: 400 });
    return { h: Number(m[1]), mi: Number(m[2]) };
}

function parseDate(str, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
    if (!m) throw Object.assign(new Error('Format tanggal harus "YYYY-MM-DD".'), { code: 'BAD_DATE', status: 400 });
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const utc = zonedToUtc(y, mo, d, 12, 0, tz);
    const back = tzParts(utc, tz);
    if (back.y !== y || back.mo !== mo || back.d !== d) throw Object.assign(new Error('Tanggal tidak valid.'), { code: 'BAD_DATE', status: 400 });
    return { y, mo, d };
}

module.exports = function createScheduler({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    file = path.join(__dirname, 'data', 'schedules.json'),
    now = () => Date.now(),
    log = console.log,
    notify = null,
    registry = null,
    sensorHistory = null,
    startedAt = Date.now()
} = {}) {
    const tz = () => String(env('SCHEDULE_TZ', 'Asia/Jakarta') || 'Asia/Jakarta');
    const maxLateMs = () => clamp(Number(env('SCHEDULE_MAX_LATE_S', '300')) || 300, 0, 86400) * 1000;
    const missedPolicy = () => String(env('SCHEDULE_MISSED_POLICY', 'skip')).toLowerCase() === 'run-once' ? 'run-once' : 'skip';
    const evalIntervalMs = () => clamp(Number(env('AUTOMATION_EVAL_MS', '2000')) || 2000, 500, 60000);

    let schedules = [];
    let automations = [];
    let loading = false;
    let timer = null;
    let ticking = false;
    let lastTickAt = 0;
    let writeChain = Promise.resolve();
    let lastError = '';

    const randomId = p => p + crypto.randomBytes(4).toString('hex');

    // ---------- Persistensi atomik ----------
    function save() {
        const payload = JSON.stringify({ ver: 1, savedAt: new Date(now()).toISOString(), schedules, automations }, null, 1);
        writeChain = writeChain.then(async () => {
            try {
                await fs.promises.mkdir(path.dirname(file), { recursive: true });
                const tmp = file + '.tmp';
                await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
                await fs.promises.rename(tmp, file);
                lastError = '';
            } catch (e) {
                lastError = e.message;
                log('[Jadwal] gagal menyimpan: ' + e.message);
            }
        });
        return writeChain;
    }

    function load() {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            schedules = Array.isArray(raw.schedules) ? raw.schedules.filter(s => s && s.id && typeof s.skill === 'string') : [];
            automations = Array.isArray(raw.automations) ? raw.automations.filter(a => a && a.id && SENSORS[a.sensor]) : [];
            loading = true;
        } catch { schedules = []; automations = []; }
    }

    // ---------- Pratinjau waktu (dipakai kebijakan konfirmasi) ----------
    function previewSchedule({ time, date, repeat } = {}) {
        const t = now();
        const p = parseTime(time);
        const zone = tz();
        if (repeat === 'once' && date) {
            const dt = parseDate(date, zone);
            const at = zonedToUtc(dt.y, dt.mo, dt.d, p.h, p.mi, zone);
            if (at <= t) throw Object.assign(new Error('Waktu yang diminta sudah lewat. Sebutkan tanggal/jam lain.'), { code: 'TIME_PAST', status: 400 });
            return { at, atIso: new Date(at).toISOString(), atLocal: localLabel(at, zone), tz: zone, repeat: 'once' };
        }
        const base = tzParts(t, zone);
        let at = zonedToUtc(base.y, base.mo, base.d, p.h, p.mi, zone);
        if (at <= t) {
            const next = tzParts(t + 86400000, zone);
            at = zonedToUtc(next.y, next.mo, next.d, p.h, p.mi, zone);
        }
        if (repeat === 'once') {
            return { at, atIso: new Date(at).toISOString(), atLocal: localLabel(at, zone), tz: zone, repeat: 'once', note: 'Tanggal tidak disebut; memakai waktu terdekat berikutnya.' };
        }
        return { at, atIso: new Date(at).toISOString(), atLocal: localLabel(at, zone), tz: zone, repeat: 'daily' };
    }

    function nextDailyAfter(time, after) {
        const zone = tz();
        const p = parseTime(time);
        for (let i = 0; i < 3; i++) {
            const base = tzParts(after + i * 86400000, zone);
            const at = zonedToUtc(base.y, base.mo, base.d, p.h, p.mi, zone);
            if (at > after) return at;
        }
        return after + 86400000;
    }

    function scheduleView(s) {
        const zone = tz();
        return {
            id: s.id, skill: s.skill, args: s.args || {}, repeat: s.repeat, time: s.time,
            status: s.status, next_run_at: s.nextRun ? new Date(s.nextRun).toISOString() : null,
            next_run_local: s.nextRun ? localLabel(s.nextRun, zone) : null,
            last_run_at: s.lastRun ? new Date(s.lastRun).toISOString() : null,
            last_run_local: s.lastRun ? localLabel(s.lastRun, zone) : null,
            last_outcome: s.lastOutcome || null, last_error: s.lastError || null,
            created_at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
            created_by: s.createdBy || null, missed: s.missed || 0
        };
    }

    // ---------- Jadwal ----------
    async function addSchedule({ skill, args, time, date, repeat, createdBy, channel, sessionId, chatId, requestId, confirmId } = {}) {
        if (!['once', 'daily'].includes(repeat)) throw Object.assign(new Error('repeat harus "once" atau "daily".'), { status: 400 });
        const preview = previewSchedule({ time, date, repeat });
        const rec = {
            id: randomId('sc-'),
            skill, args: args || {}, time, repeat,
            date: date || null,
            nextRun: preview.at,
            status: 'active',
            createdAt: now(), createdBy: createdBy || 'admin', channel: channel || 'web',
            sessionId: sessionId || '', chatId: chatId || '', requestId: requestId || '', confirmId: confirmId || '',
            lastRun: null, lastOutcome: null, lastError: null, missed: 0,
            localLabel: preview.atLocal
        };
        schedules.push(rec);
        await save();
        log(`[Jadwal] ${rec.id}: ${skill} pada ${preview.atLocal} (${repeat})`);
        return scheduleView(rec);
    }

    function listSchedules() {
        return schedules.map(scheduleView).sort((a, b) => String(a.next_run_at).localeCompare(String(b.next_run_at)));
    }

    async function cancelSchedule(id) {
        const target = String(id || '');
        const i = schedules.findIndex(s => s.id === target);
        if (i < 0) throw Object.assign(new Error('Jadwal tidak ditemukan.'), { status: 404, code: 'SCHEDULE_NOT_FOUND' });
        schedules.splice(i, 1);
        await save();
        return { cancelled: true, id: target };
    }

    // ---------- Otomasi ----------
    const automationView = a => ({
        id: a.id, name: a.name, enabled: a.enabled !== false,
        sensor: a.sensor, operator: a.operator, threshold: a.threshold,
        duration_sec: a.durationSec, cooldown_sec: a.cooldownSec, hysteresis: a.hysteresis,
        action: a.action, trigger_count: a.triggerCount || 0,
        last_trigger_at: a.lastTrigger ? new Date(a.lastTrigger).toISOString() : null,
        last_value: a.lastValue == null ? null : a.lastValue,
        last_skipped: a.lastSkipped || null,
        created_at: a.createdAt ? new Date(a.createdAt).toISOString() : null
    });

    function addAutomation({ name, sensor, operator, threshold, durationSec, cooldownSec, hysteresis, action, enabled, createdBy, channel, confirmId } = {}) {
        if (!SENSORS[sensor]) throw Object.assign(new Error('Sensor otomasi tidak dikenal.'), { status: 400 });
        if (!OPERATORS.includes(operator)) throw Object.assign(new Error('Operator otomasi tidak dikenal.'), { status: 400 });
        if (!Number.isFinite(Number(threshold))) throw Object.assign(new Error('Ambang batas harus angka.'), { status: 400 });
        if (!action || (!action.notify && !action.skill)) throw Object.assign(new Error('Tindakan otomasi harus berisi "notify" atau "skill".'), { status: 400 });
        const rec = {
            id: randomId('au-'), name: String(name).slice(0, 60), enabled: enabled !== false,
            sensor, operator, threshold: Number(threshold),
            durationSec: clamp(Number(durationSec) || 0, 0, 3600),
            cooldownSec: clamp(Number(cooldownSec) || 300, 30, 86400),
            hysteresis: clamp(Number(hysteresis) || 0, 0, 100),
            action, createdAt: now(), createdBy: createdBy || 'admin', channel: channel || 'web',
            confirmId: confirmId || '',
            triggerCount: 0, lastTrigger: 0, lastValue: null, lastSkipped: null,
            condSince: null, armed: true
        };
        automations.push(rec);
        save();
        log(`[Otomasi] ${rec.id}: ${rec.sensor} ${rec.operator} ${rec.threshold} -> ${action.notify ? 'notifikasi' : action.skill}`);
        return automationView(rec);
    }

    function listAutomations() { return automations.map(automationView); }

    function disableAutomation(id) {
        const a = automations.find(x => x.id === String(id || ''));
        if (!a) throw Object.assign(new Error('Otomasi tidak ditemukan.'), { status: 404, code: 'AUTOMATION_NOT_FOUND' });
        a.enabled = false;
        a.condSince = null;
        save();
        return { disabled: true, id: a.id };
    }

    // ---------- Evaluasi ----------
    async function announce(text) {
        if (!notify) return;
        try { await notify(text); } catch { }
    }

    async function runSchedule(rec) {
        const zone = tz();
        const when = localLabel(now(), zone);
        let result;
        try {
            if (!registry || typeof registry.execute !== 'function') throw new Error('Registry skill tidak tersedia.');
            // Pertahanan berlapis: berkas jadwal bisa saja disunting manual. Tindakan
            // sensitif tidak pernah dijalankan otomatis tanpa tombol pengguna.
            if (registry.SCHEDULABLE && typeof registry.SCHEDULABLE.has === 'function' && !registry.SCHEDULABLE.has(rec.skill)) {
                throw new Error(`Skill "${rec.skill}" tidak diizinkan dijalankan otomatis; konfirmasi manual diperlukan.`);
            }
            result = await registry.execute(rec.skill, rec.args || {}, {
                channel: 'scheduler', actor: 'system',
                sessionId: rec.sessionId || '', chatId: rec.chatId || '',
                requestId: rec.id, confirmId: rec.confirmId || '', confirmed: true
            });
        } catch (e) {
            result = { status: 'error', message: e.message };
        }
        rec.lastRun = now();
        rec.lastOutcome = result.status;
        rec.lastError = result.status === 'error' ? String(result.message || '').slice(0, 300) : null;
        if (result.status === 'error') {
            if (!rec.lastNotify || now() - rec.lastNotify > 5 * 60 * 1000) {
                rec.lastNotify = now();
                await announce(`⚠️ Jadwal ${rec.id} (${rec.skill}) gagal pada ${when}: ${result.message}`);
            }
        }
        return result;
    }

    function sensorValue(sensor) {
        const p = sensorHistory && typeof sensorHistory.latest === 'function' ? sensorHistory.latest() : null;
        if (!p || !p.point) return { ok: false, reason: 'Belum ada data sensor.' };
        if (p.point.online === false) return { ok: false, reason: 'Perangkat sedang offline.', latest: p };
        if (!p.fresh) return { ok: false, reason: `Data sensor kedaluwarsa (${p.ageSec} detik).`, latest: p };
        const field = SENSORS[sensor];
        const v = p.point[field];
        if (!Number.isFinite(v)) return { ok: false, reason: `Nilai ${sensor} tidak tersedia pada pembacaan terakhir.`, latest: p };
        return { ok: true, value: v, at: p.point.t, ageSec: p.ageSec };
    }

    function compare(op, value, threshold) {
        switch (op) {
            case '>': return value > threshold;
            case '>=': return value >= threshold;
            case '<': return value < threshold;
            case '<=': return value <= threshold;
            case '==': return value === threshold;
            default: return false;
        }
    }

    async function evaluateAutomation(a) {
        if (a.enabled === false) return;
        const sv = sensorValue(a.sensor);
        if (!sv.ok) {
            a.lastSkipped = sv.reason;
            a.condSince = null;
            return;
        }
        a.lastSkipped = null;
        a.lastValue = sv.value;
        const active = compare(a.operator, sv.value, a.threshold);
        const t = now();

        // Re-arm memakai hysteresis: setelah pemicu, nilai harus kembali melewati
        // ambang (dikurangi/ditambah hysteresis) sebelum boleh memicu lagi.
        if (!a.armed) {
            const back = a.operator === '<' || a.operator === '<='
                ? sv.value > a.threshold + a.hysteresis
                : sv.value < a.threshold - a.hysteresis;
            if (a.operator === '==' || back) { a.armed = true; a.condSince = null; }
            else return;
        }
        if (!active) { a.condSince = null; return; }
        if (!a.condSince) a.condSince = t;
        const held = t - a.condSince;
        if (held < a.durationSec * 1000) return;
        if (a.lastTrigger && t - a.lastTrigger < a.cooldownSec * 1000) return;

        a.lastTrigger = t;
        a.triggerCount = (a.triggerCount || 0) + 1;
        a.armed = false;
        a.condSince = null;
        const label = `${a.sensor} = ${sv.value} (${new Date(sv.at).toISOString()})`;
        if (a.action.notify) {
            await announce(`🔔 Otomasi "${a.name}": ${a.sensor} ${a.operator} ${a.threshold} terpenuhi — ${label}. ${String(a.action.notify).slice(0, 300)}`);
            a.lastOutcome = 'notified';
        } else if (a.action.skill) {
            let result;
            try {
                result = await registry.execute(a.action.skill, a.action.args || {}, {
                    channel: 'automation', actor: 'system', sessionId: '', chatId: '',
                    requestId: a.id, confirmId: a.confirmId || '', confirmed: true
                });
            } catch (e) { result = { status: 'error', message: e.message }; }
            a.lastOutcome = result.status;
            if (result.status === 'error') await announce(`⚠️ Otomasi "${a.name}" gagal: ${result.message} (${label})`);
        }
        save();
    }

    async function tick() {
        if (ticking) return;
        ticking = true;
        try {
            const t = now();
            if (t - lastTickAt < evalIntervalMs()) return;
            lastTickAt = t;
            // Jadwal
            for (const rec of schedules.slice()) {
                if (rec.status !== 'active' || !rec.nextRun) continue;
                if (rec.nextRun > t) continue;
                await runSchedule(rec);
                if (rec.repeat === 'daily') {
                    rec.nextRun = nextDailyAfter(rec.time, t);
                } else {
                    rec.status = 'done';
                }
                await save();
            }
            // Otomasi
            for (const a of automations.slice()) {
                try { await evaluateAutomation(a); } catch (e) { lastError = e.message; }
            }
        } finally { ticking = false; }
    }

    // ---------- Startup: kebijakan jadwal terlewat ----------
    async function bootstrap() {
        const t = now();
        let changed = false;
        for (const rec of schedules) {
            if (rec.status !== 'active') continue;
            if (!rec.nextRun || rec.nextRun > t) continue;
            const lateBy = t - rec.nextRun;
            const missedBeforeBoot = rec.nextRun < startedAt;   // jadwal jatuh tempo saat server mati
            const policy = missedPolicy();
            const withinLate = lateBy <= maxLateMs();
            if (missedBeforeBoot) {
                rec.missed = (rec.missed || 0) + 1;
                rec.lastMissedAt = t;
                changed = true;
                if (policy === 'run-once' && withinLate) {
                    log(`[Jadwal] ${rec.id} terlewat ${Math.round(lateBy / 1000)} dtk; kebijakan run-once -> dijalankan sekali.`);
                    await runSchedule(rec);
                } else {
                    log(`[Jadwal] ${rec.id} terlewat saat server mati; dilewati (kebijakan ${policy}).`);
                    await announce(`ℹ️ Jadwal ${rec.id} (${rec.skill}) terlewat karena server mati dan DILEWATI sesuai kebijakan ${policy}.`);
                }
            } else if (withinLate) {
                log(`[Jadwal] ${rec.id} telat ${Math.round(lateBy / 1000)} dtk; dijalankan sekarang.`);
                await runSchedule(rec);
            }
            if (rec.repeat === 'daily') rec.nextRun = nextDailyAfter(rec.time, t);
            else { rec.status = 'done'; }
            changed = true;
        }
        // Bangun ulang nextRun untuk jadwal harian yang belum jatuh tempo (mis. zona waktu berubah).
        for (const rec of schedules) {
            if (rec.status === 'active' && rec.repeat === 'daily' && rec.nextRun && rec.nextRun <= t) {
                rec.nextRun = nextDailyAfter(rec.time, t);
                changed = true;
            }
        }
        if (changed || loading) { loading = false; await save(); }
    }

    load();

    async function start() {
        await bootstrap();
        if (timer) return;
        timer = setInterval(() => { tick().catch(e => { lastError = e.message; }); }, 1000);
        if (timer.unref) timer.unref();
        log(`[Jadwal] aktif: ${schedules.length} jadwal, ${automations.length} otomasi (zona ${tz()}).`);
        return true;
    }

    function stop() { if (timer) clearInterval(timer); timer = null; }

    return {
        start, stop, tick, bootstrap,
        addSchedule, listSchedules, cancelSchedule,
        addAutomation, listAutomations, disableAutomation,
        previewSchedule, localLabel,
        get schedules() { return schedules; },
        get automations() { return automations; },
        stats: () => ({
            schedules: schedules.length, active: schedules.filter(s => s.status === 'active').length,
            automations: automations.length, enabled: automations.filter(a => a.enabled !== false).length,
            timezone: tz(), persist: file, lastError, missedPolicy: missedPolicy()
        }),
        _evaluateAutomation: evaluateAutomation,
        _runSchedule: runSchedule,
        _save: save
    };
};

module.exports.tzParts = tzParts;
module.exports.zonedToUtc = zonedToUtc;
module.exports.localLabel = localLabel;
module.exports.SENSORS = SENSORS;
module.exports.OPERATORS = OPERATORS;
