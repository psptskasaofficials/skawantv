/**
 * SKAWAN TV - WebRTC Streamer Engine (v2.1 Robust Mesh Signaling)
 * Mendukung Multi-Cam HP, Screen Share, & Multi-Viewer Switcher/PD/PGM
 */
class SkawanStreamer {
  constructor(options = {}) {
    this.roomToken = (options.roomToken || 'SKASA').toUpperCase();
    this.roleKey = options.roleKey || `peer_${Math.random().toString(36).substring(2, 7)}`;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    
    this.db = window.db || (typeof firebase !== 'undefined' && firebase.database ? firebase.database() : null);

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    };

    this.localStreams = new Map(); // key -> MediaStream
    this.peers = new Map();        // peerId -> RTCPeerConnection
    this.iceQueues = new Map();    // peerId -> Array of RTCIceCandidate
    this.activeListeners = [];
    this.isBroadcaster = this.checkIsBroadcaster();

    this.initSignaling();
  }

  checkIsBroadcaster() {
    return this.roleKey.startsWith('cam_') || 
           this.roleKey.startsWith('cam') || 
           this.roleKey === 'sharescreen';
  }

  getBroadcasterKey() {
    if (this.roleKey.startsWith('cam_')) return this.roleKey;
    if (this.roleKey.startsWith('cam')) return 'cam_' + this.roleKey.replace('cam', '');
    if (this.roleKey === 'sharescreen') return 'sharescreen';
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
      // PENYIAR (cam_1, cam_2, cam_3, sharescreen)
      // Dengarkan permintaan koneksi baru dari viewer (switcher, pd, pgm)
      const requestsRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}`);
      requestsRef.on('child_added', snap => {
        const viewerId = snap.key;
        if (!viewerId) return;

        // Cek jika ada request masuk dari viewer
        snap.ref.child('request').on('value', rSnap => {
          if (rSnap.exists() && this.localStreams.has(bKey)) {
            this.handleViewerHandshake(viewerId, bKey);
          }
        });
      });
      this.activeListeners.push(requestsRef);

    } else {
      // PENERIMA / VIEWER (switcher, pd, index, live)
      this.discoverBroadcasters();
    }
  }

  // DIJALANKAN VIEWER: Pantau penyiar yang aktif di ruangan
  discoverBroadcasters() {
    const presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}`);
    presenceRef.on('value', snap => {
      const activeBroadcasters = snap.val() || {};
      Object.keys(activeBroadcasters).forEach(bKey => {
        if (activeBroadcasters[bKey] && activeBroadcasters[bKey].active) {
          this.connectToBroadcaster(bKey);
        }
      });
    });
    this.activeListeners.push(presenceRef);
  }

  // VIEWER MEMINTA STREAM DARI PENYIAR
  connectToBroadcaster(bKey) {
    if (this.peers.has(bKey)) return;

    const connPath = `webrtc_signals/${this.roomToken}/${bKey}/${this.roleKey}`;
    const connRef = this.db.ref(connPath);

    // Tandai viewer sedang meminta stream
    connRef.child('request').set({
      viewerId: this.roleKey,
      timestamp: Date.now()
    });
    connRef.onDisconnect().remove();

    // Dengarkan SDP Offer dari Broadcaster
    const offerRef = connRef.child('offer');
    offerRef.on('value', async snap => {
      const offerData = snap.val();
      if (!offerData || !offerData.sdp) return;

      let pc = this.peers.get(bKey);
      if (!pc) {
        pc = new RTCPeerConnection(this.rtcConfig);
        this.peers.set(bKey, pc);
        this.iceQueues.set(bKey, []);

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            this.onRemoteStream(bKey, event.streams[0]);
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            connRef.child('ice_from_v').push(event.candidate.toJSON());
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            pc.close();
            this.peers.delete(bKey);
            this.iceQueues.delete(bKey);
          }
        };
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offerData));

        // Flush semua antrean ICE kandidat yang sempat tertunda
        const queue = this.iceQueues.get(bKey) || [];
        while (queue.length > 0) {
          const cand = queue.shift();
          try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        connRef.child('answer').set({
          sdp: answer.sdp,
          type: answer.type
        });
      } catch (err) {
        console.warn(`[WebRTC] Error handshake offer on ${bKey}:`, err);
      }
    });
    this.activeListeners.push(offerRef);

    // Dengarkan ICE kandidat dari Broadcaster
    const iceFromBRef = connRef.child('ice_from_b');
    iceFromBRef.on('child_added', snap => {
      const cand = snap.val();
      if (!cand) return;

      const pc = this.peers.get(bKey);
      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } else {
        if (!this.iceQueues.has(bKey)) this.iceQueues.set(bKey, []);
        this.iceQueues.get(bKey).push(cand);
      }
    });
    this.activeListeners.push(iceFromBRef);
  }

  // DIJALANKAN PENYIAR: Kirim Offer ke Viewer yang meminta
  async handleViewerHandshake(viewerId, bKey) {
    let pc = this.peers.get(viewerId);
    if (pc) {
      pc.close();
      this.peers.delete(viewerId);
      this.iceQueues.delete(viewerId);
    }

    pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(viewerId, pc);
    this.iceQueues.set(viewerId, []);

    const connPath = `webrtc_signals/${this.roomToken}/${bKey}/${viewerId}`;
    const connRef = this.db.ref(connPath);

    // Tambahkan track video/audio lokal ke sambungan
    const localStream = this.localStreams.get(bKey);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        connRef.child('ice_from_b').push(event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        pc.close();
        this.peers.delete(viewerId);
        this.iceQueues.delete(viewerId);
      }
    };

    // Dengarkan Answer dari Viewer
    const answerRef = connRef.child('answer');
    answerRef.on('value', async snap => {
      const answerData = snap.val();
      if (!answerData || !answerData.sdp) return;

      try {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(answerData));

          // Flush antrean ICE kandidat di Broadcaster
          const queue = this.iceQueues.get(viewerId) || [];
          while (queue.length > 0) {
            const cand = queue.shift();
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
        }
      } catch (err) {
        console.warn(`[WebRTC] Error setting answer for ${viewerId}:`, err);
      }
    });
    this.activeListeners.push(answerRef);

    // Dengarkan ICE kandidat dari Viewer
    const iceFromVRef = connRef.child('ice_from_v');
    iceFromVRef.on('child_added', snap => {
      const cand = snap.val();
      if (!cand) return;

      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } else {
        if (!this.iceQueues.has(viewerId)) this.iceQueues.set(viewerId, []);
        this.iceQueues.get(viewerId).push(cand);
      }
    });
    this.activeListeners.push(iceFromVRef);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      connRef.child('offer').set({
        sdp: offer.sdp,
        type: offer.type
      });
    } catch (err) {
      console.warn(`[WebRTC] Failed to create offer for ${viewerId}:`, err);
    }
  }

  // PUBLIKASI ATAU PEMBARUAN STREAM (DIPANGGIL OLEH CAM & SCREEN)
  publishStream(streamKey, mediaStream) {
    this.localStreams.set(streamKey, mediaStream);
    const bKey = this.getBroadcasterKey() || streamKey;

    // Jika sudah ada sambungan aktif, lakukan replaceTrack dinamis
    this.peers.forEach(pc => {
      const senders = pc.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');

      const newVideoTrack = mediaStream.getVideoTracks()[0];
      const newAudioTrack = mediaStream.getAudioTracks()[0];

      if (videoSender && newVideoTrack) {
        videoSender.replaceTrack(newVideoTrack).catch(() => {});
      } else if (!videoSender && newVideoTrack) {
        pc.addTrack(newVideoTrack, mediaStream);
      }

      if (audioSender && newAudioTrack) {
        audioSender.replaceTrack(newAudioTrack).catch(() => {});
      } else if (!audioSender && newAudioTrack) {
        pc.addTrack(newAudioTrack, mediaStream);
      }
    });

    // Nyalakan tanda kehadiran aktif di Firebase
    if (this.db) {
      this.presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}/${bKey}`);
      this.presenceRef.set({
        active: true,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      this.presenceRef.onDisconnect().remove();
    }
  }

  // HENTIKAN STREAM
  unpublishStream(streamKey) {
    this.localStreams.delete(streamKey);
    const bKey = this.getBroadcasterKey() || streamKey;

    if (this.db) {
      this.db.ref(`webrtc_presence/${this.roomToken}/${bKey}`).remove().catch(() => {});
      this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}`).remove().catch(() => {});
    }

    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.iceQueues.clear();
  }

  destroy() {
    const bKey = this.getBroadcasterKey();
    if (bKey) {
      this.unpublishStream(bKey);
    }

    this.activeListeners.forEach(ref => ref.off());
    this.activeListeners = [];
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.iceQueues.clear();
    this.localStreams.clear();
  }
}

window.SkawanStreamer = SkawanStreamer;
