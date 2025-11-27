import { useRef, useEffect, useCallback } from 'react';
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
  const { streamUrl, settings } = useAppStore();
  const playerSettings = settings.video_player;
  const isLiveRef = useRef<boolean>(true);
  const userInitiatedPauseRef = useRef<boolean>(false);

  // Sync volume with store
  const syncVolumeToPlayer = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.volume = playerSettings.volume;
      playerRef.current.muted = playerSettings.muted;
    }
  }, [playerSettings.volume, playerSettings.muted]);

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
      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        console.log('[HLS] Manifest parsed, starting playback');
        console.log('[HLS] Available quality levels:', data.levels.map(l => `${l.height}p`).join(', '));
        
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
            settings: ['quality', 'speed'],
            quality: {
              default: playerSettings.start_quality || 0,
              options: [0, ...data.levels.map(l => l.height)],
              forced: true,
              onChange: (quality: number) => {
                if (quality === 0) {
                  hls.currentLevel = -1;
                  console.log('[HLS] Quality set to Auto');
                } else {
                  const levelIndex = data.levels.findIndex(l => l.height === quality);
                  if (levelIndex !== -1) {
                    hls.currentLevel = levelIndex;
                    console.log(`[HLS] Quality set to ${quality}p (level ${levelIndex})`);
                  }
                }
              },
            },
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
            i18n: {
              qualityLabel: {
                0: 'Auto',
              },
            },
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
        console.log(`[HLS] Level switched to: ${data.level}`);
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

    // Create the HLS player
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
