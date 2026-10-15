// ============================================================================
// ai.js — AI Agent berbasis Gemini (free tier) yang berjalan di Telegram.
//
// AI Agent diberi "skill" (lihat skills.js) agar tahu apa yang ada di server
// dan bisa mengontrol ESP32, lock door, Termux, serta file. Kunci API Gemini
// disimpan di .env (GEMINI_API_KEY) dan bisa diisi dari setup awal / Pengaturan.
// ============================================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const E = (k, d = '') => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const { skills, systemPrompt } = require('./skills');

// Pesan singkat saat kunci API belum ada: diisi dari setup awal (/setup.html) atau
// tab Pengaturan > AI Agent, keduanya menulis GEMINI_API_KEY ke .env.
const KEY_HELP = 'GEMINI_API_KEY belum diisi. Isi di setup awal (langkah AI Agent) atau tab Pengaturan > AI Agent — kunci gratis dari Google AI Studio (aistudio.google.com/apikey).';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
const RETIRED_MODEL_RE = /^gemini-(1\.[05](-[a-z0-9.]+)?|pro(-vision)?)$/i;

function normalizeModel(m) {
    const raw = String(m || '').trim().replace(/^models\//i, '');
    if (!raw || RETIRED_MODEL_RE.test(raw)) return DEFAULT_MODEL;
    return raw;
}

function shouldFallback(status, msg) {
    if (status === 404 || status === 503 || status === 429) return true;
    return /not found|not supported|deprecated|retired|no longer available|unavailable|overloaded/i.test(String(msg || ''));
}

function extractText(parts, sep = '\n') {
    if (!Array.isArray(parts)) return '';
    const nonThought = parts.filter(p => p && !p.thought && typeof p.text === 'string' && p.text.trim());
    const list = nonThought.length ? nonThought : parts.filter(p => p && typeof p.text === 'string' && p.text.trim());
    return list.map(p => p.text).join(sep).trim();
}

const SECRET = /(PASSWORD|PASSWD|TOKEN|API_?KEY|SECRET)/i;
function childEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) if (!SECRET.test(k) && k !== 'ADMIN_USERNAME') out[k] = v;
    out.TERM = 'dumb'; out.NO_COLOR = '1'; out.PAGER = 'cat';
    return out;
}

function runCommand(cmd, timeout = 30000) {
    return new Promise(resolve => {
        let out = '', err = '', done = false, t;
        const end = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
        const c = spawn('/bin/sh', ['-c', String(cmd)], { env: childEnv(), detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        c.stdout.setEncoding('utf8'); c.stderr.setEncoding('utf8');
        c.stdout.on('data', d => { out += d; if (out.length > 8000) out = out.slice(-8000); });
        c.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
        t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { } end({ ok: false, output: out, error: 'timeout' }); }, timeout);
        c.on('error', e => end({ ok: false, output: out, error: e.message }));
        c.on('close', code => end({ ok: code === 0, code, output: out.trim(), error: err.trim() }));
    });
}

const toolDeclarations = [
    { name: 'get_status', description: skills.find(s => s.name === 'get_status').description, parameters: { type: 'object', properties: {} } },
    { name: 'set_relay', description: skills.find(s => s.name === 'set_relay').description, parameters: { type: 'object', properties: { id: { type: 'string' }, state: { type: 'boolean' } }, required: ['id', 'state'] } },
    { name: 'open_door', description: skills.find(s => s.name === 'open_door').description, parameters: { type: 'object', properties: {} } },
    { name: 'close_door', description: skills.find(s => s.name === 'close_door').description, parameters: { type: 'object', properties: {} } },
    { name: 'set_door_enabled', description: skills.find(s => s.name === 'set_door_enabled').description, parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] } },
    { name: 'enroll_card', description: skills.find(s => s.name === 'enroll_card').description, parameters: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'run_command', description: skills.find(s => s.name === 'run_command').description, parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'list_files', description: skills.find(s => s.name === 'list_files').description, parameters: { type: 'object', properties: { dir: { type: 'string' } } } }
];

module.exports = ({ app, saveEnv, esp32, door, telegram, terminal, auth, broadcast, notify } = {}) => {
    const deps = { esp32, door, telegram, terminal, auth, broadcast, notify };
    const histories = new Map();
    let started = false;                       // start() hanya sekali menampilkan status di log

    function cfg() {
        return {
            enabled: E('AI_AGENT_ENABLED', 'true') !== 'false',
            apiKey: E('GEMINI_API_KEY', ''),
            model: normalizeModel(E('GEMINI_MODEL', DEFAULT_MODEL))
        };
    }

    function reload() { /* nilai dibaca saat dipakai */ }

    async function executeTool(name, args) {
        args = args || {};
        switch (name) {
            case 'get_status': {
                const e = (esp32 && typeof esp32.snapshot === 'function') ? esp32.snapshot() : {};
                const d = (door && typeof door.snapshot === 'function') ? door.snapshot() : {};
                return { esp32: e, door: d };
            }
            case 'set_relay': {
                if (!esp32 || typeof esp32.setRelay !== 'function') throw new Error('ESP32 tidak tersedia');
                await esp32.setRelay(String(args.id).toLowerCase() === 'all' ? 'all' : Number(args.id), !!args.state);
                return { ok: true };
            }
            case 'open_door': {
                if (!door || typeof door.open !== 'function') throw new Error('Lock door tidak tersedia');
                await door.open();
                return { ok: true };
            }
            case 'close_door': {
                if (!door || typeof door.close !== 'function') throw new Error('Lock door tidak tersedia');
                await door.close();
                return { ok: true };
            }
            case 'set_door_enabled': {
                if (!door || typeof door.setEnabled !== 'function') throw new Error('Lock door tidak tersedia');
                const st = await door.setEnabled(!!args.enabled);
                return { ok: true, synced: st && st.synced };
            }
            case 'enroll_card': {
                if (!door || typeof door.enroll !== 'function') throw new Error('Lock door tidak tersedia');
                await door.enroll(args.name || '', true);
                return { ok: true };
            }
            case 'run_command': {
                if (!args.command) throw new Error('perintah kosong');
                return await runCommand(args.command);
            }
            case 'list_files': {
                try {
                    const storage = require('./storage');
                    const files = await storage.list(args.dir || '');
                    return { files };
                } catch (e) {
                    return { error: e.message };
                }
            }
            default:
                throw new Error('skill tidak dikenal: ' + name);
        }
    }

    async function callModels(apiKey, primaryModel, body, timeoutMs) {
        const primary = normalizeModel(primaryModel);
        const models = [primary, ...FALLBACK_MODELS.filter(m => m !== primary)];
        let lastErr = null;
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const r = await fetch(url, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
            });
            const j = await r.json().catch(() => null);
            if (r.ok) return { json: j, model: m };
            const msg = (j && j.error && (j.error.message || j.error.status)) || ('Gemini HTTP ' + r.status);
            lastErr = new Error(`${msg} (model ${m})`);
            if (!shouldFallback(r.status, msg)) throw lastErr;
        }
        throw lastErr;
    }

    async function gemini(contents) {
        const c = cfg();
        if (!c.enabled) throw new Error('AI agent dinonaktifkan. Aktifkan di setup awal atau Pengaturan > AI Agent.');
        if (!c.apiKey) throw new Error(KEY_HELP);
        const body = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents,
            tools: [{ function_declarations: toolDeclarations }],
            tool_config: { function_calling_config: { mode: 'AUTO' } }
        };
        const { json } = await callModels(c.apiKey, c.model, body, 60000);
        return json;
    }

    // Cek cepat satu kunci API: panggil model dengan prompt pendek. Kalau override
    // { apiKey, model } dikirim (halaman setup awal), kunci itu yang diuji — bukan yang
    // tersimpan di .env — jadi pengguna tahu kuncinya benar sebelum menyimpan.
    async function testKey(override = {}) {
        const c = cfg();
        const apiKey = String(override.apiKey === undefined ? c.apiKey : override.apiKey).trim();
        if (!apiKey) { const e = new Error(KEY_HELP); e.status = 400; throw e; }
        const model = normalizeModel(override.model || c.model);
        const body = { contents: [{ role: 'user', parts: [{ text: 'Balas singkat: OK' }] }] };
        const { json: j } = await callModels(apiKey, model, body, 30000);
        const parts = ((((j || {}).candidates || [])[0] || {}).content || {}).parts || [];
        const text = extractText(parts, ' ');
        if (!text) throw new Error('Gemini menjawab kosong — pastikan model sudah diizinkan untuk kunci ini');
        return text;
    }

    async function handleMessage(userText, chatId) {
        userText = String(userText || '').trim();
        if (!userText) return 'Tulis pertanyaan atau perintah untuk AI Agent.';
        const c = cfg();
        if (!c.enabled) return 'AI agent dinonaktifkan. Aktifkan di setup awal atau Pengaturan > AI Agent.';
        if (!c.apiKey) return KEY_HELP;

        const history = histories.get(chatId) || [];
        const contents = [...history, { role: 'user', parts: [{ text: userText }] }];

        let rounds = 0;
        while (rounds < 8) {
            rounds++;
            const j = await gemini(contents);
            const candidate = (j.candidates && j.candidates[0]) || {};
            const parts = (candidate.content && candidate.content.parts) || [];
            const funcCalls = parts.filter(p => p.functionCall);
            if (funcCalls.length) {
                contents.push({ role: 'model', parts });
                const toolParts = [];
                for (const fc of funcCalls) {
                    const name = fc.functionCall.name;
                    const args = fc.functionCall.args || {};
                    let result;
                    try { result = await executeTool(name, args); }
                    catch (e) { result = { error: e.message }; }
                    toolParts.push({ functionResponse: { name, response: { result } } });
                }
                contents.push({ role: 'user', parts: toolParts });
                continue;
            }
            const text = extractText(parts, '\n');
            history.push({ role: 'user', parts: [{ text: userText }] });
            history.push({ role: 'model', parts: [{ text: text || '(tidak ada jawaban)' }] });
            if (history.length > 20) history.splice(0, history.length - 20);
            histories.set(chatId, history);
            return text || '(tidak ada jawaban)';
        }
        return 'Terlalu banyak langkah. Coba ulangi permintaan.';
    }

    // Route HTTP (opsional, untuk uji dari web). /api/ai/status ikut dipakai halaman
    // setup awal dan tab Pengaturan untuk menampilkan apakah kunci Gemini sudah ada.
    if (app) {
        app.get('/api/ai/status', (req, res) => {
            const c = cfg();
            res.json({
                enabled: c.enabled, hasKey: !!c.apiKey, model: c.model,
                ready: c.enabled && !!c.apiKey, skills: skills.map(s => s.name)
            });
        });
        app.post('/api/ai/chat', async (req, res) => {
            try {
                const reply = await handleMessage((req.body || {}).message || '', req.ip);
                res.json({ success: true, reply });
            } catch (e) {
                res.status(500).json({ success: false, message: e.message });
            }
        });
        app.post('/api/ai/test', async (req, res) => {
            const b = req.body || {};
            try {
                const reply = await testKey({
                    apiKey: b.apiKey === undefined || b.apiKey === '' ? undefined : b.apiKey,
                    model: b.model
                });
                res.json({ success: true, reply });
            } catch (e) {
                res.status(e && e.status === 400 ? 400 : 502).json({ success: false, message: e.message });
            }
        });
    }

    return {
        start() {
            if (started) return cfg().enabled && !!cfg().apiKey;
            started = true;
            const c = cfg();
            if (!c.apiKey) console.log('[AI] ' + KEY_HELP);
            else console.log(`[AI] AI Agent ${c.enabled ? 'aktif' : 'nonaktif'} (model ${c.model}).`);
            return c.enabled && !!c.apiKey;
        },
        testKey,
        reload,
        handleMessage,
        handle: handleMessage,
        ask: handleMessage,
        chat: handleMessage,
        run: handleMessage,
        handleTelegramMessage: handleMessage,
        handleTelegram: handleMessage,
        skills,
        cfg,
        executeTool,
        execute: executeTool,
        callSkill: executeTool,
        runSkill: executeTool
    };
};

module.exports.skills = require("./skills").skills;
module.exports.systemPrompt = require("./skills").systemPrompt;
