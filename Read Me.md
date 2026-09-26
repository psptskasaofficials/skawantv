# SKAWAN TV (SKASA Wahana Televisi)
### Platform Web Simulasi Produksi Siaran Televisi Real-Time
**SMK Negeri 1 Pacitan &bull; Jurusan Broadcasting & Perfilman**

---

## 📌 Sekilas Program
**SKAWAN TV** adalah platform web terdistribusi yang dirancang khusus untuk pembelajaran praktik simulasi produksi siaran multi-kamera di studio televisi. Sistem ini menghubungkan berbagai perangkat (laptop kru dan smartphone siswa) secara serempak dan *real-time* tanpa memerlukan instalasi perangkat lunak rumit, memanfaatkan teknologi web modern (**HTML5**, **Tailwind CSS**, **Firebase Realtime Database**, dan **WebRTC / PeerJS**).

---

## 🗂️ Struktur File & Arsitektur Sistem

```text
skawan-tv/
├── index.html          # Gerbang utama: Login guru & pemilihan peran siswa
├── admin.html          # Master Control Room (MCR): Konfigurasi sesi & kontrol krisis
├── creative.html       # Workspace Tim Kreatif: Rundown mata acara real-time
├── pd.html             # Command Center Program Director: Multiview & Quick Cues
├── switcher.html       # Video Switcher: Konsol emulasi ATEM Mini Pro
├── audio-vt.html       # Audio & VT Deck: 6-Ch Virtual Mixer & Pemutar VT (YouTube/Drive)
├── cg.html             # Character Generator: Kontrol Lower Third, Bug Logo, & Ticker
├── fd.html             # Floor Director Desk: Countdown Timer & Studio Tally
├── camera.html         # Viewfinder HP Kamerawan: Tally Full-Frame & WebRTC Broadcast
├── panduan-vt.md       # Panduan teknis memasukkan video klip VT
├── README.md           # Panduan & dokumentasi sistem lengkap
└── js/
    ├── firebase-config.js  # Kunci koneksi Firebase Realtime Database
    └── webrtc-stream.js    # Modul streaming video WebRTC kamera HP ke Multiview
```

---

## 👥 Peran Kru & Alur Tugas Kerja

| Posisi | File Halaman | Perangkat Utama | Tugas & Tanggung Jawab |
|---|---|---|---|
| **Guru / Instruktur** | `admin.html` | Laptop / PC | Membuka sesi ruangan, mengatur kuota kamera, memulai siaran (*ON-AIR*), dan menyuntikkan simulasi kendala teknis (*Crisis Injection*). |
| **Tim Kreatif** | `creative.html` | Laptop / Tablet | Menyusun urutan segmen acara (*rundown*), menghitung akumulasi durasi waktu, serta menuliskan deskripsi aksi talent dan arahan teknis. |
| **Program Director (PD)** | `pd.html` | Laptop / Layar Ganda | Sutradara siaran yang memantau multiview semua kamera, mengawasi sisa waktu rundown, serta memberi instruksi suara/aba-aba makro ke seluruh divisi. |
| **Video Switcher** | `switcher.html` | Laptop (Keyboard) | Mengoperasikan konsol ATEM untuk memotong gambar (*CUT*), transisi halus (*AUTO* / Dissolve), dan *Fade to Black* (FTB) sesuai komando PD. |
| **Audio & VT Operator** | `audio-vt.html` | Laptop / Tablet | Mengatur fader volume mikrofon presenter/tamu, memutar video klip VT (*YouTube* atau *Google Drive*), dan memantau VU Meter. |
| **Graphic Operator (CG)** | `cg.html` | Laptop / Tablet | Menayangkan dan menghapus grafis nama/jabatan (*Lower Third*), logo stasiun TV, dan teks berita berjalan (*Ticker*). |
| **Floor Director (FD)** | `fd.html` | Smartphone / Tablet | Menghitung mundur waktu di depan talent, memandu pandangan mata host ke kamera aktif (*Studio Tally*), serta memberi isyarat tangan siaran. |
| **Kamerawan (Cam 1..N)** | `camera.html` | Smartphone Android/iOS | Mengambil gambar framing kamera studio (360p hemat bandwidth) dengan panduan bingkai Tally otomatis (*Merah On-Air*, *Hijau Standby*). |

---

## 🚀 Panduan Memulai Simulasi (Langkah Demi Langkah)

### 1. Persiapan Koneksi Firebase
1. Buat proyek di [Firebase Console](https://console.firebase.google.com/).
2. Aktifkan **Realtime Database** (disarankan region **Singapore** `asia-southeast1`).
3. Pada tab **Rules**, atur izin baca dan tulis ke `true`:
   ```json
   {
     "rules": {
       ".read": true,
       ".write": true
     }
   }
   ```
4. Salin objek konfigurasi Firebase ke file `js/firebase-config.js`.

### 2. Guru Membuka Ruangan
1. Guru membuka halaman `index.html` $\rightarrow$ klik tab **Master Control (Guru)**.
2. Masukkan kata sandi: `admin`.
3. Di halaman `admin.html`, masukkan Nama Program (misal: *Bincang Sore SKAWAN*), Token Studio (misal: `STUDIO-1`), dan jumlah kamera HP siswa (1–4 kamera).
4. Klik **"Buka Lobby Studio"**.

### 3. Siswa Masuk & Mengambil Peran
1. Setiap siswa membuka `index.html` melalui peramban di laptop atau smartphone masing-masing.
2. Siswa memasukkan **Token Ruangan** (misal: `STUDIO-1`) dan **Nama Lengkap**.
3. Di layar pemilihan peran, siswa memilih salah satu posisi yang masih kosong (slot yang sudah dipilih otomatis terkunci bagi siswa lain).
4. Siswa menunggu di ruang tunggu (*Waiting Room*).

### 4. Memulai Siaran (ON-AIR)
1. Setelah semua posisi terisi, Guru menekan tombol hijau **"MULAI SIARAN (ON-AIR)"** pada `admin.html`.
2. Seluruh layar laptop dan HP siswa seketika dialihkan secara otomatis ke *workspace* perannya masing-masing.
3. Simulasi siaran langsung studio dimulai mengikuti panduan rundown dan komando sutradara.

---

## ⚡ Fitur Latihan Krisis Siaran (Crisis Injection)
Guru dapat memicu situasi darurat tak terduga secara langsung dari `admin.html`:
* **Cam 1 Loss Video:** Feed kamera 1 berubah menjadi *No Signal* dan memperingatkan Switcher untuk segera melakukan *Cut* darurat ke kamera cadangan.
* **VT Freeze / Glitch:** Mensimulasikan pemutar video VT yang mendadak macet saat siaran berlangsung.
* **Time Crunch (-60 Detik):** Memotong durasi segmen secara drastis untuk melatih kesiapan Floor Director memberi isyarat *Wrap Up* ke pembawa acara.
* **CG System Crash:** Menghilangkan lapisan teks grafis *Lower Third* dari layar siaran secara mendadak.

---

## 🛠️ Lisensi & Hak Cipta
Dikembangkan untuk kebutuhan praktikum kejuruan pertelevisian **SMK Negeri 1 Pacitan (SKASA)**.
Dapat digunakan dan dikembangkan secara bebas untuk keperluan edukasi penyiaran di Indonesia.