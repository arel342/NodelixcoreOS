'use strict';

const net = require('node:net');

function parseIPv4(value) {
    const parts = value.split('.');
    if (parts.length !== 4) return null;
    let result = 0n;
    for (const part of parts) {
        if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        result = (result << 8n) | BigInt(octet);
    }
    return { version: 4, bits: 32, value: result, mapped: false };
}

function parseIPv6(value) {
    let text = value.toLowerCase().split('%')[0];
    if (text.includes('.')) {
        const lastColon = text.lastIndexOf(':');
        if (lastColon < 0) return null;
        const v4 = parseIPv4(text.slice(lastColon + 1));
        if (!v4) return null;
        const hi = Number((v4.value >> 16n) & 0xffffn).toString(16);
        const lo = Number(v4.value & 0xffffn).toString(16);
        text = text.slice(0, lastColon + 1) + hi + ':' + lo;
    }

    const halves = text.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    const groups = left.concat(Array(missing).fill('0'), right);
    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;

    let result = 0n;
    for (const group of groups) result = (result << 16n) | BigInt(parseInt(group, 16));
    const mapped = (result >> 32n) === 0xffffn;
    if (mapped) return { version: 4, bits: 32, value: result & 0xffffffffn, mapped: true };
    return { version: 6, bits: 128, value: result, mapped: false };
}

function parseIp(value) {
    const text = String(value || '').trim().replace(/^\[|\]$/g, '');
    const zoneFree = text.split('%')[0];
    const version = net.isIP(zoneFree);
    if (version === 4) return parseIPv4(zoneFree);
    if (version === 6) return parseIPv6(zoneFree);
    return null;
}

function parseCidr(entry) {
    const text = String(entry || '').trim();
    if (!text) throw new Error('CIDR kosong tidak valid.');
    const slash = text.lastIndexOf('/');
    const address = slash < 0 ? text : text.slice(0, slash);
    const parsed = parseIp(address);
    if (!parsed) throw new Error('Alamat IP/CIDR tidak valid: ' + text);

    let prefix = slash < 0 ? parsed.bits : Number(text.slice(slash + 1));
    if (!Number.isInteger(prefix)) throw new Error('Prefix CIDR tidak valid: ' + text);
    if (parsed.mapped) prefix -= 96;
    if (prefix < 0 || prefix > parsed.bits) throw new Error('Prefix CIDR di luar rentang: ' + text);
    const hostBits = BigInt(parsed.bits - prefix);
    const network = (parsed.value >> hostBits) << hostBits;
    return { version: parsed.version, bits: parsed.bits, prefix, network, source: text };
}

function parseAllowlist(value) {
    const entries = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!entries.length) throw new Error('LOCAL_ALLOWED_CIDRS harus mengizinkan minimal loopback.');
    const networks = entries.map(parseCidr);
    if (networks.some(item => item.prefix === 0)) {
        throw new Error('CIDR catch-all (/0) tidak diizinkan untuk server lokal.');
    }
    return networks;
}

function isAllowed(address, networks) {
    const ip = parseIp(address);
    if (!ip) return false;
    return networks.some(network => {
        if (network.version !== ip.version) return false;
        const hostBits = BigInt(ip.bits - network.prefix);
        return (ip.value >> hostBits) === (network.network >> hostBits);
    });
}

function createNetworkGuard(rawCidrs) {
    const networks = parseAllowlist(rawCidrs);
    return {
        networks,
        isAllowed: address => isAllowed(address, networks),
        middleware(req, res, next) {
            const address = req.socket && req.socket.remoteAddress;
            if (!isAllowed(address, networks)) {
                return res.status(403).json({
                    success: false,
                    error: 'Akses ditolak: alamat sumber tidak termasuk jaringan lokal yang diizinkan.',
                    message: 'Source address is not in the local network allowlist.'
                });
            }
            return next();
        }
    };
}

module.exports = { createNetworkGuard, parseAllowlist, parseCidr, parseIp, isAllowed };
