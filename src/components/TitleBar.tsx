import { Window } from '@tauri-apps/api/window';
import { Gift, User, Settings, Proportions, MessageCircle, Pickaxe, Clock, Tv, RotateCw, ClipboardList } from 'lucide-react';
import { Minus, X, CornersOut, CornersIn, Medal } from 'phosphor-react';
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../stores/AppStore';
import PenroseLogo from './PenroseLogo';
import AboutWidget from './AboutWidget';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getSelectedCompactViewPreset } from '../constants/compactViewPresets';
import type { MiningStatus, DropsSettings, DropProgress } from '../types';
import { deriveMiningDisplay } from '../utils/miningDisplay';


import { Logger } from '../utils/logger';
import { useVisibleInterval } from '../utils/useVisibleInterval';
import { Tooltip } from './ui/Tooltip';

/** Maps the discrete stage strings emitted by Rust's bundle-update-progress
 *  event to a fill percentage for the progress bar. */
const getUpdateStageProgress = (stage: string | null): number => {
  if (!stage) return 5;
  const s = stage.toLowerCase();
  if (s.includes('complete')) return 100;
  if (s.includes('restart')) return 95;
  if (s.includes('install')) return 75;
  if (s.includes('extract')) return 50;
  if (s.includes('download')) return 25;
  return 5;
};

const TitleBar = () => {
  const store = useAppStore();

  const { openSettings, setShowDropsOverlay, setShowBadgesOverlay, setShowWhispersOverlay, showListsPanel, setShowListsPanel, isAuthenticated, currentUser, isMiningActive, isTheaterMode, toggleTheaterMode, streamUrl, settings, whisperImportState, updateInfo, setUpdateInfo, addToast } = store;
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [, setShowSplash] = useState(false);
  const [dropsSettings, setDropsSettings] = useState<DropsSettings | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const prevMiningActive = useRef(isMiningActive);
  
  // Mining status state for progress badge and hover preview
  const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
  // Live per-drop progress, accumulated from 'drops-progress-update' events. The
  // backend's current_drop carries minutes that only move on its slower poll, so
  // the badge percentage is derived from this fresher stream instead — the same
  // source the overlay cards and detail panel trust, keeping all three aligned.
  const [liveProgress, setLiveProgress] = useState<DropProgress[]>([]);
  const [showDropsPreview, setShowDropsPreview] = useState(false);
  const [previewPos, setPreviewPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const dropsButtonRef = useRef<HTMLDivElement>(null);
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Dynamic badge icon state
  const [badgeImages, setBadgeImages] = useState<string[]>([]);
  const [currentBadgeUrl, setCurrentBadgeUrl] = useState<string | null>(null);
  const badgeIndexRef = useRef(0);


  // Track window maximize state
  useEffect(() => {
    const checkMaximized = async () => {
      const window = Window.getCurrent();
      const maximized = await window.isMaximized();
      setIsMaximized(maximized);
    };

    checkMaximized();

    // Listen for window resize events
    const unlisten = Window.getCurrent().onResized(async () => {
      await checkMaximized();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);



  // Load drops settings. These are user preferences that only change when the
  // user toggles them in the settings dialog — polling at 5s was wildly
  // over-aggressive. Once on mount + once an hour as a stale-protection
  // safety net, gated on window visibility.
  const loadDropsSettings = useCallback(async () => {
    try {
      const settings = await invoke<DropsSettings>('get_drops_settings');
      setDropsSettings(settings);
    } catch (err) {
      Logger.error('Failed to get drops settings:', err);
    }
  }, []);
  useEffect(() => {
    loadDropsSettings();
  }, [loadDropsSettings]);
  useVisibleInterval(loadDropsSettings, 60 * 60 * 1000);

  // Load and subscribe to mining status updates for progress badge
  const loadMiningStatus = useCallback(async () => {
    try {
      const status = await invoke<MiningStatus>('get_mining_status');
      setMiningStatus(status);
    } catch {
      // Silently fail - not critical for title bar
    }
  }, []);

  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let isMounted = true;

    const setupListeners = async () => {
      // Listen for mining status updates
      const uStatus = await listen<MiningStatus>('mining-status-update', (event) => {
        setMiningStatus(event.payload);
        // Drop the accumulated per-drop progress once mining stops so a finished
        // session's numbers can't leak into the next one's fallback derivation.
        if (!event.payload.is_mining) setLiveProgress([]);
      });
      if (isMounted) unlistenStatus = uStatus;
      else uStatus();

      // Listen for progress updates (more frequent)
      const uProgress = await listen<{ drop_id: string; current_minutes: number; required_minutes: number; campaign_id?: string; drop_name?: string; timestamp?: number | string }>('drops-progress-update', (event) => {
        const { drop_id: dropId, current_minutes: currentMinutes, required_minutes: requiredMinutes } = event.payload;

        // Keep a live, per-drop progress map. The badge percentage is derived
        // from this (via deriveMiningDisplay) so it tracks the freshest minutes
        // and can still show a value when current_drop hasn't been set yet.
        setLiveProgress((prev) => {
          const idx = prev.findIndex((p) => p.drop_id === dropId);
          const entry: DropProgress = {
            campaign_id: event.payload.campaign_id || (idx >= 0 ? prev[idx].campaign_id : ''),
            drop_id: dropId,
            current_minutes_watched: currentMinutes,
            required_minutes_watched: requiredMinutes,
            is_claimed: false,
            last_updated: String(event.payload.timestamp ?? ''),
            drop_name: event.payload.drop_name || (idx >= 0 ? prev[idx].drop_name : undefined),
          };
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...entry };
            return next;
          }
          return [...prev, entry];
        });

        setMiningStatus((prev) => {
          if (!prev || !prev.is_mining) return prev;

          // Only update the displayed drop in place when this event is for it.
          // WHICH drop is shown (the one closest to completion) is decided by
          // the backend and delivered via 'mining-status-update'. Ignoring
          // other drops' progress events here is what stops the percentage from
          // flipping between rewards (e.g. the 60-min vs the 180-min reward).
          if (prev.current_drop && prev.current_drop.drop_id === dropId) {
            return {
              ...prev,
              current_drop: {
                ...prev.current_drop,
                current_minutes: currentMinutes,
                required_minutes: requiredMinutes
              }
            };
          }

          return prev;
        });
      });
      if (isMounted) unlistenProgress = uProgress;
      else uProgress();
    };

    loadMiningStatus();
    setupListeners();

    return () => {
      isMounted = false;
      if (unlistenStatus) unlistenStatus();
      if (unlistenProgress) unlistenProgress();
    };
  }, [loadMiningStatus]);

  // Backup poll: real-time updates come from the event listeners above. This
  // is just a stale-protection net in case an event was missed. 60-min cadence
  // aligned with the drops-settings poll above. Visibility-gated so it doesn't
  // fire when StreamNook is tucked in the tray.
  useVisibleInterval(loadMiningStatus, 60 * 60 * 1000);

  // Clean up preview timeout on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
    };
  }, []);

  // Load global badge images for the dynamic badge icon
  useEffect(() => {
    const loadBadgeImages = async () => {
      try {
        const cachedBadges = await invoke<{ data: Array<{ set_id: string; versions: Array<{ image_url_2x: string }> }> } | null>('get_cached_global_badges');
        if (cachedBadges?.data && cachedBadges.data.length > 0) {
          
          const isExcludedBadge = (setId: string) => {
            const s = setId.toLowerCase();
            return s.includes('sub') || s.includes('found') || 
                   s.includes('predict') || s.includes('mod') || 
                   s.includes('gift') || s.includes('broadcaster') || 
                   s.includes('partner') || s.includes('verified') || 
                   s.includes('bit') || s.includes('cheer') ||
                   s.includes('develop') || s.includes('audio') || 
                   s.includes('video') || s.includes('listen');
          };
          
          const filteredSets = cachedBadges.data.filter(set => !isExcludedBadge(set.set_id));
          
          const urls = filteredSets
            .flatMap(set => set.versions.map(v => v.image_url_2x))
            .filter(Boolean);
          if (urls.length > 0) {
            // Shuffle the URLs for variety
            const shuffled = [...urls].sort(() => Math.random() - 0.5);
            setBadgeImages(shuffled);
            setCurrentBadgeUrl(shuffled[0]);
            badgeIndexRef.current = 0;
          }
        }
      } catch {
        // Silently fail — Medal icon fallback is fine
      }
    };
    loadBadgeImages();
  }, []);

  // Cycle to next badge on unhover
  const cycleBadgeIcon = useCallback(() => {
    if (badgeImages.length === 0) return;
    const nextIndex = (badgeIndexRef.current + 1) % badgeImages.length;
    badgeIndexRef.current = nextIndex;
    setCurrentBadgeUrl(badgeImages[nextIndex]);
  }, [badgeImages]);

  // Calculate progress percentage through the shared rule so the badge matches
  // the overlay cards and detail panel. Prefers the freshest live minutes, and
  // falls back to the drop finishing first when current_drop isn't set yet (so
  // the badge shows a number instead of reverting to the plain gift icon).
  const progressPercent = useMemo(
    () => deriveMiningDisplay(miningStatus, liveProgress)?.percent ?? 0,
    [miningStatus, liveProgress],
  );

  // Handle hover preview show/hide with delay
  const handleDropsMouseEnter = () => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      if (isMiningActive && miningStatus?.current_drop) {
        setShowDropsPreview(true);
      }
    }, 300); // 300ms delay before showing preview
  };

  const handleDropsMouseLeave = () => {
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }
    previewTimeoutRef.current = setTimeout(() => {
      setShowDropsPreview(false);
    }, 150); // Small delay before hiding
  };

  // The hover preview is portalled to <body> so it escapes the title bar's
  // own stacking context (the bar is position:relative z-50). Rendered inline,
  // the card's z-index:9999 only competes inside that context, so the compact
  // expand-on-hover sidebar overlay (also z-50, but later in the DOM) painted
  // over it. As a body-level portal it sits above the sidebar. Position it just
  // under the drops button with fixed viewport coordinates from the button rect.
  useLayoutEffect(() => {
    if (!showDropsPreview) return;
    const reposition = () => {
      const el = dropsButtonRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPreviewPos({ top: Math.round(r.bottom + 8), left: Math.round(r.left) });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [showDropsPreview]);

  useEffect(() => {
    // Detect when mining stops
    if (prevMiningActive.current && !isMiningActive) {
      queueMicrotask(() => setShowSplash(true));
      setTimeout(() => setShowSplash(false), 600);
    }
    prevMiningActive.current = isMiningActive;
  }, [isMiningActive]);

  const handleMinimize = async () => {
    const window = Window.getCurrent();
    await window.minimize();
  };

  const handleMaximize = async () => {
    const window = Window.getCurrent();
    await window.toggleMaximize();
  };

  const handleClose = async () => {
    const window = Window.getCurrent();
    await window.close();
  };

  const handleSettingsOrUpdate = useCallback(async () => {
    if (isUpdating) return;
    if (!updateInfo) {
      openSettings();
      return;
    }
    setIsUpdating(true);
    setUpdateProgress('Starting update...');
    addToast(`Updating to v${updateInfo.latest_version}...`, 'info');

    const unlisten = await listen<string>('bundle-update-progress', (event) => {
      setUpdateProgress(event.payload);
    });

    try {
      await invoke('download_and_install_bundle');
      addToast('Update installed successfully!', 'success');
      setUpdateInfo(null);
    } catch (e) {
      Logger.error('Update failed:', e);
      addToast(`Update failed: ${e}`, 'error');
    } finally {
      unlisten();
      setIsUpdating(false);
      setUpdateProgress(null);
    }
  }, [updateInfo, isUpdating, openSettings, setUpdateInfo, addToast]);

  return (
    <>
      <div
        data-tauri-drag-region
        className="relative flex items-center justify-between h-[33px] px-3 select-none bg-secondary backdrop-blur-md border-b border-borderSubtle z-50"
      >
        {/* Dynamic Island is rendered at the app root (App.tsx), not here, so it
            can lift above the Settings blur overlay. It still pins to the top
            center via fixed positioning, so it visually sits in this title bar. */}

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* Penrose Logo */}
          <PenroseLogo onClick={() => setShowAbout(true)} />



          {/* Drops Button with Inline Progress Badge */}
          <div 
            className="relative"
            ref={dropsButtonRef}
            onMouseEnter={handleDropsMouseEnter}
            onMouseLeave={handleDropsMouseLeave}
          >
            {(() => {
              const isChannelPointsMining = dropsSettings?.auto_claim_channel_points ?? false;
              const isBothActive = isMiningActive && isChannelPointsMining;
              const showProgressBadge = isMiningActive && progressPercent > 0;

              // Determine gift box color/shimmer class
              // Silver = channel points only, Gold = drops only, Iridescent = both
              let giftClass = '';
              let title = 'Drops & Points';

              if (isBothActive) {
                giftClass = 'gift-shimmer-iridescent';
                title = 'Drops & Points (Both Active)';
              } else if (isMiningActive) {
                giftClass = 'gift-shimmer-gold';
                title = `Drops Mining: ${progressPercent}%`;
              } else if (isChannelPointsMining) {
                giftClass = 'gift-shimmer-silver';
                title = 'Drops & Points (Channel Points Active)';
              }

              const isAnyMiningActive = isMiningActive || isChannelPointsMining;

              return (
                <Tooltip content={title} delay={200}>
                  <button
                    onClick={() => setShowDropsOverlay(true)}
                    className={`p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200 ${showProgressBadge ? 'flex items-center gap-1' : ''}`}
                  >
                    {showProgressBadge ? (
                      // Replace icon with inline progress percentage badge when mining
                      <span className="drops-progress-inline">
                        {progressPercent}%
                      </span>
                    ) : (
                      // Normal Gift icon when not mining drops
                      <Gift size={16} className={isAnyMiningActive ? giftClass : ''} />
                    )}
                  </button>
                </Tooltip>
              );
            })()}

            {/* Hover Preview Card - portalled to body, positioned under the drops button */}
            {showDropsPreview && isMiningActive && miningStatus?.current_drop && createPortal(
              <div
                className="drops-preview-card-right"
                style={{ position: 'fixed', top: previewPos.top, left: previewPos.left, zIndex: 9999 }}
                onMouseEnter={() => {
                  if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
                }}
                onMouseLeave={handleDropsMouseLeave}
              >
                {/* Header */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 rounded-md bg-accent/20">
                    <Pickaxe size={14} className="text-accent" />
                  </div>
                  <span className="text-xs font-semibold text-textPrimary">Mining Drop</span>
                </div>

                {/* Game & Drop Info */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-textMuted">Game:</span>
                    <span className="text-textPrimary font-medium truncate max-w-[140px]">
                      {miningStatus.current_drop.game_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-textMuted">Drop:</span>
                    <span className="text-textPrimary font-medium truncate max-w-[140px]">
                      {miningStatus.current_drop.drop_name}
                    </span>
                  </div>
                  {miningStatus.current_channel && (
                    <div className="flex items-center gap-2 text-xs">
                      <Tv size={10} className="text-textMuted" />
                      <span className="text-textSecondary truncate max-w-[160px]">
                        {miningStatus.current_channel.display_name}
                      </span>
                    </div>
                  )}
                </div>

                {/* Progress Bar */}
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-textMuted flex items-center gap-1">
                      <Clock size={10} />
                      Progress
                    </span>
                    <span className="text-accent font-semibold">{progressPercent}%</span>
                  </div>
                  <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                    <div 
                      className="h-full rounded-full mining-progress-bar transition-all duration-500"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-textMuted mt-1">
                    <span>{miningStatus.current_drop.current_minutes} min</span>
                    <span>{miningStatus.current_drop.required_minutes} min</span>
                  </div>
                </div>

                {/* Click hint */}
                <div className="mt-2 pt-2 border-t border-borderSubtle">
                  <span className="text-[10px] text-textMuted">Click to view all drops</span>
                </div>
              </div>,
              document.body
            )}
          </div>

          {/* Badges Button — dynamic badge icon that cycles on unhover */}
          <Tooltip content="Global Badges" delay={200}>
            <button
              onClick={() => setShowBadgesOverlay(true)}
              onMouseLeave={cycleBadgeIcon}
              className="w-7 h-7 flex items-center justify-center text-textSecondary hover:text-textPrimary rounded transition-colors duration-200"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {currentBadgeUrl ? (
                  <motion.img
                    key={currentBadgeUrl}
                    initial={{ opacity: 0, scale: 0.8, y: 5 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -5 }}
                    transition={{ duration: 0.15 }}
                    src={currentBadgeUrl}
                    alt="Badge"
                    className="w-4 h-4 object-contain"
                    draggable={false}
                  />
                ) : (
                  <motion.div
                    key="medal"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <Medal size={16} />
                  </motion.div>
                )}
              </AnimatePresence>
            </button>
          </Tooltip>



          {/* Settings / Update button. Morphs into an update trigger when an
              update is available; one click installs the new bundle. Auto-opens
              a progress dropdown while installing. */}
          <div className="relative">
            <Tooltip
              content={
                isUpdating
                  ? ''
                  : updateInfo
                    ? `Update v${updateInfo.current_version} to v${updateInfo.latest_version} (click to install)`
                    : 'Settings'
              }
              delay={200}
            >
              <button
                onClick={handleSettingsOrUpdate}
                disabled={isUpdating}
                className={`settings-gear-btn p-1.5 rounded transition-colors duration-200 ${
                  updateInfo
                    ? 'text-[#84ff57] hover:bg-[#84ff57]/10'
                    : 'text-textSecondary hover:text-textPrimary'
                }`}
              >
                {updateInfo ? (
                  <RotateCw size={16} className={isUpdating ? 'animate-spin' : 'update-icon-pulse'} />
                ) : (
                  <Settings size={16} />
                )}
              </button>
            </Tooltip>

            {isUpdating && updateInfo && (
              <div className="drops-preview-card-right">
                <div className="flex items-center mb-2">
                  <span className="text-xs font-semibold text-textPrimary">Updating StreamNook</span>
                </div>

                <div className="flex items-center gap-2 text-xs mb-3">
                  <span className="text-textMuted">v{updateInfo.current_version}</span>
                  <span className="text-textMuted">→</span>
                  <span className="text-[#84ff57] font-medium">v{updateInfo.latest_version}</span>
                </div>

                <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${getUpdateStageProgress(updateProgress)}%`,
                      backgroundColor: '#84ff57',
                    }}
                  />
                </div>
                <p className="text-[10px] text-textMuted mt-1.5 truncate">
                  {updateProgress ?? 'Starting update...'}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* Lists Button */}
          <Tooltip content="Lists" delay={200}>
            <button
              onClick={() => setShowListsPanel(!showListsPanel)}
              className={`p-1.5 rounded transition-all duration-200 ${
                showListsPanel ? 'text-accent' : 'text-textSecondary hover:text-textPrimary'
              }`}
            >
              <ClipboardList size={16} />
            </button>
          </Tooltip>

          {/* Whispers Button */}
          <Tooltip content="Whispers" delay={200}>
            <button
              onClick={() => setShowWhispersOverlay(true)}
              className="relative p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              <MessageCircle size={16} />
              {/* Import indicator */}
              {whisperImportState.isImporting && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
              )}
            </button>
          </Tooltip>

          {/* Profile Button */}
          <Tooltip content={isAuthenticated ? 'Profile' : 'Sign in'} delay={200}>
            <button
              onClick={() => openSettings('Profile')}
              className="p-1 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              {isAuthenticated && currentUser?.profile_image_url ? (
                <img
                  src={currentUser.profile_image_url}
                  alt="Profile"
                  className="w-5 h-5 rounded-full object-cover"
                />
              ) : (
                <User size={20} />
              )}
            </button>
          </Tooltip>

          {/* Compact View Button - only show when stream is playing */}
          {streamUrl && (
            <Tooltip content={isTheaterMode ? 'Exit Compact View' : `Compact View (${getSelectedCompactViewPreset(settings?.compact_view?.selectedPresetId, settings?.compact_view?.customPresets).name})`} delay={200}>
              <button
                onClick={toggleTheaterMode}
                className={`p-1.5 !rounded transition-all duration-200 ${isTheaterMode ? 'text-accent glass-input shadow-[0_0_10px_rgba(var(--color-accent-rgb),0.3)]' : 'text-textSecondary hover:text-textPrimary'
                  }`}
              >
                <Proportions size={16} />
              </button>
            </Tooltip>
          )}


          <Tooltip content="Minimize" delay={200}>
            <button
              onClick={handleMinimize}
              className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              <Minus size={16} />
            </button>
          </Tooltip>
          <Tooltip content={isMaximized ? "Restore" : "Maximize"} delay={200}>
            <button
              onClick={handleMaximize}
              className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              {isMaximized ? (
                <CornersIn size={16} />
              ) : (
                <CornersOut size={16} />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Close" delay={200}>
            <button
              onClick={handleClose}
              className="p-1.5 text-textSecondary hover:text-red-400 rounded transition-all duration-200"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* About Widget */}
      {showAbout && <AboutWidget onClose={() => setShowAbout(false)} />}
    </>
  );
};

export default TitleBar;
