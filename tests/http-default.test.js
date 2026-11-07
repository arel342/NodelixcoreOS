'use strict';
// Default transport must serve HTTP/WS without certificates, including web cookies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const WebSocket = require('ws');
const tls = require('../tls');
const createAuth = require('../auth');

function request(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
    });
}

test('HTTP default: no certificates, session cookie works, WebSocket uses ws', async t => {
    const saved = new Map(['TLS_ENABLED', 'TLS_ALLOW_HTTP', 'TLS_CERT_FILE', 'TLS_KEY_FILE'].map(k => [k, process.env[k]]));
    t.after(() => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    delete process.env.TLS_ENABLED;
    delete process.env.TLS_ALLOW_HTTP;
    process.env.TLS_CERT_FILE = '/nonexistent/nodelix-test.crt';
    process.env.TLS_KEY_FILE = '/nonexistent/nodelix-test.key';
    assert.equal(tls.isEnabled(), false);
    assert.equal(tls.allowHttp(), true);
    assert.equal(tls.scheme(), 'http');
    assert.deepEqual(tls.describe(), { enabled: false, scheme: 'http', httpsRequired: false });
    assert.equal(tls.load(), null);

    const app = express();
    const auth = createAuth({ env: (key, fallback) => fallback, log: () => {} });
    app.get('/login', (req, res) => {
        auth.createSession(res, { secure: req.secure });
        res.json({ secure: req.secure });
    });
    app.get('/private', auth.requireAuth, (req, res) => res.json({ success: true }));
    const server = tls.createServer(app, { requestTimeout: 900000, headersTimeout: 60000, keepAliveTimeout: 5000 });
    assert.equal(server.requestTimeout, 900000);
    assert.equal(server.headersTimeout, 60000);
    assert.equal(server.keepAliveTimeout, 5000);
    const wss = new WebSocket.Server({ server });
    wss.on('connection', socket => socket.send('ready'));
    t.after(async () => {
        for (const socket of wss.clients) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const login = await request(port, '/login');
    assert.equal(login.status, 200);
    assert.equal(JSON.parse(login.body).secure, false);
    assert.equal(login.headers['strict-transport-security'], undefined);
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /^sid=[a-f0-9]{64};/);
    assert.doesNotMatch(cookie, /; Secure(?:;|$)/);
    const privateResponse = await request(port, '/private', { Cookie: cookie.split(';')[0] });
    assert.equal(privateResponse.status, 200);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const [message] = await once(ws, 'message');
    assert.equal(message.toString(), 'ready');
    ws.close();
    await once(ws, 'close');

    process.env.TLS_ALLOW_HTTP = 'false';
    assert.throws(() => tls.createServer(app), { code: 'HTTP_FORBIDDEN' });
    process.env.TLS_ENABLED = 'true';
    assert.equal(tls.scheme(), 'https');
    assert.throws(() => tls.createServer(app), { code: 'CERT_MISSING' });
});
