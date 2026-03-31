import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { usemultiNookStore } from '../../stores/multiNookStore';
import { useAppStore } from '../../stores/AppStore';
import { Logger } from '../../utils/logger';
import { multiNookHlsRegistry } from './useMultiNookSync';

interface UseMultiNookPlayerProps {
  streamUrl?: string; // Proxy URL
  streamId: string;
  volume: number;
  muted: boolean;
  isMinimized: boolean;
}

export const useMultiNookPlayer = ({
  streamUrl,
  streamId,
  volume,
  muted,
  isMinimized,
}: UseMultiNookPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const playerRef = useRef<Plyr | null>(null);
  const userInitiatedPauseRef = useRef<boolean>(false);
  const currentSettings = useAppStore(state => state.settings.video_player);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(false);
  const progressUpdateIntervalRef = useRef<number | null>(null);
  
  // Handlers for cleanup
  const onPlayingRef = useRef<(() => void) | null>(null);
  const onWaitingRef = useRef<(() => void) | null>(null);
  const onNativeLoadedMetadataRef = useRef<(() => void) | null>(null);

  // Update time display for live streams to show "LIVE" or time behind
  const updateLiveTimeDisplay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // In MultiNook, Player container holds the UI
    const container = (playerRef.current as any)?.elements?.container || video.parentElement?.parentElement;
    if (!container) {
      progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);
      return;
    }

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
    progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Apply volume/mute to native video if plyr isn't ready
    if (playerRef.current) {
      // Only apply if changed to prevent Plyr from implicitly unmuting on volume assignments
      if (typeof volume === 'number' && playerRef.current.volume !== volume) {
        playerRef.current.volume = volume;
      }
      if (typeof muted === 'boolean' && playerRef.current.muted !== muted) {
        playerRef.current.muted = muted;
      }
    } else {
      if (video.volume !== volume) video.volume = volume;
      if (video.muted !== muted) video.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    if (!playerRef.current) return;
    
    // Explicitly mute/restore volume when toggling dock state
    if (isMinimized) {
      if (!playerRef.current.muted) playerRef.current.muted = true;
    } else {
      if (playerRef.current.volume !== volume) playerRef.current.volume = volume;
      if (playerRef.current.muted !== muted) playerRef.current.muted = muted;
    }
  }, [isMinimized, muted, volume]); // Added muted, volume to deps for correct restoration

  // Clean up Plyr on unmount
  useEffect(() => {
    return () => {
      if (playerRef.current) {
        playerRef.current.destroy();
        playerRef.current = null;
      }
      if (progressUpdateIntervalRef.current) {
        cancelAnimationFrame(progressUpdateIntervalRef.current);
        progressUpdateIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);

    Logger.debug(`[MultiNook-${streamId}] Initializing player with URL: ${streamUrl}`);
    
    // Avoid synchronous setState in effect
    queueMicrotask(() => {
      setIsBuffering(true);
      setError(null);
    });

    // Refs to store actual listener handlers for cleanup
    onPlayingRef.current = null;
    onWaitingRef.current = null;
    onNativeLoadedMetadataRef.current = null;

    // Destroy existing HLS instance
    if (hlsRef.current) {
      multiNookHlsRegistry.delete(streamId);
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const onNativeError = () => {
      if (!Hls.isSupported() && video?.error) {
          setError('Failed to load video (Native)');
      }
    };

    if (video) {
        // Fallback for native Safari playback
        video.addEventListener('error', onNativeError);
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: false, // Force false: LL-HLS chunk parsing causes cyclic starvation with proxies
        startFragPrefetch: true, 
        backBufferLength: 30, 
        maxBufferLength: currentSettings.max_buffer_length || 30, 
        maxMaxBufferLength: currentSettings.max_buffer_length || 120, 
        maxBufferSize: 60 * 1000 * 1000, 
        maxBufferHole: 0.5, 
        highBufferWatchdogPeriod: 2, 
        nudgeOffset: 0.2, 
        nudgeMaxRetry: 3, 
        maxFragLookUpTolerance: 0.5, 
        liveSyncDuration: currentSettings.low_latency_mode ? 6 : 8, 
        liveMaxLatencyDuration: 600, // Massive drift ceiling so manual scrobbling backwards into the DVR buffer isn't violently snapped to live edge.
        maxLiveSyncPlaybackRate: 1.15,
        liveDurationInfinity: true, 
        manifestLoadingTimeOut: 10000, 
        manifestLoadingMaxRetry: 3, 
        manifestLoadingRetryDelay: 1000, 
        levelLoadingTimeOut: 10000, 
        levelLoadingMaxRetry: 4, 
        levelLoadingRetryDelay: 1000, 
        fragLoadingTimeOut: 20000, 
        fragLoadingMaxRetry: 6, 
        fragLoadingRetryDelay: 1000, 
        startLevel: currentSettings.start_quality || -1, 
        abrEwmaDefaultEstimate: 3_000_000, 
        abrEwmaFastLive: 3.0, 
        abrEwmaSlowLive: 9.0, 
        abrBandWidthFactor: 0.95, 
        abrBandWidthUpFactor: 0.7, 
      });

      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        Logger.debug(`[MultiNook-${streamId}] Manifest parsed, starting playback`);
        
        // Register to global sync controller for Co-Stream syncing
        multiNookHlsRegistry.set(streamId, hls);

        // Initialize Plyr once Media is attached
        if (!playerRef.current) {
          playerRef.current = new Plyr(video, {
            controls: ['play', 'progress', 'current-time', 'volume', 'fullscreen'],
            autoplay: false, // Wait for buffer gate
            muted: muted,
            clickToPlay: false, // Disabled so we can capture clicks for focus
            storage: { enabled: false }
          });

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
          
          if (typeof volume === 'number') playerRef.current.volume = volume;
          if (typeof muted === 'boolean') playerRef.current.muted = muted;

          // Listen for pause to know if it was user initiated
          playerRef.current.on('play', () => {
             userInitiatedPauseRef.current = false;
          });
          playerRef.current.on('pause', () => {
             setTimeout(() => {
                if (video.paused) {
                   userInitiatedPauseRef.current = true;
                }
             }, 50);
          });

          // Sync backwards to store
          playerRef.current.on('volumechange', () => {
            if (!playerRef.current) return;
            // Prevent syncing changes if we are minimized (docked streams are forced mute)
            const currentState = usemultiNookStore.getState().slots.find(s => s.id === streamId);
            if (currentState?.isMinimized) return;
            
            const newVol = playerRef.current.volume;
            const newMuted = playerRef.current.muted;
            usemultiNookStore.getState().updateSlot(streamId, { volume: newVol, muted: newMuted });
          });

          playerRef.current.on('controlsshown', () => setShowControls(true));
          playerRef.current.on('controlshidden', () => setShowControls(false));
          
          // Initial state
          setShowControls(true);
        }

        // Do not force play() here to prevent cold-start stall.
        // Wait for FRAG_BUFFERED gate.
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) {
           if (data.details === 'bufferStalledError') {
             Logger.debug(`[MultiNook-${streamId}] Buffer stalled, attempting recovery...`);
             if (video.paused && !userInitiatedPauseRef.current) {
               video.play().catch(() => {});
             }
             const buffered = video.buffered;
             if (buffered.length > 0) {
               const currentTime = video.currentTime;
               const bufferedEnd = buffered.end(buffered.length - 1);
               if (bufferedEnd - currentTime > 2.0) {
                 video.currentTime = currentTime + 0.5;
               }
             }
           }
           return;
        }

        if (data.fatal) {
          Logger.error(`[MultiNook-${streamId}] Fatal error:`, data);
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Network error');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Media error');
              hls.recoverMediaError();
              break;
            default:
              setError('Playback error');
              multiNookHlsRegistry.delete(streamId);
              hls.destroy();
              break;
          }
        }
      });
      
      let playStarted = false;

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (playStarted) return;
        
        playStarted = true;
        Logger.debug(`[MultiNook-${streamId}] First fragment buffered, starting playback immediately (Gate removed)`);
        video.play().catch(e => {
          Logger.debug(`[MultiNook-${streamId}] Autoplay failed:`, e);
          video.muted = true;
          video.play().catch(() => {});
        });
        setIsBuffering(false);
      });

      const onPlaying = () => {
        setIsPlaying(true);
        setIsBuffering(false);
        setError(null);
      };

      const onWaiting = () => setIsBuffering(true);
      
      onPlayingRef.current = onPlaying;
      onWaitingRef.current = onWaiting;

      video.addEventListener('playing', onPlaying);
      video.addEventListener('waiting', onWaiting);

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari fallback
      video.src = streamUrl;
      const onNativeLoadedMetadata = () => {
        if (!playerRef.current) {
          playerRef.current = new Plyr(video, {
            controls: ['play', 'progress', 'current-time', 'volume', 'fullscreen'],
            autoplay: false,
            muted: muted,
            clickToPlay: false, // Disabled so we can capture clicks for focus
            storage: { enabled: false }
          });
          
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

          if (typeof volume === 'number') playerRef.current.volume = volume;
          if (typeof muted === 'boolean') playerRef.current.muted = muted;

          // Sync backwards to store
          playerRef.current.on('volumechange', () => {
            if (!playerRef.current) return;
            const currentState = usemultiNookStore.getState().slots.find(s => s.id === streamId);
            if (currentState?.isMinimized) return;
            
            const newVol = playerRef.current.volume;
            const newMuted = playerRef.current.muted;
            usemultiNookStore.getState().updateSlot(streamId, { volume: newVol, muted: newMuted });
          });

          playerRef.current.on('controlsshown', () => setShowControls(true));
          playerRef.current.on('controlshidden', () => setShowControls(false));
          
          setShowControls(true);
        }
        video.play().catch(e => Logger.error(`[MultiNook-${streamId}] Fallback auto-play failed:`, e));
      };

      onNativeLoadedMetadataRef.current = onNativeLoadedMetadata;
      video.addEventListener('loadedmetadata', onNativeLoadedMetadata);

    }

    return () => {
      if (video) {
        video.removeEventListener('error', onNativeError);
        if (onPlayingRef.current) video.removeEventListener('playing', onPlayingRef.current);
        if (onWaitingRef.current) video.removeEventListener('waiting', onWaitingRef.current);
        if (onNativeLoadedMetadataRef.current) video.removeEventListener('loadedmetadata', onNativeLoadedMetadataRef.current);
      }
      multiNookHlsRegistry.delete(streamId);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (progressUpdateIntervalRef.current) {
        cancelAnimationFrame(progressUpdateIntervalRef.current);
        progressUpdateIntervalRef.current = null;
      }
    };
  }, [streamUrl, streamId, updateLiveTimeDisplay]); // intentionally omitting volume/muted from deps

  return {
    videoRef,
    playerRef,
    isPlaying,
    isBuffering,
    error,
    showControls,
  };
};

