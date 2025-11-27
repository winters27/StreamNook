import { useRef, useEffect, useCallback } from 'react';
import Hls, { Events, ManifestParsedData, ErrorData, LevelSwitchedData, Level } from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { useAppStore } from '../stores/AppStore';

// Type for HLS quality levels
interface QualityLevel {
  height: number;
  width: number;
  bitrate: number;
  name: string;
}

const VideoPlayer = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressUpdateIntervalRef = useRef<number | null>(null);
  const { streamUrl, settings } = useAppStore();
  const playerSettings = settings.video_player;
  const isLiveRef = useRef<boolean>(false);
  const isInitialLoadRef = useRef<boolean>(true);
  const userInitiatedPauseRef = useRef<boolean>(false);
  const lastPlayTimeRef = useRef<number>(0);

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

    const seekable = video.seekable;
    if (seekable.length > 0) {
      const seekableEnd = seekable.end(0);
      const seekableStart = seekable.start(0);
      // Get actual current time (bypass our override)
      const originalCurrentTimeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      const actualTime = originalCurrentTimeDesc?.get?.call(video) ?? 0;
      const timeFromLive = seekableEnd - actualTime;

      // Update time display
      const currentTimeDisplay = container.querySelector('.plyr__time--current');
      if (currentTimeDisplay) {
        // Consider anything less than 8 seconds behind as "LIVE" to account for buffer
        if (timeFromLive < 8) {
          currentTimeDisplay.textContent = 'LIVE';
        } else {
          // Show how far behind live we are (negative time)
          const behindSeconds = Math.floor(timeFromLive);
          const mins = Math.floor(behindSeconds / 60);
          const secs = behindSeconds % 60;
          currentTimeDisplay.textContent = `-${mins}:${secs.toString().padStart(2, '0')}`;
        }
      }

      // Update buffer bar with correct values
      const buffered = video.buffered;
      if (buffered.length > 0) {
        const bufferedEnd = buffered.end(buffered.length - 1);
        const seekableDuration = seekableEnd - seekableStart;
        const bufferPercent = ((bufferedEnd - seekableStart) / seekableDuration) * 100;
        const bufferBar = container.querySelector('.plyr__progress__buffer') as HTMLProgressElement;
        if (bufferBar) {
          bufferBar.value = Math.min(100, Math.max(0, bufferPercent));
        }
      }
    }

    // Continue the animation loop
    if (isLiveRef.current) {
      progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);
    }
  }, []);

  useEffect(() => {
    if (!videoRef.current || !streamUrl) return;

    const video = videoRef.current;

    // Initialize HLS.js
    if (Hls.isSupported()) {
      // Map start_quality setting to HLS startLevel
      // -1 = Auto, 0 = Lowest, 1 = Low, 2 = Medium, 3 = High, 4 = Highest
      const startQuality = playerSettings.start_quality ?? -1;

      const hls = new Hls({
        // Low latency configuration
        enableWorker: true,
        lowLatencyMode: playerSettings.low_latency_mode,
        backBufferLength: 90,
        // Max buffer settings
        maxBufferLength: playerSettings.max_buffer_length || 30,
        maxMaxBufferLength: playerSettings.max_buffer_length || 120,
        // Live sync configuration for low latency
        // Use segment counts for more stability (Twitch segments are usually 2s)
        liveSyncDurationCount: playerSettings.low_latency_mode ? 3 : 6,
        liveMaxLatencyDurationCount: playerSettings.low_latency_mode ? 6 : 12,
        liveDurationInfinity: true,
        // Smooth level switching
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        // Start quality level (-1 = auto)
        startLevel: startQuality,
        // Buffer settings for smooth playback
        maxBufferHole: 0.5,
      });

      hlsRef.current = hls;

      // Load the HLS stream
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      // Prevent unwanted pausing throughout playback
      // This handles cases where the browser automatically pauses the stream
      const handlePause = (e: Event) => {
        const now = Date.now();
        const timeSinceLastPlay = now - lastPlayTimeRef.current;
        
        // If this pause happened very soon after play (< 500ms), it's likely automatic
        // Also check if user didn't initiate the pause
        const isAutomaticPause = !userInitiatedPauseRef.current && timeSinceLastPlay < 500;
        
        // For live streams, also check buffer status
        const hasBuffer = video.buffered.length > 0 && 
                         video.buffered.end(video.buffered.length - 1) - video.currentTime > 1;
        
        if ((isInitialLoadRef.current || isAutomaticPause || (isLiveRef.current && hasBuffer)) && video.readyState >= 2) {
          console.log('Preventing unexpected pause, resuming playback (buffer available:', hasBuffer, ')');
          e.preventDefault();
          
          // Reset the flag
          userInitiatedPauseRef.current = false;
          
          // Resume playback
          video.play().catch(err => {
            console.log('Resume play failed:', err);
            // Try again after a short delay
            setTimeout(() => {
              if (video.paused && !userInitiatedPauseRef.current) {
                video.play().catch(e => console.log('Second resume attempt failed:', e));
              }
            }, 100);
          });
        } else {
          // This was a legitimate user pause
          console.log('User-initiated pause detected');
        }
      };

      const handlePlaying = () => {
        // Track when playback starts for pause detection
        lastPlayTimeRef.current = Date.now();
        
        // After first successful play, disable initial load protection
        if (isInitialLoadRef.current) {
          console.log('First playback started, disabling initial load protection');
          setTimeout(() => {
            isInitialLoadRef.current = false;
          }, 2000);
        }
      };
      
      // Track user-initiated play/pause from controls
      const handlePlayClick = () => {
        userInitiatedPauseRef.current = false;
        lastPlayTimeRef.current = Date.now();
      };
      
      const handlePauseClick = () => {
        userInitiatedPauseRef.current = true;
      };

      // Store handlers for cleanup
      (video as any)._handlePause = handlePause;
      (video as any)._handlePlaying = handlePlaying;
      (video as any)._handlePlayClick = handlePlayClick;
      (video as any)._handlePauseClick = handlePauseClick;

      video.addEventListener('pause', handlePause);
      video.addEventListener('playing', handlePlaying);
      video.addEventListener('play', handlePlayClick);

      // Track available quality levels
      const qualityLevels: QualityLevel[] = [];

      hls.on(Hls.Events.MANIFEST_PARSED, (_event: Events.MANIFEST_PARSED, data: ManifestParsedData) => {
        console.log('HLS manifest parsed, levels:', data.levels.length);
        data.levels.forEach((level, index) => {
          console.log(`Level ${index}: ${level.height}p, bitrate: ${level.bitrate}, video: ${level.videoCodec}, audio: ${level.audioCodec}`);
        });

        // Check if this is a live stream using HLS.js (more reliable than video.duration)
        // Check after a short delay when the stream type is determined
        const checkLiveStream = () => {
          // Use HLS.js live detection - check if it's a live manifest
          const isLive = hls.levels.length > 0 && (
            !isFinite(video.duration) ||
            video.duration === Infinity ||
            hls.liveSyncPosition !== undefined
          );

          if (isLive && !isLiveRef.current) {
            isLiveRef.current = true;
            console.log('Detected live stream, setting up overrides');

            // Store original getters
            const originalCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
            const originalDuration = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');

            // Override duration to return seekable range duration
            Object.defineProperty(video, 'duration', {
              get: function () {
                const seekable = this.seekable;
                if (seekable.length > 0) {
                  const seekableStart = seekable.start(0);
                  const seekableEnd = seekable.end(0);
                  const duration = seekableEnd - seekableStart;
                  if (isFinite(duration) && duration > 0) {
                    return duration;
                  }
                }
                // Fallback to original
                return originalDuration?.get?.call(this) ?? Infinity;
              },
              configurable: true,
            });

            // Override currentTime getter to return time relative to seekable start
            // but keep the setter working normally
            const originalCurrentTimeGetter = originalCurrentTime?.get;
            const originalCurrentTimeSetter = originalCurrentTime?.set;

            Object.defineProperty(video, 'currentTime', {
              get: function () {
                const actualTime = originalCurrentTimeGetter?.call(this) ?? 0;
                const seekable = this.seekable;
                if (seekable.length > 0 && seekable.end(0) - seekable.start(0) > 0) {
                  const seekableStart = seekable.start(0);
                  const seekableEnd = seekable.end(0);
                  const seekableDuration = seekableEnd - seekableStart;
                  // Return time relative to seekable start
                  const relativeTime = Math.max(0, actualTime - seekableStart);
                  // Clamp to prevent going past duration (with small buffer for live edge)
                  return Math.min(relativeTime, Math.max(0, seekableDuration - 0.1));
                }
                return actualTime;
              },
              set: function (value: number) {
                // When setting, add back the seekable start
                const seekable = this.seekable;
                if (seekable.length > 0 && seekable.end(0) - seekable.start(0) > 0) {
                  const seekableStart = seekable.start(0);
                  const seekableEnd = seekable.end(0);
                  const absoluteTime = value + seekableStart;
                  const clampedTime = Math.max(seekableStart, Math.min(seekableEnd, absoluteTime));
                  originalCurrentTimeSetter?.call(this, clampedTime);
                } else {
                  originalCurrentTimeSetter?.call(this, value);
                }
              },
              configurable: true,
            });

            // Store references for cleanup
            (video as any)._originalCurrentTime = originalCurrentTime;
            (video as any)._originalDuration = originalDuration;

            // Start time display update loop
            progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);

            // Handle seeking on the progress bar for live streams
            const container = containerRef.current;
            if (container) {
              const progressContainer = container.querySelector('.plyr__progress__container');
              if (progressContainer && !(progressContainer as any)._handleSeek) {
                const handleSeek = (e: Event) => {
                  const mouseEvent = e as MouseEvent;
                  const rect = (progressContainer as HTMLElement).getBoundingClientRect();
                  const clickX = mouseEvent.clientX - rect.left;
                  const percentage = clickX / rect.width;

                  const seekable = video.seekable;
                  if (seekable.length > 0) {
                    const seekableStart = seekable.start(0);
                    const seekableEnd = seekable.end(0);
                    const seekableDuration = seekableEnd - seekableStart;
                    // Calculate relative target time (since currentTime setter expects relative time)
                    const relativeTargetTime = percentage * seekableDuration;

                    console.log(`Seeking to ${relativeTargetTime.toFixed(2)}s relative (${(percentage * 100).toFixed(1)}%)`);
                    // The setter will convert this to absolute time
                    video.currentTime = Math.max(0, Math.min(seekableDuration, relativeTargetTime));
                  }
                };

                progressContainer.addEventListener('click', handleSeek);
                // Store cleanup function
                (progressContainer as any)._handleSeek = handleSeek;
              }
            }
          }
        };

        // Check immediately and also when playback starts (seekable range may not be ready yet)
        checkLiveStream();
        video.addEventListener('playing', checkLiveStream, { once: true });
        video.addEventListener('loadeddata', checkLiveStream, { once: true });

        // Build quality levels array
        qualityLevels.length = 0;
        data.levels.forEach((level: Level) => {
          qualityLevels.push({
            height: level.height,
            width: level.width,
            bitrate: level.bitrate,
            name: `${level.height}p`,
          });
        });

        // Sort by height (descending)
        qualityLevels.sort((a, b) => b.height - a.height);

        // Get unique heights for Plyr quality options
        const uniqueHeights = [...new Set(qualityLevels.map((q) => q.height))];

        // Initialize Plyr with quality options
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
            default: 0, // 0 means auto
            options: [0, ...uniqueHeights],
            forced: true,
            onChange: (quality: number) => {
              if (quality === 0) {
                // Auto quality - let HLS.js decide
                hls.currentLevel = -1;
                console.log('Quality set to Auto');
              } else {
                // Find the level index for the selected height
                const levelIndex = data.levels.findIndex(
                  (level: Level) => level.height === quality
                );
                if (levelIndex !== -1) {
                  hls.currentLevel = levelIndex;
                  console.log(`Quality set to ${quality}p (level ${levelIndex})`);
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
          i18n: {
            qualityLabel: {
              0: 'Auto',
            },
          },
        });

        playerRef.current = player;

        // Initial volume sync
        syncVolumeToPlayer();

        // Listen for Plyr pause/play events to track user intention
        player.on('play', () => {
          userInitiatedPauseRef.current = false;
          lastPlayTimeRef.current = Date.now();
        });
        
        player.on('pause', () => {
          // Only mark as user-initiated if the video is actually paused
          // (not if it's a brief pause during seeking)
          setTimeout(() => {
            if (video.paused) {
              userInitiatedPauseRef.current = true;
            }
          }, 50);
        });

        // Handle autoplay
        if (playerSettings.autoplay) {
          video.play().catch((err) => {
            console.log('Autoplay prevented:', err);
            // Try muted autoplay as fallback
            video.muted = true;
            video.play().catch(() => {
              console.log('Even muted autoplay was prevented');
            });
          });
        }
      });

      // Handle HLS errors
      hls.on(Hls.Events.ERROR, (_event: Events.ERROR, data: ErrorData) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('Network error, attempting recovery...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('Media error, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('Fatal HLS error, destroying...');
              hls.destroy();
              break;
          }
        }
      });

      // Handle level switching (quality change)
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event: Events.LEVEL_SWITCHED, data: LevelSwitchedData) => {
        const level = hls.levels[data.level];
        if (level) {
          console.log(`Switched to quality: ${level.height}p, video: ${level.videoCodec}, audio: ${level.audioCodec}`);
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      video.src = streamUrl;

      // Initialize Plyr for native HLS
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
    } else {
      console.error('HLS is not supported in this browser');
    }

    // Cleanup
    return () => {
      // Cancel progress update animation frame
      if (progressUpdateIntervalRef.current) {
        cancelAnimationFrame(progressUpdateIntervalRef.current);
        progressUpdateIntervalRef.current = null;
      }

      // Remove seek event listener
      const container = containerRef.current;
      if (container) {
        const progressContainer = container.querySelector('.plyr__progress__container');
        if (progressContainer && (progressContainer as any)._handleSeek) {
          progressContainer.removeEventListener('click', (progressContainer as any)._handleSeek);
          delete (progressContainer as any)._handleSeek;
        }
      }

      // Remove pause and playing event listeners
      if (video && (video as any)._handlePause) {
        video.removeEventListener('pause', (video as any)._handlePause);
        delete (video as any)._handlePause;
      }
      if (video && (video as any)._handlePlaying) {
        video.removeEventListener('playing', (video as any)._handlePlaying);
        delete (video as any)._handlePlaying;
      }
      if (video && (video as any)._handlePlayClick) {
        video.removeEventListener('play', (video as any)._handlePlayClick);
        delete (video as any)._handlePlayClick;
      }
      if (video && (video as any)._handlePauseClick) {
        video.removeEventListener('pause', (video as any)._handlePauseClick);
        delete (video as any)._handlePauseClick;
      }

      // Restore original video element property descriptors if they were overridden
      if (video && (video as any)._originalCurrentTime) {
        Object.defineProperty(video, 'currentTime', (video as any)._originalCurrentTime);
        delete (video as any)._originalCurrentTime;
      }
      if (video && (video as any)._originalDuration) {
        Object.defineProperty(video, 'duration', (video as any)._originalDuration);
        delete (video as any)._originalDuration;
      }

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      if (videoRef.current) {
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      }
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }

      // Reset state for next stream
      isLiveRef.current = false;
      isInitialLoadRef.current = true;
      userInitiatedPauseRef.current = false;
      lastPlayTimeRef.current = 0;
    };
  }, [streamUrl, playerSettings.autoplay, playerSettings.low_latency_mode, playerSettings.max_buffer_length, playerSettings.start_quality, syncVolumeToPlayer, updateLiveTimeDisplay]);

  // Update volume and muted state when settings change
  useEffect(() => {
    syncVolumeToPlayer();
  }, [syncVolumeToPlayer]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black flex items-center justify-center video-player-container"
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        playsInline
      />
    </div>
  );
};

export default VideoPlayer;
