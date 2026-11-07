'use strict';
// HTTP-only transport regression: no certificate module or TLS configuration is required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const WebSocket = require('ws');
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

test('HTTP only: session cookie works and WebSocket uses ws without certificates', async t => {
    const app = express();
    const auth = createAuth({ env: (key, fallback) => fallback, log: () => {} });
    app.get('/login', (req, res) => {
        auth.createSession(res, { secure: false });
        res.json({ secure: false });
    });
    app.get('/private', auth.requireAuth, (req, res) => res.json({ success: true }));

    const server = http.createServer(app);
    server.requestTimeout = 900000;
    server.headersTimeout = 60000;
    server.keepAliveTimeout = 5000;
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
});
