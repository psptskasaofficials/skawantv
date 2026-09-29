/**
 * js/webrtc-stream.js
 * Modul Native WebRTC Peer-to-Peer & Relay SKAWAN TV
 * SMK Negeri 1 Pacitan
 * 
 * Versi v4.0 (Zero-PeerJS Cloud Dependency):
 * - Direct Firebase Realtime Database Signaling (Offer/Answer/Candidate)
 * - Native window.RTCPeerConnection (100% Kompatibel Semua Browser)
 * - Multi-Port STUN & OpenRelay TURN (Bypass Firewall Sekolah & 4G NAT)
 * - Auto Candidate Queueing & Seamless Track Hot-Swapping
 */

const SKAWAN_ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
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
  ],
  iceCandidatePoolSize: 10
};

class SkawanStreamer {
  constructor(options = {}) {
    this.rawRoomToken = (options.roomToken || 'SKASA').trim().toUpperCase();
    this.roomToken = this.rawRoomToken.replace(/[^A-Z0-9]/g, '').toLowerCase() || 'skasa';
    this.roleKey = options.roleKey || 'cam_1';
    this.localStream = options.localStream || null;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // Role penerima stream: Switcher, PD, Admin Inspector, Viewer, Audio-VT, CG
    this.isReceiver = ['switcher', 'pd', 'admin', 'viewer', 'inspector', 'audio_vt', 'cg'].includes(this.roleKey);

    // Kumpulan koneksi aktif: Map<targetKey, { pc, candidateQueue, hasRemoteDesc, unsubscribeList }>
    this.connections = new Map();
    this.isDestroyed = false;
    this.reconnectTimer = null;
    this.peerPresenceRef = null;

    // Generate Client ID Unik per sesi
    this.clientId = `${this.roleKey}_${Math.floor(1000 + Math.random() * 9000)}`;

    this._startEngine();
  }

  _getDb() {
    if (window.db) return window.db;
    if (typeof firebase !== 'undefined' && firebase.database) {
      window.db = firebase.database();
      return window.db;
    }
    return null;
  }

  _startEngine() {
    const activeDb = this._getDb();
    if (!activeDb) {
      setTimeout(() => this._startEngine(), 600);
      return;
    }

    console.log(`[Native WebRTC] Memulai mesin untuk role: ${this.roleKey} (Room: ${this.rawRoomToken})`);
    this.onStatusChange('ready', this.isReceiver ? 'Penerima Siaga' : 'Siap (Menghubungkan ke Studio...)');

    // 1. Daftarkan kehadiran node peer di Firebase
    this._announcePresence(activeDb);

    // 2. Dengarkan sinyal WebRTC masuk
    this._listenIncomingSignals(activeDb);

    // 3. Jika kamera pemancar: inisiasi panggilan ke stasiun studio
    if (!this.isReceiver) {
      this._monitorStudioReceivers(activeDb);
    }
  }

  _announcePresence(activeDb) {
    this.peerPresenceRef = activeDb.ref(`rooms/${this.rawRoomToken}/webrtc_presence/${this.roleKey}`);
    this.peerPresenceRef.set({
      clientId: this.clientId,
      role: this.roleKey,
      isReceiver: this.isReceiver,
      online: true,
      updatedAt: Date.now()
    });

    this.peerPresenceRef.onDisconnect().remove();
  }

  _monitorStudioReceivers(activeDb) {
    const targets = ['switcher', 'pd', 'admin', 'inspector'];

    activeDb.ref(`rooms/${this.rawRoomToken}/webrtc_presence`).on('value', (snapshot) => {
      if (this.isDestroyed || !snapshot.exists()) return;
      const peers = snapshot.val() || {};

      Object.keys(peers).forEach((key) => {
        const p = peers[key];
        if (!p || !p.online) return;

        // Jika receiver aktif terdeteksi (Switcher / PD / Viewer)
        if (targets.includes(key) || key.startsWith('viewer_')) {
          if (!this.connections.has(key)) {
            console.log(`[Native WebRTC] Target studio terdeteksi: ${key}. Membuat offer...`);
            this._createPeerConnectionAsSender(key, activeDb);
          }
        }
      });
    });
  }

  async _createPeerConnectionAsSender(targetKey, activeDb) {
    if (this.isDestroyed || !this.localStream) return;

    // Bersihkan sambungan lama jika ada
    this._closeConnection(targetKey);

    const pc = new RTCPeerConnection(SKAWAN_ICE_CONFIG);
    const connData = {
      pc,
      candidateQueue: [],
      hasRemoteDesc: false,
      unsubs: []
    };
    this.connections.set(targetKey, connData);

    // Tambahkan seluruh track lokal kamera ke peer connection
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    // Kirim ICE Candidate lokal ke Firebase
    const signalPath = `rooms/${this.rawRoomToken}/webrtc_signals/${this.roleKey}___${targetKey}`;
    pc.onicecandidate = (event) => {
      if (event.candidate && !this.isDestroyed) {
        activeDb.ref(`${signalPath}/candidates_from_cam`).push(event.candidate.toJSON());
      }
    };

    // Pantau status koneksi WebRTC
    const handleStateChange = () => {
      console.log(`[Native WebRTC] State ${targetKey}: ${pc.connectionState} (ICE: ${pc.iceConnectionState})`);
      this._updateConnectionStatus();

      if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        console.warn(`[Native WebRTC] Sambungan ke ${targetKey} gagal. Mengulang jabat tangan...`);
        this._closeConnection(targetKey);
        setTimeout(() => {
          if (!this.isDestroyed && !this.connections.has(targetKey)) {
            this._createPeerConnectionAsSender(targetKey, activeDb);
          }
        }, 2000);
      }
    };

    pc.onconnectionstatechange = handleStateChange;
    pc.oniceconnectionstatechange = handleStateChange;

    try {
      // Buat Offer SDP
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false
      });
      await pc.setLocalDescription(offer);

      // Bersihkan sinyal usang dan simpan Offer baru di Firebase
      await activeDb.ref(signalPath).set({
        offer: { type: offer.type, sdp: offer.sdp },
        camClientId: this.clientId,
        timestamp: Date.now()
      });

      // Dengarkan Answer dari Receiver
      const answerRef = activeDb.ref(`${signalPath}/answer`);
      const onAnswer = answerRef.on('value', async (snap) => {
        if (!snap.exists() || this.isDestroyed || connData.hasRemoteDesc) return;
        const answer = snap.val();
        if (answer && answer.sdp) {
          try {
            console.log(`[Native WebRTC] Menerima Answer SDP dari ${targetKey}. Menerapkan...`);
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            connData.hasRemoteDesc = true;

            // Kuras antrean kandidat ICE yang tiba duluan
            while (connData.candidateQueue.length > 0) {
              const cand = connData.candidateQueue.shift();
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
          } catch (e) {
            console.warn('[Native WebRTC] SetRemoteDescription error:', e);
          }
        }
      });
      connData.unsubs.push(() => answerRef.off('value', onAnswer));

      // Dengarkan ICE Candidates dari Receiver
      const candRef = activeDb.ref(`${signalPath}/candidates_from_rec`);
      const onCand = candRef.on('child_added', async (snap) => {
        if (!snap.exists() || this.isDestroyed) return;
        const candData = snap.val();
        if (connData.hasRemoteDesc) {
          await pc.addIceCandidate(new RTCIceCandidate(candData)).catch(() => {});
        } else {
          connData.candidateQueue.push(candData);
        }
      });
      connData.unsubs.push(() => candRef.off('child_added', onCand));

      this._updateConnectionStatus();

    } catch (err) {
      console.warn(`[Native WebRTC] Gagal membuat offer ke ${targetKey}:`, err);
      this._closeConnection(targetKey);
    }
  }

  _listenIncomingSignals(activeDb) {
    if (!this.isReceiver) return;

    const signalsRoot = activeDb.ref(`rooms/${this.rawRoomToken}/webrtc_signals`);
    signalsRoot.on('child_added', (snapshot) => {
      this._processIncomingChannel(snapshot.key, activeDb);
    });
    signalsRoot.on('child_changed', (snapshot) => {
      this._processIncomingChannel(snapshot.key, activeDb);
    });
  }

  _processIncomingChannel(channelKey, activeDb) {
    if (this.isDestroyed || !channelKey || !channelKey.includes('___')) return;

    const [senderRole, targetRole] = channelKey.split('___');
    // Jika panggilan ini ditujukan untuk role saya (misal: switcher, pd, viewer)
    if (targetRole !== this.roleKey && !this.roleKey.startsWith(targetRole)) {
      return;
    }

    const signalPath = `rooms/${this.rawRoomToken}/webrtc_signals/${channelKey}`;
    activeDb.ref(signalPath).once('value', async (snapshot) => {
      if (!snapshot.exists() || this.isDestroyed) return;
      const data = snapshot.val() || {};
      const offer = data.offer;
      if (!offer || !offer.sdp) return;

      // Jika koneksi untuk kamera ini sudah aktif dengan sdp yang sama, abaikan
      const existing = this.connections.get(senderRole);
      if (existing && existing.currentOfferSdp === offer.sdp) {
        return;
      }

      console.log(`[Native WebRTC Receiver] Menerima Offer dari ${senderRole}. Membuka channel...`);
      await this._answerIncomingCall(senderRole, signalPath, offer, activeDb);
    });
  }

  async _answerIncomingCall(senderRole, signalPath, offer, activeDb) {
    this._closeConnection(senderRole);

    const pc = new RTCPeerConnection(SKAWAN_ICE_CONFIG);
    const connData = {
      pc,
      candidateQueue: [],
      hasRemoteDesc: false,
      currentOfferSdp: offer.sdp,
      unsubs: []
    };
    this.connections.set(senderRole, connData);

    // Kirim ICE Candidate dari Receiver ke Firebase
    pc.onicecandidate = (event) => {
      if (event.candidate && !this.isDestroyed) {
        activeDb.ref(`${signalPath}/candidates_from_rec`).push(event.candidate.toJSON());
      }
    };

    // Saat track video kamera diterima dari HP:
    pc.ontrack = (event) => {
      console.log(`[Native WebRTC] Stream video aktif diterima dari: ${senderRole}`);
      if (event.streams && event.streams[0]) {
        const normKey = senderRole.includes('_') ? senderRole : senderRole.replace('cam', 'cam_');
        this.onRemoteStream(normKey, event.streams[0]);
        this.onRemoteStream(senderRole, event.streams[0]);
      }
    };

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      connData.hasRemoteDesc = true;

      // Kuras antrean kandidat ICE
      while (connData.candidateQueue.length > 0) {
        const cand = connData.candidateQueue.shift();
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      }

      // Buat Answer SDP
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Kirim Answer balik ke Firebase
      await activeDb.ref(`${signalPath}/answer`).set({
        type: answer.type,
        sdp: answer.sdp,
        receiverClientId: this.clientId,
        timestamp: Date.now()
      });

      // Dengarkan ICE Candidates dari Kamera
      const camCandRef = activeDb.ref(`${signalPath}/candidates_from_cam`);
      const onCamCand = camCandRef.on('child_added', async (snap) => {
        if (!snap.exists() || this.isDestroyed) return;
        const candData = snap.val();
        if (connData.hasRemoteDesc) {
          await pc.addIceCandidate(new RTCIceCandidate(candData)).catch(() => {});
        } else {
          connData.candidateQueue.push(candData);
        }
      });
      connData.unsubs.push(() => camCandRef.off('child_added', onCamCand));

    } catch (err) {
      console.warn(`[Native WebRTC] Gagal menjawab offer dari ${senderRole}:`, err);
      this._closeConnection(senderRole);
    }
  }

  _updateConnectionStatus() {
    if (this.isReceiver || this.isDestroyed) return;

    const connectedRoles = [];
    let isAnyConnecting = false;

    this.connections.forEach((conn, role) => {
      const pc = conn.pc;
      if (pc) {
        const isConnected = pc.connectionState === 'connected' || 
                            pc.iceConnectionState === 'connected' || 
                            pc.iceConnectionState === 'completed';
        const isConnecting = pc.connectionState === 'connecting' || 
                             pc.iceConnectionState === 'checking';

        if (isConnected) {
          connectedRoles.push(role.toUpperCase());
        } else if (isConnecting) {
          isAnyConnecting = true;
        }
      }
    });

    if (connectedRoles.length > 0) {
      this.onStatusChange('connected', `Terhubung ke ${connectedRoles.join(' & ')}`);
    } else if (isAnyConnecting || this.connections.size > 0) {
      this.onStatusChange('connecting', 'Menghubungkan ke Studio...');
    } else {
      this.onStatusChange('ready', 'Siap (Menunggu Switcher/PD)');
    }
  }

  updateLocalStream(newStream) {
    this.localStream = newStream;
    const newVideoTrack = newStream.getVideoTracks()[0];

    this.connections.forEach((conn) => {
      if (conn.pc && newVideoTrack) {
        const senders = conn.pc.getSenders();
        const videoSender = senders.find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(newVideoTrack).catch((e) => console.warn(e));
        }
      }
    });
  }

  _closeConnection(key) {
    const conn = this.connections.get(key);
    if (!conn) return;

    if (conn.unsubs) {
      conn.unsubs.forEach((unsub) => {
        try { unsub(); } catch(e){}
      });
    }

    if (conn.pc) {
      try { conn.pc.close(); } catch(e){}
    }

    this.connections.delete(key);
  }

  destroy() {
    this.isDestroyed = true;

    if (this.peerPresenceRef) {
      this.peerPresenceRef.remove().catch(() => {});
    }

    this.connections.forEach((_, key) => {
      this._closeConnection(key);
    });
    this.connections.clear();
  }
}

if (typeof window !== 'undefined') {
  window.SkawanStreamer = SkawanStreamer;
}
