// ============================================================================
// relay-map.js — pemetaan relay ESP32 (satu sumber untuk validasi backend).
//
// Pemetaan perangkat TIDAK diubah dari versi sebelumnya:
//   Relay 1 & 2 -> GPIO 26 (kanal HTTP 1, satu grup)
//   Relay 3     -> GPIO 27 (kanal HTTP 2)
//   Relay 4     -> GPIO 32 (kanal HTTP 3)
// esp32.js tetap menjadi pemilik pemetaan kanal; modul ini hanya menormalkan
// id/alias yang dikirim model agar target divalidasi SEBELUM perangkat disentuh.
// ============================================================================
const RELAYS = [
    { id: 1, ch: 1, pin: 26, name: 'Relay 1 & 2' },
    { id: 3, ch: 2, pin: 27, name: 'Relay 3' },
    { id: 4, ch: 3, pin: 32, name: 'Relay 4' }
];

const GROUP_ID = '1&2';               // hasil normalisasi untuk grup Relay 1 & 2

function labels(env) {
    const raw = String(env('RELAY_LABELS', '') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!raw.length) return RELAYS.map(r => r.name);
    if (raw.every(s => /^relay\s*\d+(\s*[&,-]\s*\d+)?$/i.test(s))) return RELAYS.map(r => r.name);
    if (raw.length === 4) return [`${raw[0]} & ${raw[1]}`, raw[2], raw[3]];
    return raw;
}

// Nilai balik: 'all' | '1&2' | 3 | 4 | null. `null` = target tidak dikenal.
function normalizeRelayId(value, env = () => '') {
    const s = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    if (s === 'all' || s === 'semua' || s === 'semua relay') return 'all';
    if (/^(?:r(?:elay)?\s*)?1\s*[&,+-]\s*2$/.test(s)) return GROUP_ID;
    if (/^(?:r(?:elay)?\s*)?1$/.test(s) || /^(?:r(?:elay)?\s*)?2$/.test(s)) return GROUP_ID;
    const gpio = /^(?:gpio|pin)\s*(\d+)$/.exec(s);
    if (gpio) {
        const p = Number(gpio[1]);
        if (p === 26) return GROUP_ID;
        if (p === 27) return 3;
        if (p === 32) return 4;
        return null;
    }
    const plain = /^(?:r(?:elay)?\s*)?(\d+)$/.exec(s);
    if (plain) {
        const n = Number(plain[1]);
        if (n === 1 || n === 2 || n === 26) return GROUP_ID;
        if (n === 3 || n === 27) return 3;
        if (n === 4 || n === 32) return 4;
        return null;
    }
    // Nama relay dari RELAY_LABELS (mis. "Lampu Teras")
    const names = labels(env);
    const idx = names.map(n => n.toLowerCase()).indexOf(s);
    if (idx === 0) return GROUP_ID;
    if (idx === 1) return 3;
    if (idx === 2) return 4;
    return null;
}

function describeRelay(id) {
    if (id === 'all') return 'semua relay';
    if (id === GROUP_ID) return 'Relay 1 & 2 (GPIO 26)';
    const r = RELAYS.find(x => x.id === id);
    return r ? `${r.name} (GPIO ${r.pin})` : String(id);
}

module.exports = { RELAYS, GROUP_ID, labels, normalizeRelayId, describeRelay };
