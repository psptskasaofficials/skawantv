/**
 * SKAWAN TV - WebRTC Streamer Engine (v2.2 Robust Mesh Signaling)
 * Multi-Cam HP, Screen Share, & Multi-Viewer Switcher/PD/PGM
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
        { urls: 'stun:stun3.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    };

    this.localStreams = new Map();
    this.peers = new Map();
    this.iceQueues = new Map();
    this.activeListeners = [];

    this.initSignaling();
  }

  getBroadcasterKey() {
    if (this.roleKey.startsWith('cam_')) return this.roleKey;
    if (this.roleKey.startsWith('cam')) return 'cam_' + this.roleKey.replace('cam', '');
    if (this.roleKey === 'sharescreen') return 'sharescreen';
    if (this.roleKey === 'audio_master') return 'audio_master';
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
      // PENYIAR (cam_1, cam_2, cam_3, sharescreen, audio_master)
      const requestsRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}`);
      requestsRef.on('child_added', snap => {
        const viewerId = snap.key;
        if (!viewerId) return;

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

  connectToBroadcaster(bKey) {
    if (this.peers.has(bKey)) return;

    const connPath = `webrtc_signals/${this.roomToken}/${bKey}/${this.roleKey}`;
    const connRef = this.db.ref(connPath);

    connRef.child('request').set({
      viewerId: this.roleKey,
      timestamp: Date.now()
    });
    connRef.onDisconnect().remove();

    if (!this.iceQueues.has(bKey)) {
      this.iceQueues.set(bKey, []);
    }

    const offerRef = connRef.child('offer');
    offerRef.on('value', async snap => {
      const offerData = snap.val();
      if (!offerData || !offerData.sdp) return;

      let pc = this.peers.get(bKey);
      if (!pc) {
        pc = new RTCPeerConnection(this.rtcConfig);
        this.peers.set(bKey, pc);

        pc.ontrack = (event) => {
          let stream = (event.streams && event.streams[0]) ? event.streams[0] : null;
          if (!stream) {
            stream = new MediaStream([event.track]);
          }
          this.onRemoteStream(bKey, stream);
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
        console.warn(`[WebRTC] Handshake error offer on ${bKey}:`, err);
      }
    });
    this.activeListeners.push(offerRef);

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

    const answerRef = connRef.child('answer');
    answerRef.on('value', async snap => {
      const answerData = snap.val();
      if (!answerData || !answerData.sdp) return;

      try {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(answerData));

          const queue = this.iceQueues.get(viewerId) || [];
          while (queue.length > 0) {
            const cand = queue.shift();
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
        }
      } catch (err) {
        console.warn(`[WebRTC] Answer error for ${viewerId}:`, err);
      }
    });
    this.activeListeners.push(answerRef);

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
      console.warn(`[WebRTC] Offer error for ${viewerId}:`, err);
    }
  }

  publishStream(streamKey, mediaStream) {
    this.localStreams.set(streamKey, mediaStream);
    const bKey = this.getBroadcasterKey() || streamKey;

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

    if (this.db) {
      this.presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}/${bKey}`);
      this.presenceRef.set({
        active: true,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      this.presenceRef.onDisconnect().remove();

      // Trigger re-handshake untuk viewer yang sudah meminta sebelum stream siap
      this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}`).once('value', snap => {
        const viewers = snap.val() || {};
        Object.keys(viewers).forEach(viewerId => {
          if (viewers[viewerId] && viewers[viewerId].request) {
            this.handleViewerHandshake(viewerId, bKey);
          }
        });
      });
    }
  }

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
