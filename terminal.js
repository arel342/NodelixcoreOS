// ============================================================================
// terminal.js — terminal web (Pengaturan > Terminal) di atas executor.js.
//
// Modul ini hanya menyediakan HTTP + format polling; seluruh eksekusi, batas,
// timeout, pembatalan, dan penghentian proses anak ada di executor.js yang SAMA
// dengan yang dipakai skill `run_command` milik AI. Jadi:
//   • TERMINAL_ENABLED=false menutup terminal web dan perintah AI sekaligus.
//   • Shell, folder kerja, batas panjang perintah, batas output, timeout, dan
//     batas proses bersamaan berlaku sama untuk web dan AI.
//   • Mematikan fitur menghentikan pekerjaan yang masih berjalan (SIGTERM -> SIGKILL).
//
// Route (semua sudah dilindungi login di server.js):
//   GET  /api/terminal/info
//   POST /api/terminal/enabled  {enabled:boolean}
//   POST /api/terminal/run      {cmd, cwd}
//   GET  /api/terminal/job/:id?after=N
//   POST /api/terminal/input    {id, data}
//   POST /api/terminal/kill     {id, force}
// ============================================================================
const T = require('./lang');

module.exports = ({ app, saveEnv, executor, requireExecutor }) => {
    // Kalau modul dibuat tanpa executor (mis. berkas ini dimuat sendirian),
    // muat executor baru supaya perilaku tetap sama.
    if (!executor) executor = (requireExecutor || require('./executor'))();

    const enabled = () => executor.enabled();
    const guard = (req, res, next) => enabled() ? next() : res.status(403).json({ error: T('term.disabled') });
    const fail = (res, e) => res.status((e && e.status) || 500).json({ error: e.message });

    app.get('/api/terminal/info', (req, res) => {
        const i = executor.info();
        res.json({
            enabled: i.enabled, shell: i.shellName, shellPath: i.shell, home: i.home,
            user: i.user, host: i.host, timeout: i.timeout,
            maxOutputKB: i.maxOutputKB, maxJobs: i.maxJobs, maxCmd: i.maxCmd,
            running: i.running.map(j => ({ id: j.id, cmd: j.cmd, cwd: j.cwd, startedAt: j.startedAt }))
        });
    });

    app.post('/api/terminal/enabled', (req, res) => {
        const value = (req.body || {}).enabled;
        // Nilai boolean harus benar-benar boolean: string "false" tidak boleh jadi true.
        if (typeof value !== 'boolean') return res.status(400).json({ success: false, error: 'Nilai "enabled" harus boolean true/false.' });
        saveEnv('TERMINAL_ENABLED', value ? 'true' : 'false');
        // Saat dimatikan: hentikan semua pekerjaan yang masih berjalan secara terkendali.
        if (!value) executor.killAll('disabled');
        res.json({ success: true, enabled: value, message: T(value ? 'term.on' : 'term.off') });
    });

    app.post('/api/terminal/run', guard, (req, res) => {
        const b = req.body || {};
        const cmd = typeof b.cmd === 'string' ? b.cmd.replace(/\r\n?/g, '\n') : '';
        // Job lama yang sudah selesai dibuang otomatis oleh executor.
        let job;
        try {
            job = executor.start({ cmd, cwd: b.cwd, channel: 'web', owner: (req.ip || '-'), interactive: true });
        } catch (e) { return fail(res, e); }
        res.json({ success: true, id: job.id, cwd: job.cwd });
    });

    app.get('/api/terminal/job/:id', guard, (req, res) => {
        const j = executor.get(req.params.id);
        if (!j) return res.status(404).json({ error: T('term.noJob') });
        const after = Math.max(0, Number(req.query.after) || 0);
        res.json({
            chunks: j.chunks.filter(c => c.i > after).map(c => ({ i: c.i, s: c.s, d: c.d })),
            truncated: !!j.truncated,
            done: !!j.done,
            code: j.code,
            signal: j.signal,
            timedOut: !!j.timedOut,
            cancelled: !!j.cancelled,
            ms: j.ms || (Date.now() - j.startedAt),
            cwd: j.done ? j.newCwd : j.cwd
        });
    });

    app.post('/api/terminal/input', guard, (req, res) => {
        try {
            executor.input((req.body || {}).id, (req.body || {}).data);
            res.json({ success: true });
        } catch (e) { fail(res, e); }
    });

    app.post('/api/terminal/kill', guard, (req, res) => {
        try {
            executor.kill((req.body || {}).id, (req.body || {}).force === true);
            res.json({ success: true });
        } catch (e) { fail(res, e); }
    });

    return {
        killAll: reason => executor.killAll(reason || 'shutdown'),
        isEnabled: enabled,
        executor
    };
};
