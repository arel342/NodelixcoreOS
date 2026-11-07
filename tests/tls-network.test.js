'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ensureLocalTls } = require('./helpers/local-tls');
const { loadTlsOptions, MIN_TLS_VERSION } = require('../tls-config');
const { createNetworkGuard, parseCidr, parseIp, isAllowed } = require('../network-allowlist');
const TEST_TLS = ensureLocalTls();

const testEnv = overrides => (key, fallback) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;

test('TLS config: valid Root CA, certificate, key, and SAN are accepted', () => {
    const options = loadTlsOptions(testEnv(TEST_TLS.serverEnv));
    assert.equal(options.minVersion, MIN_TLS_VERSION);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.ok(options.key);
    assert.ok(options.cert);
});

test('TLS config: a hostname absent from SAN is rejected', () => {
    assert.throws(
        () => loadTlsOptions(testEnv({ ...TEST_TLS.serverEnv, TLS_SERVER_NAMES: 'wrong-name.example' })),
        /SAN sertifikat tidak mencakup/
    );
});

test('TLS config: missing certificate settings fail closed', () => {
    assert.throws(
        () => loadTlsOptions(testEnv({ TLS_CERT_PATH: '', TLS_KEY_PATH: '', TLS_CA_CERT_PATH: '' })),
        /TLS_CERT_PATH wajib diisi/
    );
});

test('TLS config: expired server certificates are rejected', () => {
    const threeDaysAhead = Date.now() + 3 * 24 * 60 * 60 * 1000;
    assert.throws(
        () => loadTlsOptions(testEnv(TEST_TLS.serverEnv), threeDaysAhead),
        /Sertifikat server belum berlaku atau sudah kedaluwarsa/
    );
});

test('TLS config: symbolic-link key paths are rejected', t => {
    if (process.platform === 'win32') return t.skip('Symlink test memerlukan dukungan symlink POSIX.');
    const linkedKey = path.join(TEST_TLS.dir, 'server-key-link');
    fs.symlinkSync(TEST_TLS.keyPath, linkedKey);
    assert.throws(
        () => loadTlsOptions(testEnv({ ...TEST_TLS.serverEnv, TLS_KEY_PATH: linkedKey })),
        /harus berupa file biasa, bukan symlink/
    );
});

test('TLS config: a server private key with group/other permissions is rejected', t => {
    if (process.platform === 'win32') return t.skip('Mode POSIX tidak tersedia di Windows.');
    const tooOpen = path.join(TEST_TLS.dir, 'too-open.key');
    fs.copyFileSync(TEST_TLS.keyPath, tooOpen);
    fs.chmodSync(tooOpen, 0o644);
    assert.throws(
        () => loadTlsOptions(testEnv({ ...TEST_TLS.serverEnv, TLS_KEY_PATH: tooOpen })),
        /Permission private key server terlalu terbuka/
    );
    fs.chmodSync(tooOpen, 0o600);
});

test('TLS config: a mismatched private key is rejected', () => {
    const mismatched = path.join(TEST_TLS.dir, 'mismatched.key');
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', mismatched]);
    fs.chmodSync(mismatched, 0o600);
    assert.throws(
        () => loadTlsOptions(testEnv({ ...TEST_TLS.serverEnv, TLS_KEY_PATH: mismatched })),
        /Private key server tidak cocok/
    );
});

test('network allowlist: IPv4 CIDR only permits members of the subnet', () => {
    const guard = createNetworkGuard('192.168.50.0/24');
    assert.equal(guard.isAllowed('192.168.50.1'), true);
    assert.equal(guard.isAllowed('192.168.50.254'), true);
    assert.equal(guard.isAllowed('192.168.51.1'), false);
    assert.equal(guard.isAllowed('8.8.8.8'), false);
});

test('network allowlist: IPv6 CIDR permits the configured subnet only', () => {
    const guard = createNetworkGuard('fd12:3456:789a::/64');
    assert.equal(guard.isAllowed('fd12:3456:789a::1'), true);
    assert.equal(guard.isAllowed('fd12:3456:789a::ffff'), true);
    assert.equal(guard.isAllowed('fd12:3456:789b::1'), false);
});

test('network allowlist: IPv4-mapped IPv6 client addresses match IPv4 rules', () => {
    const guard = createNetworkGuard('127.0.0.1/32');
    assert.equal(guard.isAllowed('::ffff:127.0.0.1'), true);
    assert.equal(guard.isAllowed('::ffff:127.0.0.2'), false);
});

test('network allowlist: loopback defaults are valid and external sources are denied', () => {
    const guard = createNetworkGuard('127.0.0.1/32,::1/128');
    assert.equal(guard.isAllowed('127.0.0.1'), true);
    assert.equal(guard.isAllowed('::1'), true);
    assert.equal(guard.isAllowed('192.168.1.20'), false);
});

test('network allowlist: empty, invalid, and catch-all CIDRs are rejected', () => {
    assert.throws(() => createNetworkGuard(''), /minimal loopback/);
    assert.throws(() => createNetworkGuard('not-an-ip/24'), /Alamat IP\/CIDR tidak valid/);
    assert.throws(() => createNetworkGuard('0.0.0.0/0'), /catch-all/);
    assert.throws(() => createNetworkGuard('::/0'), /catch-all/);
    assert.throws(() => createNetworkGuard('8.8.8.8/32'), /hanya boleh berisi subnet private/);
    assert.throws(() => createNetworkGuard('2001:4860::/32'), /hanya boleh berisi subnet private/);
    assert.throws(() => parseCidr('192.168.1.1/33'), /Prefix CIDR di luar rentang/);
    assert.equal(parseIp('invalid'), null);
    assert.equal(isAllowed('not-an-ip', [parseCidr('127.0.0.1/32')]), false);
});
