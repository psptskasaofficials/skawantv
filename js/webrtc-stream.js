/**
 * SKAWAN TV - WebRTC Streamer Engine
 * Mendukung Multi-Cam HP, Screen Share, & Master Playout Audio
 */
class SkawanStreamer {
  constructor(options = {}) {
    this.roomToken = (options.roomToken || 'SKASA').toUpperCase();
    this.roleKey = options.roleKey || `peer_${Math.random().toString(36).substring(2, 7)}`;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    
    this.db = window.db || (typeof firebase !== 'undefined' && firebase.database ? firebase.database() : null);
    
    // Konfigurasi STUN Server Publik Google
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };

    this.localStreams = new Map(); // key -> MediaStream (misal: 'cam_1', 'sharescreen')
    this.peers = new Map();        // peerId -> RTCPeerConnection
    this.activeListeners = [];

    this.initSignaling();
  }

  getBroadcasterKey() {
    // Menentukan apakah role ini adalah pemancar materi
    if (this.roleKey.startsWith('cam_') || this.roleKey === 'sharescreen' || this.roleKey === 'audio_master') {
      return this.roleKey;
    }
    return null;
  }

  initSignaling() {
    if (!this.db) {
      setTimeout(() => {
        this.db = window.db || (typeof firebase !== 'undefined' && firebase.database ? firebase.database() : null);
        this.initSignaling();
      }, 300);
      return;
    }

    const bKey = this.getBroadcasterKey();
    if (bKey) {
      // Daftarkan bahwa penyiar ini aktif di studio
      this.presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}/${bKey}`);
      this.presenceRef.set({
        role: bKey,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      this.presenceRef.onDisconnect().remove();

      // Dengarkan permintaan sambungan (Handshake request) dari viewer/switcher
      const offersRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/requests`);
      offersRef.on('child_added', snap => {
        const req = snap.val();
        if (!req || !req.viewerId) return;
        this.handleViewerRequest(req.viewerId, bKey);
        snap.ref.remove().catch(() => {});
      });
      this.activeListeners.push(offersRef);

      // Dengarkan Answer dari viewer
      const answersRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/answers`);
      answersRef.on('child_added', snap => {
        const data = snap.val();
        if (!data || !data.viewerId || !data.sdp) return;
        this.handleAnswer(data.viewerId, data.sdp);
        snap.ref.remove().catch(() => {});
      });
      this.activeListeners.push(answersRef);

      // Dengarkan ICE kandidat dari viewer
      const iceFromViewerRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/ice_from_viewers`);
      iceFromViewerRef.on('child_added', snap => {
        const iceData = snap.val();
        if (!iceData || !iceData.candidate) return;
        this.handleRemoteIce(iceData.viewerId, iceData.candidate);
        snap.ref.remove().catch(() => {});
      });
      this.activeListeners.push(iceFromViewerRef);

    } else {
      // Role ini adalah Viewer/Receiver (Switcher, PD, index.html, dll)
      this.discoverBroadcasters();
    }
  }

  // DIJALANKAN OLEH VIEWER: Cari semua kamera & screen share yang aktif
  discoverBroadcasters() {
    const presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}`);
    presenceRef.on('value', snap => {
      const activeBroadcasters = snap.val() || {};
      Object.keys(activeBroadcasters).forEach(bKey => {
        this.requestStreamFromBroadcaster(bKey);
      });
    });
    this.activeListeners.push(presenceRef);
  }

  requestStreamFromBroadcaster(bKey) {
    if (this.peers.has(bKey)) return;

    // Kirim request ke penyiar agar penyiar membuat WebRTC Offer
    this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/requests`).push({
      viewerId: this.roleKey,
      timestamp: Date.now()
    });

    // Tunggu Offer dari penyiar
    const offerRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/offers/${this.roleKey}`);
    offerRef.on('value', snap => {
      const data = snap.val();
      if (!data || !data.sdp) return;
      this.handleOfferFromBroadcaster(bKey, data.sdp);
      snap.ref.remove().catch(() => {});
    });
    this.activeListeners.push(offerRef);

    // Dengarkan ICE kandidat dari penyiar
    const iceFromBroadcasterRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/ice_to_viewers/${this.roleKey}`);
    iceFromBroadcasterRef.on('child_added', snap => {
      const ice = snap.val();
      if (!ice || !ice.candidate) return;
      this.handleRemoteIce(bKey, ice.candidate);
      snap.ref.remove().catch(() => {});
    });
    this.activeListeners.push(iceFromBroadcasterRef);
  }

  // DIJALANKAN OLEH PENYIAR: Tanggapi permintaan sambungan dari viewer
  async handleViewerRequest(viewerId, bKey) {
    let pc = this.peers.get(viewerId);
    if (pc) {
      pc.close();
      this.peers.delete(viewerId);
    }

    pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(viewerId, pc);

    // Masukkan track video/audio lokal ke peer
    const localStream = this.localStreams.get(bKey);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Kirim ICE candidate ke viewer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/ice_to_viewers/${viewerId}`).push({
          candidate: event.candidate.toJSON()
        });
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Simpan Offer untuk viewer
      this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/offers/${viewerId}`).set({
        sdp: offer.sdp,
        timestamp: Date.now()
      });
    } catch (err) {
      console.warn("Error creating WebRTC offer:", err);
    }
  }

  // DIJALANKAN OLEH VIEWER: Terima Offer dari penyiar
  async handleOfferFromBroadcaster(bKey, sdp) {
    let pc = this.peers.get(bKey);
    if (!pc) {
      pc = new RTCPeerConnection(this.rtcConfig);
      this.peers.set(bKey, pc);

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          this.onRemoteStream(bKey, event.streams[0]);
        }
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/ice_from_viewers`).push({
            viewerId: this.roleKey,
            candidate: event.candidate.toJSON()
          });
        }
      };
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Kirim Answer kembali ke penyiar
      this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/answers`).push({
        viewerId: this.roleKey,
        sdp: answer.sdp
      });
    } catch (err) {
      console.warn("Error accepting WebRTC offer:", err);
    }
  }

  // DIJALANKAN OLEH PENYIAR: Terima Answer dari viewer
  async handleAnswer(viewerId, sdp) {
    const pc = this.peers.get(viewerId);
    if (!pc) return;
    try {
      if (pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdp }));
      }
    } catch (err) {
      console.warn("Error setting remote answer:", err);
    }
  }

  // Tangani ICE Candidate
  async handleRemoteIce(peerKey, candidateData) {
    const pc = this.peers.get(peerKey);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (e) {}
  }

  // MEMUBLIKASIKAN ATAU MENGGANTI STREAM KAMERA / SCREEN SHARE
  publishStream(streamKey, mediaStream) {
    this.localStreams.set(streamKey, mediaStream);

    // Ganti track pada peer yang sedang terhubung tanpa restart negosiasi
    this.peers.forEach(pc => {
      const senders = pc.getSenders();
      mediaStream.getTracks().forEach(newTrack => {
        const sender = senders.find(s => s.track && s.track.kind === newTrack.kind);
        if (sender) {
          sender.replaceTrack(newTrack).catch(() => {});
        } else {
          pc.addTrack(newTrack, mediaStream);
        }
      });
    });

    // Picu pembaruan presence agar viewer yang belum tersambung langsung meminta
    if (this.presenceRef) {
      this.presenceRef.update({ updatedAt: firebase.database.ServerValue.TIMESTAMP });
    }
  }

  destroy() {
    this.activeListeners.forEach(ref => ref.off());
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.localStreams.clear();

    if (this.presenceRef) {
      this.presenceRef.remove().catch(() => {});
    }
  }
}

window.SkawanStreamer = SkawanStreamer;
