'use strict';
// Run the actual npm start entry point, not just tls.createServer(). Each server
// uses an isolated copy so tests never load a user's .env or modify their data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function request(port, url, { method = 'GET', cookie, body } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        if (body) headers['Content-Type'] = 'application/json';
        const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}

for (const explicitHttp of [false, true]) {
    test(`npm start: real HTTP server (${explicitHttp ? 'explicit config' : 'default config'})`, { timeout: 30000 }, async t => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-http-startup-'));
        let child;
        const sockets = new Set();
        t.after(async () => {
            for (const socket of sockets) socket.terminate();
            try {
                if (!child || !child.pid) return;
                try { process.kill(-child.pid, 'SIGTERM'); } catch { }
                if (child.exitCode !== null || child.signalCode !== null) return;
                const timer = setTimeout(() => {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch { }
                }, 3000);
                try { await once(child, 'exit'); } finally { clearTimeout(timer); }
            } finally {
                fs.rmSync(fixture, { recursive: true, force: true });
            }
        });
        // Copy modules rather than symlink them, so __dirname also points to the
        // isolated fixture for runtime data, credentials and settings.
        for (const entry of fs.readdirSync(ROOT)) {
            if (entry.endsWith('.js') || entry === 'package.json') {
                fs.copyFileSync(path.join(ROOT, entry), path.join(fixture, entry));
            }
        }
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
        fs.symlinkSync(path.join(ROOT, 'public'), path.join(fixture, 'public'), 'dir');
        const storage = path.join(fixture, 'storage');
        fs.mkdirSync(path.join(storage, 'upload'), { recursive: true });
        const port = await freePort();
        const env = {
            ...process.env, PORT: String(port),
            ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'http-startup-test-123',
            STORAGE_DEVICE: storage, STORAGE_MODE: 'direct', STORAGE_FOLDER: 'upload',
            SU_BIN: '/bin/sh', UPDATE_CHECK_ENABLED: 'false', AI_AGENT_ENABLED: 'false',
            TELEGRAM_ALERTS: 'false', TELEGRAM_BOT_TOKEN: '', GEMINI_API_KEY: '',
            TERMINAL_ENABLED: 'false', ESP32_IP: '', DOOR_IP: '', TRUST_PROXY: '',
            SESSION_TTL_HOURS: '1', MOBILE_SESSION_TTL_HOURS: '1',
            TLS_CERT_FILE: path.join(fixture, 'missing.crt'),
            TLS_KEY_FILE: path.join(fixture, 'missing.key')
        };
        delete env.TLS_ENABLED;
        delete env.TLS_ALLOW_HTTP;
        if (explicitHttp) {
            env.TLS_ENABLED = 'false';
            env.TLS_ALLOW_HTTP = 'true';
        }
        // A process group lets cleanup stop both npm and its node child.
        child = spawn('npm', ['start'], {
            cwd: fixture, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('npm start did not become ready:\n' + output)), 15000);
            const onData = () => {
                if (output.includes('[Web] Server aktif kembali di port')) finish();
            };
            const onExit = code => finish(new Error(`npm start exited (${code}):\n${output}`));
            const onError = error => finish(error);
            function finish(error) {
                clearTimeout(timer);
                child.stdout.off('data', onData);
                child.off('exit', onExit);
                child.off('error', onError);
                if (error) reject(error); else resolve();
            }
            child.stdout.on('data', onData);
            child.once('exit', onExit);
            child.once('error', onError);
        });

        const session = await request(port, '/api/session');
        assert.equal(session.status, 200);
        assert.equal(session.headers['strict-transport-security'], undefined);
        assert.equal((await request(port, '/api/system')).status, 401);
        const login = await request(port, '/api/login', {
            method: 'POST', body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }
        });
        assert.equal(login.status, 200, login.text);
        const setCookie = login.headers['set-cookie'][0];
        assert.match(setCookie, /^sid=[a-f0-9]{64};/);
        assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
        const cookie = setCookie.split(';')[0];
        assert.equal((await request(port, '/api/system', { cookie })).status, 200);

        // Exercise server.js's actual authenticated upgrade handler in both
        // directions, so attaching it to the wrong server cannot slip through.
        const denied = new WebSocket(`ws://127.0.0.1:${port}/`);
        sockets.add(denied);
        await new Promise((resolve, reject) => {
            denied.on('error', () => {});
            denied.once('open', () => reject(new Error('Unauthenticated WebSocket accepted')));
            denied.once('unexpected-response', (req, res) => {
                res.resume();
                denied.terminate();
                try { assert.equal(res.statusCode, 401); resolve(); } catch (error) { reject(error); }
            });
        });
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Cookie: cookie } });
        sockets.add(ws);
        await new Promise((resolve, reject) => {
            const received = new Set();
            ws.on('error', reject);
            ws.on('message', message => {
                try {
                    received.add(JSON.parse(message.toString()).type);
                    if (received.has('SENSOR') && received.has('DEVICE_COUNT')) resolve();
                } catch (error) { reject(error); }
            });
        });
        ws.close();
        await once(ws, 'close');
        assert.equal(child.exitCode, null, output);
        assert.doesNotMatch(output, /TypeError|uncaughtException/);
    });
}
