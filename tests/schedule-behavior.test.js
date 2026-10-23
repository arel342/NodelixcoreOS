// ============================================================================
// tests/schedule-behavior.test.js — jadwal & otomasi:
//   • zona waktu Asia/Jakarta dan waktu lengkap ditampilkan sebelum disimpan
//   • jadwal bertahan setelah restart (berkas JSON atomik)
//   • jadwal terlewat tidak dijalankan diam-diam (policy skip) / run-once eksplisit
//   • data sensor offline/kedaluwarsa TIDAK memicu otomasi
//   • otomasi tetap menghormati kebijakan konfirmasi (tidak bisa memakai open_door)
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const createScheduler = require(path.join(root, 'scheduler'));
const createRegistry = require(path.join(root, 'skills-registry'));
const createConfirm = require(path.join(root, 'confirm'));

const envFrom = obj => (k, d) => (obj[k] === undefined || obj[k] === '' ? d : obj[k]);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-sched-')), 'schedules.json');

let clock = Date.parse('2026-10-23T10:00:00+07:00');
const now = () => clock;

function makeScheduler(file, extraEnv = {}, sensorHistory = null) {
    const calls = { execute: [] };
    const registry = {
        execute: async (skill, args, ctx) => {
            calls.execute.push({ skill, args, ctx });
            return { status: 'ok', result: { ok: true } };
        }
    };
    const s = createScheduler({
        file, now, log() { }, registry, sensorHistory,
        env: envFrom({ SCHEDULE_TZ: 'Asia/Jakarta', SCHEDULE_MAX_LATE_S: '300', ...extraEnv }),
        startedAt: clock
    });
    return { s, calls };
}

test('jadwal: waktu lengkap berzona Asia/Jakarta ditampilkan sebelum disimpan', async () => {
    const { s } = makeScheduler(tmpFile());
    const p = s.previewSchedule({ time: '22:00', repeat: 'daily' });
    assert.equal(p.tz, 'Asia/Jakarta');
    assert.match(p.atLocal, /22:00/);
    assert.match(p.atLocal, /WIB|GMT\+7|Asia\/Jakarta/);

    // Kebijakan konfirmasi memuat waktu lengkap yang akan disimpan.
    const confirm = createConfirm({ env: envFrom({ CONFIRM_TTL_S: '300' }), now, log() { } });
    const reg = createRegistry({
        deps: { confirm, scheduler: s, audit: { write() { } } },
        env: envFrom({ SCHEDULE_TZ: 'Asia/Jakarta', DOOR_IP: '10.0.0.9' }),
        now
    });
    const pending = await reg.execute('schedule_action', {
        skill: 'set_relay', args: { id: 3, state: false }, time: '22:00', repeat: 'daily'
    }, { channel: 'web', sessionId: 's1', actor: 'admin' });
    assert.equal(pending.status, 'pending_confirmation');
    assert.match(pending.summary, /22:00/);
    assert.match(pending.summary, /WIB|GMT\+7|Asia\/Jakarta/);
    assert.match(pending.summary, /HARIAN|SEKALI/);
    assert.equal(s.listSchedules().length, 0, 'jadwal belum disimpan sebelum disetujui');
    confirm.stop();
    s.stop();
});

test('jadwal: bertahan setelah restart (berkas yang sama)', async () => {
    const file = tmpFile();
    const { s } = makeScheduler(file);
    const view = await s.addSchedule({
        skill: 'set_relay', args: { id: 3, state: false }, time: '22:00', repeat: 'daily',
        createdBy: 'admin', channel: 'web'
    });
    s.stop();

    const second = makeScheduler(file).s;
    const list = second.listSchedules();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, view.id);
    assert.equal(list[0].skill, 'set_relay');
    second.stop();
});

test('jadwal terlewat: kebijakan default skip tidak menjalankan apa pun', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
        ver: 1, automations: [],
        schedules: [{
            id: 'sc-telat', skill: 'set_relay', args: { id: 3, state: false },
            time: '22:00', repeat: 'daily', nextRun: clock - 3600_000, status: 'active',
            createdAt: clock - 7200_000, missed: 0
        }]
    }));
    const { s, calls } = makeScheduler(file);
    await s.bootstrap();
    assert.equal(calls.execute.length, 0, 'jadwal terlewat tidak boleh jalan diam-diam');
    assert.equal(s.schedules[0].missed, 1);
    s.stop();
});

test('jadwal terlewat: SCHEDULE_MISSED_POLICY=run-once menjalankan sekali', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({
        ver: 1, automations: [],
        schedules: [{
            id: 'sc-telat', skill: 'set_relay', args: { id: 4, state: true },
            time: '22:00', repeat: 'daily', nextRun: clock - 10_000, status: 'active',
            createdAt: clock - 7200_000, missed: 0
        }]
    }));
    const { s, calls } = makeScheduler(file, { SCHEDULE_MISSED_POLICY: 'run-once' });
    await s.bootstrap();
    assert.equal(calls.execute.length, 1);
    assert.equal(calls.execute[0].skill, 'set_relay');
    assert.deepEqual(calls.execute[0].args, { id: 4, state: true });
    s.stop();
});

test('otomasi: sensor offline / kedaluwarsa tidak memicu tindakan', async () => {
    const state = { online: false, fresh: true, ageSec: 3, temp: 40 };
    const sensor = { latest: () => ({ point: { t: clock, online: state.online, temp: state.temp }, fresh: state.fresh, ageSec: state.ageSec }) };
    const { s, calls } = makeScheduler(tmpFile(), {}, sensor);
    s.addAutomation({
        name: 'Suhu tinggi', sensor: 'temperature', operator: '>', threshold: 35,
        durationSec: 0, cooldownSec: 30, hysteresis: 0.5, action: { notify: 'Panas!' }
    });
    const a = s.automations[0];

    await s._evaluateAutomation(a);
    assert.equal(calls.execute.length, 0);
    assert.match(String(a.lastSkipped), /offline/i);

    state.online = true;
    state.fresh = false;
    state.ageSec = 500;
    await s._evaluateAutomation(a);
    assert.equal(calls.execute.length, 0);
    assert.match(String(a.lastSkipped), /kedaluwarsa/i);
    s.stop();
});

test('otomasi: durasi + hysteresis + cooldown mencegah pemicu berulang', async () => {
    const state = { temp: 34 };
    const sensor = { latest: () => ({ point: { t: clock, online: true, temp: state.temp }, fresh: true, ageSec: 2 }) };
    const { s } = makeScheduler(tmpFile(), {}, sensor);
    const notes = [];
    s.addAutomation({
        name: 'Suhu >35', sensor: 'temperature', operator: '>', threshold: 35,
        durationSec: 60, cooldownSec: 300, hysteresis: 0.5, action: { notify: 'Suhu tinggi' }
    });
    const a = s.automations[0];

    await s._evaluateAutomation(a);                         // 34: belum memenuhi
    assert.equal(a.triggerCount, 0);
    state.temp = 36;
    await s._evaluateAutomation(a);                         // mulai menghitung durasi
    assert.equal(a.triggerCount, 0, 'durasi 60 detik belum terpenuhi');

    clock += 61_000;
    await s._evaluateAutomation(a);
    assert.equal(a.triggerCount, 1);

    await s._evaluateAutomation(a);                         // masih panas: hysteresis menahan
    assert.equal(a.triggerCount, 1);

    state.temp = 34;                                        // kembali di bawah ambang
    await s._evaluateAutomation(a);
    assert.equal(a.armed, true);
    state.temp = 36;
    await s._evaluateAutomation(a);
    assert.equal(a.triggerCount, 1, 'cooldown 300 detik belum lewat');

    clock += 301_000;
    await s._evaluateAutomation(a);
    assert.equal(a.triggerCount, 2);
    s.stop();
});

test('otomasi: skill sensitif (open_door) tidak boleh dipakai dan tetap butuh konfirmasi', async () => {
    const file = tmpFile();
    const { s } = makeScheduler(file);
    const confirm = createConfirm({ env: envFrom({ CONFIRM_TTL_S: '300' }), now, log() { } });
    const reg = createRegistry({
        deps: { confirm, scheduler: s, audit: { write() { } } },
        env: envFrom({ SCHEDULE_TZ: 'Asia/Jakarta', DOOR_IP: '10.0.0.9' }),
        now
    });
    const pending = await reg.execute('create_automation', {
        name: 'Buka pintu', sensor: 'temperature', operator: '>', threshold: 1,
        action: { skill: 'open_door' }
    }, { channel: 'web', sessionId: 's1', actor: 'admin' });
    assert.equal(pending.status, 'pending_confirmation', 'pembuatan otomasi sendiri butuh konfirmasi');

    const rec = confirm.approve(pending.confirmation_id, { channel: 'web', sessionId: 's1', actor: 'admin' });
    // Sama seperti ai.approveConfirmation: argumen record konfirmasi sudah
    // divalidasi + dinormalkan, jadi tidak divalidasi ulang terhadap schema.
    const run = await reg.execute('create_automation', rec.args, {
        channel: 'web', sessionId: 's1', actor: 'admin', confirmed: true, preValidated: true, confirmId: rec.id
    });
    assert.equal(run.status, 'error');
    assert.match(run.message, /tidak diizinkan/i);
    assert.equal(s.automations.length, 0);
    confirm.stop();
    s.stop();
});
