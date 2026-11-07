'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const https = require('node:https');

let cached;

function ensureLocalTls() {
    if (cached) return cached;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodelix-test-tls-'));
    const run = args => execFileSync('openssl', args, { stdio: 'pipe' });
    const caKey = path.join(dir, 'test-root.key');
    const caCert = path.join(dir, 'test-root.crt');
    const serverKey = path.join(dir, 'test-server.key');
    const csr = path.join(dir, 'test-server.csr');
    const serverCert = path.join(dir, 'test-server.crt');
    const config = path.join(dir, 'server-san.cnf');

    try {
        run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
        fs.chmodSync(caKey, 0o600);
        run([
            'req', '-x509', '-new', '-key', caKey, '-sha256', '-days', '2',
            '-out', caCert, '-subj', '/CN=Nodelix Test Root CA',
            '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
        ]);
        run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', serverKey]);
        fs.chmodSync(serverKey, 0o600);

        fs.writeFileSync(config, [
            '[ req ]',
            'prompt = no',
            'distinguished_name = dn',
            'req_extensions = request_ext',
            '',
            '[ dn ]',
            'CN = localhost',
            '',
            '[ request_ext ]',
            'subjectAltName = @alt_names',
            '',
            '[ server_cert ]',
            'basicConstraints = critical,CA:FALSE',
            'keyUsage = critical,digitalSignature,keyEncipherment',
            'extendedKeyUsage = serverAuth',
            'subjectAltName = @alt_names',
            '',
            '[ alt_names ]',
            'DNS.1 = localhost',
            'IP.1 = 127.0.0.1',
            'IP.2 = ::1',
            ''
        ].join('\n'));
        run(['req', '-new', '-key', serverKey, '-out', csr, '-config', config]);
        run([
            'x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey,
            '-CAcreateserial', '-out', serverCert, '-days', '2', '-sha256',
            '-extfile', config, '-extensions', 'server_cert'
        ]);

        cached = {
            dir,
            certPath: serverCert,
            keyPath: serverKey,
            caPath: caCert,
            ca: fs.readFileSync(caCert),
            serverEnv: {
                TLS_CERT_PATH: serverCert,
                TLS_KEY_PATH: serverKey,
                TLS_CA_CERT_PATH: caCert,
                TLS_SERVER_NAMES: 'localhost,127.0.0.1,::1',
                LOCAL_ALLOWED_CIDRS: '127.0.0.1/32,::1/128',
                BIND_HOST: '127.0.0.1'
            }
        };
        return cached;
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error('Gagal membuat sertifikat TLS sementara untuk tes. Pastikan OpenSSL tersedia: ' + error.message);
    }
}

function httpsFetch(input, options = {}) {
    const tlsConfig = ensureLocalTls();
    const url = new URL(input);
    if (url.protocol !== 'https:') throw new Error('Test helper hanya mengizinkan HTTPS.');
    const body = options.body == null ? null : options.body;
    const headers = { ...(options.headers || {}) };

    return new Promise((resolve, reject) => {
        const request = https.request({
            protocol: 'https:',
            hostname: url.hostname,
            port: url.port || 443,
            method: options.method || 'GET',
            path: url.pathname + url.search,
            headers,
            ca: tlsConfig.ca,
            rejectUnauthorized: true,
            servername: netHostname(url.hostname)
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('error', reject);
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const responseHeaders = new Headers(response.headers);
                resolve({
                    status: response.statusCode,
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    headers: responseHeaders,
                    text: async () => text,
                    json: async () => JSON.parse(text)
                });
            });
        });
        request.on('error', reject);
        if (body != null) request.write(body);
        request.end();
    });
}

function netHostname(host) {
    // SNI is a DNS extension and must not be populated with an IP literal.
    return require('node:net').isIP(host) ? undefined : host;
}

module.exports = { ensureLocalTls, httpsFetch };
