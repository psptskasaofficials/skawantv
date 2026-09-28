<!-- ... existing code ... -->
      timerRemainingSeconds = totalSec;
      renderRundownTimer();
    }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 font-sans min-h-screen flex flex-col selection:bg-rose-600 selection:text-white pb-6">

<!-- ... existing code ... -->

    <!-- 2. MULTIVIEW STUDIO FEEDS (SIMULTAN) -->
    <div class="bg-slate-950 border border-slate-800 rounded-2xl p-3 shadow-md space-y-2">
      <div class="flex items-center justify-between pb-1 border-b border-slate-800 text-xs">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span class="font-brand font-bold text-slate-200 uppercase tracking-wider">Multiview Live Feeds (Simultan)</span>
        </div>
        <span class="font-mono text-[10px] text-slate-400">Pantau seluruh framing kamera & VT secara simultan</span>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5" id="multiviewCardsGrid">
        <!-- Render otomatis via JavaScript -->
      </div>
    </div>

<!-- ... existing code ... -->
    let pdPgmYt = null;
    let pdPvwYt = null;
    let isYtReady = false;
    let currentPgmYtId = '';
    let currentPvwYtId = '';

    const remoteCamStreams = new Map();
    let streamerInstance = null;

    let pdMvYt = null;
    let currentMvYtId = '';

    let rundownData = [
// ... existing code ...
    function startWibLiveClock() {
      setInterval(() => {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('id-ID', {
          timeZone: 'Asia/Jakarta',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        const wibStr = `${formatter.format(now)} WIB`;
        const clockEl = document.getElementById('pdTickerWibHeader');
        if (clockEl) clockEl.innerText = wibStr;
      }, 1000);
    }

    // Inisialisasi YouTube API untuk Sutradara (3 Player: PGM, PVW, dan Multiview Thumbnail VT)
    window.onYouTubeIframeAPIReady = function() {
      isYtReady = true;
      const playerDefaults = {
        playsinline: 1,
        controls: 0,
        rel: 0,
        mute: 1,
        modestbranding: 1,
        disablekb: 1,
        cc_load_policy: 0, // Matikan takarir/CC bawaan
        iv_load_policy: 3  // Matikan anotasi pop-up
      };

      try {
        pdPgmYt = new YT.Player('pgmVtYtEl', {
          height: '100%', width: '100%',
          videoId: DEFAULT_SKASA_CLIP.youtubeId,
          playerVars: playerDefaults,
          events: { onReady: () => { syncVtDisplay(); } }
        });
        pdPvwYt = new YT.Player('pvwVtYtEl', {
          height: '100%', width: '100%',
          videoId: DEFAULT_SKASA_CLIP.youtubeId,
          playerVars: playerDefaults,
          events: { onReady: () => { syncVtDisplay(); } }
        });
        const mvYtContainer = document.getElementById('mv-vt-yt-el');
        if (mvYtContainer) {
          pdMvYt = new YT.Player('mv-vt-yt-el', {
            height: '100%', width: '100%',
            videoId: DEFAULT_SKASA_CLIP.youtubeId,
            playerVars: playerDefaults,
            events: { onReady: () => { syncVtDisplay(); } }
          });
        }
      } catch (e) {
        console.warn("[PD] YouTube Player init error:", e);
      }
    };

    window.addEventListener('DOMContentLoaded', () => {
// ... existing code ...
      renderMultiviewCards();
      updateMonitors();

      // Inisialisasi WebRTC Streamer (Role: PD Receiver)
      if (typeof SkawanStreamer !== 'undefined') {
        streamerInstance = new SkawanStreamer({
          roomToken: token,
          roleKey: 'pd',
          onRemoteStream: (camKey, stream) => {
            console.log(`[WebRTC PD] Feed diterima dari ${camKey}`);
            const normKey = camKey.includes('_') ? camKey : camKey.replace('cam', 'cam_');
            remoteCamStreams.set(normKey, stream);
            remoteCamStreams.set(camKey, stream);

            // 1. Perbarui Thumbnail Multiview Kamera secara seketika
            const mvVideo = document.getElementById(`mv-video-${normKey}`) || document.getElementById(`mv-video-${camKey}`);
            if (mvVideo) {
              if (mvVideo.srcObject !== stream) mvVideo.srcObject = stream;
              mvVideo.classList.remove('hidden');
              mvVideo.play().catch(() => {});
            }

            const mvLabel = document.getElementById(`mv-label-${normKey}`) || document.getElementById(`mv-label-${camKey}`);
            if (mvLabel) {
              mvLabel.innerText = "● LIVE FEED";
              mvLabel.className = "text-center font-mono font-black text-xs text-emerald-400 relative z-10 animate-pulse drop-shadow";
            }

            // 2. Perbarui PVW dan PGM jika kamera ini sedang aktif
            updateMonitors();
          },
          onStatusChange: (status, info) => {
            console.log(`[WebRTC PD] Status: ${status} - ${info}`);
          }
        });
      }
    }

    function getCameraStream(key) {
      if (!key) return null;
      if (remoteCamStreams.has(key)) return remoteCamStreams.get(key);
      const altKey = key.includes('_') ? key.replace('_', '') : key.replace('cam', 'cam_');
      if (remoteCamStreams.has(altKey)) return remoteCamStreams.get(altKey);
      return null;
    }

    // Merender Multiview Inputs: Cam 1, Cam 2, Cam 3, dan VT secara simultan
    function renderMultiviewCards() {
      const grid = document.getElementById('multiviewCardsGrid');
      grid.innerHTML = '';

      const sources = [];
      for (let i = 1; i <= totalCameras; i++) {
        sources.push({ key: `cam_${i}`, label: `CAM ${i}`, sub: `Kamera HP ${i}` });
      }
      sources.push({ key: 'vt', label: 'VT / MEDIA', sub: 'Pemutar YouTube/Drive' });

      sources.forEach(src => {
        const card = document.createElement('div');
        card.id = `mv-card-${src.key}`;
        card.className = "bg-slate-900 border-2 border-slate-700 rounded-xl p-2 flex flex-col justify-between aspect-video relative overflow-hidden shadow";

        if (src.key === 'vt') {
          // Kotak Multiview khusus VT (Mendukung YouTube, Drive, dan HTML5 secara live)
          card.innerHTML = `
            <div id="mv-vt-wrapper" class="absolute inset-0 w-full h-full bg-black flex items-center justify-center pointer-events-none">
              <video id="mv-vt-html5" class="w-full h-full object-contain hidden" playsinline muted autoplay></video>
              <div id="mv-vt-yt-wrap" class="w-full h-full hidden pointer-events-none">
                <div id="mv-vt-yt-el" class="w-full h-full"></div>
              </div>
              <iframe id="mv-vt-gdrive" class="w-full h-full border-0 hidden pointer-events-none"></iframe>
            </div>

            <div class="flex items-center justify-between relative z-10">
              <span class="font-brand font-black text-xs text-white drop-shadow">${src.label}</span>
              <span id="mv-badge-${src.key}" class="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                OFF
              </span>
            </div>

            <div class="text-center font-mono font-bold text-xs text-slate-400 relative z-10" id="mv-label-${src.key}">
              VT PLAYLIST
            </div>

            <div class="text-[9px] text-slate-300 font-mono truncate relative z-10 drop-shadow" id="mv-sub-vt">Profil SKAWAN TV</div>
            <div class="scanline absolute inset-0 pointer-events-none"></div>
          `;
        } else {
          // Kotak Multiview Kamera HP
          card.innerHTML = `
            <video id="mv-video-${src.key}" class="hidden absolute inset-0 w-full h-full object-cover pointer-events-none" autoplay playsinline muted></video>

            <div class="flex items-center justify-between relative z-10">
              <span class="font-brand font-black text-xs text-white drop-shadow">${src.label}</span>
              <span id="mv-badge-${src.key}" class="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                OFF
              </span>
            </div>

            <div class="text-center font-mono font-bold text-xs text-slate-400 relative z-10" id="mv-label-${src.key}">
              MENUNGGU FEED
            </div>

            <div class="text-[9px] text-slate-400 font-mono truncate relative z-10 drop-shadow">${src.sub}</div>
            <div class="scanline absolute inset-0 pointer-events-none"></div>
          `;
        }

        grid.appendChild(card);

        // Jika stream kamera sudah ada di memori, langsung pasang seketika
        if (src.key !== 'vt') {
          const existingStream = getCameraStream(src.key);
          if (existingStream) {
            setTimeout(() => {
              const vid = document.getElementById(`mv-video-${src.key}`);
              const lbl = document.getElementById(`mv-label-${src.key}`);
              if (vid) {
                if (vid.srcObject !== existingStream) vid.srcObject = existingStream;
                vid.classList.remove('hidden');
                vid.play().catch(() => {});
              }
              if (lbl) {
                lbl.innerText = "● LIVE FEED";
                lbl.className = "text-center font-mono font-black text-xs text-emerald-400 relative z-10 animate-pulse drop-shadow";
              }
            }, 60);
          }
        }
      });

      // Inisialisasi ulang thumbnail YouTube jika player belum terpasang
      if (isYtReady && !pdMvYt && document.getElementById('mv-vt-yt-el')) {
        try {
          pdMvYt = new YT.Player('mv-vt-yt-el', {
            height: '100%', width: '100%',
            videoId: latestVtState.youtubeId || DEFAULT_SKASA_CLIP.youtubeId,
            playerVars: {
              playsinline: 1, controls: 0, rel: 0, mute: 1, modestbranding: 1, disablekb: 1,
              cc_load_policy: 0, iv_load_policy: 3
            },
            events: { onReady: () => syncVtDisplay() }
          });
        } catch (e) {}
      }

      updateTallyVisuals();
      syncVtDisplay();
    }

    function updateTallyVisuals() {
// ... existing code ...
        } else {
          card.className = "bg-slate-900 border-2 border-slate-700 rounded-xl p-2 flex flex-col justify-between aspect-video relative overflow-hidden shadow";
          badge.className = "text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400";
          badge.innerText = "OFF";
        }
      });
    }

    function updateMonitors() {
      const pgmLabel = (liveState.programSource || 'cam_1').toUpperCase().replace('_', ' ');
      const pvwLabel = (liveState.previewSource || 'cam_2').toUpperCase().replace('_', ' ');

      document.getElementById('badgePgmSource').innerText = pgmLabel;
      document.getElementById('pgmScreenLabel').innerText = pgmLabel;
      document.getElementById('badgePvwSource').innerText = pvwLabel;
      document.getElementById('pvwScreenLabel').innerText = pvwLabel;

      // 1. Program Monitor (PGM Live Feed) - Transisi mulus bebas freeze
      const pgmVideo = document.getElementById('pgmCamVideo');
      const pgmFallback = document.getElementById('pgmFallbackBox');
      const pgmVtWrap = document.getElementById('pgmVtWrapper');

      if (liveState.programSource === 'vt') {
        pgmVideo.classList.add('hidden');
        pgmFallback.classList.add('hidden');
        pgmVtWrap.classList.remove('hidden');
      } else {
        pgmVtWrap.classList.add('hidden');
        const stream = getCameraStream(liveState.programSource);
        if (stream) {
          if (pgmVideo.srcObject !== stream) pgmVideo.srcObject = stream;
          pgmVideo.classList.remove('hidden');
          pgmFallback.classList.add('hidden');
          pgmVideo.play().catch(() => {});
        } else {
          pgmVideo.classList.add('hidden');
          pgmFallback.classList.remove('hidden');
        }
      }

      // 2. Preview Monitor (PVW Live Feed) - Transisi mulus bebas freeze
      const pvwVideo = document.getElementById('pvwCamVideo');
      const pvwFallback = document.getElementById('pvwFallbackBox');
      const pvwVtWrap = document.getElementById('pvwVtWrapper');

      if (liveState.previewSource === 'vt') {
        pvwVideo.classList.add('hidden');
        pvwFallback.classList.add('hidden');
        pvwVtWrap.classList.remove('hidden');
      } else {
        pvwVtWrap.classList.add('hidden');
        const stream = getCameraStream(liveState.previewSource);
        if (stream) {
          if (pvwVideo.srcObject !== stream) pvwVideo.srcObject = stream;
          pvwVideo.classList.remove('hidden');
          pvwFallback.classList.add('hidden');
          pvwVideo.play().catch(() => {});
        } else {
          pvwVideo.classList.add('hidden');
          pvwFallback.classList.remove('hidden');
        }
      }

      // 3. Pastikan seluruh elemen video kamera di multiview tetap bermain tanpa henti
      for (let i = 1; i <= totalCameras; i++) {
        const cStream = getCameraStream(`cam_${i}`);
        const cVideo = document.getElementById(`mv-video-cam_${i}`);
        if (cStream && cVideo) {
          if (cVideo.srcObject !== cStream) cVideo.srcObject = cStream;
          cVideo.classList.remove('hidden');
          cVideo.play().catch(() => {});
        }
      }

      syncVtDisplay();
    }

    function syncVtDisplay() {
      const isPgmVt = liveState.programSource === 'vt';
      const isPvwVt = liveState.previewSource === 'vt';

      const pgmHtml5 = document.getElementById('pgmVtHtml5');
      const pvwHtml5 = document.getElementById('pvwVtHtml5');
      const mvHtml5 = document.getElementById('mv-vt-html5');

      const pgmYtWrap = document.getElementById('pgmVtYtWrap');
      const pvwYtWrap = document.getElementById('pvwVtYtWrap');
      const mvYtWrap = document.getElementById('mv-vt-yt-wrap');

      const pgmGdrive = document.getElementById('pgmVtGdrive');
      const pvwGdrive = document.getElementById('pvwVtGdrive');
      const mvGdrive = document.getElementById('mv-vt-gdrive');

      const mvSub = document.getElementById('mv-sub-vt');
      if (mvSub && latestVtState.title) {
        mvSub.innerText = latestVtState.title;
      }

      const ytId = latestVtState.youtubeId || (latestVtState.sourceType === 'youtube' ? (latestVtState.url || 'XhwSTlXTJRc') : '');
      const isPlaying = latestVtState.status === 'playing';

      if (latestVtState.sourceType === 'youtube' && ytId) {
        // Mode YouTube Player
        if (pgmHtml5) pgmHtml5.classList.add('hidden');
        if (pvwHtml5) pvwHtml5.classList.add('hidden');
        if (mvHtml5) mvHtml5.classList.add('hidden');

        if (pgmGdrive) pgmGdrive.classList.add('hidden');
        if (pvwGdrive) pvwGdrive.classList.add('hidden');
        if (mvGdrive) mvGdrive.classList.add('hidden');

        if (pgmYtWrap) pgmYtWrap.classList.remove('hidden');
        if (pvwYtWrap) pvwYtWrap.classList.remove('hidden');
        if (mvYtWrap) mvYtWrap.classList.remove('hidden');

        if (isYtReady) {
          // Program Player
          if (pdPgmYt && typeof pdPgmYt.loadVideoById === 'function') {
            if (currentPgmYtId !== ytId) {
              currentPgmYtId = ytId;
              if (isPlaying && isPgmVt) pdPgmYt.loadVideoById(ytId, latestVtState.currentTime || 0);
              else pdPgmYt.cueVideoById(ytId, latestVtState.currentTime || 0);
            } else {
              if (isPlaying && isPgmVt) {
                pdPgmYt.playVideo();
                const cur = pdPgmYt.getCurrentTime() || 0;
                if (Math.abs(cur - (latestVtState.currentTime || 0)) > 2) {
                  pdPgmYt.seekTo(latestVtState.currentTime, true);
                }
              } else {
                pdPgmYt.pauseVideo();
              }
            }
          }

          // Preview Player
          if (pdPvwYt && typeof pdPvwYt.loadVideoById === 'function') {
            if (currentPvwYtId !== ytId) {
              currentPvwYtId = ytId;
              if (isPlaying && isPvwVt) pdPvwYt.loadVideoById(ytId, latestVtState.currentTime || 0);
              else pdPvwYt.cueVideoById(ytId, latestVtState.currentTime || 0);
            } else {
              if (isPlaying && isPvwVt) {
                pdPvwYt.playVideo();
                const cur = pdPvwYt.getCurrentTime() || 0;
                if (Math.abs(cur - (latestVtState.currentTime || 0)) > 2) {
                  pdPvwYt.seekTo(latestVtState.currentTime, true);
                }
              } else {
                pdPvwYt.pauseVideo();
              }
            }
          }

          // Multiview Thumbnail VT Player (Selalu Live)
          if (pdMvYt && typeof pdMvYt.loadVideoById === 'function') {
            if (currentMvYtId !== ytId) {
              currentMvYtId = ytId;
              if (isPlaying) pdMvYt.loadVideoById(ytId, latestVtState.currentTime || 0);
              else pdMvYt.cueVideoById(ytId, latestVtState.currentTime || 0);
            } else {
              if (isPlaying) {
                pdMvYt.playVideo();
                const cur = pdMvYt.getCurrentTime() || 0;
                if (Math.abs(cur - (latestVtState.currentTime || 0)) > 2) {
                  pdMvYt.seekTo(latestVtState.currentTime, true);
                }
              } else {
                pdMvYt.pauseVideo();
              }
            }
          }
        }
      } else if (latestVtState.sourceType === 'gdrive') {
        // Mode Google Drive
        if (pgmHtml5) pgmHtml5.classList.add('hidden');
        if (pvwHtml5) pvwHtml5.classList.add('hidden');
        if (mvHtml5) mvHtml5.classList.add('hidden');

        if (pgmYtWrap) pgmYtWrap.classList.add('hidden');
        if (pvwYtWrap) pvwYtWrap.classList.add('hidden');
        if (mvYtWrap) mvYtWrap.classList.add('hidden');

        if (pgmGdrive) pgmGdrive.classList.remove('hidden');
        if (pvwGdrive) pvwGdrive.classList.remove('hidden');
        if (mvGdrive) mvGdrive.classList.remove('hidden');

        if (latestVtState.url) {
          if (pgmGdrive && pgmGdrive.src !== latestVtState.url) pgmGdrive.src = latestVtState.url;
          if (pvwGdrive && pvwGdrive.src !== latestVtState.url) pvwGdrive.src = latestVtState.url;
          if (mvGdrive && mvGdrive.src !== latestVtState.url) mvGdrive.src = latestVtState.url;
        }
      } else {
        // Mode HTML5 Native MP4
        if (pgmYtWrap) pgmYtWrap.classList.add('hidden');
        if (pvwYtWrap) pvwYtWrap.classList.add('hidden');
        if (mvYtWrap) mvYtWrap.classList.add('hidden');

        if (pgmGdrive) pgmGdrive.classList.add('hidden');
        if (pvwGdrive) pvwGdrive.classList.add('hidden');
        if (mvGdrive) mvGdrive.classList.add('hidden');

        if (pgmHtml5) pgmHtml5.classList.remove('hidden');
        if (pvwHtml5) pvwHtml5.classList.remove('hidden');
        if (mvHtml5) mvHtml5.classList.remove('hidden');

        if (latestVtState.url) {
          if (pgmHtml5 && pgmHtml5.src !== latestVtState.url) pgmHtml5.src = latestVtState.url;
          if (pvwHtml5 && pvwHtml5.src !== latestVtState.url) pvwHtml5.src = latestVtState.url;
          if (mvHtml5 && mvHtml5.src !== latestVtState.url) mvHtml5.src = latestVtState.url;
        }

        if (isPlaying) {
          if (isPgmVt && pgmHtml5) pgmHtml5.play().catch(()=>{});
          if (isPvwVt && pvwHtml5) pvwHtml5.play().catch(()=>{});
          if (mvHtml5) mvHtml5.play().catch(()=>{});
        } else {
          if (pgmHtml5) pgmHtml5.pause();
          if (pvwHtml5) pvwHtml5.pause();
          if (mvHtml5) mvHtml5.pause();
        }
      }
    }

    function applyCgOverlay(cg) {
// ... existing code ...
