// ============================================================================
// skills.js — "Skill" yang diberikan ke AI Agent agar tahu kemampuan server.
//
// Setiap skill menjelaskan satu kemampuan yang bisa dijalankan AI Agent. Daftar
// ini juga dipakai untuk membangun system prompt (agar AI tahu ia berada di
// server NodelixcoreOS dan bisa mengontrol ESP32, lock door, Termux, file, dll).
// ============================================================================
const skills = [
    { name: 'get_status', description: 'Baca status server: ESP32 (baterai, DHT11, relay), lock door (pintu RFID), dan web.' },
    { name: 'set_relay', description: 'Nyalakan/matikan relay ESP32 (id: nomor relay atau "all", state: true/false).' },
    { name: 'open_door', description: 'Buka pintu melalui server (lock door).' },
    { name: 'close_door', description: 'Kunci/tutup pintu.' },
    { name: 'set_door_enabled', description: 'Aktif/nonaktifkan akses kartu RFID pada lock door.' },
    { name: 'enroll_card', description: 'Mode tambah kartu RFID baru (opsional nama pemilik).' },
    { name: 'run_command', description: 'Jalankan perintah shell di server (Termux). Hanya untuk perintah yang diminta pengguna.' },
    { name: 'list_files', description: 'Daftar file/folder di penyimpanan (flash disk) server.' }
];

const systemPrompt = [
    'Kamu adalah AI Agent NodelixcoreOS yang berjalan di server Node.js/Express milik pengguna.',
    'Server ini mengelola file/storage, perangkat ESP32 (monitor baterai, DHT11, relay), lock door (ESP8266 RFID), terminal Termux, dan bot Telegram.',
    'Kamu boleh memanggil skill (function) yang tersedia untuk mengontrol perangkat dan menjalankan perintah sesuai permintaan pengguna.',
    'Selalu jawab dalam bahasa Indonesia yang singkat dan jelas. Konfirmasikan tindakan yang dilakukan.',
    'Jangan menjalankan perintah berbahaya (hapus sistem, format disk, dll) tanpa konfirmasi pengguna.',
    'Skill yang tersedia: ' + skills.map(s => s.name + ' - ' + s.description).join('; ')
].join('\n');

module.exports = { skills, systemPrompt, SKILLS: skills };
