/**
 * SKAWAN TV - Native WebRTC Streamer (No PeerJS Dependency)
 * Menggunakan RTCPeerConnection Asli Browser + Firebase Realtime Database Signaling
 * Dilengkapi STUN Google/Cloudflare & TURN OpenRelay (Port 80/443 TCP)
 * Mendukung Multicast: Switcher, Program Director (PD), dan Layar Publik (Viewer)
 */

const SKAWAN_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // TURN Relay Resmi OpenRelay Gratis (Tembus NAT Seluler 4G & Wi-Fi Sekolah)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

class SkawanStreamer {
  constructor(options = {}) {
    this.roomToken = (options.roomToken || 'SKASA').toUpperCase();
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    this.isCamera = this.roleKey.startsWith('cam_');
    this.isReceiver = ['switcher', 'pd', 'audio_vt', 'cg'].includes(this.roleKey) || this.roleKey.startsWith('viewer');

    this.db = this._getDb();
    this.peerConnections = new Map(); // targetRole -> RTCPeerConnection
    this.iceCandidateQueues = new Map(); // targetRole -> Array of RTCIceCandidate
    this.activeRemoteStreams = new Map(); // camRole -> MediaStream
    this.listeners = []; // Firebase listeners untuk cleanup
    this.heartbeatTimer = null;
    this.isDestroyed = false;

    console.log(`[SkawanStreamer] Inisialisasi: Room ${this.roomToken} | Role: ${this.roleKey} (isCamera: ${this.isCamera}, isReceiver: ${this.isReceiver})`);

    this._init();
  }

  _getDb() {
    if (window.db) return window.db;
    if (typeof firebase !== 'undefined' && firebase.database) {
      window.db = firebase.database();
      return window.db;
    }
    return null;
  }

  async _init() {
    if (!this.db) {
      console.warn("[SkawanStreamer] Database Firebase tidak ditemukan!");
      this.onStatusChange('error', 'Firebase belum siap');
      return;
    }

    // 1. Daftarkan kehadiran (presence heartbeat)
    this._registerPresence();

    // 2. Pasang alur pensinyalan berdasarkan peran
    if (this.isCamera) {
      this.onStatusChange('connecting', 'Mencari Switcher / PD / Viewer...');
      this._setupCameraSignaling();
    } else if (this.isReceiver) {
      this.onStatusChange('ready', 'Siap menerima feed kamera studio');
      this._setupReceiverSignaling();
    }
  }

  _registerPresence() {
    const presenceRef = this.db.ref(`rooms/${this.roomToken}/peers/${this.roleKey}`);
    const updatePresence = () => {
      if (this.isDestroyed) return;
      presenceRef.set({
        online: true,
        lastSeen: Date.now()
      }).catch(() => {});
    };

    updatePresence();
    presenceRef.onDisconnect().remove();
    this.heartbeatTimer = setInterval(updatePresence, 3000);
  }

  // ==========================================
  // LOGIKA PEMANCAR KAMERA HP (SENDER / CALLER)
  // ==========================================
  _setupCameraSignaling() {
    // Pantau seluruh target receiver yang online di ruangan (Switcher, PD, dan Layar Penonton index.html)
    const peersRef = this.db.ref(`rooms/${this.roomToken}/peers`);
    const listener = peersRef.on('value', snap => {
      if (this.isDestroyed) return;
      const peers = snap.val() || {};

      Object.keys(peers).forEach(targetRole => {
        if (targetRole === this.roleKey) return;

        // Validasi apakah target ini adalah receiver yang sah
        const isReceiverRole = ['switcher', 'pd', 'audio_vt', 'cg'].includes(targetRole) || targetRole.startsWith('viewer');
        if (!isReceiverRole) return;

        const data = peers[targetRole];
        const isTargetOnline = data && data.online && (Date.now() - (data.lastSeen || 0) < 12000);

        if (isTargetOnline) {
          if (!this.peerConnections.has(targetRole)) {
            console.log(`[SkawanStreamer] Target receiver ${targetRole} terdeteksi online! Memulai panggilan WebRTC...`);
            this._startCallToReceiver(targetRole);
          }
        } else {
          // Jika target offline, tutup koneksi lama
          if (this.peerConnections.has(targetRole)) {
            console.log(`[SkawanStreamer] Target receiver ${targetRole} offline, menutup sambungan.`);
            this._closePeerConnection(targetRole);
          }
        }
      });

      // Bersihkan sambungan jika target telah hilang dari database
      this.peerConnections.forEach((pc, targetRole) => {
        if (!peers[targetRole] || !peers[targetRole].online) {
          this._closePeerConnection(targetRole);
        }
      });
    });

    this.listeners.push({ ref: peersRef, listener });
  }

  async _startCallToReceiver(targetRole) {
    if (!this.localStream) {
      console.warn("[SkawanStreamer] Belum ada localStream kamera!");
      return;
    }

    try {
      const channelId = `${this.roleKey}_to_${targetRole}`;
      const signalRef = this.db.ref(`rooms/${this.roomToken}/signals/${channelId}`);

      // Bersihkan sinyal usang
      await signalRef.remove();

      const pc = new RTCPeerConnection({ iceServers: SKAWAN_ICE_SERVERS });
      this.peerConnections.set(targetRole, pc);

      // Tambahkan track video kamera ke koneksi P2P
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });

      // Pantau status koneksi WebRTC
      pc.onconnectionstatechange = () => {
        console.log(`[SkawanStreamer] State ke ${targetRole}: ${pc.connectionState}`);
        this._updateCameraConnectionStatus();
      };
      pc.oniceconnectionstatechange = () => {
        console.log(`[SkawanStreamer] ICE State ke ${targetRole}: ${pc.iceConnectionState}`);
        this._updateCameraConnectionStatus();
      };

      // Kirim kandidat ICE lokal kamera ke Firebase
      pc.onicecandidate = event => {
        if (event.candidate) {
          signalRef.child('caller_candidates').push(event.candidate.toJSON());
        }
      };

      // Buat Offer WebRTC
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Tulis offer secara atomik ke Firebase
      await signalRef.child('offer').set({
        type: offer.type,
        sdp: offer.sdp,
        timestamp: Date.now()
      });

      // Dengarkan Answer dari Receiver (Switcher / PD / Viewer)
      const answerRef = signalRef.child('answer');
      const answerListener = answerRef.on('value', async snap => {
        const answer = snap.val();
        if (answer && answer.sdp && pc.signalingState === 'have-local-offer') {
          console.log(`[SkawanStreamer] Menerima Answer dari ${targetRole}`);
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));

            // Terapkan kandidat callee yang mungkin sudah tiba
            const queue = this.iceCandidateQueues.get(targetRole) || [];
            for (const cand of queue) {
              await pc.addIceCandidate(cand).catch(() => {});
            }
            this.iceCandidateQueues.delete(targetRole);
          } catch (e) {
            console.warn(`[SkawanStreamer] Gagal menerapkan Answer dari ${targetRole}:`, e);
          }
        }
      });
      this.listeners.push({ ref: answerRef, listener: answerListener });

      // Dengarkan kandidat ICE dari Receiver
      const calleeCandRef = signalRef.child('callee_candidates');
      const candListener = calleeCandRef.on('child_added', async snap => {
        const candData = snap.val();
        if (candData) {
          const candidate = new RTCIceCandidate(candData);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(candidate).catch(() => {});
          } else {
            const q = this.iceCandidateQueues.get(targetRole) || [];
            q.push(candidate);
            this.iceCandidateQueues.set(targetRole, q);
          }
        }
      });
      this.listeners.push({ ref: calleeCandRef, listener: candListener });

    } catch (err) {
      console.error(`[SkawanStreamer] Gagal membuat panggilan ke ${targetRole}:`, err);
    }
  }

  _updateCameraConnectionStatus() {
    let connectedTargets = [];
    this.peerConnections.forEach((pc, targetRole) => {
      const isConnected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      if (isConnected) {
        connectedTargets.push(targetRole.toUpperCase());
      }
    });

    if (connectedTargets.length > 0) {
      this.onStatusChange('connected', `Terhubung ke ${connectedTargets.join(' & ')}`);
    } else if (this.peerConnections.size > 0) {
      this.onStatusChange('connecting', 'Menghubungkan ke Studio...');
    } else {
      this.onStatusChange('ready', 'Siap (Buka Switcher / PD)');
    }
  }

  // ===============================================
  // LOGIKA PENERIMA FEED (SWITCHER / PD / VIEWER)
  // ===============================================
  _setupReceiverSignaling() {
    const signalsRootRef = this.db.ref(`rooms/${this.roomToken}/signals`);

    // Pantau setiap saluran penawaran yang ditujukan ke receiver ini
    // Format channel: {camRole}_to_{myRole}
    const listener = signalsRootRef.on('child_added', snap => {
      const channelId = snap.key;
      if (!channelId) return;

      const suffix = `_to_${this.roleKey}`;
      if (channelId.endsWith(suffix)) {
        const camRole = channelId.replace(suffix, '');
        console.log(`[SkawanStreamer Receiver] Penawaran terdeteksi dari ${camRole}!`);
        this._handleIncomingOfferFromCamera(camRole, channelId);
      }
    });

    this.listeners.push({ ref: signalsRootRef, listener });
  }

  async _handleIncomingOfferFromCamera(camRole, channelId) {
    const signalRef = this.db.ref(`rooms/${this.roomToken}/signals/${channelId}`);

    // Tutup koneksi lama jika ada
    if (this.peerConnections.has(camRole)) {
      this._closePeerConnection(camRole);
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: SKAWAN_ICE_SERVERS });
      this.peerConnections.set(camRole, pc);

      // Tangkap stream video yang tiba dari kamera
      pc.ontrack = event => {
        console.log(`[SkawanStreamer Receiver] Video track diterima dari ${camRole}!`, event.streams);
        if (event.streams && event.streams[0]) {
          const remoteStream = event.streams[0];
          this.activeRemoteStreams.set(camRole, remoteStream);
          this.onRemoteStream(camRole, remoteStream);
          this.onStatusChange('connected', `Feed ${camRole.toUpperCase()} Aktif`);
        }
      };

      pc.onconnectionstatechange = () => {
        console.log(`[SkawanStreamer Receiver] Koneksi ${camRole}: ${pc.connectionState}`);
      };

      // Kirim kandidat ICE receiver ke Firebase
      pc.onicecandidate = event => {
        if (event.candidate) {
          signalRef.child('callee_candidates').push(event.candidate.toJSON());
        }
      };

      // Dengarkan Offer secara tanggap (menghindari offer kosong akibat latensi jaringan)
      let hasAnswered = false;
      const offerRef = signalRef.child('offer');
      const offerListener = offerRef.on('value', async snap => {
        const offer = snap.val();
        if (!offer || !offer.sdp || hasAnswered) return;
        hasAnswered = true;

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));

          // Terapkan kandidat caller yang sudah ada dalam antrean
          const q = this.iceCandidateQueues.get(camRole) || [];
          for (const cand of q) {
            await pc.addIceCandidate(cand).catch(() => {});
          }
          this.iceCandidateQueues.delete(camRole);

          // Buat Answer P2P
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          await signalRef.child('answer').set({
            type: answer.type,
            sdp: answer.sdp,
            timestamp: Date.now()
          });

          console.log(`[SkawanStreamer Receiver] Answer berhasil dikirim ke ${camRole}!`);
        } catch (err) {
          console.warn(`[SkawanStreamer Receiver] Gagal memproses offer dari ${camRole}:`, err);
        }
      });
      this.listeners.push({ ref: offerRef, listener: offerListener });

      // Dengarkan kandidat ICE caller dari kamera
      const callerCandRef = signalRef.child('caller_candidates');
      const candListener = callerCandRef.on('child_added', async snap => {
        const candData = snap.val();
        if (candData) {
          const candidate = new RTCIceCandidate(candData);
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(candidate).catch(() => {});
          } else {
            const q = this.iceCandidateQueues.get(camRole) || [];
            q.push(candidate);
            this.iceCandidateQueues.set(camRole, q);
          }
        }
      });
      this.listeners.push({ ref: callerCandRef, listener: candListener });

    } catch (err) {
      console.error(`[SkawanStreamer Receiver] Error menangani ${camRole}:`, err);
    }
  }

  // ==========================================
  // METODE PUBLIK & PEMBERSIHAN KONEKSI
  // ==========================================
  updateLocalStream(newStream) {
    console.log("[SkawanStreamer] Memperbarui localStream kamera...");
    this.localStream = newStream;
    if (!newStream) return;

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    this.peerConnections.forEach((pc, targetRole) => {
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) {
        videoSender.replaceTrack(newVideoTrack).catch(e => console.warn(e));
      } else {
        pc.addTrack(newVideoTrack, newStream);
      }
    });
  }

  _closePeerConnection(targetRole) {
    if (this.peerConnections.has(targetRole)) {
      try {
        const pc = this.peerConnections.get(targetRole);
        pc.close();
      } catch (e) {}
      this.peerConnections.delete(targetRole);
      this.iceCandidateQueues.delete(targetRole);
    }
  }

  destroy() {
    this.isDestroyed = true;
    console.log(`[SkawanStreamer] Menghancurkan instance ${this.roleKey}...`);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Lepaskan listeners Firebase
    this.listeners.forEach(({ ref, listener }) => {
      try { ref.off('value', listener); ref.off('child_added', listener); } catch (e) {}
    });
    this.listeners = [];

    // Hapus presence
    if (this.db) {
      this.db.ref(`rooms/${this.roomToken}/peers/${this.roleKey}`).remove().catch(() => {});
    }

    // Tutup seluruh RTCPeerConnection
    this.peerConnections.forEach(pc => {
      try { pc.close(); } catch (e) {}
    });
    this.peerConnections.clear();
    this.iceCandidateQueues.clear();
    this.activeRemoteStreams.clear();
  }
}

// Pasang ke objek Window global agar selalu dapat diakses di seluruh aplikasi
window.SkawanStreamer = SkawanStreamer;
