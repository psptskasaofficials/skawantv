/**
 * SKAWAN TV - WebRTC Streamer Engine (v2.5 Robust LAN Mesh)
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
    this.lastHandshakes = new Map();
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
      this.onConnectionStateChange('standby');
      const reqRef = this.db.ref(`webrtc_requests/${this.roomToken}/${bKey}`);
      
      const processRequest = (snap) => {
        const viewerId = snap.key;
        const val = snap.val();
        if (!viewerId || !val) return;

        const reqTime = typeof val === 'object' ? val.timestamp : val;
        if (!reqTime) return;

        if (this.lastHandshakes.get(viewerId) === reqTime) return;
        this.lastHandshakes.set(viewerId, reqTime);

        if (this.localStreams.has(bKey)) {
          this.startBroadcasterHandshake(viewerId, bKey);
        }
      };

      reqRef.on('child_added', processRequest);
      reqRef.on('child_changed', processRequest);
      this.activeListeners.push(reqRef);

    } else {
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

    const reqRef = this.db.ref(`webrtc_requests/${this.roomToken}/${bKey}/${this.roleKey}`);
    reqRef.set({ timestamp: Date.now() });
    reqRef.onDisconnect().remove();

    const sigRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/${this.roleKey}`);
    sigRef.onDisconnect().remove();

    this.iceQueues.set(bKey, []);

    const offerRef = sigRef.child('offer');
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
            sigRef.child('ice_v').push({
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex
            });
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

        sigRef.child('answer').set({
          sdp: answer.sdp,
          type: answer.type
        });
      } catch (err) {
        console.warn(`[WebRTC] Handshake error pada ${bKey}:`, err);
      }
    });
    this.activeListeners.push(offerRef);

    const iceBRef = sigRef.child('ice_b');
    iceBRef.on('child_added', snap => {
      const cand = snap.val();
      if (!cand || !cand.candidate) return;

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

    const sigRef = this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}/${viewerId}`);

    const localStream = this.localStreams.get(bKey);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sigRef.child('ice_b').push({
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        });
      }
    };

    const updateStatus = () => {
      let isConnected = false;
      let isConnecting = false;
      let isFailed = false;

      this.peers.forEach(p => {
        const cs = p.connectionState;
        const ics = p.iceConnectionState;
        if (cs === 'connected' || ics === 'connected' || ics === 'completed') isConnected = true;
        else if (cs === 'connecting' || ics === 'checking') isConnecting = true;
        else if (cs === 'failed' || ics === 'failed') isFailed = true;
      });

      if (isConnected) this.onConnectionStateChange('connected');
      else if (isConnecting) this.onConnectionStateChange('connecting');
      else if (isFailed) this.onConnectionStateChange('failed');
      else if (this.peers.size > 0) this.onConnectionStateChange('connecting');
      else this.onConnectionStateChange('standby');
    };

    pc.onconnectionstatechange = updateStatus;
    pc.oniceconnectionstatechange = updateStatus;

    sigRef.child('answer').remove().catch(() => {});
    sigRef.child('ice_b').remove().catch(() => {});
    sigRef.child('ice_v').remove().catch(() => {});

    const answerRef = sigRef.child('answer');
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
        console.warn(`[WebRTC] Set answer error ${viewerId}:`, err);
      }
    });
    this.activeListeners.push(answerRef);

    const iceVRef = sigRef.child('ice_v');
    iceVRef.on('child_added', snap => {
      const cand = snap.val();
      if (!cand || !cand.candidate) return;

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

      sigRef.child('offer').set({
        sdp: offer.sdp,
        type: offer.type
      });
    } catch (err) {
      console.warn(`[WebRTC] Create offer error ${viewerId}:`, err);
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

      this.db.ref(`webrtc_requests/${this.roomToken}/${bKey}`).once('value', snap => {
        const requests = snap.val() || {};
        Object.keys(requests).forEach(viewerId => {
          if (requests[viewerId]) {
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
      this.db.ref(`webrtc_requests/${this.roomToken}/${bKey}`).remove().catch(() => {});
      this.db.ref(`webrtc_signals/${this.roomToken}/${bKey}`).remove().catch(() => {});
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
