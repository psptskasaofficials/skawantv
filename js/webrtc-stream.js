/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer dengan Firebase Auto-Discovery
 * SKAWAN TV - SMK Negeri 1 Pacitan
 * 
 * Mengalirkan feed kamera HP (camera.html) secara langsung ke Switcher, PD, & Live Viewer.
 */

class SkawanStreamer {
  constructor(options = {}) {
    this.rawRoomToken = options.roomToken || 'STUDIO-1';
    this.roomToken = this.rawRoomToken.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    
    this.peer = null;
    this.peerId = null;
    this.activeCalls = new Map();
    // Mendukung role receiver: Switcher, Program Director, Admin Inspector, dan Publik Viewer
    this.isReceiver = ['switcher', 'pd', 'admin', 'viewer'].includes(this.roleKey);
    this.dbRef = null;
    this.isDestroyed = false;

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
    // Format aman mematuhi regex PeerJS: /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/
    // DILARANG menggunakan tanda hubung berturut-turut seperti '--' atau '---'
    const cleanToken = this.roomToken.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'studio1';
    const cleanRole = this.roleKey.toLowerCase().replace(/[^a-z0-9]/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `skawan-${cleanToken}-${cleanRole}-${randomSuffix}`;
  }

  _extractRoleFromPeerId(peerId) {
    if (typeof peerId !== 'string') return 'cam_1';
    
    // 1. Ekstraksi format baku: skawan-[token]-[role]-[suffix]
    const parts = peerId.split('-');
    if (parts.length >= 4) {
      const role = parts[2].toLowerCase();
      // Normalisasi format cam1 / cam_1 -> cam_1
      const numMatch = role.match(/cam([0-9]+)/);
      if (numMatch) return `cam_${numMatch[1]}`;
      return role;
    }

    // 2. Ekstraksi fallback jika format lain digunakan
    const camMatch = peerId.match(/cam_?([0-9]+)/i);
    if (camMatch) {
      return `cam_${camMatch[1]}`;
    }

    if (peerId.includes('switcher')) return 'switcher';
    if (peerId.includes('pd')) return 'pd';
    if (peerId.includes('viewer')) return 'viewer';

    return peerId;
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

    this.peer.on('open', (id) => {
      console.log(`[WebRTC Streamer] Peer terdaftar: ${id} (${this.roleKey})`);
      this.peerId = id;
      this.onStatusChange('ready', `ID: ${id}`);

      this._registerToFirebase(id);
      this._listenTargetPeers();
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Streamer Error]:', err.type, err.message);
      if (err.type === 'peer-unavailable') {
        this.activeCalls.forEach((call, targetRole) => {
          if (call.peer === err.peer) this.activeCalls.delete(targetRole);
        });
      }
      this.onStatusChange('error', err.type);
    });

    // Menangani panggilan video masuk (Untuk Receiver: Switcher / PD / Viewer)
    this.peer.on('call', (call) => {
      console.log('[WebRTC Streamer] Menerima panggilan video masuk dari:', call.peer);

      // Jawab panggilan dengan stream asli jika ada, atau dummy stream aktif agar handshake tuntas
      const streamToAnswer = this.localStream || this._createActiveCanvasStream();
      if (streamToAnswer) {
        call.answer(streamToAnswer);
      } else {
        call.answer();
      }

      call.on('stream', (remoteStream) => {
        console.log('[WebRTC Streamer] Video stream masuk dari:', call.peer);
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.set(role, call);
        this.onRemoteStream(role, remoteStream);
      });

      call.on('close', () => {
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(role);
      });

      call.on('error', (err) => {
        console.warn('[WebRTC Streamer] Call error:', err);
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(role);
      });
    });
  }

  _registerToFirebase(id) {
    const activeDb = this._getDb();
    if (!activeDb) {
      setTimeout(() => this._registerToFirebase(id), 1000);
      return;
    }

    // Registrasi unik untuk setiap peer (viewer dapat memiliki banyak instance)
    const registerKey = this.roleKey === 'viewer' ? `viewer_${this.peerId.split('-').pop()}` : this.roleKey;
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
      const peers = snapshot.val();

      // PUSH STREAM DARI KAMERA HP KE SWITCHER, PD, DAN VIEWER
      if (!this.isReceiver && this.localStream) {
        if (peers.switcher && peers.switcher.peerId) {
          this._callTargetPeer('switcher', peers.switcher.peerId);
        }
        if (peers.pd && peers.pd.peerId) {
          this._callTargetPeer('pd', peers.pd.peerId);
        }
        // Hubungi seluruh viewer yang sedang online
        Object.keys(peers).forEach(key => {
          if (key.startsWith('viewer_') && peers[key] && peers[key].peerId) {
            this._callTargetPeer(key, peers[key].peerId);
          }
        });
      }

      // RECEIVER (SWITCHER / PD / VIEWER): Panggil kamera jika belum terhubung
      if (this.isReceiver) {
        Object.keys(peers).forEach((key) => {
          if (key.startsWith('cam_') && peers[key] && peers[key].peerId) {
            if (!this.activeCalls.has(key)) {
              this._callTargetPeer(key, peers[key].peerId);
            }
          }
        });
      }
    });
  }

  _callTargetPeer(targetRole, targetPeerId) {
    if (!this.peer || this.peer.disconnected || this.isDestroyed) return;
    if (this.activeCalls.has(targetRole)) return; // Sudah terhubung

    try {
      console.log(`[WebRTC Streamer] Menghubungi ${targetRole} (${targetPeerId})...`);
      
      const streamToSend = this.localStream || this._createActiveCanvasStream();
      const call = this.peer.call(targetPeerId, streamToSend);
      if (!call) return;

      this.activeCalls.set(targetRole, call);

      call.on('stream', (remoteStream) => {
        console.log(`[WebRTC Streamer] Stream diterima dari ${targetRole}`);
        this.onRemoteStream(targetRole, remoteStream);
        this.onStatusChange('connected', `Terhubung ke ${targetRole}`);
      });

      call.on('close', () => {
        this.activeCalls.delete(targetRole);
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC Streamer] Panggilan ke ${targetRole} gagal:`, err);
        this.activeCalls.delete(targetRole);
      });
    } catch (err) {
      console.warn('[WebRTC Streamer] Exception saat memanggil target:', err);
      this.activeCalls.delete(targetRole);
    }
  }

  _createActiveCanvasStream() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 4, 4);
      }
      return canvas.captureStream ? canvas.captureStream(1) : null;
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
  }

  destroy() {
    this.isDestroyed = true;
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
