/**
 * js/webrtc-stream.js
 * Modul Streaming WebRTC Peer-to-Peer SKAWAN TV
 * SMK Negeri 1 Pacitan
 * 
 * Versi Stabil v3.4: 
 * - Dual State Watcher (connectionState + iceConnectionState)
 * - Anti-Hang Zombie Calls Watchdog
 * - Direct Receive-Only Clean Answer
 * - Multi-Provider STUN Redundancy
 */

class SkawanStreamer {
  constructor(options = {}) {
    this.rawRoomToken = (options.roomToken || 'SKASA').trim().toUpperCase();
    this.roomToken = this.rawRoomToken.replace(/[^A-Z0-9]/g, '').toLowerCase() || 'skasa';
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    
    this.peer = null;
    this.peerId = null;
    this.activeCalls = new Map();
    // Penerima stream murni: Switcher, PD, Admin Inspector, Viewer, Audio-VT, CG
    this.isReceiver = ['switcher', 'pd', 'admin', 'viewer', 'inspector', 'audio_vt', 'cg'].includes(this.roleKey);
    this.dbRef = null;
    this.isDestroyed = false;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
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
    const cleanToken = this.roomToken.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'skasa';
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
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        sdpSemantics: 'unified-plan'
      }
    };

    try {
      this.peer = new Peer(this.peerId, peerOptions);
    } catch (e) {
      this.peer = new Peer(peerOptions);
    }

    this.peer.on('open', (id) => {
      console.log(`[WebRTC Streamer] Peer terhubung ke server: ${id} (${this.roleKey})`);
      this.peerId = id;
      this._registerToFirebase(id);
      this._listenTargetPeers();

      if (!this.isReceiver) {
        this.onStatusChange('ready', 'Siap (Menunggu Switcher/PD)');
        this._startHeartbeat();
        this._startWatchdog();
      } else {
        this.onStatusChange('ready', 'Penerima Siap');
      }
    });

    this.peer.on('error', (err) => {
      console.warn('[WebRTC Streamer Error Event]:', err.type, err.message);

      // Tangani peer-unavailable sebagai target yang belum online (bukan error fatal kamera)
      if (err.type === 'peer-unavailable') {
        this.activeCalls.forEach((call, targetRole) => {
          if (call.peer === err.peer) this.activeCalls.delete(targetRole);
        });

        // Hapus ID yang sudah tidak berlaku dari cache lokal
        Object.keys(this.knownPeers).forEach(key => {
          if (this.knownPeers[key] && this.knownPeers[key].peerId === err.peer) {
            delete this.knownPeers[key];
          }
        });

        this._updateConnectionStatus();
        return;
      }

      if (err.type === 'invalid-id' || err.type === 'unavailable-id') {
        this.peer.destroy();
        this.peer = new Peer(peerOptions);
      } else if (err.type === 'disconnected' || err.type === 'network') {
        if (!this.peer.destroyed) {
          try { this.peer.reconnect(); } catch(e){}
        }
      }

      this.onStatusChange('error', err.type || 'Koneksi jaringan');
    });

    // RECEIVER (Switcher / PD / Viewer): Menjawab panggilan kamera studio
    this.peer.on('call', (call) => {
      console.log('[WebRTC Streamer] Panggilan video masuk dari:', call.peer);

      // Jawab panggilan secara bersih tanpa memasukkan track dummy audio
      try {
        call.answer();
      } catch (err) {
        const dummyStream = this._createActiveCanvasStream();
        call.answer(dummyStream || undefined);
      }

      call.on('stream', (remoteStream) => {
        const rawRole = call.metadata?.role || this._extractRoleFromPeer(call.peer) || 'cam_1';
        const normRole = rawRole.includes('_') ? rawRole : rawRole.replace('cam', 'cam_');
        console.log(`[WebRTC Streamer] Stream video aktif diterima dari: ${normRole}`);
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
      if (!snapshot.exists() || this.isDestroyed) {
        this.knownPeers = {};
        this._updateConnectionStatus();
        return;
      }
      this.knownPeers = snapshot.val() || {};

      if (!this.isReceiver && this.localStream) {
        this._pushStreamToTargets();
      }
    });
  }

  _pushStreamToTargets() {
    if (!this.knownPeers || !this.localStream || this.isDestroyed) return;

    const receiverTargetKeys = ['switcher', 'pd', 'admin', 'inspector'];

    Object.keys(this.knownPeers).forEach(key => {
      const p = this.knownPeers[key];
      if (!p || !p.peerId) return;
      if (p.peerId === this.peerId) return;

      if (receiverTargetKeys.includes(key) || key.startsWith('viewer_') || key.startsWith('inspector_')) {
        this._callTarget(key, p.peerId);
      }
    });
  }

  _callTarget(targetRole, targetPeerId) {
    if (!this.peer || this.peer.disconnected || this.isDestroyed || !this.localStream) return;

    const existingCall = this.activeCalls.get(targetRole);
    if (existingCall) {
      if (existingCall.peer === targetPeerId) {
        const pc = existingCall.peerConnection;
        if (pc) {
          const isConnected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
          const isConnecting = pc.connectionState === 'connecting' || pc.iceConnectionState === 'checking';
          if (isConnected || isConnecting) {
            return;
          }
        }
      }
      try { existingCall.close(); } catch(e){}
      this.activeCalls.delete(targetRole);
    }

    try {
      console.log(`[WebRTC Streamer] Menghubungkan ke ${targetRole} (${targetPeerId})...`);
      
      const call = this.peer.call(targetPeerId, this.localStream, {
        metadata: { role: this.roleKey }
      });
      if (!call) return;

      call._callStartTime = Date.now();
      this.activeCalls.set(targetRole, call);

      const checkState = () => {
        this._updateConnectionStatus();
      };

      if (call.peerConnection) {
        const pc = call.peerConnection;
        pc.onconnectionstatechange = () => {
          console.log(`[WebRTC Streamer] State ${targetRole}: ${pc.connectionState}`);
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            this.activeCalls.delete(targetRole);
          }
          checkState();
        };

        pc.oniceconnectionstatechange = () => {
          console.log(`[WebRTC Streamer] ICE State ${targetRole}: ${pc.iceConnectionState}`);
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            this.activeCalls.delete(targetRole);
          }
          checkState();
        };
      }

      call.on('close', () => {
        this.activeCalls.delete(targetRole);
        checkState();
      });

      call.on('error', (err) => {
        console.warn(`[WebRTC Streamer] Panggilan ke ${targetRole} ditutup/error:`, err);
        this.activeCalls.delete(targetRole);
        checkState();
      });

      this._updateConnectionStatus();
    } catch (err) {
      console.warn('[WebRTC Streamer] Gagal memanggil target:', err);
      this.activeCalls.delete(targetRole);
    }
  }

  _isCallConnected(call) {
    if (!call || !call.peerConnection) return false;
    const pc = call.peerConnection;
    return pc.connectionState === 'connected' || 
           pc.iceConnectionState === 'connected' || 
           pc.iceConnectionState === 'completed';
  }

  _updateConnectionStatus() {
    if (this.isReceiver || this.isDestroyed) return;

    const connectedRoles = [];
    this.activeCalls.forEach((call, role) => {
      if (this._isCallConnected(call)) {
        connectedRoles.push(role.toUpperCase());
      }
    });

    if (connectedRoles.length > 0) {
      this.onStatusChange('connected', `Terhubung ke ${connectedRoles.join(' & ')}`);
    } else if (this.activeCalls.size > 0) {
      this.onStatusChange('connecting', 'Menghubungkan ke Studio...');
    } else {
      this.onStatusChange('ready', 'Siap (Menunggu Switcher/PD)');
    }
  }

  _startWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    // Evaluasi setiap 4 detik untuk membersihkan panggilan hantu/zombie
    this.watchdogTimer = setInterval(() => {
      if (this.isDestroyed || this.isReceiver) return;

      const now = Date.now();
      let cleaned = false;

      this.activeCalls.forEach((call, role) => {
        const isConn = this._isCallConnected(call);
        const startTime = call._callStartTime || 0;
        // Jika sudah lebih dari 7 detik belum juga terhubung, buang sambungan lama
        if (!isConn && (now - startTime > 7000)) {
          console.warn(`[WebRTC Watchdog] Membuang panggilan zombie ke ${role} (${call.peer})`);
          try { call.close(); } catch(e){}
          this.activeCalls.delete(role);
          cleaned = true;
        }
      });

      if (cleaned) {
        this._updateConnectionStatus();
        this._pushStreamToTargets();
      }
    }, 4000);
  }

  _startHeartbeat() {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = setInterval(() => {
      if (this.isDestroyed) return;
      if (!this.isReceiver && this.localStream && this.peer && !this.peer.disconnected) {
        this._pushStreamToTargets();
      }
    }, 3000);
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
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.dbRef) {
      this.dbRef.remove().catch(() => {});
    }
    this.activeCalls.forEach((call) => {
      try { call.close(); } catch(e){}
    });
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
