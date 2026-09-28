/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer SKAWAN TV
 * SMK Negeri 1 Pacitan
 * 
 * Arsitektur: Camera Push Stream (Publisher -> Receiver) dengan metadata peran eksplisit.
 */

class SkawanStreamer {
  constructor(options = {}) {
    this.rawRoomToken = (options.roomToken || 'STUDIO-1').trim().toUpperCase();
    this.roomToken = this.rawRoomToken.replace(/[^A-Z0-9]/g, '').toLowerCase() || 'studio1';
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    
    this.peer = null;
    this.peerId = null;
    this.activeCalls = new Map();
    // Penerima stream murni: Switcher, PD, Admin Inspector, dan Penonton Publik
    this.isReceiver = ['switcher', 'pd', 'admin', 'viewer', 'inspector'].includes(this.roleKey);
    this.dbRef = null;
    this.isDestroyed = false;
    this.reconnectTimer = null;
    this.knownPeers = {};

    this._initPeer();
  }

  _getDb() {
    if (window.db) return window.db;
    if (typeof firebase !== 'undefined' && firebase.database) {
      window.db = firebase.database();
      return window.db;
    }
    return null;
  }

  _generatePeerId() {
    // Format alfanumerik murni tanpa simbol agar bebas dari kesalahan invalid-id
    const cleanToken = this.roomToken.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'studio1';
    const cleanRole = this.roleKey.toLowerCase().replace(/[^a-z0-9]/g, '') || 'cam1';
    const randomSuffix = Math.floor(10000 + Math.random() * 90000);
    return `skawan${cleanToken}${cleanRole}${randomSuffix}`;
  }

  _initPeer() {
    if (typeof Peer === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      script.onload = () => this._createPeerInstance();
      script.onerror = () => {
        console.warn('[WebRTC] Gagal memuat CDN PeerJS.');
        this.onStatusChange('error', 'Gagal memuat pustaka WebRTC');
      };
      document.head.appendChild(script);
    } else {
      this._createPeerInstance();
    }
  }

  _createPeerInstance() {
    if (this.isDestroyed) return;
    this.peerId = this._generatePeerId();

    const peerOptions = {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ]
      }
    };

    try {
      this.peer = new Peer(this.peerId, peerOptions);
    } catch (e) {
      this.peer = new Peer(peerOptions);
    }

    this.peer.on('open', (id) => {
      console.log(`[WebRTC Streamer] Peer terhubung: ${id} (${this.roleKey})`);
      this.peerId = id;
      this.onStatusChange('ready', `ID: ${id.substring(0, 12)}...`);

      this._registerToFirebase(id);
      this._listenTargetPeers();

      // Mulai heartbeat auto-reconnect untuk kamera
      if (!this.isReceiver) {
        this._startHeartbeat();
      }
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Streamer Error]:', err.type, err.message);
      if (err.type === 'invalid-id' || err.type === 'unavailable-id') {
        this.peer.destroy();
        this.peer = new Peer(peerOptions);
      } else if (err.type === 'peer-unavailable') {
        this.activeCalls.forEach((call, targetRole) => {
          if (call.peer === err.peer) this.activeCalls.delete(targetRole);
        });
      }
      this.onStatusChange('error', err.type || 'Koneksi error');
    });

    // RECEIVER (Switcher / PD / Viewer): Menerima dan menjawab panggilan kamera
    this.peer.on('call', (call) => {
      console.log('[WebRTC Streamer] Panggilan masuk dari:', call.peer);

      // Jawab dengan dummy canvas track aktif agar negosiasi SDP berjalan mulus di semua browser
      const dummyStream = this._createActiveCanvasStream();
      call.answer(dummyStream || undefined);

      call.on('stream', (remoteStream) => {
        // Ambil nama peran langsung dari metadata panggilan atau dari mapping peer ID
        const rawRole = call.metadata?.role || this._extractRoleFromPeer(call.peer) || 'cam_1';
        const normRole = rawRole.includes('_') ? rawRole : rawRole.replace('cam', 'cam_');
        console.log(`[WebRTC Streamer] Stream aktif diterima dari: ${normRole}`);
        this.activeCalls.set(normRole, call);
        this.activeCalls.set(rawRole, call);
        this.onRemoteStream(normRole, remoteStream);
      });

      call.on('close', () => {
        const rawRole = call.metadata?.role || this._extractRoleFromPeer(call.peer);
        if (rawRole) {
          const normRole = rawRole.includes('_') ? rawRole : rawRole.replace('cam', 'cam_');
          this.activeCalls.delete(rawRole);
          this.activeCalls.delete(normRole);
        }
      });

      call.on('error', (err) => {
        console.warn('[WebRTC Streamer] Call error:', err);
        const rawRole = call.metadata?.role || this._extractRoleFromPeer(call.peer);
        if (rawRole) {
          const normRole = rawRole.includes('_') ? rawRole : rawRole.replace('cam', 'cam_');
          this.activeCalls.delete(rawRole);
          this.activeCalls.delete(normRole);
        }
      });
    });
  }

  _registerToFirebase(id) {
    const activeDb = this._getDb();
    if (!activeDb) {
      setTimeout(() => this._registerToFirebase(id), 1000);
      return;
    }

    const registerKey = this.roleKey === 'viewer' ? `viewer_${id.substring(id.length - 4)}` : this.roleKey;
    this.dbRef = activeDb.ref(`rooms/${this.rawRoomToken}/peers/${registerKey}`);
    this.dbRef.set({
      peerId: id,
      role: this.roleKey,
      online: true,
      updatedAt: Date.now()
    });

    this.dbRef.onDisconnect().remove();
  }

  _listenTargetPeers() {
    const activeDb = this._getDb();
    if (!activeDb) {
      setTimeout(() => this._listenTargetPeers(), 1000);
      return;
    }

    activeDb.ref(`rooms/${this.rawRoomToken}/peers`).on('value', (snapshot) => {
      if (!snapshot.exists() || this.isDestroyed) return;
      this.knownPeers = snapshot.val() || {};

      // PUBLISHER (KAMERA HP): Kirim stream ke Switcher, PD, dan Seluruh Receiver
      if (!this.isReceiver && this.localStream) {
        this._pushStreamToTargets();
      }
    });
  }

  _pushStreamToTargets() {
    if (!this.knownPeers || !this.localStream || this.isDestroyed) return;

    const receiverTargetKeys = ['switcher', 'pd', 'cg', 'inspector', 'audio_vt'];

    Object.keys(this.knownPeers).forEach(key => {
      const p = this.knownPeers[key];
      if (!p || !p.peerId) return;
      if (p.peerId === this.peerId) return; // Jangan panggil diri sendiri

      if (receiverTargetKeys.includes(key) || key.startsWith('viewer_') || key.startsWith('inspector_')) {
        this._callTarget(key, p.peerId);
      }
    });
  }

  _callTarget(targetRole, targetPeerId) {
    if (!this.peer || this.peer.disconnected || this.isDestroyed || !this.localStream) return;

    // Cek apakah ada panggilan yang sedang aktif ke target ini
    const existingCall = this.activeCalls.get(targetRole);
    if (existingCall) {
      // Jika masih terhubung ke peerId yang sama persis dan status open, pertahankan
      if (existingCall.peer === targetPeerId && existingCall.open) {
        return;
      }
      // Jika peerId target berubah (misal Switcher / PD di-refresh), tutup panggilan lama
      try { existingCall.close(); } catch(e){}
      this.activeCalls.delete(targetRole);
    }

    try {
      console.log(`[WebRTC Streamer] Menghubungkan ke ${targetRole} (${targetPeerId})...`);
      
      const call = this.peer.call(targetPeerId, this.localStream, {
        metadata: { role: this.roleKey }
      });
      if (!call) return;

      this.activeCalls.set(targetRole, call);

      call.on('stream', () => {
        this.onStatusChange('connected', `Terhubung ke ${targetRole.toUpperCase()}`);
      });

      call.on('close', () => {
        this.activeCalls.delete(targetRole);
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC Streamer] Panggilan ke ${targetRole} terputus:`, err);
        this.activeCalls.delete(targetRole);
      });

      this.onStatusChange('connected', `Tersambung ke ${targetRole.toUpperCase()}`);
    } catch (err) {
      console.warn('[WebRTC Streamer] Gagal memanggil target:', err);
      this.activeCalls.delete(targetRole);
    }
  }

  _startHeartbeat() {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    // Cek setiap 2.5 detik untuk memastikan koneksi ke Switcher & PD tetap hidup
    this.reconnectTimer = setInterval(() => {
      if (this.isDestroyed) return;
      if (!this.isReceiver && this.localStream && this.peer && !this.peer.disconnected) {
        this._pushStreamToTargets();
      }
    }, 2500);
  }

  _extractRoleFromPeer(peerId) {
    if (!peerId) return 'cam_1';
    const match = peerId.match(/cam_?([0-9]+)/i);
    if (match) return `cam_${match[1]}`;
    if (peerId.includes('switcher')) return 'switcher';
    if (peerId.includes('pd')) return 'pd';
    return peerId;
  }

  _createActiveCanvasStream() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 16, 16);
      }
      if (canvas.captureStream) {
        const stream = canvas.captureStream(5);
        // Segarkan kanvas secara berkala agar track dianggap aktif oleh peramban
        setInterval(() => {
          if (ctx && !this.isDestroyed) {
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, 16, 16);
          }
        }, 1000);
        return stream;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  updateLocalStream(newStream) {
    this.localStream = newStream;
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
    // Picu pengiriman jika belum ada panggilan aktif
    if (this.activeCalls.size === 0) {
      this._pushStreamToTargets();
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
