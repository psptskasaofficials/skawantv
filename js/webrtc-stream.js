/**
 * SKAWAN TV - WebRTC Streamer Engine (v2.4 LAN Production Mesh)
 * Multi-Cam HP, Screen Share, Audio Master, & Multi-Viewer
 */
class SkawanStreamer {
  constructor(options = {}) {
    this.roomToken = (options.roomToken || 'SKASA').toUpperCase();
    this.roleKey = options.roleKey || `peer_${Math.random().toString(36).substring(2, 7)}`;
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onConnectionStateChange = options.onConnectionStateChange || (() => {});
    
    this.db = window.db || (typeof firebase !== 'undefined' && firebase.database ? firebase.database() : null);

    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
      ]
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
      // SISI BROADCASTER (Cam 1-3, Screen Share)
      this.onConnectionStateChange('standby');
      const sessionRef = this.db.ref(`webrtc_sessions/${this.roomToken}/${bKey}`);
      
      const handleRequest = (snap) => {
        const viewerId = snap.key;
        const val = snap.val();
        if (!viewerId || !val) return;

        if (val.request && this.localStreams.has(bKey)) {
          this.startBroadcasterHandshake(viewerId, bKey);
        }
      };

      sessionRef.on('child_added', handleRequest);
      sessionRef.on('child_changed', handleRequest);
      this.activeListeners.push(sessionRef);

    } else {
      // SISI VIEWER (Switcher, PD, Live, Index)
      this.discoverBroadcasters();
    }
  }

  discoverBroadcasters() {
    const presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}`);
    presenceRef.on('value', snap => {
      const active = snap.val() || {};
      Object.keys(active).forEach(bKey => {
        if (active[bKey] && active[bKey].active) {
          this.connectToBroadcaster(bKey);
        }
      });
    });
    this.activeListeners.push(presenceRef);
  }

  connectToBroadcaster(bKey) {
    if (this.peers.has(bKey)) return;

    const connRef = this.db.ref(`webrtc_sessions/${this.roomToken}/${bKey}/${this.roleKey}`);
    
    connRef.set({
      request: Date.now(),
      viewerId: this.roleKey
    });
    connRef.onDisconnect().remove();

    this.iceQueues.set(bKey, []);

    const offerRef = connRef.child('offer');
    offerRef.on('value', async snap => {
      const offerData = snap.val();
      if (!offerData || !offerData.sdp) return;

      let pc = this.peers.get(bKey);
      if (!pc) {
        pc = new RTCPeerConnection(this.rtcConfig);
        this.peers.set(bKey, pc);

        pc.ontrack = (event) => {
          let stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
          this.onRemoteStream(bKey, stream);
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            connRef.child('ice_v').push(event.candidate.toJSON());
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            pc.close();
            this.peers.delete(bKey);
            this.iceQueues.delete(bKey);
            setTimeout(() => this.connectToBroadcaster(bKey), 1200);
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
        console.warn(`[WebRTC] Viewer error on ${bKey}:`, err);
      }
    });
    this.activeListeners.push(offerRef);

    const iceBRef = connRef.child('ice_b');
    iceBRef.on('child_added', snap => {
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
    this.activeListeners.push(iceBRef);
  }

  async startBroadcasterHandshake(viewerId, bKey) {
    this.onConnectionStateChange('connecting');

    let pc = this.peers.get(viewerId);
    if (pc) {
      pc.close();
      this.peers.delete(viewerId);
      this.iceQueues.delete(viewerId);
    }

    pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(viewerId, pc);
    this.iceQueues.set(viewerId, []);

    const connRef = this.db.ref(`webrtc_sessions/${this.roomToken}/${bKey}/${viewerId}`);

    const localStream = this.localStreams.get(bKey);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        connRef.child('ice_b').push(event.candidate.toJSON());
      }
    };

    pc.onconnectionstatechange = () => {
      this.updateBroadcasterConnectionStatus();
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        pc.close();
        this.peers.delete(viewerId);
        this.iceQueues.delete(viewerId);
      }
    };

    connRef.child('answer').remove().catch(() => {});
    connRef.child('ice_b').remove().catch(() => {});
    connRef.child('ice_v').remove().catch(() => {});

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
        console.warn(`[WebRTC] Set answer error for ${viewerId}:`, err);
      }
    });
    this.activeListeners.push(answerRef);

    const iceVRef = connRef.child('ice_v');
    iceVRef.on('child_added', snap => {
      const cand = snap.val();
      if (!cand) return;

      if (pc && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      } else {
        if (!this.iceQueues.has(viewerId)) this.iceQueues.set(viewerId, []);
        this.iceQueues.get(viewerId).push(cand);
      }
    });
    this.activeListeners.push(iceVRef);

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

  updateBroadcasterConnectionStatus() {
    let hasConnected = false;
    let hasConnecting = false;
    let hasFailed = false;

    this.peers.forEach(pc => {
      if (pc.connectionState === 'connected') hasConnected = true;
      else if (pc.connectionState === 'connecting') hasConnecting = true;
      else if (pc.connectionState === 'failed') hasFailed = true;
    });

    if (hasConnected) {
      this.onConnectionStateChange('connected');
    } else if (hasConnecting) {
      this.onConnectionStateChange('connecting');
    } else if (hasFailed) {
      this.onConnectionStateChange('failed');
    } else {
      this.onConnectionStateChange('standby');
    }
  }

  publishStream(streamKey, mediaStream) {
    this.localStreams.set(streamKey, mediaStream);
    const bKey = this.getBroadcasterKey() || streamKey;

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

    if (this.db) {
      this.presenceRef = this.db.ref(`webrtc_presence/${this.roomToken}/${bKey}`);
      this.presenceRef.set({
        active: true,
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      });
      this.presenceRef.onDisconnect().remove();

      this.db.ref(`webrtc_sessions/${this.roomToken}/${bKey}`).once('value', snap => {
        const sessions = snap.val() || {};
        Object.keys(sessions).forEach(viewerId => {
          if (sessions[viewerId] && sessions[viewerId].request) {
            this.startBroadcasterHandshake(viewerId, bKey);
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
      this.db.ref(`webrtc_sessions/${this.roomToken}/${bKey}`).remove().catch(() => {});
    }

    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.iceQueues.clear();
    this.onConnectionStateChange('standby');
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
