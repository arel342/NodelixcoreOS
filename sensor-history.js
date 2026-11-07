// ============================================================================
// sensor-history.js — riwayat sensor ringan (timestamp, retensi, agregasi).
//
// esp32.js yang memanggil ingest() tiap polling. Data disimpan seminimal mungkin:
// suhu, kelembapan, tegangan pack, SoC, arus, dan status online. Sampling dibatasi
// (default tiap 15 detik) dan jumlah titik dibatasi supaya cocok untuk server HP.
//
// Grafik dashboard yang lama (esp32.history 300 sampel) TIDAK diubah; modul ini
// menambah riwayat untuk skill get_sensor_history dan automasi.
//
// Persistensi opsional (SENSOR_HISTORY_PERSIST=true), ditulis atomik tiap 30 detik,
// dibatasi ukuran, dan tidak pernah berisi kredensial.
// ============================================================================
const fs = require('fs');
const path = require('path');

const FIELDS = {
    temperature: 'temp',
    humidity: 'hum',
    battery_soc: 'soc',
    battery_voltage: 'battery',
    current: 'current',
    rssi: 'rssi'
};
const METRIC_NAMES = Object.keys(FIELDS);

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round(v, d = 2) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d; }

module.exports = function createSensorHistory({
    env = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k],
    file = path.join(__dirname, 'data', 'sensor-history.json'),
    now = () => Date.now(),
    log = console.log
} = {}) {
    const retentionHours = () => clamp(Number(env('SENSOR_HISTORY_HOURS', '24')) || 24, 1, 168);
    const maxPoints = () => Math.floor(clamp(Number(env('SENSOR_HISTORY_MAX_POINTS', '6000')) || 6000, 100, 20000));
    const minIntervalMs = () => clamp(Number(env('SENSOR_HISTORY_MIN_INTERVAL_S', '15')) || 15, 1, 3600) * 1000;
    const persist = () => String(env('SENSOR_HISTORY_PERSIST', 'false')).toLowerCase() === 'true';

    let points = [];             // [{t, online, temp, hum, battery, soc, current, rssi}]
    let lastIngestAt = 0;
    let dirty = false;
    let lastError = '';

    const cutoff = () => now() - retentionHours() * 3600 * 1000;

    function trim() {
        const c = cutoff();
        if (points.length && points[0].t < c) points = points.filter(p => p.t >= c);
        const max = maxPoints();
        if (points.length > max) points = points.slice(points.length - max);
    }

    function load() {
        if (!persist()) return;
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(raw)) {
                points = raw.filter(p => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
                trim();
            }
        } catch { }
    }

    function saveNow() {
        if (!persist() || !dirty) return;
        dirty = false;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(points), { mode: 0o600 });
            fs.renameSync(tmp, file);
            lastError = '';
        } catch (e) {
            lastError = e.message;
            log('[Sensor] gagal menyimpan riwayat: ' + e.message);
        }
    }

    const timer = setInterval(saveNow, 30000);
    if (timer.unref) timer.unref();

    // Terima satu sampel. Nilai yang tidak tersedia disimpan null (bukan dikarang).
    function ingest(point = {}) {
        const t = Number.isFinite(point.t) ? point.t : now();
        if (lastIngestAt && t - lastIngestAt < minIntervalMs()) return false;
        const rec = {
            t,
            online: point.online !== false,
            temp: round(point.temp), hum: round(point.hum),
            battery: round(point.battery, 3), soc: round(point.soc, 1),
            current: round(point.current), rssi: round(point.rssi, 0)
        };
        points.push(rec);
        lastIngestAt = t;
        trim();
        dirty = true;
        return true;
    }

    function latest() {
        const p = points.length ? points[points.length - 1] : null;
        const ageMs = p ? Math.max(0, now() - p.t) : null;
        const staleMs = clamp(Number(env('SENSOR_STALE_S', '120')) || 120, 10, 3600) * 1000;
        return { point: p, ageMs, ageSec: ageMs == null ? null : Math.round(ageMs / 1000), fresh: ageMs != null && ageMs <= staleMs, staleAfterSec: staleMs / 1000 };
    }

    // Ambil riwayat pada rentang tertentu dengan agregasi per bucket.
    // Rentang & bucket sudah divalidasi oleh registry; modul tetap membatasi.
    function query({ minutes, bucketSec, metrics } = {}) {
        const spanMin = clamp(Number(minutes) || 60, 1, retentionHours() * 60);
        const to = now();
        const from = to - spanMin * 60000;
        let b = clamp(Number(bucketSec) || Math.ceil(spanMin * 60 / 60), 5, 3600);
        const wanted = Array.isArray(metrics) && metrics.length ? metrics.filter(m => FIELDS[m]) : ['temperature', 'humidity', 'battery_soc'];
        const inRange = points.filter(p => p.t >= from && p.t <= to);
        const maxBuckets = 240;
        if ((spanMin * 60) / b > maxBuckets) b = Math.ceil((spanMin * 60) / maxBuckets);
        const buckets = new Map();
        for (const p of inRange) {
            const key = Math.floor(p.t / (b * 1000)) * b * 1000;
            let bucket = buckets.get(key);
            if (!bucket) { bucket = { t: key, count: 0, sums: {}, mins: {}, maxs: {} }; buckets.set(key, bucket); }
            bucket.count++;
            for (const m of wanted) {
                const v = p[FIELDS[m]];
                if (!Number.isFinite(v)) continue;
                bucket.sums[m] = (bucket.sums[m] || 0) + v;
                bucket.counts = bucket.counts || {};
                bucket.counts[m] = (bucket.counts[m] || 0) + 1;
                bucket.mins[m] = bucket.mins[m] == null ? v : Math.min(bucket.mins[m], v);
                bucket.maxs[m] = bucket.maxs[m] == null ? v : Math.max(bucket.maxs[m], v);
            }
        }
        const series = [...buckets.values()].sort((a, c) => a.t - c.t).map(bl => {
            const out = { t: bl.t, time: new Date(bl.t).toISOString(), samples: bl.count };
            for (const m of wanted) {
                const n = bl.counts && bl.counts[m];
                if (!n) { out[m] = null; continue; }
                out[m] = round(bl.sums[m] / n, m === 'battery_soc' ? 1 : 2);
                out[m + '_min'] = round(bl.mins[m], 2);
                out[m + '_max'] = round(bl.maxs[m], 2);
            }
            return out;
        });
        const summary = {};
        for (const m of wanted) {
            const f = FIELDS[m];
            const vals = inRange.map(p => p[f]).filter(Number.isFinite);
            summary[m] = vals.length ? {
                count: vals.length,
                min: round(Math.min(...vals), 2),
                max: round(Math.max(...vals), 2),
                avg: round(vals.reduce((a, c) => a + c, 0) / vals.length, 2),
                last: round(vals[vals.length - 1], 2)
            } : { count: 0, min: null, max: null, avg: null, last: null };
        }
        return {
            from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString(),
            rangeMinutes: spanMin, bucketSec: b, metrics: wanted,
            points: series, samples: inRange.length, summary, latest: latest(),
            retention: { hours: retentionHours(), maxPoints: maxPoints(), stored: points.length, persist: persist() }
        };
    }

    function clear() { points = []; dirty = true; saveNow(); }

    function info() {
        return {
            points: points.length,
            first: points.length ? new Date(points[0].t).toISOString() : null,
            last: points.length ? new Date(points[points.length - 1].t).toISOString() : null,
            retentionHours: retentionHours(), maxPoints: maxPoints(),
            minIntervalSec: minIntervalMs() / 1000, persist: persist(), lastError
        };
    }

    load();

    return {
        ingest, latest, query, clear, info,
        FIELDS, METRIC_NAMES,
        save: () => { dirty = true; saveNow(); },
        stop: () => { clearInterval(timer); saveNow(); }
    };
};

module.exports.FIELDS = FIELDS;
module.exports.METRIC_NAMES = METRIC_NAMES;
