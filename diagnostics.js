// ============================================================================
// diagnostics.js — diagnosis perangkat yang jujur: fakta terukur vs dugaan.
//
// Aturan modul ini:
//   • Hanya melaporkan nilai yang benar-benar dibaca dari modul sistem/perangkat.
//   • Nilai yang tidak tersedia ditulis null, bukan dikarang.
//   • "possible_causes" adalah dugaan, bukan kesimpulan.
//   • Tidak pernah mengklaim perbaikan berhasil; pemeriksaan ulang harus dilakukan
//     pengguna (uji koneksi / lihat status berikutnya).
// ============================================================================
module.exports = function createDiagnostics({
    deps = {},
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    now = () => Date.now()
} = {}) {
    const age = ts => (Number.isFinite(ts) && ts > 0) ? Math.max(0, Math.round((now() - ts) / 1000)) : null;

    function classifyError(msg) {
        const s = String(msg || '');
        if (!s) return null;
        if (/timeout|timed out|aborted|ETIMEDOUT/i.test(s)) return { kind: 'timeout', text: 'Koneksi ke perangkat timeout.' };
        if (/401|403|unauthorized|forbidden|api key/i.test(s)) return { kind: 'auth', text: 'Kunci API perangkat ditolak (HTTP 401/403).' };
        if (/404|not found/i.test(s)) return { kind: 'route', text: 'Alamat/route firmware tidak ditemukan (HTTP 404).' };
        if (/ECONNREFUSED|refused/i.test(s)) return { kind: 'refused', text: 'Alamat/port menolak koneksi (ECONNREFUSED).' };
        if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(s)) return { kind: 'dns', text: 'Nama host perangkat tidak dapat diselesaikan (DNS).' };
        if (/EHOSTUNREACH|ENETUNREACH/i.test(s)) return { kind: 'unreachable', text: 'Jaringan menuju perangkat tidak dapat dijangkau.' };
        return { kind: 'other', text: s.slice(0, 200) };
    }

    function rssiQuality(rssi) {
        if (!Number.isFinite(rssi)) return null;
        if (rssi >= -60) return { level: 'sangat baik', dbm: rssi };
        if (rssi >= -70) return { level: 'baik', dbm: rssi };
        if (rssi >= -80) return { level: 'cukup', dbm: rssi };
        return { level: 'lemah', dbm: rssi };
    }

    function diagnoseEsp32() {
        const facts = {};
        const causes = [];
        const checks = [];
        const e = (deps.esp32 && typeof deps.esp32.snapshot === 'function') ? deps.esp32.snapshot() : null;
        if (!e) return { device: 'esp32', facts: { available: false }, possible_causes: ['Modul ESP32 tidak tersedia pada proses ini.'], checks, unverified: ['Tidak ada data perangkat yang bisa dibaca.'] };

        facts.configured = !!env('ESP32_IP', '');
        facts.address = env('ESP32_IP', '') ? `${env('ESP32_IP', '')}:${env('ESP32_PORT', '80')}` : null;
        facts.online = !!e.online;
        facts.last_reading_at = e.lastOk ? new Date(e.lastOk).toISOString() : null;
        facts.last_reading_age_sec = age(e.lastOk);
        facts.consecutive_failures = Number.isFinite(e.fails) ? e.fails : null;
        facts.last_error = e.lastError || null;
        facts.firmware = e.esp ? (e.esp.fw || null) : null;
        facts.wifi_rssi_dbm = e.esp && Number.isFinite(e.esp.rssi) ? e.esp.rssi : null;
        facts.wifi_quality = rssiQuality(facts.wifi_rssi_dbm);
        facts.relay_count = Array.isArray(e.relays) ? e.relays.length : null;

        if (!facts.configured) {
            causes.push('Alamat ESP32 (ESP32_IP) belum diisi.');
            checks.push('Isi IP ESP32 di Pengaturan > ESP32, lalu tekan "Uji koneksi".');
        } else if (!facts.online) {
            const c = classifyError(facts.last_error);
            if (c) causes.push(c.text);
            else causes.push('Perangkat tidak menjawab pada pembacaan terakhir.');
            if (c && c.kind === 'auth') checks.push('Samakan ESP32_API_KEY di Pengaturan dengan kunci di firmware/perangkat.');
            if (c && (c.kind === 'timeout' || c.kind === 'unreachable' || c.kind === 'refused')) checks.push('Pastikan ESP32 menyala, terhubung ke WiFi yang sama, dan IP/port benar.');
            if (c && c.kind === 'dns') checks.push('Gunakan alamat IP, atau pastikan mDNS (.local) didukung jaringan.');
            checks.push('Buka Pengaturan > ESP32 dan jalankan uji koneksi untuk memastikan hasilnya.');
        } else {
            const staleSec = Number(env('SENSOR_STALE_S', '120')) || 120;
            if (facts.last_reading_age_sec != null && facts.last_reading_age_sec > staleSec)
                causes.push(`Pembacaan terakhir lebih lama dari ${staleSec} detik; data dianggap kedaluwarsa.`);
            if (facts.wifi_quality && facts.wifi_quality.level === 'lemah')
                causes.push('RSSI WiFi lemah; koneksi bisa terputus-putus.');
            checks.push('Tidak ada tindakan yang diklaim berhasil. Awasi beberapa pembacaan berikutnya sebelum menyimpulkan normal.');
        }
        return {
            device: 'esp32', facts, possible_causes: causes, checks,
            unverified: [
                'Penyebab pasti tidak dapat ditentukan tanpa akses fisik/log perangkat.',
                'Diagnosis ini tidak melakukan perbaikan dan tidak mengubah pengaturan.'
            ]
        };
    }

    function diagnoseDoor() {
        const facts = {};
        const causes = [];
        const checks = [];
        const d = (deps.door && typeof deps.door.snapshot === 'function') ? deps.door.snapshot() : null;
        if (!d) return { device: 'door', facts: { available: false }, possible_causes: ['Modul pintu tidak tersedia.'], checks, unverified: [] };
        facts.configured = !!d.configured;
        facts.address = env('DOOR_IP', '') ? `${env('DOOR_IP', '')}:${env('DOOR_PORT', '80')}` : null;
        facts.online = !!d.online;
        facts.last_reading_at = d.lastOk ? new Date(d.lastOk).toISOString() : null;
        facts.last_reading_age_sec = age(d.lastOk);
        facts.consecutive_failures = Number.isFinite(d.fails) ? d.fails : null;
        facts.last_error = d.lastError || null;
        facts.rfid_enabled = !!d.enabled;
        facts.config_synced = !!d.synced;
        facts.door_open = !!d.open;
        facts.card_count = Array.isArray(d.cards) ? d.cards.length : null;
        facts.firmware = d.esp ? (d.esp.fw || null) : null;
        facts.wifi_rssi_dbm = d.esp && Number.isFinite(d.esp.rssi) ? d.esp.rssi : null;
        facts.wifi_quality = rssiQuality(facts.wifi_rssi_dbm);

        if (!facts.configured) {
            causes.push('Alamat ESP8266 pintu (DOOR_IP) belum diisi.');
            checks.push('Isi IP pintu di Pengaturan > Pintu RFID, lalu uji koneksi.');
        } else if (!facts.online) {
            const c = classifyError(facts.last_error);
            if (c) causes.push(c.text);
            if (c && c.kind === 'auth') checks.push('Samakan DOOR_API_KEY dengan kunci di firmware pintu.');
            checks.push('Pastikan ESP8266 menyala dan terhubung ke WiFi yang sama.');
        } else {
            if (!facts.config_synced) causes.push('Konfigurasi server dan perangkat belum sinkron (versi berbeda).');
            if (!facts.rfid_enabled) causes.push('Akses kartu RFID sedang dinonaktifkan.');
            checks.push('Jika kartu tidak membuka pintu, periksa daftar kartu dan status sinkronisasi.');
        }
        return {
            device: 'door', facts, possible_causes: causes, checks,
            unverified: ['Diagnosis tidak membuka/menutup pintu dan tidak mengubah data kartu.']
        };
    }

    async function diagnoseStorage() {
        const facts = {};
        const causes = [];
        const checks = [];
        let s = null;
        try { s = await deps.storage.status(); } catch (e) { facts.error = e.message; }
        if (!s) {
            return { device: 'storage', facts, possible_causes: ['Modul penyimpanan gagal membaca status.'], checks: ['Periksa log Termux untuk detail.'], unverified: [] };
        }
        facts.ready = !!s.ready;
        facts.mode = s.mode || null;
        facts.root = s.root || null;
        facts.total_bytes = s.total == null ? null : s.total;
        facts.free_bytes = s.free == null ? null : s.free;
        facts.message = s.message || null;
        if (!facts.ready) {
            causes.push(s.message || 'Penyimpanan belum siap.');
            if (s.mode !== 'direct') causes.push('Mode root (su) mungkin tidak tersedia/ditolak; flash disk tidak dapat diakses.');
            checks.push('Pastikan flash disk terpasang, lalu muat ulang halaman Storage/status.');
        } else {
            if (facts.free_bytes != null && facts.total_bytes) {
                const pct = Math.round((facts.free_bytes / facts.total_bytes) * 100);
                facts.free_percent = pct;
                if (pct < 5) causes.push('Ruang kosong flash disk tersisa kurang dari 5%.');
            }
            checks.push('Status ini hanya pembacaan; tidak ada perbaikan yang dilakukan.');
        }
        return { device: 'storage', facts, possible_causes: causes, checks, unverified: ['Penyebab kegagalan I/O fisik tidak dapat dipastikan dari aplikasi.'] };
    }

    function diagnoseWeb() {
        const running = typeof deps.isWebEnabled === 'function' ? !!deps.isWebEnabled() : null;
        const facts = { running, port: Number(env('PORT', '3000')) || null, session_ttl_hours: Number(env('SESSION_TTL_HOURS', '24')) || null };
        const causes = [];
        const checks = [];
        if (running === false) {
            causes.push('Web/WebSocket sedang dimatikan (mis. melalui perintah /web off di Telegram).');
            checks.push('Kirim /web on melalui bot Telegram, lalu buka alamat server lagi.');
        } else if (running) {
            checks.push('Jika halaman tidak terbuka, periksa alamat IP:port, jaringan WiFi, dan firewall Android.');
        }
        return { device: 'web', facts, possible_causes: causes, checks, unverified: ['Diagnosis tidak mengubah status web.'] };
    }

    async function diagnose(device) {
        switch (device) {
            case 'esp32': return diagnoseEsp32();
            case 'door': return diagnoseDoor();
            case 'storage': return diagnoseStorage();
            case 'web': return diagnoseWeb();
            default: throw Object.assign(new Error('Perangkat tidak dikenal. Gunakan esp32, door, storage, atau web.'), { status: 400 });
        }
    }

    return { diagnose, classifyError, rssiQuality };
};
