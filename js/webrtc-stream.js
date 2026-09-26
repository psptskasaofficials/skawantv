/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer Teroptimasi SKAWAN TV
 * SMK Negeri 1 Pacitan (SKASA)
 * 
 * Arsitektur: Camera Push Stream -> Switcher & Program Director Receiver
 */

class SkawanStreamer {
  constructor(options = {}) {
    this.rawRoomToken = options.roomToken || 'STUDIO-1';
    this.roomToken = this.rawRoomToken.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    this.peer = null;
    this.peerId = null;
    this.activeCalls = new Map();
    this.isReceiver = ['switcher', 'pd', 'admin'].includes(this.roleKey);
    this.dbRef = null;
    this.reconnectTimer = null;

    this._initPeer();
  }

  _getDb() {
    if (typeof window !== 'undefined' && window.db) return window.db;
    if (typeof db !== 'undefined' && db) return db;
    if (typeof firebase !== 'undefined' && firebase.database) {
      try { return firebase.database(); } catch (e) {}
    }
    return null;
  }

  _generatePeerId() {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `skawan-${this.roomToken}-${this.roleKey}-${randomSuffix}`;
  }

  _initPeer() {
    if (typeof Peer === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      script.onload = () => this._createPeerInstance();
      script.onerror = () => {
        this.onStatusChange('error', 'Gagal memuat pustaka PeerJS');
      };
      document.head.appendChild(script);
    } else {
      this._createPeerInstance();
    }
  }

  _createPeerInstance() {
    this.peerId = this._generatePeerId();

    try {
      this.peer = new Peer(this.peerId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
          ]
        }
      });
    } catch (err) {
      console.warn('[WebRTC] Gagal membuat instance Peer:', err);
      this.onStatusChange('error', 'Browser tidak mendukung WebRTC');
      return;
    }

    this.peer.on('open', (id) => {
      console.log(`[WebRTC] Peer terdaftar: ${id}`);
      this.peerId = id;
      this.onStatusChange('peer_ready', `ID: ${id}`);

      this._registerToFirebase(id);
      this._startPeerDiscovery();
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Error]:', err.type, err.message);
      if (err.type === 'peer-unavailable') {
        this.activeCalls.forEach((call, targetRole) => {
          if (call.peer === err.peer) this.activeCalls.delete(targetRole);
        });
      }
      this.onStatusChange('error', err.type);
    });

    // Receiver (Switcher / PD) mendengarkan panggilan video masuk dari Kamera HP
    this.peer.on('call', (call) => {
      console.log('[WebRTC] Menerima panggilan video dari:', call.peer);

      // Jawab panggilan
      if (this.localStream) {
        call.answer(this.localStream);
      } else {
        call.answer(); // Switcher/PD cukup menjawab tanpa mengirim video balik
      }

      call.on('stream', (remoteStream) => {
        console.log('[WebRTC] Stream video diterima dari:', call.peer);
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.set(role, call);
        this.onRemoteStream(role, remoteStream);
        this.onStatusChange('connected', `Streaming dari ${role.toUpperCase()}`);
      });

      call.on('close', () => {
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(role);
        this.onStatusChange('disconnected', `${role.toUpperCase()} terputus`);
      });

      call.on('error', (err) => {
        console.warn('[WebRTC] Call stream error:', err);
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(role);
      });
    });
  }

  _registerToFirebase(id) {
    const activeDb = this._getDb();
    if (!activeDb) {
      // Coba kembali jika database belum terinisialisasi
      setTimeout(() => this._registerToFirebase(id), 800);
      return;
    }

    this.dbRef = activeDb.ref(`rooms/${this.rawRoomToken}/peers/${this.roleKey}`);
    this.dbRef.set({
      peerId: id,
      role: this.roleKey,
      isCamera: !this.isReceiver,
      online: true,
      updatedAt: Date.now()
    });

    // Bersihkan node saat browser ditutup
    this.dbRef.onDisconnect().remove();
  }

  _startPeerDiscovery() {
    const activeDb = this._getDb();
    if (!activeDb) {
      setTimeout(() => this._startPeerDiscovery(), 1000);
      return;
    }

    // Pantau keberadaan perangkat lain di ruangan yang sama
    activeDb.ref(`rooms/${this.rawRoomToken}/peers`).on('value', (snapshot) => {
      if (!snapshot.exists()) return;
      const peers = snapshot.val();

      // HANYA KAMERA HP yang melakukan inisiasi panggilan (*Push Video*) ke Switcher & PD
      if (!this.isReceiver && this.localStream) {
        if (peers.switcher && peers.switcher.peerId && !this.activeCalls.has('switcher')) {
          this._pushStreamToTarget('switcher', peers.switcher.peerId);
        }
        if (peers.pd && peers.pd.peerId && !this.activeCalls.has('pd')) {
          this._pushStreamToTarget('pd', peers.pd.peerId);
        }
      }
    });
  }

  _pushStreamToTarget(targetRole, targetPeerId) {
    if (!this.peer || this.peer.disconnected || !this.localStream) return;
    if (this.activeCalls.has(targetRole)) return; // Sudah terhubung

    try {
      console.log(`[WebRTC] Kamera mengirimkan video ke ${targetRole} (${targetPeerId})...`);
      this.onStatusChange('connecting', `Menghubungkan ke ${targetRole.toUpperCase()}...`);

      const call = this.peer.call(targetPeerId, this.localStream);
      if (!call) return;

      this.activeCalls.set(targetRole, call);

      call.on('close', () => {
        this.activeCalls.delete(targetRole);
        this.onStatusChange('disconnected', `Terputus dari ${targetRole.toUpperCase()}`);
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC] Call error to ${targetRole}:`, err);
        this.activeCalls.delete(targetRole);
      });

      this.onStatusChange('connected', `Live Feed terkirim ke ${targetRole.toUpperCase()}`);
    } catch (err) {
      console.warn(`[WebRTC] Gagal push stream ke ${targetRole}:`, err);
      this.activeCalls.delete(targetRole);
    }
  }

  updateLocalStream(newStream) {
    this.localStream = newStream;
    // Update track video pada panggilan yang sedang aktif
    this.activeCalls.forEach((call) => {
      if (call.peerConnection) {
        const senders = call.peerConnection.getSenders();
        const newTrack = newStream.getVideoTracks()[0];
        const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
        if (videoSender && newTrack) {
          videoSender.replaceTrack(newTrack).catch((e) => console.warn(e));
        }
      }
    });

    // Panggil ulang jika sebelumnya belum terhubung
    this._startPeerDiscovery();
  }

  _extractRoleFromPeerId(peerId) {
    const prefix = `skawan-${this.roomToken}-`;
    if (peerId.startsWith(prefix)) {
      const rest = peerId.substring(prefix.length);
      const parts = rest.split('-');
      return parts[0];
    }
    return peerId;
  }

  destroy() {
    if (this.dbRef) {
      this.dbRef.remove().catch(() => {});
    }
    this.activeCalls.forEach((call) => call.close());
    this.activeCalls.clear();
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.SkawanStreamer = SkawanStreamer;
}
