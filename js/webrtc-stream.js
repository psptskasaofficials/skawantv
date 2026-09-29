/**
 * SKAWAN TV - Robust Native WebRTC Streamer
 * Menggunakan RTCPeerConnection Asli Browser + Firebase Realtime Database Signaling
 * STUN Google & Cloudflare Berkecepatan Tinggi (Koneksi P2P Milidetik)
 * Dilengkapi Anti-Race Mutex Lock & W3C Standard Zero-Latency Playout
 */

const SKAWAN_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
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
    this.callingInProgress = new Set(); // targetRole -> boolean (Mutex Lock)
    this.watchedChannels = new Set(); // channelId -> boolean (mencegah duplicate listener)
    this.lastProcessedOfferTimestamps = new Map(); // camRole -> timestamp
    this.listeners = []; // Firebase listeners untuk cleanup
    this.heartbeatTimer = null;
    this.isDestroyed = false;

    console.log(`[SkawanStreamer] Inisialisasi: Room ${this.roomToken} | Role: ${this.roleKey} (isCamera: ${this.isCamera}, isReceiver: ${this.isReceiver})`);

    this._init();
  }

  _getDb() {
    if (window.db) return window.db;
    if (typeof db !== 'undefined' && db) {
      window.db = db;
      return window.db;
    }
    if (typeof firebase !== 'undefined') {
      if (!firebase.apps || !firebase.apps.length) {
        try {
          firebase.initializeApp({
            apiKey: "AIzaSyAtSTgrBWY5aDahE6hq_yr4oSxpxl3QtcQ",
            authDomain: "skawan-tv.firebaseapp.com",
            databaseURL: "https://skawan-tv-default-rtdb.asia-southeast1.firebasedatabase.app",
            projectId: "skawan-tv",
            storageBucket: "skawan-tv.firebasestorage.app",
            messagingSenderId: "501619282826",
            appId: "1:501619282826:web:81e624ac35e9798062ae73"
          });
        } catch (e) {
          console.warn("[SkawanStreamer] Init fallback Firebase error:", e);
        }
      }
      if (firebase.database) {
        window.db = firebase.database();
        return window.db;
      }
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
      this.onStatusChange('connecting', `Mencari Switcher di ${this.roomToken}...`);
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
    const peersRef = this.db.ref(`rooms/${this.roomToken}/peers`);
    const listener = peersRef.on('value', snap => {
      if (this.isDestroyed) return;
      const peers = snap.val() || {};

      let anyReceiverActive = false;

      Object.keys(peers).forEach(targetRole => {
        if (targetRole === this.roleKey) return;

        // Validasi receiver yang sah
        const isReceiverRole = ['switcher', 'pd', 'audio_vt', 'cg'].includes(targetRole) || targetRole.startsWith('viewer');
        if (!isReceiverRole) return;

        const data = peers[targetRole];
        const isTargetOnline = data && (data.online === true) && (Math.abs(Date.now() - (data.lastSeen || Date.now())) < 120000);

        if (isTargetOnline) {
          anyReceiverActive = true;
          const currentPc = this.peerConnections.get(targetRole);
          const isConnected = currentPc && (currentPc.connectionState === 'connected' || currentPc.iceConnectionState === 'connected');
          const isConnecting = this.callingInProgress.has(targetRole) || (currentPc && currentPc.connectionState === 'connecting');

          // Hanya panggil jika belum terhubung dan tidak sedang dalam proses negosiasi
          if (!isConnected && !isConnecting) {
            console.log(`[SkawanStreamer] Memulai koneksi P2P ke ${targetRole}...`);
            this._startCallToReceiver(targetRole);
          }
        } else {
          // Tutup koneksi jika target offline
          if (this.peerConnections.has(targetRole)) {
            console.log(`[SkawanStreamer] Target ${targetRole} offline, menutup sambungan.`);
            this._closePeerConnection(targetRole);
          }
        }
      });

      this._updateCameraConnectionStatus(anyReceiverActive);
    });

    this.listeners.push({ ref: peersRef, listener });
  }

  async _startCallToReceiver(targetRole) {
    if (!this.localStream || this.callingInProgress.has(targetRole)) {
      return;
    }

    // Pasang kunci mutex agar tidak dipanggil dobel oleh heartbeat
    this.callingInProgress.add(targetRole);

    try {
      const channelId = `${this.roleKey}_to_${targetRole}`;
      const signalRef = this.db.ref(`rooms/${this.roomToken}/signals/${channelId}`);

      // Tutup sambungan lama jika ada
      this._closePeerConnection(targetRole);

      // Bersihkan sinyal usang
      await signalRef.remove().catch(() => {});

      const pc = new RTCPeerConnection({
        iceServers: SKAWAN_ICE_SERVERS,
        bundlePolicy: 'max-bundle'
      });
      this.peerConnections.set(targetRole, pc);

      // Tambahkan track video kamera
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });

      // Optimasi parameter pengirim video
      try {
        pc.getSenders().forEach(sender => {
          if (sender.track && sender.track.kind === 'video') {
            const params = sender.getParameters();
            if (params) {
              params.degradationPreference = 'maintain-framerate';
              sender.setParameters(params).catch(() => {});
            }
          }
        });
      } catch (e) {}

      // Pantau status koneksi WebRTC
      pc.onconnectionstatechange = () => {
        console.log(`[SkawanStreamer] State ke ${targetRole}: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          this.callingInProgress.delete(targetRole);
        } else if (pc.connectionState === 'failed') {
          this.callingInProgress.delete(targetRole);
          this._closePeerConnection(targetRole);
          setTimeout(() => {
            if (!this.isDestroyed && this.localStream) {
              this._startCallToReceiver(targetRole);
            }
          }, 1500);
        }
        this._updateCameraConnectionStatus();
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[SkawanStreamer] ICE State ke ${targetRole}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          this.callingInProgress.delete(targetRole);
        }
        this._updateCameraConnectionStatus();
      };

      // Kirim kandidat ICE kamera ke Firebase
      pc.onicecandidate = event => {
        if (event.candidate && event.candidate.candidate) {
          signalRef.child('caller_candidates').push({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          });
        }
      };

      // Buat Offer WebRTC murni tanpa regex SDP yang merusak parser
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Tulis offer ke Firebase
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
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: answer.type,
              sdp: answer.sdp
            }));

            // Terapkan antrean kandidat ICE yang sudah tiba
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

      // Dengarkan kandidat ICE callee (Switcher/PD)
      const calleeCandRef = signalRef.child('callee_candidates');
      const candListener = calleeCandRef.on('child_added', async snap => {
        const candData = snap.val();
        if (candData && candData.candidate) {
          try {
            const candidate = new RTCIceCandidate(candData);
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(candidate).catch(() => {});
            } else {
              const q = this.iceCandidateQueues.get(targetRole) || [];
              q.push(candidate);
              this.iceCandidateQueues.set(targetRole, q);
            }
          } catch (errCand) {
            console.warn("[SkawanStreamer] Parse ICE candidate error:", errCand);
          }
        }
      });
      this.listeners.push({ ref: calleeCandRef, listener: candListener });

    } catch (err) {
      console.error(`[SkawanStreamer] Gagal membuat panggilan ke ${targetRole}:`, err);
      this.callingInProgress.delete(targetRole);
    }
  }

  _updateCameraConnectionStatus(anyReceiverOnline = false) {
    let connectedTargets = [];
    this.peerConnections.forEach((pc, targetRole) => {
      const isConnected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      if (isConnected) {
        connectedTargets.push(targetRole.toUpperCase());
      }
    });

    if (connectedTargets.length > 0) {
      this.onStatusChange('connected', `Terhubung ke ${connectedTargets.join(' & ')}`);
    } else if (this.callingInProgress.size > 0 || this.peerConnections.size > 0) {
      this.onStatusChange('connecting', 'Menghubungkan ke Switcher...');
    } else if (anyReceiverOnline) {
      this.onStatusChange('connecting', 'Menyiapkan panggilan...');
    } else {
      this.onStatusChange('ready', `Mencari Switcher di ${this.roomToken}...`);
    }
  }

  // ===============================================
  // LOGIKA PENERIMA FEED (SWITCHER / PD / VIEWER)
  // ===============================================
  _setupReceiverSignaling() {
    const signalsRootRef = this.db.ref(`rooms/${this.roomToken}/signals`);

    const handleChannel = (channelId) => {
      if (!channelId || this.watchedChannels.has(channelId)) return;
      const suffix = `_to_${this.roleKey}`;
      if (channelId.endsWith(suffix)) {
        this.watchedChannels.add(channelId);
        const camRole = channelId.slice(0, -suffix.length);
        this._watchChannelFromCamera(camRole, channelId);
      }
    };

    // Cukup gunakan child_added agar tidak memicu listener ganda saat child_changed
    const addListener = signalsRootRef.on('child_added', snap => handleChannel(snap.key));
    this.listeners.push({ ref: signalsRootRef, listener: addListener });
  }

  _watchChannelFromCamera(camRole, channelId) {
    const signalRef = this.db.ref(`rooms/${this.roomToken}/signals/${channelId}`);
    const offerRef = signalRef.child('offer');

    const offerListener = offerRef.on('value', async snap => {
      const offer = snap.val();
      if (!offer || !offer.sdp) return;

      if (this.lastProcessedOfferTimestamps.get(camRole) === offer.timestamp) {
        return;
      }
      this.lastProcessedOfferTimestamps.set(camRole, offer.timestamp);

      console.log(`[SkawanStreamer Receiver] Offer baru diterima dari ${camRole}! Memproses...`);
      await this._handleIncomingOfferFromCamera(camRole, channelId, offer);
    });

    this.listeners.push({ ref: offerRef, listener: offerListener });
  }

  async _handleIncomingOfferFromCamera(camRole, channelId, offer) {
    const signalRef = this.db.ref(`rooms/${this.roomToken}/signals/${channelId}`);

    if (this.peerConnections.has(camRole)) {
      this._closePeerConnection(camRole);
    }

    try {
      const pc = new RTCPeerConnection({
        iceServers: SKAWAN_ICE_SERVERS,
        bundlePolicy: 'max-bundle'
      });
      this.peerConnections.set(camRole, pc);

      // Tangkap video track kamera
      pc.ontrack = event => {
        console.log(`[SkawanStreamer Receiver] Video track diterima dari ${camRole}!`);

        // W3C Standard: Set penundaan jitter buffer nol langsung pada receiver
        if (event.receiver) {
          try {
            if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
            if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
          } catch (e) {}
        }

        let remoteStream = (event.streams && event.streams[0]) ? event.streams[0] : null;
        if (!remoteStream) {
          remoteStream = new MediaStream();
          remoteStream.addTrack(event.track);
        }

        this.activeRemoteStreams.set(camRole, remoteStream);
        this.onRemoteStream(camRole, remoteStream);
        this.onStatusChange('connected', `Feed ${camRole.toUpperCase()} Aktif`);
      };

      pc.onconnectionstatechange = () => {
        console.log(`[SkawanStreamer Receiver] Koneksi ${camRole}: ${pc.connectionState}`);
      };

      pc.oniceconnectionstatechange = () => {
        console.log(`[SkawanStreamer Receiver] ICE ${camRole}: ${pc.iceConnectionState}`);
      };

      // Kirim kandidat ICE receiver ke Firebase
      pc.onicecandidate = event => {
        if (event.candidate && event.candidate.candidate) {
          signalRef.child('callee_candidates').push({
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          });
        }
      };

      // Terapkan Offer
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: offer.type,
        sdp: offer.sdp
      }));

      // Terapkan antrean kandidat caller yang mungkin sudah ada
      const q = this.iceCandidateQueues.get(camRole) || [];
      for (const cand of q) {
        await pc.addIceCandidate(cand).catch(() => {});
      }
      this.iceCandidateQueues.delete(camRole);

      // Buat Answer P2P standar yang sah
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await signalRef.child('answer').set({
        type: answer.type,
        sdp: answer.sdp,
        timestamp: Date.now()
      });

      // Dengarkan kandidat ICE caller dari kamera
      const callerCandRef = signalRef.child('caller_candidates');
      const candListener = callerCandRef.on('child_added', async snap => {
        const candData = snap.val();
        if (candData && candData.candidate) {
          try {
            const candidate = new RTCIceCandidate(candData);
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(candidate).catch(() => {});
            } else {
              const queue = this.iceCandidateQueues.get(camRole) || [];
              queue.push(candidate);
              this.iceCandidateQueues.set(camRole, queue);
            }
          } catch (errCand) {
            console.warn("[SkawanStreamer Receiver] ICE error:", errCand);
          }
        }
      });
      this.listeners.push({ ref: callerCandRef, listener: candListener });

      console.log(`[SkawanStreamer Receiver] Answer berhasil dikirim ke ${camRole}!`);
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

    if (this.peerConnections.size === 0) {
      this._setupCameraSignaling();
      return;
    }

    this.peerConnections.forEach((pc) => {
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
    this.callingInProgress.delete(targetRole);
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
    this.callingInProgress.clear();
    this.watchedChannels.clear();
  }
}

// Pasang ke objek global window
window.SkawanStreamer = SkawanStreamer;
