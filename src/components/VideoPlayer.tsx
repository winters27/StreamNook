import { useRef, useEffect } from 'react';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import 'video.js/dist/video-js.css';
import 'videojs-contrib-quality-levels';
import './QualitySelector';
import { useAppStore } from '../stores/AppStore';

const VideoPlayer = () => {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const { streamUrl, settings } = useAppStore();
  const playerSettings = settings.video_player;

  useEffect(() => {
    if (!videoRef.current || !streamUrl) return;

    // Initialize Video.js player
    const videoElement = document.createElement('video-js');
    videoElement.classList.add('vjs-big-play-centered');
    videoRef.current.appendChild(videoElement);

    const player = videojs(videoElement, {
      controls: true,
      autoplay: playerSettings.autoplay,
      preload: 'auto',
      fluid: true,
      responsive: true,
      playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
      liveui: true,
      controlBar: {
        children: [
          'playToggle',
          'volumePanel',
          'currentTimeDisplay',
          'timeDivider',
          'durationDisplay',
          'progressControl',
          'liveDisplay',
          'seekToLive',
          'remainingTimeDisplay',
          // 'customControlSpacer', // Removed to allow progressControl to expand
          'playbackRateMenuButton',
          'chaptersButton',
          'descriptionsButton',
          'subsCapsButton',
          'audioTrackButton',
          'QualityMenuButton',
          'pictureInPictureToggle',
          'fullscreenToggle',
        ],
      },
      html5: {
        vhs: {
          overrideNative: true,
          enableLowInitialPlaylist: playerSettings.low_latency_mode,
          smoothQualityChange: true,
          useBandwidthFromLocalStorage: true,
          // Low latency configuration
          liveRangeSafeTimeDelta: playerSettings.low_latency_mode ? 0.5 : 3,
          // Max buffer length controls how much video is buffered ahead
          maxMaxBufferLength: playerSettings.max_buffer_length || 120,
          // Target duration affects how aggressively the player tries to stay live
          targetDuration: playerSettings.low_latency_mode ? 2 : undefined,
        },
        nativeAudioTracks: false,
        nativeVideoTracks: false,
      },
    });

    playerRef.current = player;

    // Set initial volume and muted state
    player.volume(playerSettings.volume);
    player.muted(playerSettings.muted);

    // Set the source
    player.src({
      src: streamUrl,
      type: 'application/x-mpegURL',
    });


    // Wait for the player to be ready before initializing plugins and adding event listeners
    player.ready(() => {
      // Override the duration property for live streams to match seekable end
      const originalDurationDescriptor = Object.getOwnPropertyDescriptor(player.tech_, 'duration');
      if (originalDurationDescriptor && originalDurationDescriptor.configurable && typeof originalDurationDescriptor.get === 'function') {
        const originalGet = originalDurationDescriptor.get;
        Object.defineProperty(player.tech_, 'duration', {
          get: function() { // Use a regular function to get 'this' context
            const seekable = (player as any).seekable();
            if (seekable.length > 0 && !isFinite(originalGet.call(this))) { // Use 'this' here
              const seekableEnd = seekable.end(0);
              return isFinite(seekableEnd) ? seekableEnd : originalGet.call(this); // Use 'this' here
            }
            return originalGet.call(this); // Use 'this' here
          },
          configurable: true,
        });
      }

      // Initialize quality levels plugin
      const qualityLevels = (player as any).qualityLevels();
      
      // Listen for quality level changes and log them
      qualityLevels.on('addqualitylevel', () => {
        console.log('Quality levels available:', qualityLevels.length);
      });

      // Get the seek bar component
      const seekBar = (player as any).controlBar.progressControl.seekBar;

      // Create a custom element to show the seekable end position (live edge)
      const liveEdgeMarker = document.createElement('div');
      liveEdgeMarker.className = 'vjs-live-edge-marker';
      liveEdgeMarker.style.cssText = `
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background-color: rgba(255, 0, 0, 0.7);
        z-index: 2;
        pointer-events: none;
      `;
      seekBar.el().appendChild(liveEdgeMarker);

      // Override getPercent to use buffered range instead of duration
      const originalGetPercent = seekBar.getPercent;
      seekBar.getPercent = function() {
        const seekable = player.seekable();
        const buffered = player.buffered();
        const currentTime = player.currentTime();
        
        if (seekable && seekable.length > 0 && buffered && buffered.length > 0 && typeof currentTime === 'number') {
          const seekableStart = seekable.start(0);
          const bufferedEnd = buffered.end(0);
          const rangeDuration = bufferedEnd - seekableStart;
          
          if (isFinite(seekableStart) && isFinite(bufferedEnd) && rangeDuration > 0) {
            return Math.max(0, Math.min(1, (currentTime - seekableStart) / rangeDuration));
          }
        }
        
        return originalGetPercent.call(this);
      };

      // Override handleMouseMove to show correct time tooltip
      const originalHandleMouseMove = seekBar.handleMouseMove.bind(seekBar);
      seekBar.handleMouseMove = function(event: MouseEvent) {
        originalHandleMouseMove(event);
        
        const seekable = player.seekable();
        const buffered = player.buffered();
        
        if (seekable && seekable.length > 0 && buffered && buffered.length > 0) {
          const seekableStart = seekable.start(0);
          const bufferedEnd = buffered.end(0);
          const rangeDuration = bufferedEnd - seekableStart;
          
          if (isFinite(seekableStart) && isFinite(bufferedEnd) && rangeDuration > 0) {
            // Calculate the position along the seek bar
            const rect = this.el().getBoundingClientRect();
            const position = (event.clientX - rect.left) / rect.width;
            const time = seekableStart + (position * rangeDuration);
            
            // Update the time tooltip
            const timeTooltip = this.getChild('timeTooltip');
            if (timeTooltip) {
              timeTooltip.update(rect, position, time);
            }
          }
        }
      };

      // Override calculateDistance for seeking
      const originalCalculateDistance = seekBar.calculateDistance;
      seekBar.calculateDistance = function(event: MouseEvent) {
        const distance = originalCalculateDistance.call(this, event);
        const seekable = player.seekable();
        const buffered = player.buffered();
        
        if (seekable && seekable.length > 0 && buffered && buffered.length > 0) {
          const seekableStart = seekable.start(0);
          const bufferedEnd = buffered.end(0);
          const rangeDuration = bufferedEnd - seekableStart;
          
          if (isFinite(seekableStart) && isFinite(bufferedEnd) && rangeDuration > 0) {
            const targetTime = seekableStart + (distance * rangeDuration);
            player.currentTime(targetTime);
            return distance;
          }
        }
        
        return distance;
      };

      // Update live edge marker position
      player.on('timeupdate', () => {
        const buffered = player.buffered();
        const seekable = player.seekable();

        // Update live edge marker position
        if (seekable && seekable.length > 0 && buffered && buffered.length > 0) {
          const seekableStart = seekable.start(0);
          const seekableEnd = seekable.end(0);
          const bufferedEnd = buffered.end(0);
          const rangeDuration = bufferedEnd - seekableStart;

          if (isFinite(seekableStart) && isFinite(seekableEnd) && isFinite(bufferedEnd) && rangeDuration > 0) {
            // Calculate where the seekable end (live edge) is relative to the buffered range
            const liveEdgePosition = ((seekableEnd - seekableStart) / rangeDuration) * 100;
            liveEdgeMarker.style.left = `${Math.min(100, Math.max(0, liveEdgePosition))}%`;
          }
        }
      });

    });

    // Cleanup
    return () => {
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, [streamUrl, playerSettings.autoplay, playerSettings.low_latency_mode, playerSettings.max_buffer_length]);

  // Update volume and muted state when settings change
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.volume(playerSettings.volume);
      playerRef.current.muted(playerSettings.muted);
    }
  }, [playerSettings.muted, playerSettings.volume]);

  return (
    <div 
      ref={videoRef} 
      className="w-full h-full bg-black"
      data-vjs-player
    />
  );
};

export default VideoPlayer;
