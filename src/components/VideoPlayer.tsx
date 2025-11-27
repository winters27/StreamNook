import { useRef, useEffect, useCallback, useState } from 'react';
import Hls from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { useAppStore } from '../stores/AppStore';

const VideoPlayer = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressUpdateIntervalRef = useRef<number | null>(null);
  const { streamUrl, settings, getAvailableQualities, changeStreamQuality } = useAppStore();
  const playerSettings = settings.video_player;
  const isLiveRef = useRef<boolean>(true);
  const userInitiatedPauseRef = useRef<boolean>(false);
  const [availableQualities, setAvailableQualities] = useState<string[]>([]);

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
        } else {
          const behindSeconds = Math.floor(timeFromLive);
          const mins = Math.floor(behindSeconds / 60);
          const secs = behindSeconds % 60;
          currentTimeDisplay.textContent = `-${mins}:${secs.toString().padStart(2, '0')}`;
        }
      } else {
        currentTimeDisplay.textContent = 'LIVE';
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
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: playerSettings.low_latency_mode,
        backBufferLength: 90, // Keep 90 seconds of back buffer
        maxBufferLength: playerSettings.max_buffer_length || 30, // Buffer ahead
        maxMaxBufferLength: playerSettings.max_buffer_length || 120, // Max buffer
        maxBufferSize: 60 * 1000 * 1000, // 60 MB
        maxBufferHole: 0.5, // Max 0.5s gap before seeking
        highBufferWatchdogPeriod: 2, // Check buffer health every 2s
        nudgeOffset: 0.1, // Nudge by 0.1s when recovering
        nudgeMaxRetry: 3, // Try nudging 3 times
        maxFragLookUpTolerance: 0.25, // Fragment lookup tolerance
        liveSyncDurationCount: playerSettings.low_latency_mode ? 2 : 3, // Stay close to live edge
        liveMaxLatencyDurationCount: playerSettings.low_latency_mode ? 4 : 6, // Max latency before seeking
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
        startLevel: playerSettings.start_quality || -1, // Start quality level
      });

      hlsRef.current = hls;

      // HLS.js event handlers
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        console.log('[HLS] Manifest parsed, starting playback');
        console.log('[HLS] Available quality levels:', data.levels.map(l => `${l.height}p @ ${l.bitrate}bps`).join(', '));
        
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
            autoplay: playerSettings.autoplay,
            muted: playerSettings.muted,
            volume: playerSettings.volume,
            invertTime: false,
            keyboard: { focused: true, global: true },
            tooltips: { controls: true, seek: true },
            hideControls: true,
            clickToPlay: true,
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
        if (playerSettings.autoplay) {
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
        console.error('[HLS] Error:', data);

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('[HLS] Fatal network error, attempting recovery...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('[HLS] Fatal media error, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('[HLS] Fatal error, cannot recover. Recreating player...');
              setTimeout(() => {
                if (videoRef.current && isLiveRef.current) {
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
        autoplay: playerSettings.autoplay,
        muted: playerSettings.muted,
        volume: playerSettings.volume,
        invertTime: false,
        keyboard: { focused: true, global: true },
        tooltips: { controls: true, seek: true },
      });

      playerRef.current = player;
      syncVolumeToPlayer();
      
      video.addEventListener('loadedmetadata', () => {
        video.play().catch(e => console.log('Initial play failed:', e));
      });
    } else {
      console.error('[HLS] HLS is not supported in this browser');
    }
  }, [streamUrl, playerSettings, syncVolumeToPlayer]);

  useEffect(() => {
    if (!videoRef.current || !streamUrl) return;

    // Start time display update loop
    progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);

    // If HLS instance already exists and player exists, just change the source
    if (hlsRef.current && playerRef.current) {
      console.log('[HLS] Stream URL changed, loading new source:', streamUrl);
      hlsRef.current.loadSource(streamUrl);
      return; // Don't run cleanup, just update the source
    }

    // Create the HLS player (first time only)
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

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black flex items-center justify-center video-player-container"
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
    </div>
  );
};

export default VideoPlayer;
