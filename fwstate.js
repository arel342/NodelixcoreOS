// Penanda "sedang update firmware" yang dibagi antar modul (dipakai firmware.js, esp32.js, door.js).
//
// Selama OTA, ESP berhenti menjawab polling sejenak (proses tulis flash + restart), jadi modul
// pintu/monitor tidak boleh menganggapnya benar-benar offline: alarm Telegram "perangkat offline"
// dan pesan "kembali online" palsu harus ditahan sampai proses update selesai.
const busy = { esp8266: null, esp32: null };

module.exports = {
    // isBusy('esp32') -> perangkat itu sedang diupdate; isBusy() -> ada update yang sedang berjalan
    isBusy: device => (device === undefined ? !!(busy.esp8266 || busy.esp32) : !!busy[device]),
    info: device => busy[device] || null,
    // set('esp32', { startedAt }) untuk menandai mulai, set('esp32', null) untuk menandai selesai
    set(device, value) { if (device in busy) busy[device] = value || null; }
};
