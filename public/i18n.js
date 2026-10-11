// Terjemahan web: Indonesia (id), English (en), 中文 (zh).
// Bahasa aktif tersimpan di server (.env LANGUAGE) + localStorage; berlaku untuk semua
// tulisan: menu, tombol, tabel, popup, toast, sampai pesan error dari server.
(function () {
    const DICT = {
        id: {
            'app.title': 'Server Dashboard & Storage',
            'locale': 'id-ID',
            'nav.dashboard': 'Dashboard', 'nav.monitor': 'Monitor PLTS', 'nav.door': 'Pintu RFID',
            'nav.storage': 'Storage', 'nav.system': 'Sistem', 'nav.settings': 'Pengaturan', 'nav.logout': 'Logout',
            'hdr.ip': 'IP Server:',
            'c.serverOff': 'Server tidak terjangkau', 'c.cancel': 'Batal', 'c.save': 'Simpan', 'c.failed': 'Gagal',

            'login.title': 'server dashboard', 'login.user': 'username', 'login.pass': 'Password',
            'login.wrong': 'username atau password salah', 'login.signin': 'Sign In', 'login.forgot': 'Forgot Password?',
            'login.connFail': 'Gagal terhubung ke server!',
            'fg.title': 'Forgot password?',
            'fg.desc': 'Enter the verification code sent from your Telegram to continue changing your password.',
            'fg.ph': 'Enter Verification Code', 'fg.btn': 'Reset password',
            'fg.sending': 'Mengirim kode ke Telegram...', 'fg.tgFail': 'Gagal terhubung ke Telegram!', 'fg.verifyFail': 'Verifikasi Gagal!',
            'rs.title': 'Enter new password', 'rs.pass': 'Password', 'rs.hint': 'Must be 8 characters or more',
            'rs.confirm': 'Confirm password', 'rs.btn': 'Confirm', 'rs.redirect': 'Mengalihkan...', 'rs.fail': 'Gagal memperbarui password!',

            'topo.internet': 'Internet', 'topo.device': 'device({n})', 'topo.lockdoor': 'lock door',
            'topo.sensor': 'sensor', 'topo.online': 'online', 'topo.offline': 'offline',

            'tm.hm': '{h} j {m} m', 'tm.m': '{m} m', 'tm.h': '{h} j',

            'mon.connecting': 'Menghubungkan ke ESP32…', 'mon.online': 'ESP32 online', 'mon.noResp': 'ESP32 tidak merespons',
            'mon.up': 'menyala {t}', 'mon.packV': 'Tegangan pack 3S', 'mon.soc': 'SoC ≈', 'mon.cell': 'Sel {n}',
            'mon.loadAC': 'Beban AC', 'mon.vaEst': 'VA (estimasi)', 'mon.peak': 'puncak',
            'mon.relays': 'Kontrol relay', 'mon.allOff': 'Matikan semua', 'mon.alerts': 'Peringatan', 'mon.allNormal': 'Semua normal',
            'mon.calTitle': 'Kalibrasi dan koreksi nilai',
            'mon.calDesc': 'Ukur dengan multimeter, isi nilai sebenarnya, lalu Kalibrasi. Faktor koreksi disimpan di server.',
            'mon.izero': 'Arus: noise tanpa beban', 'mon.izeroBtn': 'Ukur nol', 'mon.measuring': 'Mengukur…',
            'mon.igain': 'Arus: skala (clamp meter)', 'mon.igainPh': 'Ampere', 'mon.calBtn': 'Kalibrasi', 'mon.calReset': 'Reset kalibrasi',
            'mon.noiseScale': 'noise {f} A · skala ×{g}', 'mon.tapRead': '{name}: terbaca', 'mon.tapPh': 'V multimeter',
            'mon.notePack': 'Hanya pack yang diukur, jadi tegangan sel = pack ÷ 3 (rata-rata). Aktifkan tap 1S/2S di firmware untuk tegangan per sel.',
            'mon.noteDelta': 'Selisih sel tertinggi dan terendah {v} V',
            'mon.ok': 'Berhasil', 'mon.allOffMsg': 'Semua relay akan dimatikan.', 'mon.allOffTitle': 'Matikan semua relay?',
            'mon.allOffOk': 'Matikan', 'mon.calResetMsg': 'Semua faktor koreksi kembali ke nilai awal.',
            'mon.calResetTitle': 'Reset kalibrasi?', 'mon.calResetOk': 'Reset', 'mon.on': 'ON', 'mon.off': 'OFF',
            'mon.dht': 'Suhu & kelembapan (DHT11)', 'mon.temp': 'Suhu', 'mon.hum': 'Kelembapan',
            'mon.dhtOk': 'Sensor OK', 'mon.dhtErr': 'Sensor tidak terbaca', 'mon.dhtOld': 'Firmware belum mendukung DHT11',
            'mon.dhtFail': 'gagal baca {n}×', 'mon.aux': 'Pendamping Relay 1 & 2',

            'bat.normal': 'Normal', 'bat.high': 'Tegangan berlebih', 'bat.crit': 'Kritis', 'bat.low': 'Rendah', 'bat.full': 'Penuh',
            'esp.alert.crit': 'Sel baterai KRITIS {v} V. Matikan beban!', 'esp.alert.low': 'Baterai rendah, sel terendah {v} V',
            'esp.alert.high': 'Tegangan sel berlebih {v} V', 'esp.alert.delta': 'Sel tidak seimbang, selisih {v} V',
            'esp.alert.amp': 'Arus AC tinggi {a} A',
            'esp.alert.clip': 'Sinyal ACS712 melewati batas ADC ESP32. Kurangi beban atau pakai pembagi tegangan.',

            'd.connecting': 'Menghubungkan…', 'd.statusDoor': 'Status pintu',
            'd.locked': 'TERKUNCI', 'd.lockedSub': 'Tempel kartu terdaftar untuk membuka pintu',
            'd.offlineBig': 'OFFLINE', 'd.offSub': 'Modul pintu (ESP8266) tidak terdeteksi', 'd.noCfgSub': 'DOOR_IP belum diisi di file .env',
            'd.openBig': 'TERBUKA', 'd.openSub': 'Terkunci lagi dalam {s} dtk',
            'd.deadBig': 'LOCK DOOR MATI', 'd.deadSub': 'Kartu sah pun tidak membuka pintu (LCD: LOCK)',
            'd.openBtn': 'Buka pintu (tanpa kartu)', 'd.closeBtn': 'Kunci sekarang',
            'd.lockOffBtn': 'Matikan lock door', 'd.lockOnBtn': 'Aktifkan lock door',
            'd.stateOnline': 'Modul pintu online', 'd.stateOffline': 'Modul pintu offline', 'd.stateNoCfg': 'Modul pintu belum dikonfigurasi',
            'd.syncing': 'menyinkronkan kartu…', 'd.metaUp': 'menyala {t}',
            'd.secTitle': 'Waktu relay terbuka', 'd.secUnit': 'dtk',
            'd.secHint0': '0 detik = pulsa singkat 0,3 detik (untuk pemicu gerbang/strike)',
            'd.secHintN': 'Relay menyala {s} detik setiap pintu dibuka', 'd.save': 'Simpan',
            'd.addTitle': 'Tambah kartu baru',
            'd.addHint1': 'Setelah ditekan, tempelkan kartu baru ke reader dalam', 'd.addHint2': 'detik. Kartu tersimpan otomatis dan namanya bisa diubah.',
            'd.addBtn': '+ Tambah kartu baru', 'd.enrolling': 'Tempelkan kartu ke reader…', 'd.enrollLcd': 'LCD menampilkan "Tambah kartu".',
            'd.cancel': 'Batal', 'd.cardsTitle': 'Kartu terdaftar', 'd.logTitle': 'Riwayat akses',
            'd.emptyCards': 'Belum ada kartu. Klik "Tambah kartu baru" lalu tempelkan kartu ke reader.', 'd.emptyLog': 'Belum ada aktivitas.',
            'd.never': 'belum pernah dipakai', 'd.justNow': 'dipakai baru saja',
            'd.minAgo': 'dipakai {n} mnt lalu', 'd.hrAgo': 'dipakai {n} jam lalu', 'd.dayAgo': 'dipakai {n} hari lalu',
            'd.failCode': 'Gagal ({c})', 'd.opened': 'Pintu dibuka', 'd.closed': 'Pintu dikunci',
            'd.lockConfirmMsg': 'Kartu tidak akan bisa membuka pintu sampai lock door diaktifkan lagi. Tombol "Buka pintu" di server tetap berfungsi.',
            'd.lockConfirmTitle': 'Matikan lock door?', 'd.lockConfirmOk': 'Matikan',
            'd.enrollOk': 'Tempelkan kartu baru ke reader', 'd.enrollCancelOk': 'Tambah kartu dibatalkan',
            'd.renamePrompt': 'Nama kartu (maks. 24 karakter)', 'd.renameTitle': 'Ubah nama kartu', 'd.renamed': 'Nama kartu diubah',
            'd.delMsg': 'Kartu "{name}" tidak akan bisa membuka pintu lagi.', 'd.delTitle': 'Hapus kartu?', 'd.delOk': 'Hapus',
            'd.deleted': 'Kartu dihapus', 'd.ariaRename': 'Ubah nama', 'd.ariaDel': 'Hapus kartu',
            'dlog.open': 'Pintu dibuka oleh {name}', 'dlog.lockedTap': '{name} menempel kartu, tapi lock door sedang mati',
            'dlog.unknown': 'Kartu belum terdaftar: {uid}', 'dlog.dup': 'Kartu {name} sudah terdaftar',
            'dlog.added': 'Kartu baru ditambahkan: {name} ({uid})', 'dlog.enrollTimeout': 'Waktu tambah kartu habis',
            'dlog.backOnline': 'Modul pintu kembali online', 'dlog.offline': 'Modul pintu offline (tidak merespons)',
            'dlog.remoteOpen': 'Pintu dibuka dari server (tanpa kartu)', 'dlog.remoteClose': 'Pintu dikunci lagi dari server',
            'dlog.lockOn': 'Lock door diaktifkan (kartu bisa membuka pintu)', 'dlog.lockOff': 'Lock door dimatikan (kartu tidak membuka pintu)',
            'dlog.relaySet': 'Waktu relay terbuka diatur {s} detik', 'dlog.relaySetPulse': 'Waktu relay terbuka diatur {s} detik (pulsa singkat)',
            'dlog.enrollStart': 'Mode tambah kartu dimulai ({sec} detik)', 'dlog.renamed': 'Nama kartu {old} diubah menjadi {name}',
            'dlog.deleted': 'Kartu dihapus: {name}',
            'dnote.dupToast': 'Kartu sudah terdaftar: {name}', 'dnote.addedToast': 'Kartu baru ditambahkan: {name}',
            'dnote.timeoutToast': 'Waktu tambah kartu habis',

            'fs.mkFolder': 'Buat Folder', 'fs.upload': 'Upload', 'fs.paste': 'Paste', 'fs.download': 'Download',
            'fs.cut': 'Cut', 'fs.copy': 'Copy', 'fs.checking': 'Memeriksa flash disk…', 'fs.root': 'Root',
            'fs.thName': 'Name', 'fs.thMod': 'Last modified', 'fs.thSize': 'File size', 'fs.thAction': 'Action',
            'fs.selected': '{n} Selected', 'fs.empty': 'Folder ini kosong.', 'fs.retry': 'Coba lagi', 'fs.folder': 'Folder',
            'fs.dlZip': 'Download ZIP', 'fs.rename': 'Rename', 'fs.compress': 'Kompres ZIP', 'fs.delete': 'Delete',
            'fs.mkTitle': 'Buat Folder Baru', 'fs.mkLabel': 'Nama Folder', 'fs.mkPh': 'Masukkan nama folder', 'fs.mkBtn': 'Buat',
            'fs.rnTitle': 'Rename', 'fs.rnLabel': 'Nama Baru', 'fs.cancelBtn': 'Cancel', 'fs.saveBtn': 'Save',
            'fs.delTitle': 'Hapus Item', 'fs.delMsg1': 'Apakah Anda yakin ingin menghapus',
            'fs.delMsg2': '? Item yang dihapus tidak dapat dikembalikan.', 'fs.delBtn': 'Delete',
            'fs.pasteFail': 'Gagal melakukan Paste', 'fs.pasteErr': 'Error saat melakukan Paste',
            'fs.nameEmpty': 'Nama folder tidak boleh kosong', 'fs.mkFail': 'Gagal membuat folder', 'fs.mkErr': 'Error saat membuat folder',
            'fs.cmpMsg': '"{name}" akan dikompres menjadi file ZIP di folder ini. File aslinya tidak berubah.',
            'fs.cmpTitle': 'Kompres ke ZIP', 'fs.cmpOk': 'Kompres', 'fs.cmpBusy': 'Mengompres…',
            'fs.cmpBusySub': '{name}\nJangan tutup halaman ini.', 'fs.cmpDone': 'Berhasil: {name}', 'fs.cmpFail': 'Gagal mengompres',
            'fs.cmpLost': 'Koneksi terputus saat mengompres. Cek hasilnya di daftar file.',
            'fs.rnFail': 'Gagal mengubah nama', 'fs.rnErr': 'Error saat mengubah nama',
            'fs.delFail': 'Gagal menghapus', 'fs.delErr': 'Error saat menghapus', 'fs.upErr': 'Error saat unggah file',

            'up.title': 'Mengunggah file', 'up.cancel': 'Batalkan', 'up.close': 'Tutup',
            'up.checking': 'Memeriksa flash disk…', 'up.saving': 'Menyimpan ke flash disk…', 'up.sending': 'Mengunggah ke server…',
            'up.done': 'Upload selesai', 'up.doneMsg': 'Tersimpan di flash disk · rata-rata {v} Mbps', 'up.fail': 'Upload gagal',
            'up.notReady': 'Flash disk belum siap', 'up.noSpace': 'Ruang flash disk tidak cukup (sisa {free})',
            'up.sessExp': 'Sesi habis, login ulang', 'up.failHttp': 'Upload gagal ({c})', 'up.lost': 'Koneksi terputus',
            'up.aborted': 'Upload dibatalkan', 'up.remain': 'sisa {t}',
            'up.barReady': 'Flash disk siap', 'up.barFree': '{free} kosong dari {total}', 'up.recheck': 'Cek ulang',
            'up.barFail': 'Status penyimpanan tidak terbaca',
            'up.tS': '{s} dtk', 'up.tMS': '{m} mnt {s} dtk', 'up.tHM': '{h} j {m} mnt',

            'ui.info': 'Pemberitahuan', 'ui.ok': 'Berhasil', 'ui.error': 'Terjadi masalah', 'ui.warn': 'Perhatian',
            'ui.ask': 'Konfirmasi', 'ui.okBtn': 'OK', 'ui.yes': 'Ya', 'ui.cancel': 'Batal', 'ui.save': 'Simpan',
            'ui.input': 'Masukkan nilai',

            'set.title': 'Pengaturan', 'set.langTitle': 'Bahasa',
            'set.langDesc': 'Bahasa ini berlaku untuk semua tulisan di web, termasuk popup dan pesan dari server.',
            'set.id': 'Bahasa Indonesia', 'set.en': 'English', 'set.zh': '中文', 'set.saveFail': 'Gagal menyimpan bahasa',

            'term.title': 'Terminal',
            'term.desc': 'Jalankan perintah Termux dari web. Perintah berjalan di HP server sebagai user Termux (untuk root: su -c "perintah"). Proses latar belakang: nohup perintah > log 2>&1 &. Aplikasi layar penuh (nano, vim, top) tidak didukung.',
            'term.warn': 'Hati-hati: siapa pun yang berhasil login bisa menjalankan perintah apa saja di HP ini. Pakai password kuat dan jangan buka port ke internet tanpa HTTPS/VPN.',
            'term.switch': 'Aktifkan terminal', 'term.offMsg': 'Terminal sedang dimatikan. Hidupkan saklar di atas untuk memakainya.',
            'term.ph': 'ketik perintah…', 'term.phInput': 'kirim teks ke perintah yang berjalan…',
            'term.run': 'Jalankan', 'term.send': 'Kirim', 'term.stop': 'Stop', 'term.clear': 'Bersihkan layar',
            'term.histUp': 'Perintah sebelumnya', 'term.histDown': 'Perintah berikutnya', 'term.quick': 'Perintah cepat (isi kolom, belum dijalankan)',
            'term.ready': 'Terminal siap · {who} · shell {shell}',
            'term.attached': 'tersambung kembali ke perintah yang masih berjalan',
            'term.done': 'selesai · kode {c} · {t}', 'term.killed': 'dihentikan ({s}) · {t}',
            'term.cut': '[output lama dipotong]', 'term.lost': 'koneksi terputus, mencoba lagi…',
            'term.sessionEnd': 'Sesi login berakhir. Silakan login ulang.', 'term.toggleFail': 'Gagal mengubah pengaturan terminal',

            'sys.cpu': 'CPU', 'sys.ram': 'RAM', 'sys.flash': 'Flash Disk',
            'sys.usageCpu': 'Penggunaan CPU', 'sys.usageRam': 'Penggunaan RAM',
            'sys.cores': '{n} inti', 'sys.load': 'beban {l}', 'sys.uptime': 'menyala {t}',
            'sys.usedOf': '{used} terpakai dari {total}', 'sys.freeOf': '{free} kosong dari {total}',
            'sys.waiting': 'Menunggu data…', 'sys.unavail': 'Data sistem belum tersedia',
            'sys.samples': '{n} sampel terakhir'
        },
        en: {
            'app.title': 'Server Dashboard & Storage',
            'locale': 'en-US',
            'nav.dashboard': 'Dashboard', 'nav.monitor': 'Solar Monitor', 'nav.door': 'RFID Door',
            'nav.storage': 'Storage', 'nav.system': 'System', 'nav.settings': 'Settings', 'nav.logout': 'Logout',
            'hdr.ip': 'Server IP:',
            'c.serverOff': 'Server unreachable', 'c.cancel': 'Cancel', 'c.save': 'Save', 'c.failed': 'Failed',

            'login.title': 'server dashboard', 'login.user': 'username', 'login.pass': 'Password',
            'login.wrong': 'Incorrect username or password', 'login.signin': 'Sign In', 'login.forgot': 'Forgot Password?',
            'login.connFail': 'Failed to connect to the server!',
            'fg.title': 'Forgot password?',
            'fg.desc': 'Enter the verification code sent from your Telegram to continue changing your password.',
            'fg.ph': 'Enter Verification Code', 'fg.btn': 'Reset password',
            'fg.sending': 'Sending code to Telegram...', 'fg.tgFail': 'Failed to connect to Telegram!', 'fg.verifyFail': 'Verification failed!',
            'rs.title': 'Enter new password', 'rs.pass': 'Password', 'rs.hint': 'Must be 8 characters or more',
            'rs.confirm': 'Confirm password', 'rs.btn': 'Confirm', 'rs.redirect': 'Redirecting...', 'rs.fail': 'Failed to update password!',

            'topo.internet': 'Internet', 'topo.device': 'device({n})', 'topo.lockdoor': 'lock door',
            'topo.sensor': 'sensor', 'topo.online': 'online', 'topo.offline': 'offline',

            'tm.hm': '{h} h {m} min', 'tm.m': '{m} min', 'tm.h': '{h} h',

            'mon.connecting': 'Connecting to ESP32…', 'mon.online': 'ESP32 online', 'mon.noResp': 'ESP32 is not responding',
            'mon.up': 'up {t}', 'mon.packV': '3S pack voltage', 'mon.soc': 'SoC ≈', 'mon.cell': 'Cell {n}',
            'mon.loadAC': 'AC load', 'mon.vaEst': 'VA (estimated)', 'mon.peak': 'peak',
            'mon.relays': 'Relay control', 'mon.allOff': 'Turn all off', 'mon.alerts': 'Alerts', 'mon.allNormal': 'All normal',
            'mon.calTitle': 'Calibration and value correction',
            'mon.calDesc': 'Measure with a multimeter, enter the actual value, then Calibrate. Correction factors are saved on the server.',
            'mon.izero': 'Current: no-load noise', 'mon.izeroBtn': 'Measure zero', 'mon.measuring': 'Measuring…',
            'mon.igain': 'Current: scale (clamp meter)', 'mon.igainPh': 'Amps', 'mon.calBtn': 'Calibrate', 'mon.calReset': 'Reset calibration',
            'mon.noiseScale': 'noise {f} A · scale ×{g}', 'mon.tapRead': '{name}: reads', 'mon.tapPh': 'Multimeter V',
            'mon.notePack': 'Only the pack is measured, so cell voltage = pack ÷ 3 (average). Enable taps 1S/2S in the firmware for per-cell voltage.',
            'mon.noteDelta': 'Difference between highest and lowest cell {v} V',
            'mon.ok': 'Success', 'mon.allOffMsg': 'All relays will be turned off.', 'mon.allOffTitle': 'Turn off all relays?',
            'mon.allOffOk': 'Turn off', 'mon.calResetMsg': 'All correction factors return to defaults.',
            'mon.calResetTitle': 'Reset calibration?', 'mon.calResetOk': 'Reset', 'mon.on': 'ON', 'mon.off': 'OFF',
            'mon.dht': 'Temperature & humidity (DHT11)', 'mon.temp': 'Temperature', 'mon.hum': 'Humidity',
            'mon.dhtOk': 'Sensor OK', 'mon.dhtErr': 'Sensor not reading', 'mon.dhtOld': 'Firmware does not support DHT11 yet',
            'mon.dhtFail': '{n} read errors', 'mon.aux': 'Relay 1 & 2 companion',

            'bat.normal': 'Normal', 'bat.high': 'Overvoltage', 'bat.crit': 'Critical', 'bat.low': 'Low', 'bat.full': 'Full',
            'esp.alert.crit': 'Battery cell CRITICAL {v} V. Turn off the load!', 'esp.alert.low': 'Battery low, lowest cell {v} V',
            'esp.alert.high': 'Cell overvoltage {v} V', 'esp.alert.delta': 'Cells unbalanced, difference {v} V',
            'esp.alert.amp': 'High AC current {a} A',
            'esp.alert.clip': 'ACS712 signal exceeds ESP32 ADC range. Reduce load or use a voltage divider.',

            'd.connecting': 'Connecting…', 'd.statusDoor': 'Door status',
            'd.locked': 'LOCKED', 'd.lockedSub': 'Tap a registered card to open the door',
            'd.offlineBig': 'OFFLINE', 'd.offSub': 'Door module (ESP8266) not detected', 'd.noCfgSub': 'DOOR_IP is not set in the .env file',
            'd.openBig': 'OPEN', 'd.openSub': 'Locks again in {s} s',
            'd.deadBig': 'LOCK OFF', 'd.deadSub': 'Even a valid card will not open the door (LCD: LOCK)',
            'd.openBtn': 'Open door (no card)', 'd.closeBtn': 'Lock now',
            'd.lockOffBtn': 'Disable door lock', 'd.lockOnBtn': 'Enable door lock',
            'd.stateOnline': 'Door module online', 'd.stateOffline': 'Door module offline', 'd.stateNoCfg': 'Door module not configured',
            'd.syncing': 'syncing cards…', 'd.metaUp': 'up {t}',
            'd.secTitle': 'Relay open time', 'd.secUnit': 's',
            'd.secHint0': '0 seconds = short 0.3 s pulse (for gate/strike triggers)',
            'd.secHintN': 'Relay stays on for {s} seconds each time the door opens', 'd.save': 'Save',
            'd.addTitle': 'Add new card',
            'd.addHint1': 'After pressing, tap the new card on the reader within', 'd.addHint2': 'seconds. The card is saved automatically and can be renamed.',
            'd.addBtn': '+ Add new card', 'd.enrolling': 'Tap the card on the reader…', 'd.enrollLcd': 'LCD shows "Add card".',
            'd.cancel': 'Cancel', 'd.cardsTitle': 'Registered cards', 'd.logTitle': 'Access history',
            'd.emptyCards': 'No cards yet. Click "Add new card" then tap the card on the reader.', 'd.emptyLog': 'No activity yet.',
            'd.never': 'never used', 'd.justNow': 'used just now',
            'd.minAgo': 'used {n} min ago', 'd.hrAgo': 'used {n} h ago', 'd.dayAgo': 'used {n} days ago',
            'd.failCode': 'Failed ({c})', 'd.opened': 'Door opened', 'd.closed': 'Door locked',
            'd.lockConfirmMsg': 'Cards will not be able to open the door until the lock is enabled again. The "Open door" button on the server still works.',
            'd.lockConfirmTitle': 'Disable door lock?', 'd.lockConfirmOk': 'Disable',
            'd.enrollOk': 'Tap the new card on the reader', 'd.enrollCancelOk': 'Add card cancelled',
            'd.renamePrompt': 'Card name (max. 24 characters)', 'd.renameTitle': 'Rename card', 'd.renamed': 'Card name updated',
            'd.delMsg': 'Card "{name}" will no longer be able to open the door.', 'd.delTitle': 'Delete card?', 'd.delOk': 'Delete',
            'd.deleted': 'Card deleted', 'd.ariaRename': 'Rename', 'd.ariaDel': 'Delete card',
            'dlog.open': 'Door opened by {name}', 'dlog.lockedTap': '{name} tapped a card, but the door lock is off',
            'dlog.unknown': 'Unregistered card: {uid}', 'dlog.dup': 'Card {name} is already registered',
            'dlog.added': 'New card added: {name} ({uid})', 'dlog.enrollTimeout': 'Add-card time expired',
            'dlog.backOnline': 'Door module is back online', 'dlog.offline': 'Door module offline (not responding)',
            'dlog.remoteOpen': 'Door opened from server (no card)', 'dlog.remoteClose': 'Door locked again from server',
            'dlog.lockOn': 'Door lock enabled (cards can open the door)', 'dlog.lockOff': 'Door lock disabled (cards cannot open the door)',
            'dlog.relaySet': 'Relay open time set to {s} seconds', 'dlog.relaySetPulse': 'Relay open time set to {s} seconds (short pulse)',
            'dlog.enrollStart': 'Add-card mode started ({sec} seconds)', 'dlog.renamed': 'Card name {old} changed to {name}',
            'dlog.deleted': 'Card deleted: {name}',
            'dnote.dupToast': 'Card already registered: {name}', 'dnote.addedToast': 'New card added: {name}',
            'dnote.timeoutToast': 'Add-card time expired',

            'fs.mkFolder': 'New Folder', 'fs.upload': 'Upload', 'fs.paste': 'Paste', 'fs.download': 'Download',
            'fs.cut': 'Cut', 'fs.copy': 'Copy', 'fs.checking': 'Checking flash drive…', 'fs.root': 'Root',
            'fs.thName': 'Name', 'fs.thMod': 'Last modified', 'fs.thSize': 'File size', 'fs.thAction': 'Action',
            'fs.selected': '{n} Selected', 'fs.empty': 'This folder is empty.', 'fs.retry': 'Try again', 'fs.folder': 'Folder',
            'fs.dlZip': 'Download ZIP', 'fs.rename': 'Rename', 'fs.compress': 'Compress ZIP', 'fs.delete': 'Delete',
            'fs.mkTitle': 'Create New Folder', 'fs.mkLabel': 'Folder Name', 'fs.mkPh': 'Enter folder name', 'fs.mkBtn': 'Create',
            'fs.rnTitle': 'Rename', 'fs.rnLabel': 'New Name', 'fs.cancelBtn': 'Cancel', 'fs.saveBtn': 'Save',
            'fs.delTitle': 'Delete Item', 'fs.delMsg1': 'Are you sure you want to delete',
            'fs.delMsg2': '? Deleted items cannot be restored.', 'fs.delBtn': 'Delete',
            'fs.pasteFail': 'Paste failed', 'fs.pasteErr': 'Error while pasting',
            'fs.nameEmpty': 'Folder name cannot be empty', 'fs.mkFail': 'Failed to create folder', 'fs.mkErr': 'Error while creating folder',
            'fs.cmpMsg': '"{name}" will be compressed into a ZIP file in this folder. The original is unchanged.',
            'fs.cmpTitle': 'Compress to ZIP', 'fs.cmpOk': 'Compress', 'fs.cmpBusy': 'Compressing…',
            'fs.cmpBusySub': '{name}\nDo not close this page.', 'fs.cmpDone': 'Done: {name}', 'fs.cmpFail': 'Compression failed',
            'fs.cmpLost': 'Connection lost while compressing. Check the result in the file list.',
            'fs.rnFail': 'Rename failed', 'fs.rnErr': 'Error while renaming',
            'fs.delFail': 'Delete failed', 'fs.delErr': 'Error while deleting', 'fs.upErr': 'Error while uploading file',

            'up.title': 'Uploading file', 'up.cancel': 'Cancel', 'up.close': 'Close',
            'up.checking': 'Checking flash drive…', 'up.saving': 'Saving to flash drive…', 'up.sending': 'Uploading to server…',
            'up.done': 'Upload complete', 'up.doneMsg': 'Saved to flash drive · average {v} Mbps', 'up.fail': 'Upload failed',
            'up.notReady': 'Flash drive is not ready', 'up.noSpace': 'Not enough space on the flash drive ({free} left)',
            'up.sessExp': 'Session expired, please log in again', 'up.failHttp': 'Upload failed ({c})', 'up.lost': 'Connection lost',
            'up.aborted': 'Upload cancelled', 'up.remain': '{t} left',
            'up.barReady': 'Flash drive ready', 'up.barFree': '{free} free of {total}', 'up.recheck': 'Recheck',
            'up.barFail': 'Storage status unreadable',
            'up.tS': '{s} s', 'up.tMS': '{m} min {s} s', 'up.tHM': '{h} h {m} min',

            'ui.info': 'Notice', 'ui.ok': 'Success', 'ui.error': 'Something went wrong', 'ui.warn': 'Warning',
            'ui.ask': 'Confirmation', 'ui.okBtn': 'OK', 'ui.yes': 'Yes', 'ui.cancel': 'Cancel', 'ui.save': 'Save',
            'ui.input': 'Enter a value',

            'set.title': 'Settings', 'set.langTitle': 'Language',
            'set.langDesc': 'This language applies to all text on the web, including popups and server messages.',
            'set.id': 'Bahasa Indonesia', 'set.en': 'English', 'set.zh': '中文', 'set.saveFail': 'Failed to save language',

            'term.title': 'Terminal',
            'term.desc': 'Run Termux commands from the web. Commands run on the server phone as the Termux user (for root: su -c "command"). Background jobs: nohup command > log 2>&1 &. Full-screen apps (nano, vim, top) are not supported.',
            'term.warn': 'Be careful: anyone who manages to log in can run any command on this phone. Use a strong password and do not expose the port to the internet without HTTPS/VPN.',
            'term.switch': 'Enable terminal', 'term.offMsg': 'The terminal is turned off. Switch it on above to use it.',
            'term.ph': 'type a command…', 'term.phInput': 'send text to the running command…',
            'term.run': 'Run', 'term.send': 'Send', 'term.stop': 'Stop', 'term.clear': 'Clear screen',
            'term.histUp': 'Previous command', 'term.histDown': 'Next command', 'term.quick': 'Quick commands (fills the box, does not run)',
            'term.ready': 'Terminal ready · {who} · shell {shell}',
            'term.attached': 'reconnected to a command that is still running',
            'term.done': 'finished · code {c} · {t}', 'term.killed': 'stopped ({s}) · {t}',
            'term.cut': '[older output was cut]', 'term.lost': 'connection lost, retrying…',
            'term.sessionEnd': 'Your login session has ended. Please log in again.', 'term.toggleFail': 'Failed to change the terminal setting',

            'sys.cpu': 'CPU', 'sys.ram': 'RAM', 'sys.flash': 'Flash Drive',
            'sys.usageCpu': 'CPU Usage', 'sys.usageRam': 'RAM Usage',
            'sys.cores': '{n} cores', 'sys.load': 'load {l}', 'sys.uptime': 'up {t}',
            'sys.usedOf': '{used} used of {total}', 'sys.freeOf': '{free} free of {total}',
            'sys.waiting': 'Waiting for data…', 'sys.unavail': 'System data not available yet',
            'sys.samples': 'last {n} samples'
        },
        zh: {
            'app.title': '服务器面板与存储',
            'locale': 'zh-CN',
            'nav.dashboard': '仪表盘', 'nav.monitor': '光伏监控', 'nav.door': 'RFID 门禁',
            'nav.storage': '存储', 'nav.system': '系统', 'nav.settings': '设置', 'nav.logout': '退出登录',
            'hdr.ip': '服务器 IP：',
            'c.serverOff': '无法连接服务器', 'c.cancel': '取消', 'c.save': '保存', 'c.failed': '失败',

            'login.title': '服务器面板', 'login.user': '用户名', 'login.pass': '密码',
            'login.wrong': '用户名或密码错误', 'login.signin': '登录', 'login.forgot': '忘记密码？',
            'login.connFail': '无法连接到服务器！',
            'fg.title': '忘记密码？',
            'fg.desc': '请输入从 Telegram 收到的验证码，以继续修改密码。',
            'fg.ph': '输入验证码', 'fg.btn': '重置密码',
            'fg.sending': '正在发送验证码到 Telegram……', 'fg.tgFail': '无法连接到 Telegram！', 'fg.verifyFail': '验证失败！',
            'rs.title': '输入新密码', 'rs.pass': '密码', 'rs.hint': '至少 8 个字符',
            'rs.confirm': '确认密码', 'rs.btn': '确认', 'rs.redirect': '正在跳转……', 'rs.fail': '密码更新失败！',

            'topo.internet': '互联网', 'topo.device': '设备({n})', 'topo.lockdoor': '门锁',
            'topo.sensor': '传感器', 'topo.online': '在线', 'topo.offline': '离线',

            'tm.hm': '{h} 小时 {m} 分钟', 'tm.m': '{m} 分钟', 'tm.h': '{h} 小时',

            'mon.connecting': '正在连接 ESP32……', 'mon.online': 'ESP32 在线', 'mon.noResp': 'ESP32 无响应',
            'mon.up': '已运行 {t}', 'mon.packV': '3S 电池组电压', 'mon.soc': 'SoC ≈', 'mon.cell': '电芯 {n}',
            'mon.loadAC': '交流负载', 'mon.vaEst': 'VA（估算）', 'mon.peak': '峰值',
            'mon.relays': '继电器控制', 'mon.allOff': '全部关闭', 'mon.alerts': '警告', 'mon.allNormal': '一切正常',
            'mon.calTitle': '校准与数值修正',
            'mon.calDesc': '用万用表测量后填入实际值，然后点击校准。修正系数保存在服务器上。',
            'mon.izero': '电流：空载噪声', 'mon.izeroBtn': '测量零点', 'mon.measuring': '测量中……',
            'mon.igain': '电流：比例（钳形表）', 'mon.igainPh': '安培', 'mon.calBtn': '校准', 'mon.calReset': '重置校准',
            'mon.noiseScale': '噪声 {f} A · 比例 ×{g}', 'mon.tapRead': '{name}：读数', 'mon.tapPh': '万用表电压',
            'mon.notePack': '仅测量电池组，电芯电压 = 电池组 ÷ 3（平均值）。如需单芯电压，请在固件中启用 1S/2S 采样点。',
            'mon.noteDelta': '最高与最低电芯压差 {v} V',
            'mon.ok': '成功', 'mon.allOffMsg': '所有继电器将被关闭。', 'mon.allOffTitle': '关闭所有继电器？',
            'mon.allOffOk': '关闭', 'mon.calResetMsg': '所有修正系数将恢复为默认值。',
            'mon.calResetTitle': '重置校准？', 'mon.calResetOk': '重置', 'mon.on': '开', 'mon.off': '关',
            'mon.dht': '温度与湿度 (DHT11)', 'mon.temp': '温度', 'mon.hum': '湿度',
            'mon.dhtOk': '传感器正常', 'mon.dhtErr': '传感器无读数', 'mon.dhtOld': '固件尚不支持 DHT11',
            'mon.dhtFail': '读取失败 {n} 次', 'mon.aux': '继电器 1 & 2 配套输出',

            'bat.normal': '正常', 'bat.high': '电压过高', 'bat.crit': '严重', 'bat.low': '偏低', 'bat.full': '已满',
            'esp.alert.crit': '电池电芯严重过低 {v} V，请关闭负载！', 'esp.alert.low': '电池电量低，最低电芯 {v} V',
            'esp.alert.high': '电芯电压过高 {v} V', 'esp.alert.delta': '电芯不平衡，压差 {v} V',
            'esp.alert.amp': '交流电流过大 {a} A',
            'esp.alert.clip': 'ACS712 信号超出 ESP32 ADC 范围，请减小负载或使用分压器。',

            'd.connecting': '正在连接……', 'd.statusDoor': '门状态',
            'd.locked': '已上锁', 'd.lockedSub': '刷已注册的卡片开门',
            'd.offlineBig': '离线', 'd.offSub': '未检测到门禁模块（ESP8266）', 'd.noCfgSub': '尚未在 .env 文件中设置 DOOR_IP',
            'd.openBig': '已打开', 'd.openSub': '{s} 秒后重新上锁',
            'd.deadBig': '门锁已关', 'd.deadSub': '即使有效卡片也无法开门（LCD 显示 LOCK）',
            'd.openBtn': '开门（免卡）', 'd.closeBtn': '立即上锁',
            'd.lockOffBtn': '关闭门锁', 'd.lockOnBtn': '启用门锁',
            'd.stateOnline': '门禁模块在线', 'd.stateOffline': '门禁模块离线', 'd.stateNoCfg': '门禁模块尚未配置',
            'd.syncing': '正在同步卡片……', 'd.metaUp': '已运行 {t}',
            'd.secTitle': '继电器开门时间', 'd.secUnit': '秒',
            'd.secHint0': '0 秒 = 0.3 秒短脉冲（用于闸机/电锁触发）',
            'd.secHintN': '每次开门后继电器保持 {s} 秒', 'd.save': '保存',
            'd.addTitle': '添加新卡',
            'd.addHint1': '按下后，请在', 'd.addHint2': '秒内将新卡贴近读卡器。卡片会自动保存，并可修改名称。',
            'd.addBtn': '+ 添加新卡', 'd.enrolling': '请将卡片贴近读卡器……', 'd.enrollLcd': 'LCD 显示“添加卡片”。',
            'd.cancel': '取消', 'd.cardsTitle': '已注册卡片', 'd.logTitle': '开门记录',
            'd.emptyCards': '暂无卡片。点击“添加新卡”，然后将卡片贴近读卡器。', 'd.emptyLog': '暂无记录。',
            'd.never': '从未使用', 'd.justNow': '刚刚使用过',
            'd.minAgo': '{n} 分钟前使用过', 'd.hrAgo': '{n} 小时前使用过', 'd.dayAgo': '{n} 天前使用过',
            'd.failCode': '失败（{c}）', 'd.opened': '门已打开', 'd.closed': '门已上锁',
            'd.lockConfirmMsg': '在重新启用门锁之前，卡片将无法开门。服务器上的“开门”按钮仍可使用。',
            'd.lockConfirmTitle': '关闭门锁？', 'd.lockConfirmOk': '关闭',
            'd.enrollOk': '请将新卡贴近读卡器', 'd.enrollCancelOk': '已取消添加卡片',
            'd.renamePrompt': '卡片名称（最多 24 个字符）', 'd.renameTitle': '修改卡片名称', 'd.renamed': '卡片名称已修改',
            'd.delMsg': '卡片“{name}”将无法再开门。', 'd.delTitle': '删除卡片？', 'd.delOk': '删除',
            'd.deleted': '卡片已删除', 'd.ariaRename': '修改名称', 'd.ariaDel': '删除卡片',
            'dlog.open': '门已由 {name} 打开', 'dlog.lockedTap': '{name} 刷卡了，但门锁处于关闭状态',
            'dlog.unknown': '未注册的卡片：{uid}', 'dlog.dup': '卡片 {name} 已注册',
            'dlog.added': '新卡片已添加：{name}（{uid}）', 'dlog.enrollTimeout': '添加卡片时间已超时',
            'dlog.backOnline': '门禁模块已恢复在线', 'dlog.offline': '门禁模块离线（无响应）',
            'dlog.remoteOpen': '门已从服务器打开（无卡）', 'dlog.remoteClose': '门已从服务器重新上锁',
            'dlog.lockOn': '门锁已启用（卡片可以开门）', 'dlog.lockOff': '门锁已关闭（卡片无法开门）',
            'dlog.relaySet': '继电器开门时间设为 {s} 秒', 'dlog.relaySetPulse': '继电器开门时间设为 {s} 秒（短脉冲）',
            'dlog.enrollStart': '添加卡片模式已开始（{sec} 秒）', 'dlog.renamed': '卡片名称 {old} 已改为 {name}',
            'dlog.deleted': '卡片已删除：{name}',
            'dnote.dupToast': '卡片已注册：{name}', 'dnote.addedToast': '新卡片已添加：{name}',
            'dnote.timeoutToast': '添加卡片时间已超时',

            'fs.mkFolder': '新建文件夹', 'fs.upload': '上传', 'fs.paste': '粘贴', 'fs.download': '下载',
            'fs.cut': '剪切', 'fs.copy': '复制', 'fs.checking': '正在检查 U 盘……', 'fs.root': '根目录',
            'fs.thName': '名称', 'fs.thMod': '修改时间', 'fs.thSize': '文件大小', 'fs.thAction': '操作',
            'fs.selected': '已选 {n} 项', 'fs.empty': '此文件夹为空。', 'fs.retry': '重试', 'fs.folder': '文件夹',
            'fs.dlZip': '下载 ZIP', 'fs.rename': '重命名', 'fs.compress': '压缩为 ZIP', 'fs.delete': '删除',
            'fs.mkTitle': '新建文件夹', 'fs.mkLabel': '文件夹名称', 'fs.mkPh': '输入文件夹名称', 'fs.mkBtn': '创建',
            'fs.rnTitle': '重命名', 'fs.rnLabel': '新名称', 'fs.cancelBtn': '取消', 'fs.saveBtn': '保存',
            'fs.delTitle': '删除项目', 'fs.delMsg1': '确定要删除',
            'fs.delMsg2': '吗？已删除的项目无法恢复。', 'fs.delBtn': '删除',
            'fs.pasteFail': '粘贴失败', 'fs.pasteErr': '粘贴时出错',
            'fs.nameEmpty': '文件夹名称不能为空', 'fs.mkFail': '创建文件夹失败', 'fs.mkErr': '创建文件夹时出错',
            'fs.cmpMsg': '“{name}”将被压缩为此文件夹中的 ZIP 文件，原文件不变。',
            'fs.cmpTitle': '压缩为 ZIP', 'fs.cmpOk': '压缩', 'fs.cmpBusy': '正在压缩……',
            'fs.cmpBusySub': '{name}\n请勿关闭此页面。', 'fs.cmpDone': '成功：{name}', 'fs.cmpFail': '压缩失败',
            'fs.cmpLost': '压缩时连接中断，请在文件列表中检查结果。',
            'fs.rnFail': '重命名失败', 'fs.rnErr': '重命名时出错',
            'fs.delFail': '删除失败', 'fs.delErr': '删除时出错', 'fs.upErr': '上传文件时出错',

            'up.title': '正在上传文件', 'up.cancel': '取消', 'up.close': '关闭',
            'up.checking': '正在检查 U 盘……', 'up.saving': '正在保存到 U 盘……', 'up.sending': '正在上传到服务器……',
            'up.done': '上传完成', 'up.doneMsg': '已保存到 U 盘 · 平均 {v} Mbps', 'up.fail': '上传失败',
            'up.notReady': 'U 盘尚未就绪', 'up.noSpace': 'U 盘空间不足（剩余 {free}）',
            'up.sessExp': '会话已过期，请重新登录', 'up.failHttp': '上传失败（{c}）', 'up.lost': '连接中断',
            'up.aborted': '上传已取消', 'up.remain': '剩余 {t}',
            'up.barReady': 'U 盘就绪', 'up.barFree': '{total} 中剩余 {free}', 'up.recheck': '重新检查',
            'up.barFail': '无法读取存储状态',
            'up.tS': '{s} 秒', 'up.tMS': '{m} 分 {s} 秒', 'up.tHM': '{h} 小时 {m} 分',

            'ui.info': '通知', 'ui.ok': '成功', 'ui.error': '出现问题', 'ui.warn': '注意',
            'ui.ask': '确认', 'ui.okBtn': '确定', 'ui.yes': '是', 'ui.cancel': '取消', 'ui.save': '保存',
            'ui.input': '请输入内容',

            'set.title': '设置', 'set.langTitle': '语言',
            'set.langDesc': '此语言将应用于网页中的所有文字，包括弹窗和服务器消息。',
            'set.id': 'Bahasa Indonesia', 'set.en': 'English', 'set.zh': '中文', 'set.saveFail': '保存语言失败',

            'term.title': '终端',
            'term.desc': '通过网页运行 Termux 命令。命令以 Termux 用户身份在服务器手机上执行（需要 root：su -c "命令"）。后台任务：nohup 命令 > log 2>&1 &。不支持全屏程序（nano、vim、top）。',
            'term.warn': '请注意：任何成功登录的人都可以在这部手机上运行任意命令。请使用强密码，未使用 HTTPS/VPN 时不要把端口暴露到互联网。',
            'term.switch': '启用终端', 'term.offMsg': '终端已关闭。请打开上方开关后使用。',
            'term.ph': '输入命令……', 'term.phInput': '向正在运行的命令发送文字……',
            'term.run': '运行', 'term.send': '发送', 'term.stop': '停止', 'term.clear': '清屏',
            'term.histUp': '上一条命令', 'term.histDown': '下一条命令', 'term.quick': '快捷命令（仅填入输入框，不会运行）',
            'term.ready': '终端就绪 · {who} · shell {shell}',
            'term.attached': '已重新连接到仍在运行的命令',
            'term.done': '已完成 · 退出码 {c} · {t}', 'term.killed': '已停止（{s}）· {t}',
            'term.cut': '[较早的输出已被截断]', 'term.lost': '连接中断，正在重试……',
            'term.sessionEnd': '登录已过期，请重新登录。', 'term.toggleFail': '更改终端设置失败',

            'sys.cpu': 'CPU', 'sys.ram': '内存', 'sys.flash': 'U 盘',
            'sys.usageCpu': 'CPU 使用率', 'sys.usageRam': '内存使用率',
            'sys.cores': '{n} 核', 'sys.load': '负载 {l}', 'sys.uptime': '已运行 {t}',
            'sys.usedOf': '已用 {used} / 共 {total}', 'sys.freeOf': '{total} 中剩余 {free}',
            'sys.waiting': '等待数据……', 'sys.unavail': '暂无系统数据',
            'sys.samples': '最近 {n} 个样本'
        }
    };

    let LANG = 'id';
    try { LANG = localStorage.getItem('srv7.lang') || 'id'; } catch (e) { }

    // t('nav.storage') / t('d.delMsg', { name }) -> teks sesuai bahasa aktif
    window.t = function (key, vars) {
        let s = (DICT[LANG] && DICT[LANG][key] !== undefined ? DICT[LANG][key] : DICT.id[key]);
        if (s === undefined) s = key;
        if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => vars[k] != null ? vars[k] : m);
        return s;
    };
    window.getLang = () => LANG;

    // Tandai tombol bahasa yang sedang aktif di tab Pengaturan
    function updateLangButtons() {
        ['id', 'en', 'zh'].forEach(l => {
            const b = document.getElementById('lang-btn-' + l);
            if (b) b.classList.toggle('lang-active', l === LANG);
        });
    }

    // Terapkan bahasa ke semua elemen statis, lalu minta tiap modul menggambar ulang teks dinamisnya
    window.applyLang = function () {
        document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : LANG;
        document.title = t('app.title');
        document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
        document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
        document.querySelectorAll('[data-cell]').forEach(el => { el.textContent = t('mon.cell', { n: el.dataset.cell }); });
        updateLangButtons();
        try {
            if (typeof renderTableRows === 'function' && document.getElementById('file-table-body')) renderTableRows();
            if (typeof updateUISelectionState === 'function') updateUISelectionState();
            if (typeof mon !== 'undefined' && mon.snap && typeof renderMonitor === 'function') renderMonitor(mon.snap);
            if (typeof dr !== 'undefined' && dr.s && typeof renderDoor === 'function') renderDoor(dr.s);
            if (typeof renderSystem === 'function') renderSystem();
            if (typeof termRender === 'function') termRender();
            if (typeof refreshTopoCount === 'function') refreshTopoCount();
            if (typeof loggedIn !== 'undefined' && loggedIn && typeof loadStorageStatus === 'function') loadStorageStatus();
        } catch (e) { }
    };

    // Ganti bahasa: terapkan langsung, lalu simpan ke server (supaya berlaku juga di perangkat lain)
    window.setLang = async function (l) {
        if (!DICT[l]) return;
        LANG = l;
        try { localStorage.setItem('srv7.lang', l); } catch (e) { }
        applyLang();
        try {
            const r = await fetch('/api/settings/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) });
            const j = await r.json();
            if (!j.success && window.uiToast) uiToast(t('set.saveFail'), 'error');
        } catch (e) { }
    };

    // Samakan dengan bahasa tersimpan di server (dipanggil saat halaman dibuka)
    window.syncLang = async function () {
        try {
            const j = await (await fetch('/api/settings/lang')).json();
            if (j.lang && DICT[j.lang] && j.lang !== LANG) { LANG = j.lang; try { localStorage.setItem('srv7.lang', LANG); } catch (e) { } }
        } catch (e) { }
        applyLang();
    };

    document.addEventListener('DOMContentLoaded', () => { applyLang(); syncLang(); });
})();
