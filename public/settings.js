// ============================================================================
// settings.js (halaman) — kartu "Perangkat & Integrasi" di tab Pengaturan.
//
// Semua yang diisi di sini dikirim ke server dan ditulis ke .env, jadi pengaturan
// ESP32 / ESP8266 (pintu) / Telegram / akun admin / batas monitoring bisa diubah
// dari browser tanpa membuka Termux.
//
//   GET  /api/settings              -> nilai sekarang (diisi ke kolom)
//   POST /api/settings              -> simpan per kelompok (esp32, door, telegram, ai, server, monitor)
//   POST /api/settings/account      -> ubah username / password admin
//   POST /api/settings/telegram/test-> kirim pesan uji
//   POST /api/ai/test               -> uji kunci API Gemini ke model yang dipilih
//   POST /api/settings/device/test  -> uji koneksi ke ESP
//   POST /api/settings/device/push  -> kirim WiFi/IP/kunci API ke ESP lewat jaringan
//   POST /api/settings/device/portal-> ESP masuk mode setup (WiFi sendiri + halaman web)
// ============================================================================
(function () {
    const CSS = `
.cfg{display:grid;gap:14px;margin-top:14px}
.cfg-card{background:#fff;border:1px solid #dbe2ee;border-radius:16px;padding:16px}
.cfg-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}
.cfg-head b{font-size:15px}
.cfg-badge{font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;background:#eef2f9;color:#6b7a94}
.cfg-badge.on{background:#e1f6ec;color:#067a52}
.cfg-badge.off{background:#fdeaea;color:#991b1b}
.cfg-p{font-size:12.5px;color:#6b7a94;line-height:1.55;margin:6px 0 12px}
.cfg-grid{display:grid;gap:10px}
@media(min-width:560px){.cfg-grid.two{grid-template-columns:1fr 1fr}.cfg-grid.three{grid-template-columns:1fr 1fr 1fr}}
.cfg-f{font-size:12.5px;font-weight:600;color:#3d4b62}
.cfg-f input[type=text],.cfg-f input[type=password],.cfg-f input[type=number]{display:block;width:100%;margin-top:5px;padding:10px 12px;border:1.5px solid #dbe2ee;border-radius:11px;font:inherit;font-size:14px;background:#fbfcfe;color:#0b1a30;outline:none}
.cfg-f input:focus{border-color:#8ab4e8;background:#fff}
.cfg-row{display:flex;gap:8px;align-items:flex-end}
.cfg-row>div{flex:1}
.cfg-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.cfg-b{border:0;border-radius:11px;padding:10px 16px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;background:#0b1a30;color:#fff}
.cfg-b:disabled{opacity:.5;cursor:not-allowed}
.cfg-b.ghost{background:#fff;color:#0b1a30;border:1.5px solid #dbe2ee}
.cfg-b.warn{background:#fff3d6;color:#7c4a00;border:1.5px solid #f6dfae}
.cfg-b.mini{padding:10px 12px;font-size:12.5px}
.cfg-sw{display:flex;align-items:center;gap:10px;margin:10px 0 0;font-size:13.5px;font-weight:600;color:#3d4b62}
.cfg-sw input{width:19px;height:19px;accent-color:#f5a524}
.cfg-msg{font-size:12.5px;font-weight:600;margin-top:12px;border-radius:11px;padding:10px 12px;display:none}
.cfg-msg.ok{display:block;background:#e6f7ec;color:#166534}
.cfg-msg.err{display:block;background:#fdeaea;color:#991b1b}
.cfg-msg.work{display:block;background:#eef4fb;color:#2f5f92}
.cfg-side{border-top:1px dashed #dbe2ee;margin-top:14px;padding-top:12px}
.cfg-side summary{cursor:pointer;font-size:13px;font-weight:700;color:#2f78be;list-style:none}
.cfg-side summary::-webkit-details-marker{display:none}
.cfg-side[open] summary{margin-bottom:10px}
.cfg-hint{font-size:11.5px;color:#7a879c;line-height:1.5;margin:8px 0 0}
.cfg-kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:7px 0;border-bottom:1px dashed #e6ebf4}
.cfg-kv:last-child{border-bottom:0}
.cfg-kv span{color:#6b7a94}
.cfg-kv b{font-weight:600;word-break:break-all;text-align:right}
.cfg-a{color:#2f78be;font-weight:700;font-size:13px;text-decoration:none}
.cfg-a:hover{text-decoration:underline}`;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);

    let S = null;                       // nilai pengaturan dari server
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = v => (v === null || v === undefined) ? '' : v;
    const cfgMsg = (id, text, type) => { const el = document.getElementById(id); if (el) { el.className = 'cfg-msg ' + (type || ''); el.textContent = text || ''; } };
    const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const chk = id => { const el = document.getElementById(id); return el ? !!el.checked : false; };

    function badge(state) {
        if (state === undefined) return '';
        return `<span class="cfg-badge ${state ? 'on' : 'off'}">${esc(state ? t('cfg.on') : t('cfg.off'))}</span>`;
    }

    // ---------- Kerangka kartu ----------
    function cardESP32() {
        const e = S.esp32;
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.esp32'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.esp32d'))}</p>
            <div class="cfg-grid two">
                <label class="cfg-f">${esc(t('cfg.ipDev'))}<input id="c-e32-ip" type="text" spellcheck="false" placeholder="192.168.1.50" value="${esc(e.ip)}"></label>
                <label class="cfg-f">${esc(t('cfg.port'))}<input id="c-e32-port" type="number" min="1" max="65535" value="${esc(String(num(e.port)))}"></label>
            </div>
            <div class="cfg-row" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.apiKey'))}<input id="c-e32-key" type="text" spellcheck="false" autocomplete="off" value="${esc(e.apiKey)}"></label>
                <button class="cfg-b ghost mini" type="button" onclick="cfgGen('c-e32-key')">${esc(t('cfg.genKey'))}</button>
                <button class="cfg-b ghost mini" type="button" onclick="cfgCopy('c-e32-key')">${esc(t('cfg.copy'))}</button>
            </div>
            <div class="cfg-grid two" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.pollMs'))}<input id="c-e32-poll" type="number" min="200" max="60000" step="100" value="${esc(String(num(e.pollMs)))}"></label>
                <label class="cfg-f">${esc(t('cfg.labels'))}<input id="c-e32-labels" type="text" value="${esc(e.labels)}" placeholder="Relay 1, Relay 3, Relay 4"></label>
            </div>
            <div class="cfg-btns">
                <button class="cfg-b" type="button" onclick="cfgSave('esp32')">${esc(t('cfg.save'))}</button>
                <button class="cfg-b ghost" type="button" onclick="cfgTest('esp32')">${esc(t('cfg.testDev'))}</button>
                <button class="cfg-b warn" type="button" onclick="cfgPortal('esp32')">${esc(t('cfg.portal'))}</button>
            </div>
            <details class="cfg-side">
                <summary>${esc(t('cfg.pushTitle'))}</summary>
                <p class="cfg-hint">${esc(t('cfg.pushDesc'))}</p>
                <div class="cfg-grid two">
                    <label class="cfg-f">${esc(t('cfg.pushSsid'))}<input id="c-e32-ssid" type="text" spellcheck="false"></label>
                    <label class="cfg-f">${esc(t('cfg.pushPass'))}<input id="c-e32-pass" type="text" spellcheck="false" autocomplete="off"></label>
                </div>
                <label class="cfg-sw"><input id="c-e32-dhcp" type="checkbox" checked>${esc(t('cfg.pushDhcp'))}</label>
                <div class="cfg-grid two" style="margin-top:10px">
                    <label class="cfg-f">${esc(t('cfg.pushIp'))}<input id="c-e32-newip" type="text" spellcheck="false" placeholder="192.168.1.50"></label>
                    <label class="cfg-f">${esc(t('cfg.pushGw'))}<input id="c-e32-gw" type="text" spellcheck="false" placeholder="192.168.1.1"></label>
                    <label class="cfg-f">${esc(t('cfg.pushMask'))}<input id="c-e32-mask" type="text" spellcheck="false" placeholder="255.255.255.0"></label>
                    <label class="cfg-f">${esc(t('cfg.pushDns'))}<input id="c-e32-dns" type="text" spellcheck="false" placeholder="192.168.1.1"></label>
                    <label class="cfg-f">${esc(t('cfg.pushNewKey'))}<input id="c-e32-newkey" type="text" spellcheck="false" autocomplete="off"></label>
                    <label class="cfg-f">${esc(t('cfg.pushDevKey'))}<input id="c-e32-devkey" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(e.apiKey)}"></label>
                </div>
                <p class="cfg-hint">${esc(t('cfg.pushDevKeyHint'))}</p>
                <div class="cfg-btns"><button class="cfg-b" type="button" onclick="cfgPush('esp32')">${esc(t('cfg.pushSend'))}</button></div>
            </details>
            <div class="cfg-msg" id="c-msg-esp32"></div>
        </div>`;
    }

    function cardDoor() {
        const d = S.door;
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.door'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.doord'))}</p>
            <div class="cfg-grid two">
                <label class="cfg-f">${esc(t('cfg.ipDev'))}<input id="c-d-ip" type="text" spellcheck="false" placeholder="192.168.1.60" value="${esc(d.ip)}"></label>
                <label class="cfg-f">${esc(t('cfg.port'))}<input id="c-d-port" type="number" min="1" max="65535" value="${esc(String(num(d.port)))}"></label>
            </div>
            <div class="cfg-row" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.apiKey'))}<input id="c-d-key" type="text" spellcheck="false" autocomplete="off" value="${esc(d.apiKey)}"></label>
                <button class="cfg-b ghost mini" type="button" onclick="cfgGen('c-d-key')">${esc(t('cfg.genKey'))}</button>
                <button class="cfg-b ghost mini" type="button" onclick="cfgCopy('c-d-key')">${esc(t('cfg.copy'))}</button>
            </div>
            <div class="cfg-grid two" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.pollMs'))}<input id="c-d-poll" type="number" min="200" max="60000" step="100" value="${esc(String(num(d.pollMs)))}"></label>
                <label class="cfg-f">${esc(t('cfg.enrollSec'))}<input id="c-d-sec" type="number" min="5" max="300" value="${esc(String(num(d.enrollSec)))}"></label>
            </div>
            <label class="cfg-sw"><input id="c-d-open" type="checkbox" ${d.notifyOpen ? 'checked' : ''}>${esc(t('cfg.notifyOpen'))}</label>
            <label class="cfg-sw"><input id="c-d-unknown" type="checkbox" ${d.notifyUnknown ? 'checked' : ''}>${esc(t('cfg.notifyUnknown'))}</label>
            <div class="cfg-btns">
                <button class="cfg-b" type="button" onclick="cfgSave('door')">${esc(t('cfg.save'))}</button>
                <button class="cfg-b ghost" type="button" onclick="cfgTest('esp8266')">${esc(t('cfg.testDev'))}</button>
                <button class="cfg-b warn" type="button" onclick="cfgPortal('esp8266')">${esc(t('cfg.portal'))}</button>
            </div>
            <details class="cfg-side">
                <summary>${esc(t('cfg.pushTitle'))}</summary>
                <p class="cfg-hint">${esc(t('cfg.pushDesc'))}</p>
                <div class="cfg-grid two">
                    <label class="cfg-f">${esc(t('cfg.pushSsid'))}<input id="c-d-ssid" type="text" spellcheck="false"></label>
                    <label class="cfg-f">${esc(t('cfg.pushPass'))}<input id="c-d-pass" type="text" spellcheck="false" autocomplete="off"></label>
                </div>
                <label class="cfg-sw"><input id="c-d-dhcp" type="checkbox" checked>${esc(t('cfg.pushDhcp'))}</label>
                <div class="cfg-grid two" style="margin-top:10px">
                    <label class="cfg-f">${esc(t('cfg.pushIp'))}<input id="c-d-newip" type="text" spellcheck="false" placeholder="192.168.1.60"></label>
                    <label class="cfg-f">${esc(t('cfg.pushGw'))}<input id="c-d-gw" type="text" spellcheck="false" placeholder="192.168.1.1"></label>
                    <label class="cfg-f">${esc(t('cfg.pushMask'))}<input id="c-d-mask" type="text" spellcheck="false" placeholder="255.255.255.0"></label>
                    <label class="cfg-f">${esc(t('cfg.pushDns'))}<input id="c-d-dns" type="text" spellcheck="false" placeholder="192.168.1.1"></label>
                    <label class="cfg-f">${esc(t('cfg.pushNewKey'))}<input id="c-d-newkey" type="text" spellcheck="false" autocomplete="off"></label>
                    <label class="cfg-f">${esc(t('cfg.pushDevKey'))}<input id="c-d-devkey" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(d.apiKey)}"></label>
                </div>
                <p class="cfg-hint">${esc(t('cfg.pushDevKeyHint'))}</p>
                <div class="cfg-btns"><button class="cfg-b" type="button" onclick="cfgPush('esp8266')">${esc(t('cfg.pushSend'))}</button></div>
            </details>
            <div class="cfg-msg" id="c-msg-door"></div>
        </div>`;
    }

    // Kartu AI Agent: kunci API Gemini + model. Kelompok "ai" di /api/settings menulis
    // GEMINI_API_KEY / GEMINI_MODEL / AI_AGENT_ENABLED, lalu modul AI membacanya langsung.
    function cardAi() {
        const a = S.ai || {};
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.ai'))}</b>${badge(a.enabled !== false && !!a.apiKey)}</div>
            <p class="cfg-p">${esc(t('cfg.aid'))}</p>
            <label class="cfg-sw"><input id="c-ai-on" type="checkbox" ${a.enabled !== false ? 'checked' : ''}>${esc(t('cfg.aiEnabled'))}</label>
            <div class="cfg-row" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.aiKey'))}<input id="c-ai-key" type="password" spellcheck="false" autocomplete="off" placeholder="AQ...." value="${esc(a.apiKey || '')}"></label>
                <button class="cfg-b ghost mini" type="button" onclick="cfgCopy('c-ai-key')">${esc(t('cfg.copy'))}</button>
            </div>
            <div class="cfg-grid two" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.aiModel'))}<input id="c-ai-model" type="text" spellcheck="false" autocomplete="off" list="cfg-ai-models" placeholder="gemini-2.5-flash" value="${esc(a.model || '')}"></label>
                <datalist id="cfg-ai-models">
                    <option value="gemini-2.5-flash"></option>
                    <option value="gemini-2.5-flash-lite"></option>
                    <option value="gemini-2.0-flash"></option>
                </datalist>
            </div>
            <p class="cfg-hint">${esc(t('cfg.aiHow'))}</p>
            <div class="cfg-btns">
                <button class="cfg-b" type="button" onclick="cfgSave('ai')">${esc(t('cfg.save'))}</button>
                <button class="cfg-b ghost" type="button" onclick="cfgTestAi()">${esc(t('cfg.aiTest'))}</button>
            </div>
            <div class="cfg-msg" id="c-msg-ai"></div>
        </div>`;
    }

    function cardTelegram() {
        const g = S.telegram;
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.tg'))}</b>${badge(!!(g.token && g.chatId))}</div>
            <p class="cfg-p">${esc(t('cfg.tgd'))}</p>
            <label class="cfg-sw"><input id="c-tg-alerts" type="checkbox" ${g.alerts ? 'checked' : ''}>${esc(t('cfg.alerts'))}</label>
            <div class="cfg-grid" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.token'))}<input id="c-tg-token" type="text" spellcheck="false" autocomplete="off" value="${esc(g.token)}"></label>
                <label class="cfg-f">${esc(t('cfg.chatId'))}<input id="c-tg-chat" type="text" spellcheck="false" autocomplete="off" value="${esc(g.chatId)}"></label>
            </div>
            <div class="cfg-btns">
                <button class="cfg-b" type="button" onclick="cfgSave('telegram')">${esc(t('cfg.save'))}</button>
                <button class="cfg-b ghost" type="button" onclick="cfgTestTg()">${esc(t('cfg.testTg'))}</button>
            </div>
            <div class="cfg-msg" id="c-msg-telegram"></div>
        </div>`;
    }

    function cardAccount() {
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.acct'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.acctd'))}</p>
            <div class="cfg-grid two">
                <label class="cfg-f">${esc(t('cfg.username'))}<input id="c-a-user" type="text" spellcheck="false" value="${esc(S.info.username)}"></label>
                <label class="cfg-f">${esc(t('cfg.curPass'))}<input id="c-a-cur" type="password" autocomplete="current-password"></label>
            </div>
            <div class="cfg-grid two" style="margin-top:10px">
                <label class="cfg-f">${esc(t('cfg.newPass'))}<input id="c-a-new" type="password" autocomplete="new-password"></label>
                <label class="cfg-f">${esc(t('cfg.confirmPass'))}<input id="c-a-conf" type="password" autocomplete="new-password"></label>
            </div>
            <div class="cfg-btns"><button class="cfg-b" type="button" onclick="cfgSaveAccount()">${esc(t('cfg.save'))}</button></div>
            <div class="cfg-msg" id="c-msg-account"></div>
        </div>`;
    }

    function cardServer() {
        const v = S.server;
        const url = (S.info.ips || []).map(ip => `http://${ip}:${S.info.port}`).join('  ·  ');
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.srv'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.srvd'))}</p>
            <div class="cfg-kv"><span>${esc(t('wz.addr'))}</span><b>${esc(url)}</b></div>
            <div class="cfg-grid three" style="margin-top:12px">
                <label class="cfg-f">${esc(t('cfg.portWeb'))}<input id="c-s-port" type="number" min="1" max="65535" value="${esc(String(num(v.port)))}"></label>
                <label class="cfg-f">${esc(t('cfg.sessionHours'))}<input id="c-s-session" type="number" min="1" max="720" value="${esc(String(num(v.sessionHours)))}"></label>
                <label class="cfg-f">${esc(t('cfg.storageFolder'))}<input id="c-s-storage" type="text" value="${esc(v.storageFolder)}"></label>
                <label class="cfg-f">${esc(t('cfg.otaMaxMB'))}<input id="c-s-otamax" type="number" min="1" max="32" value="${esc(String(num(v.otaMaxMB)))}"></label>
                <label class="cfg-f">${esc(t('cfg.otaTimeoutS'))}<input id="c-s-otatimeout" type="number" min="30" max="1800" value="${esc(String(num(v.otaTimeoutS)))}"></label>
                <label class="cfg-f">${esc(t('cfg.otaWaitS'))}<input id="c-s-otawait" type="number" min="10" max="600" value="${esc(String(num(v.otaWaitS)))}"></label>
            </div>
            <p class="cfg-hint">${esc(t('wz.s2hint'))}</p>
            <div class="cfg-btns"><button class="cfg-b" type="button" onclick="cfgSave('server')">${esc(t('cfg.save'))}</button></div>
            <div class="cfg-msg" id="c-msg-server"></div>
        </div>`;
    }

    function cardMonitor() {
        const m = S.monitor;
        const f = (id, label, v) => `<label class="cfg-f">${esc(label)}<input id="${id}" type="number" step="0.01" value="${esc(String(num(v)))}"></label>`;
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('cfg.mon'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.mond'))}</p>
            <div class="cfg-grid three">
                ${f('c-m-iwarn', 'I_WARN_A', m.iWarn)}
                ${f('c-m-vmax', 'CELL_V_MAX', m.cellVMax)}
                ${f('c-m-vcrit', 'CELL_V_CRIT', m.cellVCrit)}
                ${f('c-m-vlow', 'CELL_V_LOW', m.cellVLow)}
                ${f('c-m-delta', 'CELL_DELTA_WARN', m.cellDeltaWarn)}
                ${f('c-m-dead', 'I_DEADBAND_A', m.iDeadband)}
                ${f('c-m-vac', 'AC_VOLTAGE_NOMINAL', m.acVoltage)}
                ${f('c-m-pf', 'AC_POWER_FACTOR', m.acPowerFactor)}
            </div>
            <div class="cfg-btns"><button class="cfg-b" type="button" onclick="cfgSave('monitor')">${esc(t('cfg.save'))}</button></div>
            <div class="cfg-msg" id="c-msg-monitor"></div>
        </div>`;
    }

    function cardWizard() {
        return `
        <div class="cfg-card">
            <div class="cfg-head"><b>${esc(t('wz.title'))}</b></div>
            <p class="cfg-p">${esc(t('cfg.rerunDesc'))}</p>
            <a class="cfg-a" href="/setup.html">${esc(t('cfg.openWizard'))} →</a>
        </div>`;
    }

    function render() {
        const root = document.getElementById('settings-root');
        if (!root || !S) return;
        root.innerHTML = `<div class="cfg">
            ${cardWizard()}
            ${cardESP32()}
            ${cardDoor()}
            ${cardTelegram()}
            ${cardAi()}
            ${cardAccount()}
            ${cardServer()}
            ${cardMonitor()}
        </div>`;
    }

    // ---------- Muat dari server ----------
    window.loadSettings = async function () {
        const root = document.getElementById('settings-root');
        if (!root) return;
        try {
            const r = await fetch('/api/settings');
            if (!r.ok) return;
            S = await r.json();
            render();
        } catch (e) { /* tab tetap kosong kalau server tidak menjawab */ }
    };

    // ---------- Simpan & aksi ----------
    async function post(url, body) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.success) throw new Error(j.message || ('HTTP ' + r.status));
        return j;
    }

    function collect(group) {
        if (group === 'esp32') return {
            esp32: {
                ip: val('c-e32-ip'), port: val('c-e32-port'), apiKey: val('c-e32-key'),
                pollMs: val('c-e32-poll'), labels: val('c-e32-labels')
            }
        };
        if (group === 'door') return {
            door: {
                ip: val('c-d-ip'), port: val('c-d-port'), apiKey: val('c-d-key'),
                pollMs: val('c-d-poll'), enrollSec: val('c-d-sec'),
                notifyOpen: chk('c-d-open'), notifyUnknown: chk('c-d-unknown')
            }
        };
        if (group === 'telegram') return {
            telegram: { alerts: chk('c-tg-alerts'), token: val('c-tg-token'), chatId: val('c-tg-chat') }
        };
        if (group === 'ai') return {
            ai: { enabled: chk('c-ai-on'), apiKey: val('c-ai-key'), model: val('c-ai-model') }
        };
        if (group === 'server') return {
            server: {
                port: val('c-s-port'), sessionHours: val('c-s-session'), storageFolder: val('c-s-storage'),
                otaMaxMB: val('c-s-otamax'), otaTimeoutS: val('c-s-otatimeout'), otaWaitS: val('c-s-otawait')
            }
        };
        if (group === 'monitor') return {
            monitor: {
                iWarn: val('c-m-iwarn'), cellVMax: val('c-m-vmax'), cellVCrit: val('c-m-vcrit'), cellVLow: val('c-m-vlow'),
                cellDeltaWarn: val('c-m-delta'), iDeadband: val('c-m-dead'), acVoltage: val('c-m-vac'), acPowerFactor: val('c-m-pf')
            }
        };
        return {};
    }
    const msgId = g => ({ esp32: 'c-msg-esp32', door: 'c-msg-door', telegram: 'c-msg-telegram', ai: 'c-msg-ai', server: 'c-msg-server', monitor: 'c-msg-monitor' }[g] || '');

    window.cfgSave = async function (group) {
        const id = msgId(group);
        cfgMsg(id, '…', 'work');
        try {
            await post('/api/settings', collect(group));
            cfgMsg(id, t('cfg.saved'), 'ok');
            if (window.uiToast) uiToast(t('cfg.saved'), 'ok');
            await loadSettings();                       // tampilkan nilai yang benar-benar tersimpan
        } catch (e) { cfgMsg(id, e.message, 'err'); }
    };

    window.cfgSaveAccount = async function () {
        cfgMsg('c-msg-account', '…', 'work');
        try {
            await post('/api/settings/account', {
                password: val('c-a-cur'), username: val('c-a-user'),
                newPassword: val('c-a-new'), confirmPassword: val('c-a-conf')
            });
            cfgMsg('c-msg-account', t('set.acctOk'), 'ok');
            ['c-a-cur', 'c-a-new', 'c-a-conf'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
        } catch (e) { cfgMsg('c-msg-account', e.message, 'err'); }
    };

    window.cfgTest = async function (device) {
        const id = device === 'esp32' ? 'c-msg-esp32' : 'c-msg-door';
        cfgMsg(id, '…', 'work');
        try {
            const j = await post('/api/settings/device/test', { device });
            cfgMsg(id, j.message || t('cfg.devTestOk', { dev: device, fw: j.fw || '-' }), 'ok');
        } catch (e) { cfgMsg(id, e.message, 'err'); }
    };

    window.cfgPortal = async function (device) {
        const id = device === 'esp32' ? 'c-msg-esp32' : 'c-msg-door';
        const ap = device === 'esp32' ? 'Nodelix-ESP32' : 'Nodelix-DOOR';
        const ok = window.uiConfirm ? await uiConfirm(t('cfg.portalHint', { ap }), { ok: t('cfg.portal') }) : true;
        if (!ok) return;
        cfgMsg(id, '…', 'work');
        try {
            const j = await post('/api/settings/device/portal', { device });
            cfgMsg(id, j.message, 'ok');
        } catch (e) { cfgMsg(id, e.message, 'err'); }
    };

    window.cfgTestTg = async function () {
        cfgMsg('c-msg-telegram', '…', 'work');
        try {
            await post('/api/settings', collect('telegram'));      // simpan token/chat ID dulu
            const j = await post('/api/settings/telegram/test', {});
            cfgMsg('c-msg-telegram', j.message || t('set.tgTestOk'), 'ok');
        } catch (e) { cfgMsg('c-msg-telegram', e.message, 'err'); }
    };

    // Uji kunci Gemini memakai nilai yang sedang diketik (belum tentu disimpan), jadi
    // pesan "kunci salah" langsung kelihatan tanpa menulis ke .env lebih dulu.
    window.cfgTestAi = async function () {
        cfgMsg('c-msg-ai', '…', 'work');
        try {
            const j = await post('/api/ai/test', { apiKey: val('c-ai-key'), model: val('c-ai-model') });
            cfgMsg('c-msg-ai', t('cfg.aiTestOk', { r: j.reply || '' }), 'ok');
        } catch (e) { cfgMsg('c-msg-ai', e.message, 'err'); }
    };

    window.cfgPush = async function (device) {
        const p = device === 'esp32' ? 'c-e32' : 'c-d';
        const id = device === 'esp32' ? 'c-msg-esp32' : 'c-msg-door';
        const dhcp = chk(p + '-dhcp');
        const body = {
            device,
            ssid: val(p + '-ssid'), pass: val(p + '-pass'), dhcp,
            ip: val(p + '-newip'), gw: val(p + '-gw'), mask: val(p + '-mask'), dns: val(p + '-dns'),
            apiKey: val(p + '-newkey'), deviceKey: val(p + '-devkey')
        };
        if (!dhcp) {
            const ip = body.ip;
            if (!ip) return cfgMsg(id, t('cfg.pushIp') + '?', 'err');
            if (!body.mask) body.mask = '255.255.255.0';
        }
        cfgMsg(id, '…', 'work');
        try {
            const j = await post('/api/settings/device/push', body);
            cfgMsg(id, j.message, 'ok');
        } catch (e) { cfgMsg(id, e.message, 'err'); }
    };

    window.cfgGen = function (id) {
        const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        const a = new Uint8Array(24);
        crypto.getRandomValues(a);
        const el = document.getElementById(id);
        if (el) el.value = 'nlx-' + Array.from(a, x => abc[x % abc.length]).join('');
    };

    window.cfgCopy = async function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        try { await navigator.clipboard.writeText(el.value); if (window.uiToast) uiToast(t('cfg.copied'), 'ok'); } catch { el.select(); }
    };

    // Ikut berganti bahasa bersama sisa halaman (tanpa menghapus isian yang belum disimpan)
    const prevApply = window.applyLang;
    window.applyLang = function () {
        if (prevApply) prevApply();
        if (S) render();
    };
    const prevSetLang = window.setLang;
    window.setLang = async function (lang) {
        const r = prevSetLang ? await prevSetLang(lang) : undefined;
        if (document.getElementById('settings-root')) loadSettings();     // teks kartu ikut bahasa baru
        return r;
    };
})();
