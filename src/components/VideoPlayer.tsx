import { useRef, useEffect, useCallback, useState } from 'react';
import Hls from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { Heart, HeartBreak } from 'phosphor-react';
import { useAppStore } from '../stores/AppStore';

const VideoPlayer = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressUpdateIntervalRef = useRef<number | null>(null);
  const { streamUrl, settings, getAvailableQualities, changeStreamQuality, handleStreamOffline, isAutoSwitching, currentStream, currentUser, stopStream } = useAppStore();
  const playerSettings = settings.video_player;
  // Store settings in a ref so createPlayer doesn't need to depend on them
  // This prevents player recreation when volume/muted settings change
  const playerSettingsRef = useRef(playerSettings);
  playerSettingsRef.current = playerSettings;
  const isLiveRef = useRef<boolean>(true);
  const userInitiatedPauseRef = useRef<boolean>(false);
  const hasJumpedToLiveRef = useRef<boolean>(false);
  const [availableQualities, setAvailableQualities] = useState<string[]>([]);
  // Overlay visibility state (works in both normal and fullscreen modes)
  const [showOverlay, setShowOverlay] = useState(false);
  const overlayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const OVERLAY_HIDE_DELAY = 2600; // Match Plyr's native control hide timing (2.6s)

  // Follow state
  const [isFollowing, setIsFollowing] = useState<boolean | null>(null);
  const [followLoading, setFollowLoading] = useState(false);
  const [checkingFollowStatus, setCheckingFollowStatus] = useState(true);
  const [heartDropAnimation, setHeartDropAnimation] = useState(false);

  // Track consecutive fatal errors to determine when stream is truly offline
  const fatalErrorCountRef = useRef<number>(0);
  const manifestErrorCountRef = useRef<number>(0);
  const nonFatalErrorCountRef = useRef<number>(0); // Track non-fatal errors like bufferStalled, fragParsing
  const lastErrorTimeRef = useRef<number>(0);
  const lastSuccessfulPlayRef = useRef<number>(0);
  const lastFragLoadedTimeRef = useRef<number>(0); // Track when we last received a fragment
  const maxFatalErrorsBeforeOffline = 5; // Increased from 3 - be more tolerant
  const maxManifestErrorsBeforeOffline = 4; // Increased from 2 - be more tolerant
  const maxNonFatalErrorsBeforeOffline = 8; // Non-fatal errors threshold (bufferStalled, fragParsing)
  const errorResetTimeMs = 30000; // Reset error count after 30 seconds of stability
  const minPlayTimeBeforeOfflineMs = 5000; // Must have played at least 5 seconds before considering offline
  const noFragmentTimeoutMs = 15000; // If no fragments received for 15 seconds with errors, stream is likely offline

  // Sync volume with store
  const syncVolumeToPlayer = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.volume = playerSettings.volume;
      playerRef.current.muted = playerSettings.muted;
    }
  }, [playerSettings.volume, playerSettings.muted]);

  // Fetch available qualities from Streamlink
  useEffect(() => {
    if (streamUrl) {
      getAvailableQualities().then(qualities => {
        if (qualities.length > 0) {
          setAvailableQualities(qualities);
          console.log('[Quality] Fetched from Streamlink:', qualities);
        }
      });
    }
  }, [streamUrl, getAvailableQualities]);

  // Update quality menu when qualities are available
  const updateQualityMenu = useCallback(() => {
    const container = containerRef.current;
    if (!container || availableQualities.length === 0) return;

    console.log('[Quality] Setting up menu with Streamlink qualities:', availableQualities);
    console.log('[Quality] Current selected quality from settings:', settings.quality);

    setTimeout(() => {
      const settingsMenu = container.querySelector('.plyr__menu');
      if (!settingsMenu) {
        console.warn('[Quality] Could not find Plyr settings menu');
        return;
      }

      // Remove existing quality menu if any
      const existingQualityMenu = settingsMenu.querySelector('[data-quality-menu]');
      if (existingQualityMenu) {
        existingQualityMenu.remove();
      }

      const existingQualityButton = settingsMenu.querySelector('[data-plyr="quality"]');
      if (existingQualityButton) {
        existingQualityButton.remove();
      }

      // Determine the display value - use the actual quality being streamed
      const currentQualityDisplay = settings.quality.charAt(0).toUpperCase() + settings.quality.slice(1);

      // Create quality menu item in main settings
      const settingsHome = settingsMenu.querySelector('[role="menu"]');
      if (settingsHome) {
        const qualityMenuItem = document.createElement('button');
        qualityMenuItem.className = 'plyr__control';
        qualityMenuItem.setAttribute('data-plyr', 'quality');
        qualityMenuItem.setAttribute('type', 'button');
        qualityMenuItem.setAttribute('role', 'menuitem');
        qualityMenuItem.innerHTML = `
          <span>Quality<span class="plyr__menu__value">${currentQualityDisplay}</span></span>
        `;

        qualityMenuItem.addEventListener('click', () => {
          const qualitySubmenu = settingsMenu.querySelector('[data-quality-menu]');
          if (qualitySubmenu) {
            settingsHome.setAttribute('hidden', '');
            qualitySubmenu.removeAttribute('hidden');
          }
        });

        // Insert before speed option
        const speedOption = settingsHome.querySelector('[data-plyr="speed"]');
        if (speedOption) {
          settingsHome.insertBefore(qualityMenuItem, speedOption);
        } else {
          settingsHome.appendChild(qualityMenuItem);
        }

        // Create quality submenu (as sibling to settingsHome, not a new menu container)
        const qualitySubmenu = document.createElement('div');
        qualitySubmenu.setAttribute('role', 'menu');
        qualitySubmenu.setAttribute('data-quality-menu', '');
        qualitySubmenu.setAttribute('hidden', '');
        qualitySubmenu.innerHTML = `
          <button class="plyr__control plyr__control--back" type="button" data-plyr="back">
            <span>Quality</span>
          </button>
          ${availableQualities.map(quality => `
            <button 
              class="plyr__control" 
              type="button" 
              data-quality="${quality}"
              role="menuitemradio"
              aria-checked="${quality.toLowerCase() === settings.quality.toLowerCase() ? 'true' : 'false'}"
            >
              <span>${quality.charAt(0).toUpperCase() + quality.slice(1)}</span>
            </button>
          `).join('')}
        `;

        // Add as sibling to settings home inside the menu container
        const menuContainer = settingsMenu.querySelector('.plyr__menu__container');
        if (menuContainer) {
          menuContainer.appendChild(qualitySubmenu);
        }

        // Handle back button
        const backBtn = qualitySubmenu.querySelector('[data-plyr="back"]');
        backBtn?.addEventListener('click', () => {
          qualitySubmenu.setAttribute('hidden', '');
          settingsHome.removeAttribute('hidden');
        });

        // Handle quality selection
        qualitySubmenu.querySelectorAll('[data-quality]').forEach(btn => {
          if (btn.getAttribute('data-plyr') === 'back') return;

          btn.addEventListener('click', async () => {
            const selectedQuality = btn.getAttribute('data-quality');
            if (!selectedQuality) return;

            console.log(`[Quality] User selected: ${selectedQuality}`);

            // Update UI - mark selected
            qualitySubmenu.querySelectorAll('[data-quality]').forEach(b => {
              if (b.getAttribute('data-plyr') === 'back') return;
              b.setAttribute('aria-checked', 'false');
            });
            btn.setAttribute('aria-checked', 'true');

            // Update value in main menu (with capitalization)
            const qualityValueSpan = settingsHome.querySelector('[data-plyr="quality"] .plyr__menu__value');
            if (qualityValueSpan) {
              qualityValueSpan.textContent = selectedQuality.charAt(0).toUpperCase() + selectedQuality.slice(1);
            }

            // Close menu
            qualitySubmenu.setAttribute('hidden', '');
            settingsHome.removeAttribute('hidden');

            // Change stream quality via Streamlink
            await changeStreamQuality(selectedQuality);
          });
        });
      }
    }, 200);
  }, [availableQualities, settings.quality, changeStreamQuality]);

  // Update time display for live streams to show "LIVE" or time behind
  const updateLiveTimeDisplay = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || !isLiveRef.current) return;

    // Update time display to show "LIVE"
    const currentTimeDisplay = container.querySelector('.plyr__time--current');
    if (currentTimeDisplay) {
      const buffered = video.buffered;
      if (buffered.length > 0) {
        const bufferedEnd = buffered.end(buffered.length - 1);
        const timeFromLive = bufferedEnd - video.currentTime;

        if (timeFromLive < 5) {
          currentTimeDisplay.textContent = 'LIVE';
          currentTimeDisplay.classList.add('plyr__time--live');
        } else {
          const behindSeconds = Math.floor(timeFromLive);
          const mins = Math.floor(behindSeconds / 60);
          const secs = behindSeconds % 60;
          currentTimeDisplay.textContent = `-${mins}:${secs.toString().padStart(2, '0')}`;
          currentTimeDisplay.classList.remove('plyr__time--live');
        }
      } else {
        currentTimeDisplay.textContent = 'LIVE';
        currentTimeDisplay.classList.add('plyr__time--live');
      }
    }

    // Continue the animation loop
    if (isLiveRef.current) {
      progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);
    }
  }, []);

  const createPlayer = useCallback(() => {
    if (!videoRef.current || !streamUrl) return;

    const video = videoRef.current;
    // Read settings from ref to avoid dependency on playerSettings
    // This prevents player recreation when only volume/muted changes
    const currentSettings = playerSettingsRef.current;

    // Destroy existing HLS instance if any
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (e) {
        console.warn('Error destroying existing HLS:', e);
      }
      hlsRef.current = null;
    }

    console.log('Creating HLS.js player for URL:', streamUrl);

    // Check if HLS.js is supported
    if (Hls.isSupported()) {
      console.log('[HLS] HLS.js is supported, creating player...');

      // Create HLS.js instance with optimized settings
      // Note: liveSyncDurationCount and liveMaxLatencyDurationCount are kept at default/conservative
      // values for stability. The "jump to live" feature just does a one-time seek on load.
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: currentSettings.low_latency_mode,
        backBufferLength: 30, // Keep 30 seconds of back buffer
        maxBufferLength: currentSettings.max_buffer_length || 30, // Buffer ahead
        maxMaxBufferLength: currentSettings.max_buffer_length || 120, // Max buffer
        maxBufferSize: 60 * 1000 * 1000, // 60 MB
        maxBufferHole: 2.0, // Increased from 0.5 - allow larger gaps before seeking (helps with buffering issues)
        highBufferWatchdogPeriod: 3, // Increased from 2 - check buffer health every 3s (less aggressive)
        nudgeOffset: 0.5, // Increased from 0.1 - larger nudge when recovering (helps unstick playback)
        nudgeMaxRetry: 5, // Increased from 3 - try more times to recover from stalls
        maxFragLookUpTolerance: 0.5, // Increased from 0.25 - more tolerant fragment lookup
        liveSyncDurationCount: currentSettings.low_latency_mode ? 2 : 3, // Stay close to live edge
        liveMaxLatencyDurationCount: currentSettings.low_latency_mode ? 5 : 8, // Increased - allow more latency before seeking
        liveDurationInfinity: true, // Live stream has infinite duration
        manifestLoadingTimeOut: 10000, // 10s timeout for manifest
        manifestLoadingMaxRetry: 3, // Retry manifest 3 times
        manifestLoadingRetryDelay: 1000, // Wait 1s between retries
        levelLoadingTimeOut: 10000, // 10s timeout for level playlists
        levelLoadingMaxRetry: 4, // Retry level 4 times
        levelLoadingRetryDelay: 1000, // Wait 1s between retries
        fragLoadingTimeOut: 20000, // 20s timeout for fragments
        fragLoadingMaxRetry: 6, // Retry fragments 6 times
        fragLoadingRetryDelay: 1000, // Wait 1s between retries
        startLevel: currentSettings.start_quality || -1, // Start quality level
        // Additional buffering improvements
        abrEwmaDefaultEstimate: 500000, // Initial bandwidth estimate (500kbps)
        abrEwmaFastLive: 3.0, // Fast ABR for live streams
        abrEwmaSlowLive: 9.0, // Slow ABR for live streams
        abrBandWidthFactor: 0.95, // Be slightly conservative with bandwidth (helps prevent stalls)
        abrBandWidthUpFactor: 0.7, // Be cautious when upgrading quality
      });

      hlsRef.current = hls;

      // HLS.js event handlers
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[HLS] Manifest parsed, starting playback');
        console.log('[HLS] Available quality levels:', data.levels.map(l => `${l.height}p @ ${l.bitrate}bps`).join(', '));

        // Reset error counts on successful manifest parse - stream is working
        fatalErrorCountRef.current = 0;
        manifestErrorCountRef.current = 0;

        // Initialize Plyr AFTER we have the video loaded
        if (!playerRef.current) {
          const player = new Plyr(video, {
            controls: [
              'play-large',
              'play',
              'progress',
              'current-time',
              'mute',
              'volume',
              'settings',
              'pip',
              'fullscreen',
            ],
            settings: ['speed'], // Remove 'quality' - we'll add it manually
            speed: {
              selected: 1,
              options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
            },
            autoplay: currentSettings.autoplay,
            muted: currentSettings.muted,
            volume: currentSettings.volume,
            invertTime: false,
            keyboard: { focused: true, global: true },
            tooltips: { controls: true, seek: true },
            hideControls: true,
            clickToPlay: true,
            // Disable Plyr's built-in localStorage - we manage settings via Tauri backend
            storage: { enabled: false },
          });

          playerRef.current = player;

          // Set up live stream overrides
          isLiveRef.current = true;

          // Override duration for live stream progress bar
          Object.defineProperty(video, 'duration', {
            get: function () {
              const buffered = this.buffered;
              if (buffered.length > 0) {
                return buffered.end(buffered.length - 1);
              }
              return Infinity;
            },
            configurable: true,
          });

          // Initial volume sync
          syncVolumeToPlayer();

          // Listen for Plyr events
          player.on('play', () => {
            userInitiatedPauseRef.current = false;
          });

          player.on('pause', () => {
            setTimeout(() => {
              if (video.paused) {
                userInitiatedPauseRef.current = true;
              }
            }, 50);
          });
        }

        // Start playback
        if (currentSettings.autoplay) {
          video.play().catch(e => {
            console.log('[HLS] Autoplay failed:', e);
            // Try muted autoplay as fallback
            video.muted = true;
            video.play().catch(() => {
              console.log('[HLS] Muted autoplay also failed');
            });
          });
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[HLS] Error:', JSON.stringify({ type: data.type, details: data.details, fatal: data.fatal }));

        // Handle non-fatal errors with improved recovery
        if (!data.fatal) {
          const now = Date.now();

          // Handle buffer stalled errors with active recovery
          if (data.details === 'bufferStalledError') {
            console.log('[HLS] Buffer stalled, attempting recovery...');

            // Try to recover by seeking slightly forward if video is paused
            if (video.paused && !userInitiatedPauseRef.current) {
              console.log('[HLS] Video is paused due to stall, attempting to resume playback');
              video.play().catch(e => console.log('[HLS] Resume play failed:', e));
            }

            // If we have buffered data ahead, try jumping to it
            const buffered = video.buffered;
            if (buffered.length > 0) {
              const currentTime = video.currentTime;
              const bufferedEnd = buffered.end(buffered.length - 1);

              // If we're significantly behind the buffered end, seek forward
              if (bufferedEnd - currentTime > 2.0) {
                const seekTarget = currentTime + 0.5; // Small jump forward
                console.log(`[HLS] Seeking forward from ${currentTime} to ${seekTarget} to recover from stall`);
                video.currentTime = seekTarget;
              }
            }

            // Reset error count if enough time has passed since last error
            if (now - lastErrorTimeRef.current > errorResetTimeMs) {
              nonFatalErrorCountRef.current = 0;
            }

            nonFatalErrorCountRef.current++;
            lastErrorTimeRef.current = now;

            console.log(`[HLS] Non-fatal error count: ${nonFatalErrorCountRef.current}/${maxNonFatalErrorsBeforeOffline}`);
            console.log(`[HLS] Time since last fragment: ${now - lastFragLoadedTimeRef.current}ms`);

            // Check if we should trigger offline detection
            // Conditions: 
            // 1. Multiple non-fatal errors accumulated
            // 2. No new fragments received for a while (stream is stalled)
            // 3. Stream has been playing successfully before (not initial load issues)
            const hasPlayedSuccessfully = lastSuccessfulPlayRef.current > 0;
            const timeSinceLastFrag = now - lastFragLoadedTimeRef.current;
            const fragmentsStalled = lastFragLoadedTimeRef.current > 0 && timeSinceLastFrag > noFragmentTimeoutMs;

            const shouldTriggerOffline =
              nonFatalErrorCountRef.current >= maxNonFatalErrorsBeforeOffline &&
              hasPlayedSuccessfully &&
              fragmentsStalled &&
              !isAutoSwitching;

            if (shouldTriggerOffline) {
              console.log('[HLS] Multiple non-fatal errors with stalled fragments detected. Stream appears to have ended.');
              console.log(`[HLS] Non-fatal errors: ${nonFatalErrorCountRef.current}, Time since frag: ${timeSinceLastFrag}ms`);

              // Reset error counts
              nonFatalErrorCountRef.current = 0;
              fatalErrorCountRef.current = 0;
              manifestErrorCountRef.current = 0;

              // Trigger auto-switch
              handleStreamOffline();
              return;
            }
          }

          // Handle other non-fatal errors
          if (data.details === 'fragParsingError' || data.details === 'bufferNudgeOnStall') {
            // Reset error count if enough time has passed since last error
            if (now - lastErrorTimeRef.current > errorResetTimeMs) {
              nonFatalErrorCountRef.current = 0;
            }

            nonFatalErrorCountRef.current++;
            lastErrorTimeRef.current = now;

            console.log(`[HLS] Non-fatal error (${data.details}) count: ${nonFatalErrorCountRef.current}/${maxNonFatalErrorsBeforeOffline}`);
          }

          // For non-fatal errors, return early - HLS.js will try to recover
          return;
        }

        // Handle fatal errors
        if (data.fatal) {
          const now = Date.now();

          // Reset error count if enough time has passed since last error
          if (now - lastErrorTimeRef.current > errorResetTimeMs) {
            fatalErrorCountRef.current = 0;
          }

          fatalErrorCountRef.current++;
          lastErrorTimeRef.current = now;

          console.log(`[HLS] Fatal error count: ${fatalErrorCountRef.current}/${maxFatalErrorsBeforeOffline}`);

          // Check if we've exceeded max fatal errors - likely stream is offline
          if (fatalErrorCountRef.current >= maxFatalErrorsBeforeOffline && !isAutoSwitching) {
            console.log('[HLS] Max fatal errors reached, stream appears to be offline. Triggering auto-switch...');

            // Reset error count
            fatalErrorCountRef.current = 0;

            // Trigger auto-switch
            handleStreamOffline();
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[HLS] Fatal network error, attempting recovery...');

              // Check if this is a manifest/playlist load error (strong indicator of offline stream)
              if (data.details === 'manifestLoadError' ||
                data.details === 'manifestLoadTimeOut' ||
                data.details === 'manifestParsingError' ||
                data.details === 'levelLoadError' ||
                data.details === 'levelLoadTimeOut') {
                console.log(`[HLS] Manifest/level loading failed: ${data.details}`);

                // For manifest errors, use separate counter to be more careful
                manifestErrorCountRef.current++;
                console.log(`[HLS] Manifest error count: ${manifestErrorCountRef.current}/${maxManifestErrorsBeforeOffline}`);

                // Only trigger offline if we've had multiple manifest errors AND 
                // either never played successfully OR it's been a while since we started
                const timeSinceStart = Date.now() - lastSuccessfulPlayRef.current;
                const hasPlayedSuccessfully = lastSuccessfulPlayRef.current > 0;
                const shouldTriggerOffline = manifestErrorCountRef.current >= maxManifestErrorsBeforeOffline &&
                  (!hasPlayedSuccessfully || timeSinceStart > minPlayTimeBeforeOfflineMs);

                if (shouldTriggerOffline && !isAutoSwitching) {
                  console.log('[HLS] Multiple manifest errors, stream likely offline. Triggering auto-switch...');
                  console.log(`[HLS] Has played: ${hasPlayedSuccessfully}, Time since start: ${timeSinceStart}ms`);
                  manifestErrorCountRef.current = 0;
                  fatalErrorCountRef.current = 0;
                  handleStreamOffline();
                  return;
                }
              }

              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[HLS] Fatal media error, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error, cannot recover. Recreating player...');
              setTimeout(() => {
                if (videoRef.current && isLiveRef.current && !isAutoSwitching) {
                  createPlayer();
                }
              }, 2000);
              break;
          }
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels[data.level];
        console.log(`[HLS] Level switched to: ${data.level} (${level?.height}p @ ${level?.bitrate}bps)`);

        // Update Plyr's quality display if in auto mode
        if (playerRef.current && hls.currentLevel === -1) {
          // In auto mode, update the display to show current quality
          const qualityBadge = containerRef.current?.querySelector('.plyr__menu__container [data-plyr="quality"][aria-checked="true"]');
          if (qualityBadge && level) {
            console.log(`[HLS] Auto selected: ${level.height}p`);
          }
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        // Track when we last successfully received a fragment
        lastFragLoadedTimeRef.current = Date.now();

        // Reset non-fatal error count on successful fragment load
        // This means the stream is still working
        nonFatalErrorCountRef.current = 0;

        // Log occasionally to avoid spam
        if (Math.random() < 0.05) {
          console.log(`[HLS] Fragment loaded: ${data.frag.sn}`);
        }
      });

      // Load the stream
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      // Add video event listeners
      video.addEventListener('loadedmetadata', () => {
        console.log(`[Video] Metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
      });

      video.addEventListener('playing', () => {
        console.log(`[Video] Playing: ${video.videoWidth}x${video.videoHeight}, paused: ${video.paused}, readyState: ${video.readyState}`);
        console.log(`[Video] Audio state: muted=${video.muted}, volume=${video.volume}`);

        // Track successful playback - this helps us distinguish between
        // "stream never loaded" vs "stream was playing and then had issues"
        if (lastSuccessfulPlayRef.current === 0) {
          lastSuccessfulPlayRef.current = Date.now();
          console.log('[Video] First successful playback recorded');
        }

        // Jump to live on first play if enabled (fixes 15s delay)
        // This is a one-time seek on load - doesn't affect ongoing buffer behavior
        // Usage of 'playing' event ensures stream is actually running before we seek
        if (currentSettings.jump_to_live && !hasJumpedToLiveRef.current && isLiveRef.current) {
          console.log('[HLS] Jump to live on load enabled, will seek to live edge...');
          hasJumpedToLiveRef.current = true;

          // Wait for buffer to build up before seeking - this is crucial!
          // If we seek before there's buffered data ahead, playback might stall
          setTimeout(() => {
            // Check buffer state
            if (video.buffered.length === 0) {
              console.log('[HLS] Jump to live: no buffer yet, skipping seek');
              return;
            }

            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            const bufferedStart = video.buffered.start(video.buffered.length - 1);
            const bufferedDuration = bufferedEnd - bufferedStart;
            const currentPos = video.currentTime;
            const timeBehindLive = bufferedEnd - currentPos;

            console.log(`[HLS] Jump to live: buffer=${bufferedDuration.toFixed(2)}s, current=${currentPos.toFixed(2)}s, bufferedEnd=${bufferedEnd.toFixed(2)}s, behind=${timeBehindLive.toFixed(2)}s`);

            // Only seek if we're significantly behind (more than 5 seconds from live)
            // and we have a reasonable buffer built up (at least 3 seconds)
            if (timeBehindLive > 5 && bufferedDuration >= 3) {
              // Seek to 2 seconds before buffered end to ensure smooth playback
              // This mimics what happens when you manually click "jump to live"
              const seekTarget = bufferedEnd - 2;
              console.log(`[HLS] Jump to live: seeking from ${currentPos.toFixed(2)}s to ${seekTarget.toFixed(2)}s`);
              video.currentTime = seekTarget;
            } else if (timeBehindLive <= 5) {
              console.log('[HLS] Jump to live: already close to live edge, no seek needed');
            } else {
              console.log(`[HLS] Jump to live: buffer too small (${bufferedDuration.toFixed(2)}s), waiting...`);
              // Try again after more buffer builds up
              hasJumpedToLiveRef.current = false;
            }
          }, 1000); // Wait 1 second for buffer to build
        }

        // Reset error counts on successful playback - stream is working
        fatalErrorCountRef.current = 0;
        manifestErrorCountRef.current = 0;
        nonFatalErrorCountRef.current = 0;
      });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      console.log('[HLS] Using native HLS support');
      video.src = streamUrl;

      // Initialize Plyr for Safari
      const player = new Plyr(video, {
        controls: [
          'play-large',
          'play',
          'progress',
          'current-time',
          'mute',
          'volume',
          'settings',
          'pip',
          'fullscreen',
        ],
        settings: ['speed'],
        speed: {
          selected: 1,
          options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        },
        autoplay: currentSettings.autoplay,
        muted: currentSettings.muted,
        volume: currentSettings.volume,
        invertTime: false,
        keyboard: { focused: true, global: true },
        tooltips: { controls: true, seek: true },
        // Disable Plyr's built-in localStorage - we manage settings via Tauri backend
        storage: { enabled: false },
      });

      playerRef.current = player;
      syncVolumeToPlayer();

      video.addEventListener('loadedmetadata', () => {
        video.play().catch(e => console.log('Initial play failed:', e));
      });
    } else {
      console.error('[HLS] HLS is not supported in this browser');
    }
    // Only depend on streamUrl - settings are read from ref inside the callback
    // This prevents player recreation when volume/muted settings change
  }, [streamUrl, syncVolumeToPlayer, handleStreamOffline, isAutoSwitching]);

  useEffect(() => {
    if (!videoRef.current || !streamUrl) return;

    // Start time display update loop
    progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);

    const video = videoRef.current;

    // If HLS instance already exists, fully destroy it before creating new one
    // HLS.js doesn't handle reusing instances well after detach/attach cycles
    if (hlsRef.current) {
      console.log('[HLS] Stream URL changed, destroying old HLS instance before creating new one:', streamUrl);

      try {
        // Stop loading new data
        hlsRef.current.stopLoad();
        // Detach from media element first
        hlsRef.current.detachMedia();
        // Then destroy the instance
        hlsRef.current.destroy();
      } catch (e) {
        console.warn('[HLS] Error destroying old HLS instance:', e);
      }
      hlsRef.current = null;

      // Thoroughly reset video element to clear any buffered data
      video.pause();
      video.removeAttribute('src');

      // Clear any existing source buffers if MediaSource is attached
      if (video.srcObject) {
        video.srcObject = null;
      }

      video.load();

      // Small delay to ensure video element is fully reset before loading new stream
      // This prevents corrupted TS packets from old stream mixing with new stream
      const timeoutId = setTimeout(() => {
        createPlayer();
      }, 100);

      return () => clearTimeout(timeoutId);
    }

    // Create the HLS player (fresh instance for initial load)
    createPlayer();

    // Cleanup
    return () => {
      // Cancel progress update animation frame
      if (progressUpdateIntervalRef.current) {
        cancelAnimationFrame(progressUpdateIntervalRef.current);
        progressUpdateIntervalRef.current = null;
      }

      // Destroy HLS.js instance
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (e) {
          console.warn('Error destroying HLS on cleanup:', e);
        }
        hlsRef.current = null;
      }

      // Destroy Plyr instance
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }

      // Reset state
      isLiveRef.current = true;
      userInitiatedPauseRef.current = false;
      hasJumpedToLiveRef.current = false;

      // Reset error tracking for next stream
      fatalErrorCountRef.current = 0;
      manifestErrorCountRef.current = 0;
      nonFatalErrorCountRef.current = 0;
      lastSuccessfulPlayRef.current = 0;
      lastErrorTimeRef.current = 0;
      lastFragLoadedTimeRef.current = 0;
    };
  }, [streamUrl, createPlayer, updateLiveTimeDisplay]);

  // Update volume when settings change
  useEffect(() => {
    syncVolumeToPlayer();
  }, [syncVolumeToPlayer]);

  // Update quality menu when qualities become available
  useEffect(() => {
    if (availableQualities.length > 0 && playerRef.current) {
      updateQualityMenu();
    }
  }, [availableQualities, updateQualityMenu]);

  // Clear overlay timer helper - use ref to avoid dependency issues
  const clearOverlayTimer = useCallback(() => {
    if (overlayTimerRef.current) {
      clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = null;
    }
  }, []);

  // Start overlay hide timer - use ref to avoid dependency issues
  const startOverlayHideTimer = useCallback(() => {
    if (overlayTimerRef.current) {
      clearTimeout(overlayTimerRef.current);
    }
    overlayTimerRef.current = setTimeout(() => {
      setShowOverlay(false);
    }, OVERLAY_HIDE_DELAY);
  }, []);

  // Handle mouse events for overlay visibility (works in both normal and fullscreen modes)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseMove = () => {
      // Show overlay on mouse movement
      setShowOverlay(true);
      // Reset the hide timer
      startOverlayHideTimer();
    };

    const handleMouseEnter = () => {
      setShowOverlay(true);
      startOverlayHideTimer();
    };

    const handleMouseLeave = () => {
      // Hide immediately when mouse leaves (unless timer is still running)
      // Clear any existing timer and hide
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
      setShowOverlay(false);
    };

    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseenter', handleMouseEnter);
    container.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseenter', handleMouseEnter);
      container.removeEventListener('mouseleave', handleMouseLeave);
      if (overlayTimerRef.current) {
        clearTimeout(overlayTimerRef.current);
        overlayTimerRef.current = null;
      }
    };
  }, [startOverlayHideTimer]);

  // Check follow status when stream changes
  useEffect(() => {
    if (!currentStream?.user_id) {
      setIsFollowing(null);
      setCheckingFollowStatus(false);
      return;
    }

    const checkFollowStatus = async () => {
      try {
        setCheckingFollowStatus(true);
        const result = await invoke<boolean>('check_following_status', { targetUserId: currentStream.user_id });
        setIsFollowing(result);
      } catch (err) {
        console.error('[VideoPlayer] Failed to check follow status:', err);
        setIsFollowing(false);
      } finally {
        setCheckingFollowStatus(false);
      }
    };

    checkFollowStatus();
  }, [currentStream?.user_id]);

  // Handle follow/unfollow action using browser automation
  const handleFollowClick = useCallback(async () => {
    if (followLoading || !currentStream?.user_login) return;

    const action = isFollowing ? 'unfollow' : 'follow';

    // If unfollowing, trigger the drop animation first
    if (isFollowing) {
      setHeartDropAnimation(true);
      // Wait for animation to complete before showing loading
      await new Promise(resolve => setTimeout(resolve, 600));
      setHeartDropAnimation(false);
    }

    setFollowLoading(true);
    console.log(`[VideoPlayer] Initiating ${action} for ${currentStream.user_login}`);

    try {
      const result = await invoke<{ success: boolean; message: string; action: string }>('automate_connection', {
        channel: currentStream.user_login,
        action: action
      });

      console.log('[VideoPlayer] Automation result:', result);

      if (result.success) {
        setIsFollowing(prev => !prev);
        console.log(`[VideoPlayer] Successfully ${action}ed ${currentStream.user_login}`);
      } else {
        console.error(`[VideoPlayer] ${action} failed:`, result.message);

        // Check if user is not logged in
        if (result.message.includes('NOT_LOGGED_IN')) {
          // Open subscribe window so user can log in
          const webview = new WebviewWindow(`login-${Date.now()}`, {
            url: `https://www.twitch.tv/login`,
            title: 'Log in to Twitch',
            width: 500,
            height: 700,
            center: true,
            resizable: true,
          });

          webview.once('tauri://error', (e) => {
            console.error('Error opening login window:', e);
          });
        } else {
          // Show helpful toast message for other failures
          useAppStore.getState().addToast(
            `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
            'error'
          );
        }
      }
    } catch (err: any) {
      console.error(`[VideoPlayer] ${action} error:`, err);
      // Show helpful error message
      useAppStore.getState().addToast(
        `Follow/Unfollow failed. Try logging out and back in via Settings to re-authenticate.`,
        'error'
      );
    } finally {
      setFollowLoading(false);
    }
  }, [currentStream?.user_login, isFollowing, followLoading]);

  // Track the subscribe window reference for auto-close on successful subscription
  const subscribeWindowRef = useRef<WebviewWindow | null>(null);
  const subscribeWindowLabelRef = useRef<string | null>(null);

  // Listen for subscription events to auto-close the subscribe window
  useEffect(() => {
    const handleSubscriptionDetected = async (event: Event) => {
      const customEvent = event as CustomEvent<{ login: string; msgId: string; displayName: string }>;
      const { login, msgId, displayName } = customEvent.detail;
      const currentUserLogin = currentUser?.login?.toLowerCase();
      
      console.log('[VideoPlayer] Subscription event detected:', { login, msgId, displayName, currentUserLogin });
      
      // Check if this subscription is from the current user
      if (currentUserLogin && login === currentUserLogin && subscribeWindowLabelRef.current) {
        console.log('[VideoPlayer] Detected own subscription! Auto-closing subscribe window...');
        
        // Show success toast
        useAppStore.getState().addToast(
          `🎉 Subscription successful! ${msgId === 'subgift' ? 'Gift sent!' : 'Thank you for subscribing!'}`,
          'success'
        );
        
        // Close the subscribe window
        try {
          const subscribeWindow = await WebviewWindow.getByLabel(subscribeWindowLabelRef.current);
          if (subscribeWindow) {
            await subscribeWindow.close();
            console.log('[VideoPlayer] Subscribe window closed successfully');
          }
        } catch (e) {
          console.warn('[VideoPlayer] Failed to close subscribe window:', e);
        }
        
        // Clear the reference
        subscribeWindowRef.current = null;
        subscribeWindowLabelRef.current = null;
      }
    };

    // Add the event listener
    window.addEventListener('twitch-subscription-detected', handleSubscriptionDetected);
    
    return () => {
      window.removeEventListener('twitch-subscription-detected', handleSubscriptionDetected);
    };
  }, [currentUser?.login]);

  // NOTE: PIP exit handling is done in App.tsx, not here
  // App.tsx correctly differentiates between "Back to tab" (returns to stream view)
  // and "X" button (stops stream) by checking if video is paused
  // Handle subscribe button click
  const handleSubscribeClick = useCallback(() => {
    if (currentStream?.user_login) {
      const windowLabel = `subscribe-${currentStream.user_login}-${Date.now()}`;
      subscribeWindowLabelRef.current = windowLabel;
      
      const webview = new WebviewWindow(windowLabel, {
        url: `https://www.twitch.tv/subs/${currentStream.user_login}`,
        title: `Subscribe to ${currentStream.user_name}`,
        width: 800,
        height: 900,
        center: true,
        resizable: true,
        minimizable: true,
        maximizable: true,
      });

      subscribeWindowRef.current = webview;

      webview.once('tauri://error', (e) => {
        console.error('Error opening subscribe window:', e);
        subscribeWindowRef.current = null;
        subscribeWindowLabelRef.current = null;
      });
      
      // Clear reference when window is closed manually
      webview.once('tauri://destroyed', () => {
        console.log('[VideoPlayer] Subscribe window closed by user');
        subscribeWindowRef.current = null;
        subscribeWindowLabelRef.current = null;
      });
    }
  }, [currentStream]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black flex items-center justify-center video-player-container group"
      style={{
        minHeight: '300px',
        position: 'relative',
      }}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          backgroundColor: '#000',
        }}
        playsInline
      />

      {/* Follow & Subscribe Button Overlay */}
      {currentStream && (
        <div
          className={`subscribe-overlay absolute top-3 right-3 z-50 flex items-center gap-2 transition-all duration-300 ${showOverlay
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 -translate-y-2 pointer-events-none'
            }`}
        >
          {/* Follow Button - Icon Only with Glow */}
          <button
            onClick={handleFollowClick}
            disabled={followLoading || checkingFollowStatus}
            className={`flex items-center justify-center p-2.5 rounded-full transition-all duration-200 hover:scale-110 ${followLoading || checkingFollowStatus
              ? 'opacity-60 cursor-wait bg-background/60 backdrop-blur-md'
              : isFollowing
                ? 'bg-red-500/20 hover:bg-red-500/30'
                : 'bg-emerald-500/20 hover:bg-emerald-500/30'
              }`}
            style={{
              boxShadow: followLoading || checkingFollowStatus
                ? 'none'
                : isFollowing
                  ? '0 0 15px rgba(239, 68, 68, 0.35), 0 0 25px rgba(239, 68, 68, 0.15)'
                  : '0 0 15px rgba(16, 185, 129, 0.35), 0 0 25px rgba(16, 185, 129, 0.15)'
            }}
            title={
              checkingFollowStatus
                ? 'Checking follow status...'
                : followLoading
                  ? 'Processing...'
                  : isFollowing
                    ? `Unfollow ${currentStream.user_name}`
                    : `Follow ${currentStream.user_name}`
            }
          >
            {followLoading || checkingFollowStatus ? (
              <Loader2 className="w-6 h-6 animate-spin text-textSecondary" />
            ) : heartDropAnimation ? (
              <HeartBreak
                weight="fill"
                className="w-6 h-6 text-red-400 animate-heart-drop"
              />
            ) : isFollowing ? (
              <HeartBreak
                weight="fill"
                className="w-6 h-6 text-red-400 drop-shadow-[0_0_5px_rgba(239,68,68,0.7)]"
              />
            ) : (
              <Heart
                weight="fill"
                className="w-6 h-6 text-emerald-400 drop-shadow-[0_0_5px_rgba(16,185,129,0.7)]"
              />
            )}
          </button>

          {/* Subscribe Button */}
          <button
            onClick={handleSubscribeClick}
            className="flex items-center gap-2 px-4 py-2 glass-button text-textPrimary text-sm font-semibold rounded-lg shadow-lg transition-all duration-200 hover:scale-105"
            title={`Subscribe to ${currentStream.user_name}`}
          >
            <span>Subscribe</span>
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;
