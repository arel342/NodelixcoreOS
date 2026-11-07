'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const envFile = require('../env-file');
const ROOT = path.resolve(__dirname, '..');

function request(port, url, body, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url,
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }
        }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json; try { json = JSON.parse(text); } catch { }
                resolve({ status: res.statusCode, headers: res.headers, json });
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

test('env credentials round-trip exactly; duplicates removed and legacy entries supported', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-env-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'ADMIN_PASSWORD=old\nADMIN_PASSWORD=stale\nPORT=3000\n');
    for (const password of ['  password123  ', '"password123"', "'password123'", 'back\\slash$#123', 'unicode-密码-123']) {
        envFile.save(file, 'ADMIN_PASSWORD', password);
        const text = fs.readFileSync(file, 'utf8');
        assert.equal(envFile.parse(text).get('ADMIN_PASSWORD'), password);
        assert.equal(text.match(/^ADMIN_PASSWORD=/gm).length, 1);
        assert.equal(envFile.parse(text).get('PORT'), '3000');
    }
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(envFile.parse("A='legacy value'\nB=plain").get('A'), 'legacy value');
});

test('fresh setup → protected steps → finish → logout → restart → login (Android interface denial simulated)', { timeout: 45000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-clean-'));
    let child;
    async function stop() {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exit = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exit; } finally { clearTimeout(timer); }
    }
    t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    for (const name of fs.readdirSync(ROOT)) {
        if (name.endsWith('.js') || name === 'package.json') fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.symlinkSync(path.join(ROOT, 'public'), path.join(dir, 'public'), 'dir');
    fs.writeFileSync(path.join(dir, 'android-denial.cjs'), "require('os').networkInterfaces = () => { throw new Error('uv_interface_addresses: permission denied'); };\n");
    // Reserve a free port, then release it before starting the actual server.
    const probe = require('node:net').createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    async function start() {
        const env = { ...process.env, PORT: String(port), STORAGE_MODE: 'direct', STORAGE_DEVICE: path.join(dir, 'storage'),
            UPDATE_CHECK_ENABLED: 'false', AI_AGENT_ENABLED: 'false', TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALERTS: 'false',
            TERMINAL_ENABLED: 'false', ESP32_IP: '', DOOR_IP: '', SU_BIN: '/bin/sh' };
        delete env.ADMIN_PASSWORD; delete env.ADMIN_USERNAME;
        child = spawn(process.execPath, ['--require', './android-denial.cjs', 'server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('startup timeout: ' + log)), 15000);
            const onData = () => { if (/Setup awal:|Server aktif/.test(log)) finish(); };
            const onExit = () => finish(new Error('startup failed: ' + log));
            function finish(error) {
                clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit);
                error ? reject(error) : resolve();
            }
            child.stdout.on('data', onData); child.once('exit', onExit);
        });
        await request(port, '/api/setup/status');
        assert.doesNotMatch(log, /Gagal menjalankan server/, 'network enumeration denial must not abort startup');
    }
    await start();
    assert.equal(fs.existsSync(path.join(dir, '.env')), false);
    assert.equal((await request(port, '/')).headers.location, '/setup.html');
    assert.equal((await request(port, '/api/session')).status, 409);
    assert.equal((await request(port, '/api/setup/status')).json.required, true);
    const account = { username: 'owner', password: '  "password$123"  ' };
    assert.equal((await request(port, '/api/setup/account', { ...account, confirmPassword: 'mismatch' })).status, 400);
    const created = await request(port, '/api/setup/account', { ...account, confirmPassword: account.password });
    assert.equal(created.status, 200);
    let cookie = created.headers['set-cookie'][0].split(';')[0];
    assert.match(created.headers['set-cookie'][0], /HttpOnly; SameSite=Lax/);
    assert.equal((await request(port, '/api/session', undefined, cookie)).json.authenticated, true);
    assert.equal((await request(port, '/api/setup/account', { ...account, confirmPassword: account.password })).status, 403);
    assert.equal((await request(port, '/api/setup/server', { server: { port } }, cookie)).status, 200);
    const finished = await request(port, '/api/setup/finish', {}, cookie);
    assert.equal(finished.status, 200);
    cookie = finished.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(port, '/api/logout', {}, cookie)).status, 200);
    assert.equal((await request(port, '/api/session', undefined, cookie)).json.authenticated, false);
    await stop(); await start();
    assert.equal((await request(port, '/api/setup/status')).json.required, false);
    assert.equal((await request(port, '/api/login', { ...account, password: 'wrong-password' })).status, 401);
    const login = await request(port, '/api/login', account);
    assert.equal(login.status, 200, 'exact password must work after reading .env again');
    cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(port, '/api/session', undefined, cookie)).json.authenticated, true);
});
