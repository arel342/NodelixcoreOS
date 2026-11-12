'use strict';
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function findTailscaleBin() {
    const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of pathDirs) {
        const p = path.join(d, 'tailscale');
        if (fs.existsSync(p)) return p;
    }
    return 'tailscale';
}

function tailscaleStatus() {
    return new Promise(resolve => {
        const bin = findTailscaleBin();
        execFile(bin, ['status', '--json'], { timeout: 10000, maxBuffer: 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve({ ok: false, error: err.message });
                try {
                    const data = JSON.parse(stdout);
                    const self = data.Self || {};
                    const ip = (self.TailscaleIPs && self.TailscaleIPs[0]) || (self.DNSName || '');
                    resolve({
                        ok: true,
                        online: self.Online !== undefined ? self.Online : null,
                        backendState: data.BackendState || null,
                        tailscaleIp: ip,
                        dnsName: self.DNSName || null
                    });
                } catch (e) { resolve({ ok: false, error: e.message }); }
            });
    });
}

function tailscaleIp() {
    return new Promise(resolve => {
        const bin = findTailscaleBin();
        execFile(bin, ['ip', '-4'], { timeout: 8000, maxBuffer: 16384 }, (err, stdout) => {
            if (err) return resolve(null);
            const ip = String(stdout || '').trim();
            resolve(ip || null);
        });
    });
}

function tailscaleOrigin(envMap = {}) {
    const env = envMap || process.env;
    const explicit = String(env.TAILSCALE_ORIGIN || '').trim();
    if (explicit) return explicit;
    const ip = String(env.TAILSCALE_IP || '').trim();
    if (ip) {
        const port = env.TAILSCALE_PORT || env.PORT || '3000';
        return `http://${ip}:${port}`;
    }
    return null;
}

module.exports = { findTailscaleBin, tailscaleStatus, tailscaleIp, tailscaleOrigin };
