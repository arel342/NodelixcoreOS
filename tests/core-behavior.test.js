// ============================================================================
// tests/core-behavior.test.js — perilaku inti yang diminta audit:
//   • executor: shell dipilih, TERMINAL_ENABLED diperiksa tiap kali, timeout
//     mematikan anak proses, killAll menghentikan pekerjaan
//   • registry: validasi boolean/parameter sebelum efek samping, konfirmasi
//     backend, sekali pakai, identitas terikat, tolak self-approval
//   • confirm: kedaluwarsa + identitas salah + single-use
//   • audit: rahasia disaring
//   • alias: semua modul AI menunjuk implementasi yang sama
// Tanpa jaringan, tanpa perangkat sungguhan.
// ============================================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const createExecutor = require(path.join(root, 'executor'));
const createRegistry = require(path.join(root, 'skills-registry'));
const createConfirm = require(path.join(root, 'confirm'));
const createAudit = require(path.join(root, 'audit'));

const envFrom = obj => (k, d) => (obj[k] === undefined || obj[k] === '' ? d : obj[k]);
const delay = ms => new Promise(r => setTimeout(r, ms));
const POSIX = process.platform !== 'win32';

function makeExecutor(extra = {}) {
    const env = {
        TERMINAL_ENABLED: 'true',
        TERMINAL_SHELL: '/bin/sh',
        TERMINAL_TIMEOUT_S: '10',
        TERMINAL_MAX_OUTPUT_KB: '64',
        TERMINAL_MAX_JOBS: '4',
        ...extra
    };
    const ex = createExecutor({ env: envFrom(env), log() { } });
    return { ex, env };
}

// ---------- Executor ----------
test('executor: memakai shell dari TERMINAL_SHELL', { skip: !POSIX }, async () => {
    const { ex } = makeExecutor();
    assert.equal(ex.enabled(), true);
    assert.equal(ex.shell(), '/bin/sh');
    const r = await ex.execute({ cmd: 'printf "%s" "$0"', channel: 'test' });
    assert.equal(r.ok, true, r.stderr);
    // sh -c menerima jalur shell sebagai $0
    assert.equal(path.basename(r.output.trim()), 'sh');
    ex.stopSweeper();
});

test('executor: TERMINAL_ENABLED diperiksa setiap kali perintah dijalankan', { skip: !POSIX }, async () => {
    const { ex, env } = makeExecutor();
    const first = await ex.execute({ cmd: 'echo satu', channel: 'test' });
    assert.equal(first.ok, true);

    env.TERMINAL_ENABLED = 'false';
    const off = await ex.execute({ cmd: 'echo dua', channel: 'test' });
    assert.equal(off.ok, false);
    assert.equal(off.errorCode, 'TERMINAL_DISABLED');

    env.TERMINAL_ENABLED = 'true';
    const again = await ex.execute({ cmd: 'echo tiga', channel: 'test' });
    assert.equal(again.ok, true, 'terminal aktif lagi harus langsung bisa dipakai');
    ex.stopSweeper();
});

test('executor: timeout mematikan proses anak (tidak ada file tertinggal)', { skip: !POSIX }, async () => {
    const { ex } = makeExecutor();
    const marker = path.join(os.tmpdir(), `nodelix-timeout-${process.pid}-${Date.now()}`);
    const r = await ex.execute({ cmd: `sleep 5; touch ${JSON.stringify(marker)}`, channel: 'test', timeoutMs: 350 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    await delay(700);
    assert.equal(fs.existsSync(marker), false, 'anak proses tidak boleh hidup setelah timeout');
    ex.stopSweeper();
});

test('executor: killAll menghentikan proses yang masih berjalan', { skip: !POSIX }, async () => {
    const { ex } = makeExecutor();
    const marker = path.join(os.tmpdir(), `nodelix-kill-${process.pid}-${Date.now()}`);
    const job = ex.start({ cmd: `sleep 10; touch ${JSON.stringify(marker)}`, channel: 'test' });
    await delay(150);
    ex.killAll('disabled');
    await delay(1200);
    assert.equal(job.done, true);
    assert.equal(job.killedBy, 'disabled');
    assert.equal(fs.existsSync(marker), false);
    ex.stopSweeper();
});

// ---------- Registry + konfirmasi ----------
let clock = Date.now();
const now = () => clock;

function makeRegistry({ terminalEnabled = true } = {}) {
    const calls = { relay: [], doorOpen: 0, doorEnabled: [], enroll: 0, exec: 0, audit: [] };
    const env = { DOOR_IP: '10.0.0.9', CONFIRM_TTL_S: '300', SENSOR_STALE_S: '120', AI_COMMAND_TIMEOUT_S: '30' };
    const confirm = createConfirm({ env: envFrom(env), now, log() { } });
    const deps = {
        esp32: {
            setRelay: async (target, state) => { calls.relay.push([target, state]); return { ok: true }; },
            snapshot: () => ({ online: true, relay: [false, false, false, false] })
        },
        door: {
            open: async () => { calls.doorOpen++; return { ok: true }; },
            close: async () => ({ ok: true }),
            setEnabled: async v => { calls.doorEnabled.push(v); return { ok: true, enabled: v }; },
            enroll: async () => { calls.enroll++; return { ok: true, enabled: true }; },
            snapshot: () => ({ enabled: true })
        },
        executor: {
            enabled: () => terminalEnabled,
            execute: async () => { calls.exec++; return { ok: true, code: 0, output: 'ok', stderr: '', ms: 1 }; }
        },
        locks: { run: async (key, fn) => fn() },
        audit: { write: e => calls.audit.push(e) },
        confirm
    };
    const reg = createRegistry({ deps, env: envFrom(env), log() { }, now });
    return { reg, confirm, calls, deps };
}

test('registry: terminal nonaktif -> skill shell tidak dijalankan sama sekali', async () => {
    const { reg, calls } = makeRegistry({ terminalEnabled: false });
    const r = await reg.execute('run_command', { command: 'uptime' }, { channel: 'web', sessionId: 's1' });
    assert.equal(r.status, 'error');
    assert.equal(r.code, 'FEATURE_UNAVAILABLE');
    assert.equal(calls.exec, 0);
});

test('registry: string "false" ditolak untuk parameter boolean (tanpa efek samping)', async () => {
    const { reg, calls } = makeRegistry();
    const relay = await reg.execute('set_relay', { id: '3', state: 'false' }, { channel: 'web', sessionId: 's1' });
    assert.equal(relay.status, 'error');
    assert.equal(relay.code, 'INVALID_ARGS');
    assert.equal(calls.relay.length, 0);

    const door = await reg.execute('set_door_enabled', { enabled: 'false' }, { channel: 'web', sessionId: 's1' });
    assert.equal(door.status, 'error');
    assert.equal(door.code, 'INVALID_ARGS');
    assert.equal(calls.doorEnabled.length, 0);
});

test('registry: parameter tambahan (approved:true) ditolak, bukan jalan sendiri', async () => {
    const { reg, calls } = makeRegistry();
    const r = await reg.execute('set_door_enabled', { enabled: false, approved: true }, { channel: 'web', sessionId: 's1' });
    assert.equal(r.status, 'error');
    assert.equal(r.code, 'INVALID_ARGS');
    assert.equal(calls.doorEnabled.length, 0);
});

test('registry: open_door membuat konfirmasi, baru jalan setelah disetujui; sekali pakai', async () => {
    const { reg, confirm, calls } = makeRegistry();
    const first = await reg.execute('open_door', {}, { channel: 'web', sessionId: 's1', actor: 'admin' });
    assert.equal(first.status, 'pending_confirmation');
    assert.equal(first.code, 'CONFIRM_REQUIRED');
    assert.equal(calls.doorOpen, 0, 'pintu tidak boleh dibuka sebelum persetujuan');

    const rec = confirm.approve(first.confirmation_id, { channel: 'web', sessionId: 's1', actor: 'admin' });
    assert.equal(rec.status, 'executing');
    const run = await reg.execute('open_door', rec.args, {
        channel: 'web', sessionId: 's1', actor: 'admin', confirmed: true, confirmId: rec.id
    });
    assert.equal(run.status, 'ok');
    assert.equal(calls.doorOpen, 1);
    confirm.complete(rec.id, { ok: true, result: run.result });

    assert.throws(
        () => confirm.approve(rec.id, { channel: 'web', sessionId: 's1', actor: 'admin' }),
        e => e.code === 'CONFIRM_USED' && e.status === 409
    );
});

test('confirm: kedaluwarsa & identitas lain ditolak', () => {
    const c = createConfirm({ env: envFrom({ CONFIRM_TTL_S: '60' }), now, log() { } });
    const rec = c.create({ skill: 'open_door', actor: 'admin', channel: 'web', sessionId: 's1' });

    assert.throws(() => c.approve(rec.id, { actor: 'admin', channel: 'web', sessionId: 's2' }), e => e.code === 'CONFIRM_IDENTITY');
    assert.throws(() => c.approve(rec.id, { actor: 'admin', channel: 'telegram', chatId: '1' }), e => e.code === 'CONFIRM_IDENTITY');

    const before = clock;
    clock += 61 * 1000;
    assert.throws(() => c.approve(rec.id, { actor: 'admin', channel: 'web', sessionId: 's1' }), e => e.code === 'CONFIRM_EXPIRED' && e.status === 410);
    clock = before;
    c.stop();
});

test('confirm: identitas tidak diketahui (null) ditolak rapi, bukan error 500', () => {
    const c = createConfirm({ env: envFrom({ CONFIRM_TTL_S: '60' }), now, log() { } });
    assert.throws(() => c.assertIdentity(null, {}), e => e.code === 'CONFIRM_NOT_FOUND' && e.status === 404);
    const rec = c.create({ skill: 'x', actor: 'admin', channel: 'web', sessionId: 's1' });
    assert.throws(() => c.approve(rec.id, {}), e => e.code === 'CONFIRM_IDENTITY' && e.status === 403);
    c.stop();
});

// ---------- Audit ----------
test('audit: token/kunci API disaring dari berkas', async () => {
    const file = path.join(os.tmpdir(), `nodelix-audit-${process.pid}-${Date.now()}.log`);
    const a = createAudit({ env: envFrom({ AUDIT_LOG_ENABLED: 'true' }), file, log() { } });
    await a.write({
        actor: 'admin', skill: 'run_command', target: 'shell',
        args: { command: 'TOKEN=rahasia123' },
        // Dibangun dari potongan supaya pemindai rahasia tidak menganggapnya kunci asli.
        result: { api_key: ['AIza', 'SyABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join(''), nested: { password: 'hunter2' } },
        opId: 'op-tes-1', outcome: 'ok'
    });
    const raw = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /rahasia123/);
    assert.doesNotMatch(raw, new RegExp(['AIza','SyABCDEFGHIJKLMN'].join('')));
    assert.doesNotMatch(raw, /hunter2/);
    assert.match(raw, /\[REDACTED\]/);
    const rows = await a.tail(5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].opId, 'op-tes-1');
    fs.rmSync(file, { force: true });
});

// ---------- Alias modul AI ----------
test('alias: agent.js/ai-agent.js/ai_agent.js/gemini.js memakai implementasi ai.js yang sama', () => {
    const main = require(path.join(root, 'ai'));
    for (const name of ['agent.js', 'ai-agent.js', 'ai_agent.js', 'gemini.js']) {
        assert.equal(require(path.join(root, name)), main, name + ' harus mengekspor modul ai.js yang sama');
    }
    assert.equal(typeof main, 'function');
});
