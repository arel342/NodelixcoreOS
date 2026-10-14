// Isolated tests: no hardware, running server, or real data/door.json writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const T = require('../lang');
const UID = '11223344';
const PASSWORD = ' dashboard secret ';
const response = () => ({ code: 200, status(n) { this.code = n; return this; }, json(j) { this.body = j; return this; } });

function passwordVerifier() {
    // Exercise the actual callback passed by server.js, including the login attempt limiter.
    const body = source('server.js').split('function verifyDashboardPassword(req, res) {')[1].split('\n}\n')[0];
    const env = { ADMIN_PASSWORD: PASSWORD };
    const fails = new Map();
    const sha = s => crypto.createHash('sha256').update(String(s)).digest();
    const verify = vm.runInNewContext(`(function(req, res) {${body}\n})`, {
        fails, T, env: k => env[k] || '', same: (a, b) => crypto.timingSafeEqual(sha(a), sha(b))
    });
    return { verify, env, fails };
}

function fixture(saved) {
    let disk = saved || JSON.stringify({ ver: 1, enabled: true, openSec: 5, cards: [
        { uid: UID, name: 'Owner', added: 1, last: null }, { uid: '55667788', name: 'Guest' }
    ], log: [] });
    const routes = {}, timers = new Map(), messages = [], requests = [];
    const auth = passwordVerifier();
    let id = 0;
    const fakeFs = {
        readFileSync: () => disk, mkdirSync() {}, renameSync() {}, writeFileSync: (_, data) => { disk = data; }
    };
    const context = {
        module: { exports: {} }, __dirname: root,
        require: n => n === 'fs' ? fakeFs : n === './lang' ? T : n === './fwstate' ? require('../fwstate') : require(n),
        process: { env: { DOOR_IP: 'device.test' } }, console, AbortSignal,
        setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; },
        clearTimeout: i => timers.delete(i),
        fetch: async (url, options) => {
            requests.push({ url, ...options });
            const data = url.endsWith('/api/status')
                ? { ver: 1, boot: 1, events: [], enroll: 0 }
                : { ver: Number(/^V=(\d+)/.exec(options.body)[1]) };
            return { ok: true, json: async () => data };
        }
    };
    vm.runInNewContext(source('door.js'), context);
    const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, fn) => { routes[method + ' ' + url] = fn; }]));
    const door = context.module.exports({ app, broadcast: msg => messages.push(JSON.stringify(msg)), notify() {}, verifyDashboardPassword: auth.verify });
    return {
        door, auth, requests, messages,
        async request(method, url, body, params = {}) {
            const res = response();
            await routes[method + ' ' + url]({ body, params, ip: 'test-client' }, res);
            return res;
        },
        async online() { door.start(); await new Promise(resolve => setImmediate(resolve)); },
        persisted() { for (const t of timers.values()) if (t.ms === 150) t.fn(); return disk; }
    };
}

test('promotion requires the current dashboard password; throttles repeated failures', async () => {
    const f = fixture();
    for (const password of [undefined, '', 'wrong', { value: PASSWORD }, 'wrong-again']) {
        const r = await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password });
        assert.equal(r.code, 403);
        assert.notEqual(f.door.snapshot().cards[0].admin, true);
    }
    assert.equal((await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: PASSWORD })).code, 429);
    f.auth.fails.clear();
    f.auth.env.ADMIN_PASSWORD = 'new-password';
    assert.equal((await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: PASSWORD })).code, 403);
    assert.equal((await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: 'new-password' })).body.success, true);
});

test('promotion persists offline, survives restart, and never persists/broadcasts password', async () => {
    const f = fixture();
    const r = await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: PASSWORD });
    assert.equal(r.body.success, true);
    assert.equal(r.body.synced, false);
    assert.equal(f.door.snapshot().cards[0].admin, true);
    const saved = f.persisted();
    assert.equal(fixture(saved).door.snapshot().cards[0].admin, true);
    assert.ok(!saved.includes(PASSWORD));
    assert.ok(!f.messages.join('').includes(PASSWORD));
});

test('sync distinguishes admin/regular cards, including when lock is disabled; revocation keeps card', async () => {
    const f = fixture();
    await f.online();
    const r = await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: PASSWORD });
    assert.equal(r.body.synced, true);
    await f.door.setEnabled(false);
    let sync = f.requests.filter(r => r.url.endsWith('/api/sync')).at(-1).body;
    assert.match(sync, /E=0\nA=11223344\nC=55667788\n/);
    assert.ok(!sync.includes(PASSWORD));
    await f.request('post', '/api/door/cards/rename', { uid: UID, name: 'New owner' });
    assert.equal(f.door.snapshot().cards[0].admin, true);
    await f.request('post', '/api/door/cards/admin', { uid: UID, admin: false });
    assert.equal(f.door.snapshot().cards.length, 2);
    assert.equal(f.door.snapshot().cards[0].name, 'New owner');
    assert.equal(f.door.snapshot().cards[0].admin, false);
    sync = f.requests.filter(r => r.url.endsWith('/api/sync')).at(-1).body;
    assert.match(sync, /E=0\nC=11223344\nC=55667788\n/);
    await f.request('delete', '/api/door/cards/:uid', undefined, { uid: UID });
    assert.equal(f.door.snapshot().cards.length, 1);
});

test('invalid card/status and unset dashboard password cannot grant admin', async () => {
    const f = fixture();
    assert.equal((await f.request('post', '/api/door/cards/admin', { uid: 'AAAAAAAA', admin: true, password: PASSWORD })).code, 404);
    for (const admin of ['true', 1, null, undefined]) {
        assert.equal((await f.request('post', '/api/door/cards/admin', { uid: UID, admin, password: PASSWORD })).code, 400);
    }
    f.auth.env.ADMIN_PASSWORD = '';
    assert.equal((await f.request('post', '/api/door/cards/admin', { uid: UID, admin: true, password: '' })).code, 403);
});
