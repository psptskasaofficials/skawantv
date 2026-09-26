/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer dengan Firebase Auto-Discovery
 * SKAWAN TV - SMK Negeri 1 Pacitan
 * 
 * Mengalirkan feed kamera HP (camera.html) secara langsung ke konsol Switcher & PD.
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

    this._initPeer();
  }

  _generatePeerId() {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    // Format ID unik: skawan-{roomToken}-{roleKey}-{random}
    return `skawan-${this.roomToken}-${this.roleKey}-${randomSuffix}`;
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
      console.log(`[WebRTC] Peer terdaftar: ${id}`);
      this.peerId = id;
      this.onStatusChange('ready', `ID: ${id}`);

      // Daftarkan Peer ID ini ke Firebase agar Switcher/PD & Kamera saling menemukan
      this._registerToFirebase(id);
      this._listenOtherPeers();
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Error]:', err.type, err.message);
      if (err.type === 'peer-unavailable') {
        // Hapus dari cache pemanggilan agar bisa dicoba kembali
        this.activeCalls.forEach((call, targetRole) => {
          if (call.peer === err.peer) this.activeCalls.delete(targetRole);
        });
      }
      this.onStatusChange('error', err.type);
    });

    // Menangani panggilan video masuk
    this.peer.on('call', (call) => {
      console.log('[WebRTC] Menerima panggilan dari:', call.peer);

      if (this.localStream) {
        // Jika ini adalah kamera HP, balas dengan stream kamera asli
        call.answer(this.localStream);
      } else {
        // Jika ini Switcher / PD, jawab untuk menerima stream
        call.answer();
      }

      call.on('stream', (remoteStream) => {
        console.log('[WebRTC] Video stream diterima dari:', call.peer);
        const role = this._extractRoleFromPeerId(call.peer);
        this.onRemoteStream(role, remoteStream);
      });

      call.on('close', () => {
        const role = this._extractRoleFromPeerId(call.peer);
        this.activeCalls.delete(role);
      });
    });
  }

  _registerToFirebase(id) {
    if (typeof db !== 'undefined' && db) {
      this.dbRef = db.ref(`rooms/${this.rawRoomToken}/peers/${this.roleKey}`);
      this.dbRef.set({
        peerId: id,
        role: this.roleKey,
        online: true,
        updatedAt: Date.now()
      });

      // Hapus data pendaftaran saat pengguna keluar / browser ditutup
      this.dbRef.onDisconnect().remove();
    }
  }

  _listenOtherPeers() {
    if (typeof db === 'undefined' || !db) return;

    // Pantau peers di Firebase
    db.ref(`rooms/${this.rawRoomToken}/peers`).on('value', (snapshot) => {
      if (!snapshot.exists()) return;
      const peers = snapshot.val();

      // JIKA INI KAMERA HP: Otomatis kirim video ke Switcher & PD jika mereka online
      if (!this.isReceiver && this.localStream) {
        if (peers.switcher && peers.switcher.peerId) {
          this._callTargetPeer('switcher', peers.switcher.peerId);
        }
        if (peers.pd && peers.pd.peerId) {
          this._callTargetPeer('pd', peers.pd.peerId);
        }
      }

      // JIKA INI SWITCHER / PD: Hubungi semua kamera yang online
      if (this.isReceiver) {
        Object.keys(peers).forEach((key) => {
          if (key.startsWith('cam_') && peers[key] && peers[key].peerId) {
            this._callTargetPeer(key, peers[key].peerId);
          }
        });
      }
    });
  }

  _callTargetPeer(targetRole, targetPeerId) {
    if (!this.peer || this.peer.disconnected) return;
    if (this.activeCalls.has(targetRole)) return; // Sudah terhubung

    try {
      console.log(`[WebRTC] Menghubungi ${targetRole} (${targetPeerId})...`);
      
      // Jika kamera HP: kirim localStream asli. Jika receiver: kirim dummy canvas stream aktif
      const streamToSend = this.localStream || this._createActiveCanvasStream();
      const call = this.peer.call(targetPeerId, streamToSend);
      if (!call) return;

      this.activeCalls.set(targetRole, call);

      call.on('stream', (remoteStream) => {
        console.log(`[WebRTC] Feed masuk dari ${targetRole}`);
        this.onRemoteStream(targetRole, remoteStream);
      });

      call.on('close', () => {
        this.activeCalls.delete(targetRole);
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC] Call error to ${targetRole}:`, err);
        this.activeCalls.delete(targetRole);
      });
    } catch (err) {
      console.warn('[WebRTC] Call exception:', err);
      this.activeCalls.delete(targetRole);
    }
  }

  _createActiveCanvasStream() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 2, 2);
      }
      return canvas.captureStream ? canvas.captureStream(5) : null;
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

  _extractRoleFromPeerId(peerId) {
    const prefix = `skawan-${this.roomToken}-`;
    if (peerId.startsWith(prefix)) {
      const rest = peerId.substring(prefix.length);
      const parts = rest.split('-');
      return parts[0];
    }
    return peerId;
  }

  discoverAndConnectCameras(totalCameras = 4) {
    // Sinkronisasi kini ditangani otomatis oleh _listenOtherPeers() via Firebase
  }

  destroy() {
    if (this.dbRef) {
      this.dbRef.remove();
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
