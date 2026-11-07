// ============================================================================
// locks.js — antrean per kunci (mutex async).
//
// Dipakai agar perubahan status pada perangkat yang sama dijalankan berurutan:
// relay ESP32, pintu RFID, operasi storage, dan web. Dua permintaan (web + AI +
// jadwal) tidak saling menimpa `db.ver` atau menembak relay bersamaan.
// ============================================================================
function createLocks() {
    const chains = new Map();
    const depth = new Map();

    function run(key, fn) {
        const k = String(key || 'default');
        const prev = chains.get(k) || Promise.resolve();
        const next = prev.then(() => fn());
        // Rantai internal tidak boleh berhenti karena satu tugas gagal.
        const tail = next.then(() => { }, () => { });
        chains.set(k, tail);
        depth.set(k, (depth.get(k) || 0) + 1);
        tail.then(() => {
            const left = (depth.get(k) || 1) - 1;
            if (left <= 0) { depth.delete(k); if (chains.get(k) === tail) chains.delete(k); }
            else depth.set(k, left);
        });
        return next;
    }

    return {
        run,
        busy: key => (depth.get(String(key || 'default')) || 0) > 0,
        keys: () => [...depth.keys()]
    };
}

module.exports = { createLocks };
