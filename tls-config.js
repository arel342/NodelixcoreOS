'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const tls = require('node:tls');

const MIN_TLS_VERSION = 'TLSv1.2';

function configurationError(message) {
    const error = new Error(message);
    error.code = 'TLS_CONFIG_INVALID';
    return error;
}

function configuredPath(env, key) {
    const value = String(env(key, '') || '').trim();
    if (!value) throw configurationError(key + ' wajib diisi; server tidak akan berjalan melalui HTTP.');
    return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

function readPem(file, label, privateKey) {
    let initial;
    try {
        initial = fs.lstatSync(file);
    } catch {
        throw configurationError(label + ' tidak ditemukan: ' + file);
    }
    if (initial.isSymbolicLink() || !initial.isFile()) {
        throw configurationError(label + ' harus berupa file biasa, bukan symlink: ' + file);
    }

    let fd;
    try {
        const noFollow = fs.constants.O_NOFOLLOW || 0;
        fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
        const opened = fs.fstatSync(fd);
        // Detect replacement between lstat() and open(), including symlink swaps.
        if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
            throw configurationError(label + ' berubah saat dibuka; gunakan file biasa yang stabil.');
        }
        if (privateKey && process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
            throw configurationError('Permission ' + label + ' terlalu terbuka; gunakan chmod 600 pada file private key.');
        }
        return fs.readFileSync(fd);
    } catch (error) {
        if (error && error.code === 'TLS_CONFIG_INVALID') throw error;
        throw configurationError(label + ' tidak dapat dibaca sebagai file biasa: ' + file);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { }
        }
    }
}

function assertCurrentlyValid(cert, label, now) {
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to) {
        throw configurationError(label + ' belum berlaku atau sudah kedaluwarsa.');
    }
}

function validateServerNames(cert, rawNames) {
    const names = String(rawNames || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!names.length) {
        throw configurationError('TLS_SERVER_NAMES wajib berisi hostname/IP LAN yang tercantum pada SAN sertifikat.');
    }
    for (const name of names) {
        const normalized = name.replace(/^\[|\]$/g, '');
        const matched = net.isIP(normalized) ? cert.checkIP(normalized) : cert.checkHost(normalized);
        if (!matched) throw configurationError('SAN sertifikat tidak mencakup TLS_SERVER_NAMES: ' + name);
    }
    return names;
}

function loadTlsOptions(env = (key, fallback) => process.env[key] || fallback, now = Date.now()) {
    const certPath = configuredPath(env, 'TLS_CERT_PATH');
    const keyPath = configuredPath(env, 'TLS_KEY_PATH');
    const caPath = configuredPath(env, 'TLS_CA_CERT_PATH');

    const certPem = readPem(certPath, 'sertifikat server', false);
    const keyPem = readPem(keyPath, 'private key server', true);
    const caPem = readPem(caPath, 'sertifikat publik Root CA', false);

    let serverCert;
    let rootCert;
    let privateKey;
    try {
        serverCert = new crypto.X509Certificate(certPem);
        rootCert = new crypto.X509Certificate(caPem);
        privateKey = crypto.createPrivateKey(keyPem);
    } catch {
        throw configurationError('PEM sertifikat atau private key tidak valid.');
    }

    assertCurrentlyValid(serverCert, 'Sertifikat server', now);
    assertCurrentlyValid(rootCert, 'Root CA', now);

    if (!rootCert.ca || rootCert.subject !== rootCert.issuer || !rootCert.verify(rootCert.publicKey)) {
        throw configurationError('TLS_CA_CERT_PATH harus menunjuk Root CA self-signed yang valid.');
    }
    if (serverCert.issuer !== rootCert.subject || !serverCert.verify(rootCert.publicKey)) {
        throw configurationError('Sertifikat server tidak diterbitkan langsung oleh Root CA yang dikonfigurasi.');
    }
    if (serverCert.ca) {
        throw configurationError('Sertifikat server harus berupa leaf certificate, bukan sertifikat CA.');
    }
    const SERVER_AUTH_EKU = '1.3.6.1.5.5.7.3.1';
    if (!Array.isArray(serverCert.keyUsage) || !serverCert.keyUsage.includes(SERVER_AUTH_EKU)) {
        throw configurationError('Extended Key Usage sertifikat server wajib memuat serverAuth.');
    }
    if (!serverCert.subjectAltName) {
        throw configurationError('Sertifikat server wajib memiliki Subject Alternative Name (SAN).');
    }

    const privatePublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const certificatePublic = serverCert.publicKey.export({ type: 'spki', format: 'der' });
    const rootPublic = rootCert.publicKey.export({ type: 'spki', format: 'der' });
    if (!privatePublic.equals(certificatePublic)) {
        throw configurationError('Private key server tidak cocok dengan sertifikat server.');
    }
    if (privatePublic.equals(rootPublic)) {
        throw configurationError('Private key server harus berbeda dari private key Root CA.');
    }

    validateServerNames(serverCert, env('TLS_SERVER_NAMES', ''));
    try {
        tls.createSecureContext({ key: keyPem, cert: certPem, minVersion: MIN_TLS_VERSION });
    } catch {
        throw configurationError('Pasangan sertifikat/private key tidak dapat digunakan untuk TLS.');
    }

    return {
        key: keyPem,
        cert: certPem,
        minVersion: MIN_TLS_VERSION,
        honorCipherOrder: true
    };
}

module.exports = { loadTlsOptions, MIN_TLS_VERSION };
