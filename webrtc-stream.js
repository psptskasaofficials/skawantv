/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer menggunakan PeerJS
 * Digunakan untuk mengalirkan feed video kamera HP siswa (camera.html)
 * langsung ke monitor Multiview Switcher (switcher.html) dan PD (pd.html).
 */

class SkawanStreamer {
  /**
   * Inisialisasi streamer untuk pengirim (Kamera HP) atau penerima (Switcher/PD)
   * @param {Object} options 
   * @param {string} options.roomToken - Token ruangan studio (misal: STUDIO-1)
   * @param {string} options.roleKey - Kunci peran (misal: 'cam_1', 'switcher', 'pd')
   * @param {MediaStream} [options.localStream] - Stream media lokal dari kamera HP (jika pengirim)
   * @param {Function} [options.onRemoteStream] - Callback saat menerima stream video baru (jika penerima)
   * @param {Function} [options.onStatusChange] - Callback status koneksi WebRTC
   */
  constructor(options = {}) {
    this.roomToken = (options.roomToken || 'STUDIO-1').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.peer = null;
    this.activeCalls = new Map();
    this.isReceiver = ['switcher', 'pd', 'admin'].includes(this.roleKey);

    this._initPeer();
  }

  /**
   * Membuat ID PeerJS yang unik berdasarkan format: skawan-{roomToken}-{roleKey}
   */
  _generatePeerId() {
    if (this.isReceiver) {
      // Receiver memiliki akhiran acak agar beberapa perangkat dengan peran sama tidak saling menabrak ID
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      return `skawan-${this.roomToken}-${this.roleKey}-${randomSuffix}`;
    }
    // Pengirim (Kamera HP) memiliki ID deterministik statis agar mudah dipanggil oleh receiver
    return `skawan-${this.roomToken}-${this.roleKey}`;
  }

  /**
   * Menghubungkan client ke cloud server PeerJS
   */
  _initPeer() {
    // Memuat pustaka PeerJS dari CDN jika belum ada di dokumen
    if (typeof Peer === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      script.onload = () => this._createPeerInstance();
      script.onerror = () => {
        console.warn('[WebRTC] Gagal memuat pustaka PeerJS CDN.');
        this.onStatusChange('error', 'Gagal memuat pustaka WebRTC');
      };
      document.head.appendChild(script);
    } else {
      this._createPeerInstance();
    }
  }

  _createPeerInstance() {
    const peerId = this._generatePeerId();
    
    // Inisialisasi PeerJS dengan STUN server publik Google untuk keandalan NAT traversal jaringan seluler/Wi-Fi
    this.peer = new Peer(peerId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    this.peer.on('open', (id) => {
      console.log(`[WebRTC] Peer terhubung dengan ID: ${id}`);
      this.onStatusChange('connected', `WebRTC Siap (${id})`);

      if (this.isReceiver) {
        // Jika receiver (Switcher/PD), otomatis hubungi semua kamera yang mungkin online
        this.discoverAndConnectCameras();
      }
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Error]:', err.type, err.message);
      this.onStatusChange('error', err.type);
    });

    // Menangani panggilan masuk (Bila kamera HP dipanggil oleh receiver atau sebaliknya)
    this.peer.on('call', (call) => {
      console.log('[WebRTC] Menerima panggilan dari:', call.peer);

      if (this.localStream) {
        // Jika memiliki feed kamera lokal, jawab dengan stream kamera
        call.answer(this.localStream);
      } else {
        // Jika receiver, jawab tanpa mengirimkan stream lokal
        call.answer();
      }

      call.on('stream', (remoteStream) => {
        const callerRole = this._extractRoleFromPeerId(call.peer);
        this.onRemoteStream(callerRole, remoteStream);
      });

      call.on('close', () => {
        const callerRole = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(callerRole);
      });

      const callerRole = this._extractRoleFromPeerId(call.peer);
      this.activeCalls.set(callerRole, call);
    });
  }

  /**
   * Ekstraksi kunci peran dari ID peer (contoh: "skawan-studio1-cam_1" -> "cam_1")
   */
  _extractRoleFromPeerId(peerId) {
    const prefix = `skawan-${this.roomToken}-`;
    if (peerId.startsWith(prefix)) {
      const rest = peerId.substring(prefix.length);
      const parts = rest.split('-');
      return parts[0]; // Mengembalikan 'cam_1', 'cam_2', dsb.
    }
    return peerId;
  }

  /**
   * Memperbarui stream lokal (misalnya saat pengguna berganti kamera depan/belakang)
   */
  updateLocalStream(newStream) {
    this.localStream = newStream;
    // Gantikan track video pada seluruh panggilan aktif yang sedang berlangsung
    this.activeCalls.forEach((call) => {
      if (call.peerConnection) {
        const senders = call.peerConnection.getSenders();
        const newVideoTrack = newStream.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender && newVideoTrack) {
          videoSender.replaceTrack(newVideoTrack).catch(err => console.warn('[WebRTC] ReplaceTrack error:', err));
        }
      }
    });
  }

  /**
   * Digunakan oleh Receiver (Switcher / PD) untuk memanggil kamera tertentu
   * @param {string} camRoleKey - Contoh: 'cam_1', 'cam_2'
   */
  callCamera(camRoleKey) {
    if (!this.peer || this.peer.disconnected) return;
    const targetPeerId = `skawan-${this.roomToken}-${camRoleKey}`;
    
    // Jangan panggil ulang jika sudah terhubung aktif
    if (this.activeCalls.has(camRoleKey)) return;

    try {
      // Hubungi kamera HP siswa (tanpa mengirimkan stream balik agar hemat bandwidth)
      const call = this.peer.call(targetPeerId, this.localStream || this._createEmptyMediaStream());
      if (!call) return;

      call.on('stream', (remoteStream) => {
        console.log(`[WebRTC] Berhasil menerima feed stream dari ${camRoleKey}`);
        this.onRemoteStream(camRoleKey, remoteStream);
      });

      call.on('close', () => {
        this.activeCalls.delete(camRoleKey);
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC] Gagal menghubungi ${camRoleKey}:`, err);
        this.activeCalls.delete(camRoleKey);
      });

      this.activeCalls.set(camRoleKey, call);
    } catch (err) {
      console.warn('[WebRTC Call Error]:', err);
    }
  }

  /**
   * Receiver memanggil semua kamera HP dalam ruangan secara berkala
   * @param {number} totalCameras 
   */
  discoverAndConnectCameras(totalCameras = 4) {
    if (!this.isReceiver) return;
    for (let i = 1; i <= totalCameras; i++) {
      const camKey = `cam_${i}`;
      this.callCamera(camKey);
    }

    // Ulangi percobaan koneksi setiap 6 detik untuk menangkap kamera siswa yang baru online
    if (!this._discoveryInterval) {
      this._discoveryInterval = setInterval(() => {
        for (let i = 1; i <= totalCameras; i++) {
          const camKey = `cam_${i}`;
          if (!this.activeCalls.has(camKey)) {
            this.callCamera(camKey);
          }
        }
      }, 6000);
    }
  }

  /**
   * Stream kosong sebagai placeholder saat receiver melakukan inisiasi panggilan
   */
  _createEmptyMediaStream() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.captureStream ? canvas.captureStream(1) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Menutup koneksi PeerJS dan membersihkan sumber daya
   */
  destroy() {
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    this.activeCalls.forEach(call => call.close());
    this.activeCalls.clear();
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}

// Mengekspos class ke global window
if (typeof window !== 'undefined') {
  window.SkawanStreamer = SkawanStreamer;
}
