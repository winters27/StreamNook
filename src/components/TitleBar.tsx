import { Window } from '@tauri-apps/api/window';
import { Gift, User, Settings, Proportions, MessageCircle, Pickaxe, Clock, Tv } from 'lucide-react';
import { Minus, X, CornersOut, CornersIn, Medal } from 'phosphor-react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../stores/AppStore';
import PenroseLogo from './PenroseLogo';
import AboutWidget from './AboutWidget';
import DynamicIsland from './DynamicIsland';
import ErrorBoundary from './ErrorBoundary';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getSelectedCompactViewPreset } from '../constants/compactViewPresets';
import type { MiningStatus, DropsSettings } from '../types';


import { Logger } from '../utils/logger';
import { Tooltip } from './ui/Tooltip';

const TitleBar = () => {
  const store = useAppStore();

  const { openSettings, setShowProfileOverlay, setShowDropsOverlay, setShowBadgesOverlay, setShowWhispersOverlay, showProfileOverlay, isAuthenticated, currentUser, isMiningActive, isTheaterMode, toggleTheaterMode, streamUrl, settings, whisperImportState } = store;
  const [showAbout, setShowAbout] = useState(false);
  const [, setShowSplash] = useState(false);
  const [dropsSettings, setDropsSettings] = useState<DropsSettings | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const prevMiningActive = useRef(isMiningActive);
  
  // Mining status state for progress badge and hover preview
  const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
  const [showDropsPreview, setShowDropsPreview] = useState(false);
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



  // Load drops settings
  useEffect(() => {
    const loadDropsSettings = async () => {
      try {
        const settings = await invoke<DropsSettings>('get_drops_settings');
        setDropsSettings(settings);
      } catch (err) {
        Logger.error('Failed to get drops settings:', err);
      }
    };

    loadDropsSettings();

    // Refresh settings periodically
    const interval = setInterval(loadDropsSettings, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load and subscribe to mining status updates for progress badge
  useEffect(() => {
    let unlistenStatus: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let isMounted = true;

    const loadMiningStatus = async () => {
      try {
        const status = await invoke<MiningStatus>('get_mining_status');
        setMiningStatus(status);
      } catch {
        // Silently fail - not critical for title bar
      }
    };

    const setupListeners = async () => {
      // Listen for mining status updates
      const uStatus = await listen<MiningStatus>('mining-status-update', (event) => {
        setMiningStatus(event.payload);
      });
      if (isMounted) unlistenStatus = uStatus;
      else uStatus();

      // Listen for progress updates (more frequent)
      const uProgress = await listen<{ drop_id: string; current_minutes: number; required_minutes: number; campaign_id?: string; drop_name?: string }>('drops-progress-update', (event) => {
        setMiningStatus((prev) => {
          if (!prev || !prev.is_mining) return prev;
          
          const dropId = event.payload.drop_id;
          const currentMinutes = event.payload.current_minutes;
          const requiredMinutes = event.payload.required_minutes;
          
          // Update current_drop if it matches
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
          
          // If current_drop doesn't exist or is different, update with new drop info
          return {
            ...prev,
            current_drop: {
              campaign_id: event.payload.campaign_id || prev.current_drop?.campaign_id || '',
              campaign_name: prev.current_drop?.campaign_name || prev.current_campaign || 'Campaign',
              drop_id: dropId,
              drop_name: event.payload.drop_name || prev.current_drop?.drop_name || 'Drop',
              required_minutes: requiredMinutes,
              current_minutes: currentMinutes,
              game_name: prev.current_channel?.game_name || prev.current_drop?.game_name || 'Game'
            }
          };
        });
      });
      if (isMounted) unlistenProgress = uProgress;
      else uProgress();
    };

    loadMiningStatus();
    setupListeners();

    // Poll periodically as backup
    const interval = setInterval(loadMiningStatus, 10000);

    return () => {
      isMounted = false;
      if (unlistenStatus) unlistenStatus();
      if (unlistenProgress) unlistenProgress();
      clearInterval(interval);
    };
  }, []);

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

  // Calculate progress percentage
  const progressPercent = useMemo(() => {
    if (!miningStatus?.is_mining || !miningStatus?.current_drop) return 0;
    const { current_minutes, required_minutes } = miningStatus.current_drop;
    if (required_minutes <= 0) return 0;
    return Math.min(100, Math.round((current_minutes / required_minutes) * 100));
  }, [miningStatus]);

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

  return (
    <>
      <div
        data-tauri-drag-region
        className="relative flex items-center justify-between h-[33px] px-3 select-none bg-secondary backdrop-blur-md border-b border-borderSubtle z-50"
      >
        {/* Dynamic Island - Centered in title bar */}
        <ErrorBoundary
          componentName="DynamicIsland"
          fallback={<div className="w-20 h-6" />}
        >
          <DynamicIsland />
        </ErrorBoundary>

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

            {/* Hover Preview Card - positioned to the right with top-left arrow */}
            {showDropsPreview && isMiningActive && miningStatus?.current_drop && (
              <div 
                className="drops-preview-card-right"
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
              </div>
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



          {/* Settings Button */}
          <Tooltip content="Settings" delay={200}>
            <button
              onClick={() => openSettings()}
              className="settings-gear-btn p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
            >
              <Settings size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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
          <Tooltip content={isAuthenticated ? 'Profile' : 'Login'} delay={200}>
            <button
              onClick={() => setShowProfileOverlay(!showProfileOverlay)}
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
