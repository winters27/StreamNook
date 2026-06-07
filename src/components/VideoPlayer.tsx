import { useRef, useEffect, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Hls from 'hls.js';
import Plyr from 'plyr';
import 'plyr/dist/plyr.css';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, RefreshCcw, Home, LayoutGrid, Shield, ShieldCheck, ShieldAlert, Clapperboard } from 'lucide-react';
import { Heart, HeartBreak, ArrowLeft, X as XIcon } from 'phosphor-react';
import { useAppStore } from '../stores/AppStore';
import { usemultiNookStore } from '../stores/multiNookStore';
import { useChannelSocial } from '../hooks/useChannelSocial';
import StreamTitleWithEmojis from './StreamTitleWithEmojis';
import PlayerStatsOverlay from './PlayerStatsOverlay';
import { Tooltip } from './ui/Tooltip';
import { registerPlayerControls, type PlayerControls } from '../keybindings';
import { qualitiesEquivalent } from '../utils/quality';

import { Logger } from '../utils/logger';
import { syncTauriWindowFullscreen } from '../utils/windowFullscreen';
import {
  applyAudioBoost,
  resolveAudioBoost,
  audioBoostFaderDefs,
  audioBoostResetPatch,
} from '../utils/audioBoost';
import type { AudioBoostSettings } from '../types';
import { Fader, Toggle } from './AudioBoostFaders';

// Paint the Audio Boost toggle that gets injected into Plyr's control bar so it
// reflects on/off. The `is-active` class lights it up as an accent chip (fill +
// inset rim, styled in globals.css, no outer glow); off falls back to the normal
// control. Module-level so the inject and sync effects share one copy.
function paintAudioBoostButton(btn: Element | null, on: boolean): void {
  if (!btn) return;
  btn.classList.toggle('is-active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const tip = btn.querySelector('.plyr__tooltip');
  if (tip) tip.textContent = on ? 'Audio Boost: On' : 'Audio Boost: Off';
}

const VideoPlayer = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const progressUpdateIntervalRef = useRef<number | null>(null);
  const { streamUrl, settings, activeQuality, adSource, getAvailableQualities, changeStreamQuality, handleStreamOffline, isAutoSwitching, currentStream, reloadStreamAndChat, exitStream, toggleHome, isHomeActive, streamOriginCategory, setHomeActiveTab, setHomeSelectedCategory, isAuthenticated, currentMediaType, createClip, isCreatingClip, originalMediaUrl, openStreamerMedia } = useAppStore();
  // Clippable: a live broadcast, or any VOD that's loaded — including the latest
  // VOD auto-loaded into the offline-chat space (still currentMediaType
  // 'offline_chat', but a real VOD is playing, exposed via originalMediaUrl).
  const canClip =
    currentMediaType === 'live' || (!!originalMediaUrl && /\/videos\/\d+/.test(originalMediaUrl));
  // A clip is playing in the centered overlay modal. The live stream keeps
  // playing underneath, so mute it while the modal is open to avoid two audio
  // tracks at once; restore the prior mute state on close.
  const clipModalOpen = useAppStore((s) => s.clipModal !== null);
  // Stabilize handleStreamOffline in a ref so createPlayer's identity stays stable.
  // Without this, every Zustand set() call recreates handleStreamOffline, which changes
  // createPlayer's reference, which re-fires the player creation effect — causing double
  // player creation and breaking WebView2's hardware decoder for clip playback.
  const handleStreamOfflineRef = useRef(handleStreamOffline);
  handleStreamOfflineRef.current = handleStreamOffline;
  const playerSettings = settings.video_player;
  // Store settings in a ref so createPlayer doesn't need to depend on them
  // This prevents player recreation when volume/muted settings change
  const playerSettingsRef = useRef(playerSettings);
  playerSettingsRef.current = playerSettings;
  // Store isAutoSwitching in a ref so createPlayer can access the latest value
  // without triggering function recreation (which causes black screen/audio glitch)
  const isAutoSwitchingRef = useRef(isAutoSwitching);
  isAutoSwitchingRef.current = isAutoSwitching;
  const isLiveRef = useRef<boolean>(true);
  const userInitiatedPauseRef = useRef<boolean>(false);
  const [availableQualities, setAvailableQualities] = useState<string[]>([]);
  // Tracked as STATE (not just the playerRef) so the quality-menu effect
  // re-runs the moment the player is created. The quality list now resolves
  // instantly, so it can arrive before Plyr exists; gating the menu on a ref
  // alone meant the effect fired once (no player) and never again.
  const [playerReady, setPlayerReady] = useState(false);
  // Overlay visibility state (works in both normal and fullscreen modes)
  const [showOverlay, setShowOverlay] = useState(false);
  // Live telemetry panel ("behind live" + FPS). Toggled from the Plyr settings
  // menu's "Stats" item; the ref lets the menu injection read the latest value.
  const [showStats, setShowStats] = useState(false);
  const showStatsRef = useRef(showStats);
  showStatsRef.current = showStats;
  const overlayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const OVERLAY_HIDE_DELAY = 2600; // Match Plyr's native control hide timing (2.6s)

  // Mute the background stream while a clip modal is open (the clip carries its
  // own audio); restore the prior mute state when it closes.
  const preClipMuteRef = useRef<boolean | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (clipModalOpen) {
      if (preClipMuteRef.current === null) preClipMuteRef.current = video.muted;
      video.muted = true;
    } else if (preClipMuteRef.current !== null) {
      video.muted = preClipMuteRef.current;
      preClipMuteRef.current = null;
    }
  }, [clipModalOpen]);

  // Route the live audio through the optional compressor + makeup-gain graph.
  // Re-applied whenever the audio-boost settings change and after each stream
  // swap (the player is rebuilt then, but the <video> element itself persists,
  // so its one-time audio tap stays valid and we just reconfirm the routing).
  // While the feature has never been turned on, this is a no-op and playback is
  // left completely untouched. Scoped to the main player; MultiNook tiles keep
  // their own per-tile audio.
  const audioBoostSettings = playerSettings?.audio_boost;
  useEffect(() => {
    applyAudioBoost(videoRef.current, resolveAudioBoost(audioBoostSettings));
  }, [audioBoostSettings, streamUrl, playerReady]);

  // Resolved current settings (defaults filled in) drive both the control-bar
  // toggle's appearance and the in-player popover below. The ref lets the
  // injection effect paint the button's initial state without re-running on
  // every toggle.
  const resolvedBoost = resolveAudioBoost(audioBoostSettings);
  const audioBoostEnabled = resolvedBoost.enabled;
  const audioBoostEnabledRef = useRef(audioBoostEnabled);
  audioBoostEnabledRef.current = audioBoostEnabled;

  // In-player popover for editing boost/compressor on the fly without leaving the
  // stream. Opened by right-clicking the control-bar toggle (left-click still
  // does the quick on/off).
  const [audioPanelOpen, setAudioPanelOpen] = useState(false);
  const audioPanelRef = useRef<HTMLDivElement>(null);

  // Write a patch to the persisted audio_boost settings. Reads fresh state so a
  // rapid edit never clobbers a concurrent change; the apply effect and the
  // popover both react to the result.
  const applyBoostPatch = (patch: Partial<AudioBoostSettings>) => {
    const { settings: s, updateSettings } = useAppStore.getState();
    const current = s.video_player;
    const resolved = resolveAudioBoost(current?.audio_boost);
    updateSettings({
      ...s,
      video_player: { ...current, audio_boost: { ...resolved, ...patch } },
    });
  };

  // Inject the Audio Boost toggle into Plyr's control bar, right after the volume
  // group. Plyr's `controls` option only accepts its built-in items, so (like the
  // quality menu and the Stats item) the button is added to the DOM directly.
  // Re-runs whenever Plyr is (re)created (playerReady cycles false->true on every
  // stream swap); the control bar can appear after this fires, so it retries
  // until the DOM exists and guards against double-insertion.
  useEffect(() => {
    if (!playerReady) return;
    const container = containerRef.current;
    if (!container) return;
    let attempts = 0;
    let cancelled = false;
    const inject = () => {
      if (cancelled) return;
      const controls = container.querySelector('.plyr__controls');
      if (!controls) {
        if (attempts++ < 25) setTimeout(inject, 200);
        return;
      }
      if (controls.querySelector('[data-streamnook-audioboost]')) return; // already present

      const btn = document.createElement('button');
      btn.className = 'plyr__controls__item plyr__control';
      btn.type = 'button';
      btn.setAttribute('data-streamnook-audioboost', '');
      btn.innerHTML = `
        <svg class="plyr__icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2"></path>
        </svg>
        <span class="plyr__tooltip" role="tooltip">Audio Boost</span>
      `;
      // Click opens the in-player popover (which holds the on/off toggle plus
      // all the faders), so everything is adjustable on the fly.
      btn.addEventListener('click', () => {
        setAudioPanelOpen((o) => !o);
      });

      // Sit immediately after the volume group (mute + slider) when present.
      const volume = controls.querySelector('.plyr__volume');
      if (volume && volume.parentElement === controls) {
        volume.insertAdjacentElement('afterend', btn);
      } else {
        const menu = controls.querySelector('.plyr__menu');
        if (menu) controls.insertBefore(btn, menu);
        else controls.appendChild(btn);
      }
      paintAudioBoostButton(btn, audioBoostEnabledRef.current);
    };
    inject();
    return () => {
      cancelled = true;
    };
  }, [playerReady]);

  // Keep the injected toggle's color, tooltip and pressed state in sync whenever
  // Audio Boost is flipped (from this button, the settings panel, or anywhere).
  useEffect(() => {
    const btn = containerRef.current?.querySelector('[data-streamnook-audioboost]');
    paintAudioBoostButton(btn ?? null, audioBoostEnabled);
  }, [audioBoostEnabled, playerReady]);

  // Close the popover on Escape or an outside click (but not on the toggle
  // itself, so right-click can open/close it cleanly). Capture phase so it runs
  // before the player's own pointer handlers.
  useEffect(() => {
    if (!audioPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAudioPanelOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const panel = audioPanelRef.current;
      const btn = containerRef.current?.querySelector('[data-streamnook-audioboost]');
      const target = e.target as Node;
      if (panel && !panel.contains(target) && !(btn && btn.contains(target))) {
        setAudioPanelOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [audioPanelOpen]);

  // Close the popover when the stream changes (the control bar is rebuilt then).
  useEffect(() => {
    setAudioPanelOpen(false);
  }, [streamUrl]);

  // Transient top-left "stream note" (ad source + any quality fallback). Shows
  // briefly when a new live stream resolves, then fades. Replaces the per-stream
  // toasts, which fired on nearly every stream and were overbearing.
  const [showStreamNote, setShowStreamNote] = useState(false);
  useEffect(() => {
    if (!(streamUrl && currentMediaType === 'live' && adSource)) {
      setShowStreamNote(false);
      return;
    }
    setShowStreamNote(true);
    const t = setTimeout(() => setShowStreamNote(false), 6000);
    return () => clearTimeout(t);
  }, [streamUrl, currentMediaType, adSource]);

  // Memory Leak Prevention Refs for closures / timeouts
  const volumeDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const bufferGateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const onPlayingRef = useRef<(() => void) | null>(null);
  const onLoadedMetadataRef = useRef<(() => void) | null>(null);

  // Follow + subscribe state and actions for the current channel. Shared with
  // the focused MultiNook tile via useChannelSocial so both overlays behave
  // identically (follow/unfollow, subscribe window, resub/gift detection).
  const {
    isFollowing,
    followLoading,
    checkingFollowStatus,
    heartDropAnimation,
    handleFollowClick,
    isSubscribed,
    hasSubHistory,
    cumulativeMonths,
    subscriberBadgeUrl,
    handleSubscribeClick,
  } = useChannelSocial({
    userId: currentStream?.user_id,
    userLogin: currentStream?.user_login,
    userName: currentStream?.user_name,
  });

  // Restart stream state
  const [isRestarting, setIsRestarting] = useState(false);

  // Which overlay action buttons the user keeps (undefined = all). Each button
  // still respects its own context gate below (clippable, live-only, etc.).
  const overlayButtonOn = (id: string) =>
    !settings.player_overlay_buttons || settings.player_overlay_buttons.includes(id);

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



  // Fetch available qualities from Streamlink (live streams only)
  // Clips and VODs don't need quality switching via Streamlink — they serve a single MP4.
  useEffect(() => {
    if (streamUrl && currentMediaType === 'live') {
      getAvailableQualities().then(qualities => {
        if (qualities.length > 0) {
          setAvailableQualities(qualities);
          Logger.debug('[Quality] Fetched from Streamlink:', qualities);
        }
      });
    } else {
      // Clear stale qualities when switching to clip/VOD
      setAvailableQualities([]);
    }
  }, [streamUrl, getAvailableQualities, currentMediaType]);

  // Update quality menu when qualities are available
  const updateQualityMenu = useCallback(() => {
    const container = containerRef.current;
    if (!container || availableQualities.length === 0) return;

    // Reflect the quality actually playing (activeQuality) in the menu state,
    // not the saved preference (settings.quality). They diverge whenever
    // Streamlink fell back to the closest available quality because the
    // saved preference wasn't offered for this stream.
    const displayedQuality = activeQuality ?? settings.quality;

    Logger.debug('[Quality] Setting up menu with Streamlink qualities:', availableQualities);
    Logger.debug('[Quality] Active quality:', activeQuality, 'saved preference:', settings.quality);

    let attempts = 0;
    const buildMenu = () => {
      const settingsMenu = container.querySelector('.plyr__menu');
      if (!settingsMenu) {
        // Plyr is created on hls.js MANIFEST_PARSED, which can land AFTER the
        // quality list resolves (resolution is instant now). Retry until the
        // menu DOM exists instead of bailing on the first miss.
        if (attempts++ < 25) {
          setTimeout(buildMenu, 200);
        } else {
          Logger.warn('[Quality] Could not find Plyr settings menu');
        }
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
      const currentQualityDisplay = displayedQuality.charAt(0).toUpperCase() + displayedQuality.slice(1);

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
              aria-checked="${quality.toLowerCase() === displayedQuality.toLowerCase() ? 'true' : 'false'}"
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

            Logger.debug(`[Quality] User selected: ${selectedQuality}`);

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

            // Re-resolve the stream at the chosen quality.
            await changeStreamQuality(selectedQuality);
          });
        });
      }
    };
    buildMenu();
  }, [availableQualities, settings.quality, activeQuality, changeStreamQuality]);

  // Update time display for live streams to show "LIVE" or time behind
  const updateLiveTimeDisplay = useCallback(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || !isLiveRef.current) return;
    
    // Only apply live time display if current media is live
    const { currentMediaType } = useAppStore.getState();
    if (currentMediaType !== 'live') {
      isLiveRef.current = false;
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
    if (isLiveRef.current) {
      progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);
    }
  }, []);

  const createPlayer = useCallback(() => {
    if (!videoRef.current || !streamUrl) return;

    const video = videoRef.current;

    // Clear previously attached video listeners to prevent memory leaks from stacking closures
    if (onPlayingRef.current) video.removeEventListener('playing', onPlayingRef.current);
    if (onLoadedMetadataRef.current) video.removeEventListener('loadedmetadata', onLoadedMetadataRef.current);
    
    // Clear pending timeouts
    if (bufferGateTimeoutRef.current) {
      clearTimeout(bufferGateTimeoutRef.current);
      bufferGateTimeoutRef.current = null;
    }
    if (volumeDebounceRef.current) {
      clearTimeout(volumeDebounceRef.current);
      volumeDebounceRef.current = null;
    }

    // Read settings from ref to avoid dependency on playerSettings
    // This prevents player recreation when only volume/muted changes
    const currentSettings = playerSettingsRef.current;

    // Destroy existing HLS instance if any
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (e) {
        Logger.warn('Error destroying existing HLS:', e);
      }
      hlsRef.current = null;
    }

    // ALWAYS destroy existing Plyr instances before recreating!
    // This is explicitly required because Live streams and Clips/VODs have fundamentally
    // different control layouts (progress bars vs none). Reusing instances breaks the UI
    // and can cause phantom black overlays.
    if (playerRef.current) {
      try {
        // CRITICAL: Clear video source BEFORE destroying Plyr.
        // Plyr.destroy() moves the <video> element out of its wrapper back to its
        // original DOM position. If the video is actively decoding (src is set),
        // this DOM re-parenting causes WebView2's hardware video decoder to lose
        // its DirectComposition surface — resulting in audio-but-no-video (black frame).
        video.pause();
        video.removeAttribute('src');
        video.load();
        playerRef.current.destroy();
      } catch (e) {
        Logger.warn('Error destroying existing Plyr:', e);
      }
      playerRef.current = null;
      setPlayerReady(false);
    }

    Logger.debug('Creating HLS.js player for URL:', streamUrl);

    if (streamUrl === 'offline') {
      Logger.debug('[Media] Stream is offline, skipping player creation');
      return;
    }

    // Check if it's an MP4 file
    let urlWithoutQuery = streamUrl.toLowerCase();
    const queryIndex = urlWithoutQuery.indexOf('?');
    if (queryIndex !== -1) {
      urlWithoutQuery = urlWithoutQuery.substring(0, queryIndex);
    }
    const isMp4 = urlWithoutQuery.endsWith('.mp4');

    if (isMp4) {
      Logger.debug('[Media] MP4 stream detected, bypassing Hls.js and Plyr');
      isLiveRef.current = false; // It's a clip!

      // MP4 clips use NATIVE <video> controls — NO Plyr.
      // Plyr wraps the <video> element by moving it inside a new container div. This DOM
      // re-parenting destroys WebView2's DirectComposition surface for the hardware video
      // decoder, resulting in audio-only playback (black/frozen frame). React 18 StrictMode
      // doubles the damage by running mount→cleanup→mount, causing TWO re-parenting cycles.
      // Native <video> avoids all of this — no DOM moves, no surface loss.
      video.controls = true;
      video.src = streamUrl;
      video.volume = currentSettings.volume;
      video.muted = currentSettings.muted;
      video.load();

      // Persist volume/muted changes back to settings (native controls path)
      const onVolumeChange = () => {
        if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
        volumeDebounceRef.current = setTimeout(() => {
          const { settings, updateSettings } = useAppStore.getState();
          const current = settings.video_player;
          if (current.volume !== video.volume || current.muted !== video.muted) {
            updateSettings({
              ...settings,
              video_player: { ...current, volume: video.volume, muted: video.muted },
            });
          }
        }, 300);
      };
      video.addEventListener('volumechange', onVolumeChange);

      if (currentSettings.autoplay) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => {
            Logger.debug('[Media] MP4 autoplay failed, trying muted:', e);
            video.muted = true;
            video.play().catch(e2 => Logger.debug('[Media] Muted MP4 play also failed:', e2));
          });
        }
      }
      return;
    } else if (Hls.isSupported()) {
      Logger.debug('[HLS] HLS.js is supported, creating player...');


      // Create HLS.js instance with optimized settings
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: false, // Force false: LL-HLS chunk parsing causes cyclic starvation with proxies
        startFragPrefetch: false, // Disabled: prefetching double-buffers massive TS chunks in V8 heap
        backBufferLength: 30, // Keep 30 seconds of back buffer
        maxBufferLength: currentSettings.max_buffer_length || 30, // Buffer ahead
        maxMaxBufferLength: currentSettings.max_buffer_length || 120, // Max buffer
        maxBufferSize: 60 * 1000 * 1000, // 60 MB
        maxBufferHole: 0.5, // Restored — the 2.0 was masking the premature-play root cause
        highBufferWatchdogPeriod: 2, // Restored — check buffer health every 2s
        nudgeOffset: 0.2, // Restored closer to default — buffer gate fixes the real issue
        nudgeMaxRetry: 3, // Restored to default
        maxFragLookUpTolerance: 0.5, // More tolerant fragment lookup
        liveSyncDuration: currentSettings.low_latency_mode ? 4 : 8, // Seconds behind the live edge. 4 is the proven sweet spot: it matched twitch.tv (~5.2s vs its 5.12s) on a NORMAL-latency stream and held steady. 3 stalled there (normal-latency delivery is jittery, gaps up to ~3s between segments drain a 3s cushion; twitch.tv sits at ~5s for the same reason). Both the relay targetduration rewrite (ad_detect::retarget_playlist) and the cold-start buffer-gate SNAP are required for even this 4 to be effective and safe. Toggle off = 8s. Going below 4 needs a LOW-latency broadcast (smooth delivery + PREFETCH); that path is per-stream adaptive, not a blanket lower constant.
        liveMaxLatencyDuration: 60, // Capped to 60s to allow GC. Prevents holding massive 10min TS buffers in RAM. Must stay > liveSyncDuration.
        maxLiveSyncPlaybackRate: 1.15, // Rubber-band catch-up speed. Kept gentle on purpose: aggressive catch-up outruns live segment production and stalls at the edge.
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
        // ABR tuning
        abrEwmaDefaultEstimate: 1_500_000, // 1.5Mbps — balanced start to prevent initial bandwidth spike
        abrEwmaFastLive: 3.0, // Fast ABR for live streams
        abrEwmaSlowLive: 9.0, // Slow ABR for live streams
        abrBandWidthFactor: 0.95, // Slightly conservative with bandwidth
        abrBandWidthUpFactor: 0.7, // Cautious when upgrading quality
      });

      hlsRef.current = hls;

      // HLS.js event handlers
      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        Logger.debug('[HLS] Manifest parsed, starting playback');
        Logger.debug('[HLS] Available quality levels:', data.levels.map(l => `${l.height}p @ ${l.bitrate}bps`).join(', '));

        // Diagnostic: log the details HLS.js uses for live sync calculations
        const selectedLevel = data.levels[data.firstLevel || 0];
        Logger.debug(
          `[HLS-DIAG] MANIFEST | levels=${data.levels.length} | ` +
          `firstLevel=${data.firstLevel} | ` +
          `targetDuration=${selectedLevel?.details?.targetduration ?? 'N/A'} | ` +
          `liveSyncPosition=${hls.liveSyncPosition?.toFixed(1) ?? 'N/A'} | ` +
          `config.liveSyncDuration=${hls.config.liveSyncDuration ?? 'unset'} | ` +
          `config.liveSyncDurationCount=${hls.config.liveSyncDurationCount ?? 'unset'}`
        );

        // Reset error counts on successful manifest parse - stream is working
        fatalErrorCountRef.current = 0;
        manifestErrorCountRef.current = 0;

        // Adaptive low-latency cushion. The relay scans every playlist and flags
        // low-latency broadcasts; ask it once here (one cheap IPC, no manifest
        // re-download). On a low-latency stream with Low Latency on, tighten the
        // cushion to ~2s.
        //
        // TEMPORARILY DISABLED in lockstep with the relay's prefetch promotion
        // (stream_server.rs `enable_prefetch_promotion`). The 2s cushion is only
        // safe when promotion has pushed the live edge ~2s forward; with promotion
        // off the edge sits further back, so 2s parks the playhead on the buffered
        // edge and any segment jitter stalls it (see the liveSyncDuration config
        // note: "going below 4 needs a LOW-latency broadcast"). Low Latency on
        // keeps the safe 4s base. Re-enable both flags together.
        const ENABLE_LL_CUSHION_TIGHTEN: boolean = false;
        if (ENABLE_LL_CUSHION_TIGHTEN && currentSettings.low_latency_mode) {
          invoke<boolean>('get_stream_low_latency').then((lowLatency) => {
            if (lowLatency && hlsRef.current === hls) {
              hls.config.liveSyncDuration = 2;
              Logger.debug('[HLS] Low-latency channel — cushion tightened to 2s');
            }
          }).catch(() => { /* command unavailable / stream gone */ });
        }

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
            autoplay: false, // Gate controls playback start — wait for enough buffer
            muted: currentSettings.muted,
            volume: currentSettings.volume,
            invertTime: false,
            // Player hotkeys are owned by StreamNook's unified keybinding
            // engine (src/keybindings), not Plyr. Disabling Plyr's own keyboard
            // handling prevents double-firing and keeps every player key
            // rebindable from Settings > Keybindings.
            keyboard: { focused: false, global: false },
            tooltips: { controls: true, seek: true },
            hideControls: true,
            // Single click toggles play/pause, double click toggles fullscreen.
            // Both are driven by a manual click/dblclick listener (see effect
            // below) so a double-click never also flickers play state — Plyr's
            // own click-to-play is disabled here.
            clickToPlay: false,
            // Force Plyr's CSS-only fullscreen — the Tauri window is borderless
            // (decorations: false), so HTML5 element-fullscreen ends up scoped
            // to the window viewport instead of the screen. We bridge Plyr's
            // enter/exit events to the Tauri window's true OS fullscreen below.
            fullscreen: { enabled: true, fallback: 'force', iosNative: false },
            // Disable Plyr's built-in localStorage - we manage settings via Tauri backend
            storage: { enabled: false },
          });

          playerRef.current = player;
          setPlayerReady(true);

          player.on('enterfullscreen', () => syncTauriWindowFullscreen(true));
          player.on('exitfullscreen', () => syncTauriWindowFullscreen(false));

          // Set up live stream overrides
          isLiveRef.current = useAppStore.getState().currentMediaType === 'live';

          // Override duration for live stream progress bar
          if (isLiveRef.current) {
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
          }

          // Initial volume sync
          playerRef.current.volume = currentSettings.volume;
          playerRef.current.muted = currentSettings.muted;

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

          // Persist volume/muted changes back to settings when user adjusts via Plyr UI
          player.on('volumechange', () => {
            if (!playerRef.current) return;
            const newVolume = playerRef.current.volume;
            const newMuted = playerRef.current.muted;

            // Debounce to avoid hammering the backend on every slider tick
            if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
            volumeDebounceRef.current = setTimeout(() => {
              const { settings, updateSettings } = useAppStore.getState();
              const current = settings.video_player;
              if (current.volume !== newVolume || current.muted !== newMuted) {
                updateSettings({
                  ...settings,
                  video_player: { ...current, volume: newVolume, muted: newMuted },
                });
              }
            }, 300);
          });
        }
        // Don't play here. The FRAG_BUFFERED gate below will call play()
        // once enough buffer exists (partial segment + one full segment).
        // This prevents the cold-start stall. No seeking — HLS.js positions
        // naturally via liveSyncDuration.
        Logger.debug('[HLS] Manifest parsed — waiting for buffer depth before play...');
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        Logger.error('[HLS] Error:', JSON.stringify({ type: data.type, details: data.details, fatal: data.fatal }));
        // hls.js packs the precise reason into data.error.message — for a
        // levelParsingError that is the exact parser failure (e.g. "media sequence
        // mismatch …" or "discontinuity sequence mismatch …" with BOTH playlists
        // embedded, or "Missing Target Duration" / "No Segments found"). The line
        // above drops it, which is why level parse failures have been opaque.
        if (data.error?.message) {
          Logger.error('[HLS] Error detail:', data.error.message);
        }

        // Handle non-fatal errors with improved recovery
        if (!data.fatal) {
          const now = Date.now();

          // Handle buffer stalled errors with active recovery
          if (data.details === 'bufferStalledError') {
            Logger.debug('[HLS] Buffer stalled, attempting recovery...');

            // Try to recover by seeking slightly forward if video is paused
            if (video.paused && !userInitiatedPauseRef.current) {
              Logger.debug('[HLS] Video is paused due to stall, attempting to resume playback');
              video.play().catch(e => Logger.debug('[HLS] Resume play failed:', e));
            }

            // If we have buffered data ahead, try jumping to it
            const buffered = video.buffered;
            if (buffered.length > 0) {
              const currentTime = video.currentTime;
              const bufferedEnd = buffered.end(buffered.length - 1);

              // If we're significantly behind the buffered end, seek forward
              if (bufferedEnd - currentTime > 2.0) {
                const seekTarget = currentTime + 0.5; // Small jump forward
                Logger.debug(`[HLS] Seeking forward from ${currentTime} to ${seekTarget} to recover from stall`);
                video.currentTime = seekTarget;
              }
            }

            // Reset error count if enough time has passed since last error
            if (now - lastErrorTimeRef.current > errorResetTimeMs) {
              nonFatalErrorCountRef.current = 0;
            }

            nonFatalErrorCountRef.current++;
            lastErrorTimeRef.current = now;

            Logger.debug(`[HLS] Non-fatal error count: ${nonFatalErrorCountRef.current}/${maxNonFatalErrorsBeforeOffline}`);
            Logger.debug(`[HLS] Time since last fragment: ${now - lastFragLoadedTimeRef.current}ms`);

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
              !isAutoSwitchingRef.current;

            if (shouldTriggerOffline) {
              Logger.debug('[HLS] Multiple non-fatal errors with stalled fragments detected. Stream appears to have ended.');
              Logger.debug(`[HLS] Non-fatal errors: ${nonFatalErrorCountRef.current}, Time since frag: ${timeSinceLastFrag}ms`);

              // Reset error counts
              nonFatalErrorCountRef.current = 0;
              fatalErrorCountRef.current = 0;
              manifestErrorCountRef.current = 0;

              // Trigger auto-switch
              handleStreamOfflineRef.current();
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

            Logger.debug(`[HLS] Non-fatal error (${data.details}) count: ${nonFatalErrorCountRef.current}/${maxNonFatalErrorsBeforeOffline}`);
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

          Logger.debug(`[HLS] Fatal error count: ${fatalErrorCountRef.current}/${maxFatalErrorsBeforeOffline}`);

          // Check if we've exceeded max fatal errors - likely stream is offline
          if (fatalErrorCountRef.current >= maxFatalErrorsBeforeOffline && !isAutoSwitchingRef.current) {
            Logger.debug('[HLS] Max fatal errors reached, stream appears to be offline. Triggering auto-switch...');

            // Reset error count
            fatalErrorCountRef.current = 0;

            // Trigger auto-switch
            handleStreamOfflineRef.current();
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              Logger.debug('[HLS] Fatal network error, attempting recovery...');

              // Check if this is a manifest/playlist load error (strong indicator of offline stream)
              if (data.details === 'manifestLoadError' ||
                data.details === 'manifestLoadTimeOut' ||
                data.details === 'manifestParsingError' ||
                data.details === 'levelLoadError' ||
                data.details === 'levelLoadTimeOut') {
                Logger.debug(`[HLS] Manifest/level loading failed: ${data.details}`);

                // For manifest errors, use separate counter to be more careful
                manifestErrorCountRef.current++;
                Logger.debug(`[HLS] Manifest error count: ${manifestErrorCountRef.current}/${maxManifestErrorsBeforeOffline}`);

                // Only trigger offline if we've had multiple manifest errors AND 
                // either never played successfully OR it's been a while since we started
                const timeSinceStart = Date.now() - lastSuccessfulPlayRef.current;
                const hasPlayedSuccessfully = lastSuccessfulPlayRef.current > 0;
                const shouldTriggerOffline = manifestErrorCountRef.current >= maxManifestErrorsBeforeOffline &&
                  (!hasPlayedSuccessfully || timeSinceStart > minPlayTimeBeforeOfflineMs);

                if (shouldTriggerOffline && !isAutoSwitchingRef.current) {
                  Logger.debug('[HLS] Multiple manifest errors, stream likely offline. Triggering auto-switch...');
                  Logger.debug(`[HLS] Has played: ${hasPlayedSuccessfully}, Time since start: ${timeSinceStart}ms`);
                  manifestErrorCountRef.current = 0;
                  fatalErrorCountRef.current = 0;
                  handleStreamOfflineRef.current();
                  return;
                }
              }

              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              Logger.debug('[HLS] Fatal media error, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              Logger.error('[HLS] Fatal error, cannot recover. Recreating player...');
              setTimeout(() => {
                if (videoRef.current && isLiveRef.current && !isAutoSwitchingRef.current) {
                  createPlayer();
                }
              }, 2000);
              break;
          }
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels[data.level];
        Logger.debug(`[HLS] Level switched to: ${data.level} (${level?.height}p @ ${level?.bitrate}bps)`);

        // Update Plyr's quality display if in auto mode
        if (playerRef.current && hls.currentLevel === -1) {
          // In auto mode, update the display to show current quality
          const qualityBadge = containerRef.current?.querySelector('.plyr__menu__container [data-plyr="quality"][aria-checked="true"]');
          if (qualityBadge && level) {
            Logger.debug(`[HLS] Auto selected: ${level.height}p`);
          }
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        lastFragLoadedTimeRef.current = Date.now();
        nonFatalErrorCountRef.current = 0;
        if (Math.random() < 0.05) {
          Logger.debug(`[HLS] Fragment loaded: sn=${data.frag.sn} dur=${data.frag.duration.toFixed(1)}s`);
        }
      });

      // ──── Cold-Start Buffer Gate + live-sync snap ────
      // Twitch segments are ~2s. Wait for a little buffer so a cold start doesn't
      // stall, THEN snap the playhead to the live-sync point. The snap is the
      // load-bearing part: the buffer this gate accumulates piles up BEHIND the
      // advancing live edge, so without it the cold-start buffer (not
      // liveSyncDuration) decides how far back we play, pinning latency ~6-8s no
      // matter the configured cushion. Snapping to (freshest buffered edge minus
      // liveSyncDuration), clamped into the buffered range, makes the cushion
      // actually control latency. This mirrors a manual "scrub close to live",
      // which sustains without stalling.
      // Threshold is 3, not 4: two 2s segments measure as ~3.96s, which just
      // misses a 4 threshold and forces a ~2s wait for a freshly-produced third
      // segment (the slow-load regression). 3 clears on the two already-available
      // segments instead.
      let playStarted = false;
      const GATE_THRESHOLD = 3;

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (playStarted || !currentSettings.autoplay) return;

        const buffered = video.buffered;
        if (buffered.length === 0) return;

        const bufStart = buffered.start(0);
        const bufEnd = buffered.end(buffered.length - 1);
        const depth = bufEnd - bufStart;
        if (depth < GATE_THRESHOLD) return;

        playStarted = true;

        // Snap to the live-sync point (cushion behind the freshest buffered edge),
        // clamped so we never seek into an unbuffered hole. No-op when the buffer
        // is already within the cushion (e.g. low-latency off), so it never pushes
        // anyone CLOSER than their setting asks for.
        const syncDur = hls.config.liveSyncDuration ?? 4;
        const target = Math.max(bufStart, bufEnd - syncDur);
        if (target > video.currentTime + 0.5) {
          video.currentTime = target;
        }

        Logger.debug(`[HLS] Buffer gate cleared: ${depth.toFixed(1)}s buffered, edge ${bufEnd.toFixed(1)}, snap to ${target.toFixed(1)} — starting playback`);
        video.play().catch(e => {
          Logger.debug('[HLS] Autoplay failed:', e);
          video.muted = true;
          video.play().catch(() => Logger.debug('[HLS] Muted autoplay also failed'));
        });
      });

      // Fallback timeout
      bufferGateTimeoutRef.current = setTimeout(() => {
        if (!playStarted && currentSettings.autoplay) {
          playStarted = true;
          Logger.debug('[HLS] Buffer gate timeout — starting playback');
          video.play().catch(() => {});
        }
      }, 5000);

      // Load the stream
      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      // Add video event listeners
      const onLoadedMetadata = () => {
        Logger.debug(`[Video] Metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
      };

      const onPlaying = () => {
        Logger.debug(`[Video] Playing: ${video.videoWidth}x${video.videoHeight}, paused: ${video.paused}, readyState: ${video.readyState}`);
        Logger.debug(`[Video] Audio state: muted=${video.muted}, volume=${video.volume}`);

        // Track successful playback - this helps us distinguish between
        // "stream never loaded" vs "stream was playing and then had issues"
        if (lastSuccessfulPlayRef.current === 0) {
          lastSuccessfulPlayRef.current = Date.now();
          Logger.debug('[Video] First successful playback recorded');
        }

        // Buffer gate handles the initial seek-to-live — no jump_to_live logic needed here.

        // Reset error counts on successful playback - stream is working
        fatalErrorCountRef.current = 0;
        manifestErrorCountRef.current = 0;
        nonFatalErrorCountRef.current = 0;
      };

      onLoadedMetadataRef.current = onLoadedMetadata;
      onPlayingRef.current = onPlaying;

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('playing', onPlaying);

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      Logger.debug('[HLS] Using native HLS support');
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
        clickToPlay: false, // single/double-click handled manually (see effect)
        // See note in the HLS.js path above — force CSS-only fullscreen so we
        // can promote it to a real OS window fullscreen via Tauri.
        fullscreen: { enabled: true, fallback: 'force', iosNative: false },
        // Disable Plyr's built-in localStorage - we manage settings via Tauri backend
        storage: { enabled: false },
      });

      playerRef.current = player;
      playerRef.current.volume = currentSettings.volume;
      playerRef.current.muted = currentSettings.muted;

      player.on('enterfullscreen', () => syncTauriWindowFullscreen(true));
      player.on('exitfullscreen', () => syncTauriWindowFullscreen(false));

      // Persist volume/muted changes back to settings (Safari path)
      player.on('volumechange', () => {
        if (!playerRef.current) return;
        const newVolume = playerRef.current.volume;
        const newMuted = playerRef.current.muted;

        if (volumeDebounceRef.current) clearTimeout(volumeDebounceRef.current);
        volumeDebounceRef.current = setTimeout(() => {
          const { settings, updateSettings } = useAppStore.getState();
          const current = settings.video_player;
          if (current.volume !== newVolume || current.muted !== newMuted) {
            updateSettings({
              ...settings,
              video_player: { ...current, volume: newVolume, muted: newMuted },
            });
          }
        }, 300);
      });

      const onSafariLoadedMetadata = () => {
        video.play().catch(e => Logger.debug('Initial play failed:', e));
      };
      
      onLoadedMetadataRef.current = onSafariLoadedMetadata;
      video.addEventListener('loadedmetadata', onSafariLoadedMetadata);

    } else {
      Logger.error('[HLS] HLS is not supported in this browser');
    }
    // Only depend on streamUrl - settings and isAutoSwitching are read from refs inside the callback
    // This prevents player recreation when volume/muted settings change or when isAutoSwitching toggles
  // handleStreamOffline is accessed via ref to keep this callback stable.
  }, [streamUrl]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !streamUrl) return;

    // Start time display update loop
    progressUpdateIntervalRef.current = requestAnimationFrame(updateLiveTimeDisplay);

    const video = videoElement;

    // Deferred-recreate timeout id for the stream-swap path. Held in an
    // effect-scoped variable (not a partial early-return cleanup) so the SINGLE
    // cleanup below always tears everything down — including the rAF loop above.
    let recreateTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // If HLS instance already exists, fully destroy it before creating new one
    // HLS.js doesn't handle reusing instances well after detach/attach cycles
    if (hlsRef.current) {
      Logger.debug('[HLS] Stream URL changed, destroying old HLS instance before creating new one:', streamUrl);

      try {
        // Stop loading new data
        hlsRef.current.stopLoad();
        // Detach from media element first
        hlsRef.current.detachMedia();
        // Then destroy the instance
        hlsRef.current.destroy();
      } catch (e) {
        Logger.warn('[HLS] Error destroying old HLS instance:', e);
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
      recreateTimeoutId = setTimeout(() => {
        createPlayer();
      }, 100);
    } else {
      // Create the HLS player (fresh instance for initial load)
      createPlayer();
    }

    // Cleanup
    return () => {
      // Clear a pending deferred-recreate so createPlayer can't fire after teardown
      if (recreateTimeoutId) clearTimeout(recreateTimeoutId);
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
          Logger.warn('Error destroying HLS on cleanup:', e);
        }
        hlsRef.current = null;
      }

      // Destroy Plyr instance
      // CRITICAL: Stop the video decoder BEFORE Plyr.destroy() re-parents the <video> element.
      // React 18 StrictMode double-fires effects (mount → cleanup → mount). If the video is
      // actively decoding when Plyr moves it in the DOM, WebView2's hardware decoder loses its
      // DirectComposition surface — resulting in audio-only playback (black/frozen frame).
      if (playerRef.current) {
        if (videoElement) {
          videoElement.pause();
          videoElement.removeAttribute('src');
          videoElement.load();
        }
        playerRef.current.destroy();
        playerRef.current = null;
      }

      // Reset state
      isLiveRef.current = true;
      userInitiatedPauseRef.current = false;

      // Cleanup DOM listeners and timeouts
      if (videoElement) {
        const playingHandler = onPlayingRef.current;
        const metadataHandler = onLoadedMetadataRef.current;
        if (playingHandler) videoElement.removeEventListener('playing', playingHandler);
        if (metadataHandler) videoElement.removeEventListener('loadedmetadata', metadataHandler);
      }
      const debouncer = volumeDebounceRef.current;
      const gateTimeout = bufferGateTimeoutRef.current;
      if (debouncer) clearTimeout(debouncer);
      if (gateTimeout) clearTimeout(gateTimeout);

      // Reset error tracking for next stream
      fatalErrorCountRef.current = 0;
      manifestErrorCountRef.current = 0;
      nonFatalErrorCountRef.current = 0;
      lastSuccessfulPlayRef.current = 0;
      lastErrorTimeRef.current = 0;
      lastFragLoadedTimeRef.current = 0;
    };
  // createPlayer is intentionally excluded: its only dep is streamUrl (already listed).
  // Including it causes double-creation on fresh mounts because React gives useCallback
  // a new identity on the very first render, firing this effect twice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, updateLiveTimeDisplay]);

  // Update volume when settings change
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.volume = playerSettings.volume;
      playerRef.current.muted = playerSettings.muted;
    }
  }, [playerSettings.volume, playerSettings.muted]);

  // Expose an imperative control adapter to the keybinding engine. Methods read
  // playerRef.current at call time so they survive player recreation; isActive()
  // reports false for native-control MP4 clips (no Plyr instance), which keeps
  // player-context hotkeys from firing when there is nothing to control.
  useEffect(() => {
    const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const controls: PlayerControls = {
      isActive: () => playerRef.current !== null,
      getCurrentTime: () => {
        const v = videoRef.current;
        return v && Number.isFinite(v.currentTime) ? v.currentTime : null;
      },
      togglePlay: () => playerRef.current?.togglePlay(),
      toggleMute: () => {
        const p = playerRef.current;
        if (p) p.muted = !p.muted;
      },
      toggleFullscreen: () => playerRef.current?.fullscreen.toggle(),
      volumeUp: () => {
        const p = playerRef.current;
        if (p) p.volume = Math.min(1, Math.round((p.volume + 0.05) * 100) / 100);
      },
      volumeDown: () => {
        const p = playerRef.current;
        if (p) p.volume = Math.max(0, Math.round((p.volume - 0.05) * 100) / 100);
      },
      seekForward: () => playerRef.current?.forward(10),
      seekBackward: () => playerRef.current?.rewind(10),
      togglePip: () => {
        const p = playerRef.current;
        if (!p) return;
        try {
          p.pip = !p.pip;
        } catch (err) {
          Logger.debug('[Player] PiP toggle failed:', err);
        }
      },
      speedUp: () => {
        const p = playerRef.current;
        if (!p) return;
        const i = SPEEDS.indexOf(p.speed);
        p.speed = SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + 1)];
      },
      speedDown: () => {
        const p = playerRef.current;
        if (!p) return;
        const i = SPEEDS.indexOf(p.speed);
        p.speed = SPEEDS[Math.max(0, (i < 0 ? 3 : i) - 1)];
      },
    };
    registerPlayerControls(controls);
    return () => registerPlayerControls(null);
  }, []);

  // Click vs double-click on the video surface (live/VOD Plyr path only).
  // Single click toggles play/pause; double click toggles fullscreen. A short
  // timer holds the single-click action just long enough that a following
  // double-click can cancel it, so a double-click never blips play/pause (which
  // on a live stream would force a rebuffer). Listeners live on the <video>
  // node itself, so clicks on the controls bar and the overlay buttons are
  // unaffected. Clip playback uses native controls (no Plyr); there playerRef
  // is null and these handlers no-op, leaving native behavior intact.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    const onClick = () => {
      if (clickTimer) return; // second click of a pair — let dblclick handle it
      clickTimer = setTimeout(() => {
        clickTimer = null;
        playerRef.current?.togglePlay();
      }, 250);
    };
    const onDblClick = () => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      playerRef.current?.fullscreen.toggle();
    };
    video.addEventListener('click', onClick);
    video.addEventListener('dblclick', onDblClick);
    return () => {
      if (clickTimer) clearTimeout(clickTimer);
      video.removeEventListener('click', onClick);
      video.removeEventListener('dblclick', onDblClick);
    };
  }, []);

  // Build the quality menu once BOTH the quality list and the player are ready,
  // in whichever order they arrive. `playerReady` is state, so this re-runs when
  // Plyr is created (a ref wouldn't), and the list can now arrive instantly.
  useEffect(() => {
    if (availableQualities.length > 0 && playerReady) {
      updateQualityMenu();
    }
  }, [availableQualities, playerReady, updateQualityMenu]);

  // Inject a "Stats" toggle into the Plyr settings (gear) menu, alongside Quality
  // and Speed, so the latency panel is opened from there (not a floating button).
  // Re-runs whenever Plyr is (re)created. Mirrors the quality-menu injection: the
  // menu DOM can appear after this fires, so retry until it exists.
  useEffect(() => {
    if (!playerReady) return;
    const container = containerRef.current;
    if (!container) return;
    let attempts = 0;
    let cancelled = false;
    const inject = () => {
      if (cancelled) return;
      const settingsHome = container.querySelector('.plyr__menu [role="menu"]');
      if (!settingsHome) {
        if (attempts++ < 25) setTimeout(inject, 200);
        return;
      }
      if (settingsHome.querySelector('[data-streamnook-stats]')) return; // already present
      const item = document.createElement('button');
      item.className = 'plyr__control';
      item.setAttribute('data-streamnook-stats', '');
      item.setAttribute('type', 'button');
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<span>Stats<span class="plyr__menu__value" data-stats-value>${showStatsRef.current ? 'On' : 'Off'}</span></span>`;
      item.addEventListener('click', () => setShowStats((s) => !s));
      settingsHome.appendChild(item);
    };
    inject();
    return () => {
      cancelled = true;
    };
  }, [playerReady]);

  // Keep the menu item's On/Off value in sync however showStats changes (the menu
  // item or the panel's own close button).
  useEffect(() => {
    const span = containerRef.current?.querySelector('[data-streamnook-stats] [data-stats-value]');
    if (span) span.textContent = showStats ? 'On' : 'Off';
  }, [showStats]);

  // Start overlay hide timer - use ref to avoid dependency issues
  const startOverlayHideTimer = useCallback(() => {
    if (overlayTimerRef.current) {
      clearTimeout(overlayTimerRef.current);
    }
    overlayTimerRef.current = setTimeout(() => {
      setShowOverlay(false);
    }, OVERLAY_HIDE_DELAY);
  }, []);

  // Snap the playhead back to the live edge (used by the stats panel's "Go Live"
  // button and after scrubbing into the DVR window). hls.js exposes the synced
  // live position; jump there and resume if paused.
  const goLive = useCallback(() => {
    const hls = hlsRef.current;
    const video = videoRef.current;
    if (!hls || !video) return;
    const pos = hls.liveSyncPosition;
    if (pos != null && Number.isFinite(pos)) {
      video.currentTime = pos;
      if (video.paused) video.play().catch(() => { /* autoplay policy / teardown */ });
    }
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

  // NOTE: PIP exit handling is done in App.tsx, not here
  // App.tsx correctly differentiates between "Back to tab" (returns to stream view)
  // and "X" button (stops stream) by checking if video is paused

  // Move the current single stream into MultiNook: add it as a tile, switch into
  // the grid, then close the solo player. Lets the viewer pivot from watching one
  // stream to watching several side-by-side without routing back through Home.
  const handleAddToMultiNook = useCallback(async () => {
    const stream = currentStream;
    if (!stream?.user_login) return;

    const login = stream.user_login;
    const mn = usemultiNookStore.getState();
    const alreadyPresent = mn.slots.some(
      (s) => s.channelLogin.toLowerCase() === login.toLowerCase()
    );

    // MultiNook holds at most 25 tiles. addSlot enforces this too (with its own
    // toast), but checking first avoids closing the current stream when there's
    // no room left to add it.
    if (!alreadyPresent && mn.slots.length >= 25) {
      useAppStore.getState().addToast('Maximum of 25 streams reached', 'warning');
      return;
    }

    // Await the add so slots is non-empty before we toggle. Otherwise
    // toggleMultiNook treats this as an empty entry and reloads the stored
    // lineup, dropping the channel we just added.
    await mn.addSlot(login);

    // Focus MultiNook chat on the channel we came from. The chat hook keys on
    // the active channel's login, so keeping it on this same channel means the
    // chat connection carries straight over instead of churning to another tile.
    if (stream.user_id) {
      usemultiNookStore.getState().setActiveChatChannelId(stream.user_id);
    }

    // Enter the grid BEFORE tearing down the solo stream so the chat hook never
    // sees the channel disappear (MultiNook's active slot is this same channel).
    if (!usemultiNookStore.getState().isMultiNookActive) {
      usemultiNookStore.getState().toggleMultiNook();
    }

    // Stop only the solo video proxy and clear its state. preserveBackend keeps
    // the chat bridge, EventSub and drops alive for MultiNook to inherit, and
    // leaves the grid on screen instead of raising Home.
    await exitStream({ preserveBackend: true });
  }, [currentStream, exitStream]);

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
        onLoadedMetadata={(e) => {
          const video = e.target as HTMLVideoElement;
          Logger.debug(`[Video] Metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
          // Safari fallback initial play
          if (!Hls?.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')) {
            video.play().catch(err => Logger.debug('Initial play failed:', err));
          }
        }}
        onPlaying={(e) => {
          const video = e.target as HTMLVideoElement;
          Logger.debug(`[Video] Playing: ${video.videoWidth}x${video.videoHeight}, paused: ${video.paused}, readyState: ${video.readyState}`);
          Logger.debug(`[Video] Audio state: muted=${video.muted}, volume=${video.volume}`);

          if (lastSuccessfulPlayRef.current === 0) {
            lastSuccessfulPlayRef.current = Date.now();
            Logger.debug('[Video] First successful playback recorded');
          }

          fatalErrorCountRef.current = 0;
          manifestErrorCountRef.current = 0;
          nonFatalErrorCountRef.current = 0;
        }}
      />

      {/* Offline Banner (Fallback when no VOD exists) */}
      <AnimatePresence>
        {streamUrl === 'offline' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none"
          >
            {/* Background blur/gradient */}
            <div className="absolute inset-0 bg-gradient-to-br from-purple-900/10 to-black backdrop-blur-3xl" />
            
            {/* Content card */}
            <div className="relative z-10 p-8 rounded-2xl glass-panel border border-white/10 shadow-2xl flex flex-col items-center max-w-md text-center bg-black/40">
              <div className="w-24 h-24 mb-6 rounded-full bg-glass flex items-center justify-center border border-white/20 shadow-[0_0_50px_rgba(145,70,255,0.3)]">
                <span className="text-5xl drop-shadow-lg">😴</span>
              </div>
              <h2 className="text-2xl font-bold text-white mb-3 drop-shadow-md tracking-wide">
                Stream Offline
              </h2>
              <p className="text-white/70 text-sm leading-relaxed mb-8">
                Welcome to the offline chat room. <span className="font-semibold text-white">{currentStream?.user_name || 'The broadcaster'}</span> has no recent videos available to display, but you can still hang out and chat.
              </p>
              
              <div className="flex gap-4 pointer-events-auto">
                <button 
                  onClick={() => {
                    setHomeActiveTab(isAuthenticated ? 'following' : 'recommended');
                    toggleHome();
                  }}
                  className="px-6 py-2.5 glass-button bg-accent/20 border border-accent/40 text-white rounded-lg hover:bg-accent/40 hover:border-accent/60 shadow-[0_0_15px_rgba(145,70,255,0.2)] transition-colors flex items-center gap-2 font-medium"
                >
                  <Home size={16} strokeWidth={2.5} /> Keep Browsing
                </button>
                <button 
                  onClick={async () => {
                    setHomeActiveTab(isAuthenticated ? 'following' : 'recommended');
                    await exitStream();
                  }}
                  className="px-6 py-2.5 glass-button text-white/80 rounded-lg border border-white/10 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2 font-medium"
                >
                  <XIcon size={16} weight="bold" /> Exit Chat
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transient stream note — top-left. Replaces the per-stream toasts: how
          this stream is ad-free (your entitlement vs the proxy) plus any quality
          fallback, shown briefly then faded. */}
      <AnimatePresence>
        {showStreamNote && !showOverlay && adSource && currentMediaType === 'live' && (
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="absolute top-4 left-4 z-50 max-w-xs pointer-events-none"
          >
            <div className="glass-panel p-3 rounded-lg border border-accent/30 bg-background/80 backdrop-blur-md">
              <div className="flex items-start gap-2">
                {adSource.entitled ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                ) : adSource.mode === 'auth-only' ? (
                  <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <Shield className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <p className="text-textPrimary text-xs font-medium">
                    {adSource.entitled
                      ? adSource.mode === 'turbo'
                        ? 'Ad-free via Twitch Turbo'
                        : 'Ad-free via your subscription'
                      : adSource.mode === 'auth-only'
                        ? 'Ad-blocking unavailable'
                        : 'Ad-blocking proxy active'}
                  </p>
                  <p className="text-textSecondary text-xs leading-relaxed">
                    {adSource.entitled
                      ? 'Playing directly from Twitch. No proxy.'
                      : adSource.mode === 'auth-only'
                        ? 'Ads may appear on this stream.'
                        : `Routing through ${adSource.region || 'a proxy'} for an ad-free stream.`}
                  </p>
                  {activeQuality && !qualitiesEquivalent(settings.quality, activeQuality) && (
                    <p className="text-textMuted text-[10px] leading-relaxed">
                      Playing {activeQuality} ({settings.quality} unavailable).
                    </p>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stream Title Overlay — Top-left, shares hover timing with controls */}
      <AnimatePresence>
        {currentStream && showOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="stream-title-overlay absolute top-0 left-0 right-0 z-40 pointer-events-none"
          >
          {/* Gradient scrim for text legibility over bright video */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-transparent" />
          <div className="relative px-4 pt-3 pb-6 flex items-start gap-2">
            {/* Back Arrow or Home Button (Only visible when Home is not active) */}
            {!isHomeActive && (
              currentMediaType === 'clip' || currentMediaType === 'video' ? (
                // Clips/VODs: always show back arrow — stop playback and return to category
                <Tooltip content={streamOriginCategory ? `Back to ${streamOriginCategory.name}` : 'Back'} side="bottom" delay={200}>
                  <button
                    onClick={async () => {
                      if (streamOriginCategory) {
                        setHomeActiveTab('category');
                        setHomeSelectedCategory(streamOriginCategory);
                        // homeCategoryTab is already set to 'clips' or 'videos' from when the card was clicked
                      } else {
                        setHomeActiveTab(isAuthenticated ? 'following' : 'recommended');
                      }
                      await exitStream();
                    }}
                    className="shrink-0 mt-0.5 p-2 glass-button rounded-lg pointer-events-auto"
                    style={{ backdropFilter: 'blur(16px)' }}
                  >
                    <ArrowLeft size={16} weight="bold" className="text-white" />
                  </button>
                </Tooltip>
              ) : streamOriginCategory ? (
                <Tooltip content="Back to category" side="bottom" delay={200}>
                  <button
                    onClick={() => {
                      setHomeActiveTab('category');
                      setHomeSelectedCategory(streamOriginCategory);
                      toggleHome();
                    }}
                    className="shrink-0 mt-0.5 p-2 glass-button rounded-lg pointer-events-auto"
                    style={{ backdropFilter: 'blur(16px)' }}
                  >
                    <ArrowLeft size={16} weight="bold" className="text-white" />
                  </button>
                </Tooltip>
              ) : (
                <div className="flex gap-1.5 items-center pointer-events-auto shrink-0 mt-0.5">
                  <Tooltip content="Keep Browsing" side="bottom" delay={200}>
                    <button
                      onClick={() => {
                        setHomeActiveTab(isAuthenticated ? 'following' : 'recommended');
                        toggleHome();
                      }}
                      className="p-2 glass-button rounded-lg"
                      style={{ backdropFilter: 'blur(16px)' }}
                    >
                      <Home size={16} className="text-white drop-shadow-md" strokeWidth={2.5} />
                    </button>
                  </Tooltip>
                </div>
              )
            )}
            <div className="min-w-0">
              {currentStream.title?.trim() && (
                <Tooltip content={currentStream.title} side="bottom" delay={300}>
                <h3
                  className="text-white text-sm font-medium line-clamp-1 drop-shadow-lg"
                >
                  <StreamTitleWithEmojis title={currentStream.title} />
                </h3>
                </Tooltip>
              )}
              {currentStream.game_name && (
                <p className="text-white/70 text-xs mt-0.5 drop-shadow-md">
                  {currentMediaType === 'live' 
                    ? currentStream.game_name 
                    : streamUrl === 'offline' 
                      ? currentStream.game_name
                      : `${currentStream.game_name} • ${currentStream.viewer_count?.toLocaleString() || 0} Views • ${new Date(currentStream.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
                </p>
              )}
            </div>
          </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Live telemetry panel, bottom-left. Collapsed toggle rides the hover
          overlay; the panel itself persists once opened. Live streams only. */}
      {currentMediaType === 'live' && streamUrl && streamUrl !== 'offline' && (
        <PlayerStatsOverlay
          hlsRef={hlsRef}
          videoRef={videoRef}
          open={showStats}
          onToggle={() => setShowStats((s) => !s)}
          onGoLive={goLive}
          adSource={adSource}
        />
      )}

      {/* Follow & Subscribe Button Overlay */}
      <AnimatePresence>
        {currentStream && showOverlay && (currentMediaType === 'live' || currentMediaType === 'offline_chat' || currentMediaType === 'video') && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="subscribe-overlay absolute top-3 right-3 z-50 flex items-center gap-2"
          >
          {/* Follow Button - Icon Only with Glow */}
          {overlayButtonOn('follow') && (
          <Tooltip content={checkingFollowStatus
                ? 'Checking follow status...'
                : followLoading
                  ? 'Processing...'
                  : isFollowing
                    ? `Unfollow ${currentStream.user_name}`
                    : `Follow ${currentStream.user_name}`} side="bottom">
          <button
            onClick={handleFollowClick}
            disabled={followLoading || checkingFollowStatus}
            className={`flex items-center justify-center p-2 glass-button rounded-lg ${followLoading || checkingFollowStatus
              ? 'opacity-60 cursor-wait'
              : ''
              }`}
            style={{ backdropFilter: 'blur(16px)' }}
          >
            {followLoading || checkingFollowStatus ? (
              <Loader2 className="w-4 h-4 animate-spin text-textSecondary" />
            ) : heartDropAnimation ? (
              <HeartBreak
                weight="fill"
                className="w-4 h-4 text-red-400 animate-heart-drop"
              />
            ) : isFollowing ? (
              <HeartBreak
                weight="fill"
                className="w-4 h-4 text-red-400 drop-shadow-[0_0_5px_rgba(239,68,68,0.7)]"
              />
            ) : (
              <Heart
                weight="fill"
                className="w-4 h-4 text-emerald-400 drop-shadow-[0_0_5px_rgba(16,185,129,0.7)]"
              />
            )}
          </button>
          </Tooltip>
          )}

          {/* Subscribe Button */}
          {overlayButtonOn('subscribe') && (
          <Tooltip content={isSubscribed
                ? `Gift a sub to ${currentStream.user_name}'s community`
                : hasSubHistory
                  ? `Resubscribe to ${currentStream.user_name} (${cumulativeMonths + 1} months)`
                  : `Subscribe to ${currentStream.user_name}`} side="bottom">
          <button
            onClick={handleSubscribeClick}
            className="flex items-center gap-2 px-4 py-2 glass-button text-white text-sm font-semibold transition-all duration-200"
            style={{ backdropFilter: 'blur(16px)' }}
          >
            <span>
              {isSubscribed ? 'Gift Subs' : hasSubHistory ? 'Resubscribe' : 'Subscribe'}
            </span>
            {subscriberBadgeUrl ? (
              <img 
                src={subscriberBadgeUrl} 
                alt="Subscriber badge" 
                className="w-5 h-5 object-contain"
                referrerPolicy="no-referrer"
              />
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            )}
          </button>
          </Tooltip>
          )}

          {/* Create Clip Button — live: last ~30s; VOD (incl. offline-chat's
              auto-loaded VOD): ~30s at the current spot */}
          {overlayButtonOn('clip') && canClip && (
            <Tooltip content="Create clip (Alt+X)" side="bottom">
            <button
              onClick={() => createClip()}
              disabled={isCreatingClip}
              className={`flex items-center justify-center p-2 glass-button rounded-lg ${
                isCreatingClip ? 'cursor-wait opacity-70' : ''
              }`}
              style={{ backdropFilter: 'blur(16px)' }}
            >
              {isCreatingClip ? (
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
              ) : (
                <Clapperboard className="w-4 h-4 text-white hover:text-accent transition-colors duration-200" />
              )}
            </button>
            </Tooltip>
          )}

          {/* Clips & VODs — opens this streamer's clip/VOD library. Text label,
              no icon (the label speaks for itself, so no tooltip either). */}
          {overlayButtonOn('clipsvods') && currentStream && currentStream.user_id && (
            <button
              onClick={() => openStreamerMedia(currentStream)}
              className="flex items-center justify-center px-3 py-2 glass-button rounded-lg text-sm font-semibold text-white hover:text-accent transition-colors duration-200"
              style={{ backdropFilter: 'blur(16px)' }}
            >
              Clips &amp; VODs
            </button>
          )}

          {/* Add to MultiNook Button — pulls this stream into the multi-view grid */}
          {overlayButtonOn('multinook') && currentMediaType === 'live' && (
            <Tooltip content="Add to MultiNook" side="bottom">
            <button
              onClick={handleAddToMultiNook}
              className="flex items-center justify-center p-2 glass-button rounded-lg"
              style={{ backdropFilter: 'blur(16px)' }}
            >
              <LayoutGrid className="w-4 h-4 text-white hover:text-accent transition-colors duration-200" />
            </button>
            </Tooltip>
          )}

          {/* Reload Stream + Chat Button — hard refresh of both the video and
              the chat connection, not just the stream. */}
          {overlayButtonOn('refresh') && currentMediaType === 'live' && (
            <Tooltip content="Reload stream & chat" side="bottom">
            <button
              onClick={async () => {
                setIsRestarting(true);
                try {
                  await reloadStreamAndChat();
                } finally {
                  setIsRestarting(false);
                }
              }}
              disabled={isRestarting}
              className={`flex items-center justify-center p-2 glass-button rounded-lg ${
                isRestarting ? 'cursor-wait opacity-70' : ''
              }`}
              style={{ backdropFilter: 'blur(16px)' }}
            >
              {isRestarting ? (
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
              ) : (
                <RefreshCcw className="w-4 h-4 text-white hover:text-accent transition-colors duration-200" />
              )}
            </button>
            </Tooltip>
          )}

          {/* Close Stream Button */}
          {overlayButtonOn('close') && (
          <Tooltip content="Close Stream" side="bottom">
          <button
            onClick={() => exitStream()}
            className="flex items-center justify-center p-2 glass-button rounded-lg"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.25)', backdropFilter: 'blur(16px)' }}
          >
            <XIcon weight="bold" className="w-4 h-4 text-red-400" />
          </button>
          </Tooltip>
          )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Audio Boost popover — edit boost/compressor on the fly without leaving
          the stream. Opened by right-clicking the control-bar toggle. Sits just
          above the control bar; stops pointer events so it never toggles
          play/pause underneath. */}
      <AnimatePresence>
        {audioPanelOpen && (
          <motion.div
            ref={audioPanelRef}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            className="liquid-glass-panel absolute bottom-16 right-3 z-[60] rounded-xl p-4"
            style={{ width: 'min(460px, calc(100% - 24px))' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-textPrimary">Audio Boost</span>
              <Toggle
                enabled={audioBoostEnabled}
                onChange={() => applyBoostPatch({ enabled: !audioBoostEnabled })}
              />
            </div>
            <div className={audioBoostEnabled ? '' : 'opacity-50 pointer-events-none'}>
              <div className="flex flex-wrap items-end justify-center gap-x-5 gap-y-4">
                {audioBoostFaderDefs(resolvedBoost).map((d) => (
                  <Fader
                    key={d.key}
                    label={d.label}
                    display={d.display}
                    value={d.value}
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    hint={d.hint}
                    onChange={(v) => applyBoostPatch(d.apply(v))}
                  />
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-center gap-4">
              <button
                onClick={() => applyBoostPatch(audioBoostResetPatch())}
                style={{ borderRadius: 8 }}
                className="glass-button text-textSecondary hover:text-textPrimary text-xs px-3 py-1.5"
              >
                Reset to defaults
              </button>
              <button
                onClick={() => {
                  setAudioPanelOpen(false);
                  useAppStore.getState().openSettings('Player', 'settings-section-audio-boost');
                }}
                className="text-xs text-textSecondary underline-offset-2 hover:text-textPrimary hover:underline"
              >
                Open in Settings
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default VideoPlayer;
