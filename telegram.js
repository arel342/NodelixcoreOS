const E = (k, d) => (process.env[k] === undefined || process.env[k] === '') ? d : process.env[k];
const WAIT_MS = 5000;

module.exports = ({ esp32, door, setWebEnabled, isWebEnabled }) => {
    const token = E('TELEGRAM_BOT_TOKEN', '');
    const chatId = E('TELEGRAM_CHAT_ID', '');
    let offset = 0, running = false, timer = null;

    async function api(method, body = {}, timeout = 35000) {
        const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout)
        });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${r.status}`);
        return data.result;
    }

    async function send(text, target = chatId) {
        if (!token || !target) return false;
        await api('sendMessage', { chat_id: target, text });
        return true;
    }

    const help = [
        '🤖 Perintah NodelixcoreOS:',
        '/status — status ESP32, baterai, DHT11, relay, pintu, dan web',
        '/battery — pantau baterai',
        '/dht — suhu dan kelembapan DHT11',
        '/relay <nomor|all> <on|off> — kendalikan relay ESP32',
        '/door on|off — aktif/nonaktifkan akses kartu RFID',
        '/open — buka pintu melalui server',
        '/close — tutup/kunci pintu',
        '/addcard [nama] — tambah kartu; tempelkan kartu saat diminta',
        '/cancelcard — batalkan tambah kartu',
        '/web off|on — matikan/nyalakan hanya web dan WebSocket',
        '/help — tampilkan bantuan'
    ].join('\n');

    function batteryText() {
        const s = esp32.snapshot(), b = s.battery;
        if (!s.online) return '⚠️ ESP32 sedang offline.';
        if (!b) return '🔋 Data baterai belum tersedia. Periksa sensor dan konfigurasi tap pada ESP32.';
        return `🔋 Baterai ${b.soc.toFixed(0)}% · pack ${b.pack.toFixed(2)} V · sel terendah ${b.min.toFixed(2)} V · ${b.status}`;
    }

    function dhtText() {
        const s = esp32.snapshot(), d = s.dht;
        if (!s.online) return '⚠️ ESP32 sedang offline.';
        if (!d || !d.ok || !Number.isFinite(d.t) || !Number.isFinite(d.h))
            return '🌡️ Data DHT11 belum tersedia. Periksa sensor, kabel GPIO 4, dan firmware ESP32.';
        return `🌡️ Suhu ${d.t.toFixed(1)} °C · kelembapan ${d.h.toFixed(0)}%`;
    }

    function statusText() {
        const e = esp32.snapshot(), d = door.snapshot();
        const relays = e.relays.length
            ? e.relays.map(r => `R${r.id} ${r.name}: ${r.on ? 'ON' : 'OFF'}`).join('\n')
            : 'Belum ada data relay.';
        const aux = e.aux ? `\nKeluaran pendamping GPIO ${e.aux.on_pin}/${e.aux.off_pin}: ${e.aux.on ? 'ON' : 'OFF'}/${e.aux.off ? 'ON' : 'OFF'}` : '';
        return [
            '📊 Status NodelixcoreOS',
            `📡 ESP32: ${e.online ? 'online' : 'offline'}`,
            batteryText(),
            dhtText(),
            '🔌 Relay:\n' + relays + aux,
            `🚪 Pintu: ${d.online ? 'online' : 'offline'} · lock kartu ${d.enabled ? 'aktif' : 'nonaktif'} (${d.synced ? 'sinkron' : 'belum sinkron'}) · pintu ${d.open ? 'terbuka' : 'terkunci'}`,
            `🌐 Web: ${isWebEnabled() ? 'aktif' : 'mati'}`
        ].join('\n');
    }

    async function command(message) {
        const text = String(message.text || '').trim();
        const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
        if (!match) return;
        const cmd = match[1].toLowerCase(), args = (match[2] || '').trim();

        try {
            if (cmd === 'start' || cmd === 'help') return send(help, message.chat.id);
            if (cmd === 'status') return send(statusText(), message.chat.id);
            if (cmd === 'battery') return send(batteryText(), message.chat.id);
            if (cmd === 'dht') return send(dhtText(), message.chat.id);

            if (cmd === 'relay') {
                const m = /^(all|[1-9]\d*)\s+(on|off)$/i.exec(args);
                if (!m) return send('Format: /relay <nomor|all> <on|off>', message.chat.id);
                await esp32.setRelay(m[1].toLowerCase() === 'all' ? 'all' : Number(m[1]), m[2].toLowerCase() === 'on');
                return send(`✅ Relay ${m[1]} ${m[2].toUpperCase()}.`, message.chat.id);
            }

            if (cmd === 'door') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /door on atau /door off', message.chat.id);
                const enabled = args.toLowerCase() === 'on';
                const state = await door.setEnabled(enabled);
                if (!state.synced) {
                    return send(`⚠️ Pengaturan ${enabled ? 'lock kartu aktif' : 'lock kartu mati'} tersimpan, tetapi ESP8266 belum mengonfirmasi sinkronisasi. Status saat ini: ${door.snapshot().online ? 'sinkronisasi tertunda' : 'ESP8266 offline'}. Periksa /status sebelum mengandalkan perubahan ini.`, message.chat.id);
                }
                return send(enabled
                    ? '🔐 Lock kartu RFID aktif kembali.'
                    : '🔒 Lock kartu RFID dimatikan. Kartu biasa tidak dapat membuka pintu; kartu admin tetap bisa.', message.chat.id);
            }

            if (cmd === 'open') {
                await door.open();
                return send('🔓 Pintu dibuka melalui Telegram.', message.chat.id);
            }

            if (cmd === 'close') {
                await door.close();
                return send('🔒 Pintu dikunci kembali.', message.chat.id);
            }

            if (cmd === 'addcard') {
                await door.enroll(args, true);
                const name = args ? ` "${args}"` : '';
                return send(`💳 Mode tambah kartu${name} aktif selama ${door.snapshot().enroll.total} detik. Tempelkan kartu sekarang.`, message.chat.id);
            }

            if (cmd === 'cancelcard') {
                await door.cancelEnroll();
                return send('❌ Mode tambah kartu dibatalkan.', message.chat.id);
            }

            if (cmd === 'web') {
                if (!/^(on|off)$/i.test(args)) return send('Format: /web on atau /web off', message.chat.id);
                const enabled = args.toLowerCase() === 'on';
                if (enabled) {
                    await setWebEnabled(true);
                    return send('🌐 Web dan WebSocket aktif kembali. Bot Telegram serta polling ESP32/pintu tetap berjalan.', message.chat.id);
                }
                await send('🌙 Web dan WebSocket akan dimatikan. Bot Telegram serta polling ESP32/pintu tetap berjalan; kirim /web on untuk menyalakannya lagi.', message.chat.id);
                setTimeout(() => setWebEnabled(false).catch(e => console.error('[Web]', e.message)), 500);
                return;
            }

            return send('Perintah tidak dikenal. Kirim /help untuk bantuan.', message.chat.id);
        } catch (e) {
            return send(`⚠️ Perintah gagal: ${e.message}`, message.chat.id);
        }
    }

    async function poll() {
        if (!running) return;
        try {
            const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000);
            for (const update of updates) {
                offset = update.update_id + 1;
                const message = update.message;
                if (!message || !message.text || !message.chat || message.chat.type !== 'private') continue;
                if (String(message.chat.id) !== chatId) {
                    console.warn(chatId
                        ? `[Telegram] Perintah diabaikan dari chat yang tidak diizinkan (${message.chat.id}).`
                        : `[Telegram] Isi TELEGRAM_CHAT_ID=${message.chat.id} di .env untuk mengizinkan bot bagi chat pribadi ini.`);
                    continue;
                }
                await command(message);
            }
        } catch (e) {
            if (running) console.error('[Telegram] Polling gagal:', e.message);
        }
        if (running) timer = setTimeout(poll, WAIT_MS);
    }

    async function start() {
        if (!token) {
            console.log('[Telegram] Bot dinonaktifkan: TELEGRAM_BOT_TOKEN belum diisi.');
            return;
        }
        if (!chatId) console.warn('[Telegram] Isi TELEGRAM_CHAT_ID dengan ID chat Telegram pribadi admin sebelum memakai bot.');
        try {
            const pending = await api('getUpdates', { timeout: 0, allowed_updates: ['message'] }, 8000);
            if (pending.length) {
                offset = pending[pending.length - 1].update_id + 1;
                if (!chatId) {
                    const ids = [...new Set(pending.map(u => u.message).filter(m => m && m.chat && m.chat.type === 'private').map(m => m.chat.id))];
                    if (ids.length) console.log(`[Telegram] Isi TELEGRAM_CHAT_ID di .env dengan salah satu ID chat pribadi ini: ${ids.join(', ')}`);
                }
            }
        } catch (e) {
            console.error('[Telegram] Gagal menyiapkan polling:', e.message);
        }
        running = true;
        poll();
    }

    return {
        start,
        welcome() {
            if (!token || !chatId) return Promise.resolve(false);
            return send('👋 Selamat datang di NodelixcoreOS!\n✅ Bot siap. Gunakan /help untuk melihat perintah yang tersedia.').catch(e => {
                console.error('[Telegram] Gagal mengirim pesan sambutan:', e.message);
                return false;
            });
        },
        stop() {
            running = false;
            clearTimeout(timer);
        }
    };
};
