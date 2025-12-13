import { Window } from '@tauri-apps/api/window';
import { Home, Gift, User, Settings, Proportions, Palette, Check, MessageCircle, Pickaxe, Clock, Tv } from 'lucide-react';
import { Minus, X, CornersOut, CornersIn, Medal } from 'phosphor-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../stores/AppStore';
import PenroseLogo from './PenroseLogo';
import AboutWidget from './AboutWidget';
import DynamicIsland from './DynamicIsland';
import ErrorBoundary from './ErrorBoundary';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { themes, themeCategories, getThemeById, applyTheme, Theme } from '../themes';
import type { MiningStatus } from '../types';

const TitleBar = () => {
  const store = useAppStore();
  const { openSettings, setShowProfileOverlay, setShowDropsOverlay, setShowBadgesOverlay, setShowWhispersOverlay, showProfileOverlay, isAuthenticated, currentUser, isMiningActive, isTheaterMode, toggleTheaterMode, streamUrl, settings, updateSettings, isHomeActive, toggleHome, whisperImportState } = store;
  const [showAbout, setShowAbout] = useState(false);
  const [showSplash, setShowSplash] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [dropsSettings, setDropsSettings] = useState<any>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const prevMiningActive = useRef(isMiningActive);
  const themePickerRef = useRef<HTMLDivElement>(null);
  
  // Mining status state for progress badge and hover preview
  const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
  const [showDropsPreview, setShowDropsPreview] = useState(false);
  const dropsButtonRef = useRef<HTMLDivElement>(null);
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Safely get current theme with fallback
  const currentThemeId = settings?.theme || 'winters-glass';
  const currentTheme = useMemo(() => {
    try {
      return getThemeById(currentThemeId) || getThemeById('winters-glass') || themes[0];
    } catch (error) {
      console.error('[TitleBar] Error getting theme:', error);
      return themes[0]; // Return first theme as ultimate fallback
    }
  }, [currentThemeId]);

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

  // Close theme picker on click outside
  useEffect(() => {
    if (!showThemePicker) {
      console.log('Theme picker closed, removing listener');
      return;
    }

    console.log('Theme picker opened, will add listener in 100ms');

    const handleClickOutside = (event: MouseEvent) => {
      console.log('Click outside detected', event.target);
      if (themePickerRef.current && !themePickerRef.current.contains(event.target as Node)) {
        console.log('Closing theme picker via click outside');
        setShowThemePicker(false);
      }
    };

    // Add listener after a delay to ensure state has updated
    const timeoutId = setTimeout(() => {
      console.log('Adding mousedown listener');
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      console.log('Cleanup: removing listener and timeout');
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showThemePicker]);

  const handleThemeChange = (themeId: string) => {
    if (!settings) return;
    const theme = getThemeById(themeId);
    if (theme) {
      applyTheme(theme);
      updateSettings({ ...settings, theme: themeId });
    }
  };

  // Load drops settings
  useEffect(() => {
    const loadDropsSettings = async () => {
      try {
        const settings = await invoke<any>('get_drops_settings');
        setDropsSettings(settings);
      } catch (err) {
        console.error('Failed to get drops settings:', err);
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

    const loadMiningStatus = async () => {
      try {
        const status = await invoke<MiningStatus>('get_mining_status');
        setMiningStatus(status);
      } catch (err) {
        // Silently fail - not critical for title bar
      }
    };

    const setupListeners = async () => {
      // Listen for mining status updates
      unlistenStatus = await listen<MiningStatus>('mining-status-update', (event) => {
        setMiningStatus(event.payload);
      });

      // Listen for progress updates (more frequent)
      unlistenProgress = await listen<any>('drops-progress-update', (event) => {
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
    };

    loadMiningStatus();
    setupListeners();

    // Poll periodically as backup
    const interval = setInterval(loadMiningStatus, 10000);

    return () => {
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
      setShowSplash(true);
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
        className="relative flex items-center justify-between h-8 px-3 select-none bg-secondary backdrop-blur-md border-b border-borderSubtle z-50"
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

          {/* Home Button - only show when stream is playing */}
          {streamUrl && (
            <button
              onClick={toggleHome}
              className={`p-1.5 hover:bg-glass rounded transition-all duration-200 ${isHomeActive ? 'text-accent bg-glass' : 'text-textSecondary hover:text-textPrimary'}`}
              title={isHomeActive ? "Return to Stream" : "Home"}
            >
              <Home size={16} />
            </button>
          )}

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
                <button
                  onClick={() => setShowDropsOverlay(true)}
                  className={`p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200 ${showProgressBadge ? 'flex items-center gap-1' : ''}`}
                  title={title}
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

          {/* Badges Button */}
          <button
            onClick={() => setShowBadgesOverlay(true)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Global Badges"
          >
            <Medal size={16} />
          </button>

          {/* Theme Picker Button */}
          <div className="relative" ref={themePickerRef}>
            <button
              onClick={() => {
                console.log('Theme picker clicked, current state:', showThemePicker);
                setShowThemePicker(!showThemePicker);
              }}
              className={`p-1.5 hover:bg-glass rounded transition-all duration-200 ${showThemePicker ? 'text-accent bg-glass' : 'text-textSecondary hover:text-textPrimary'
                }`}
              title="Theme"
            >
              <Palette size={16} />
            </button>

            {/* Theme Picker Dropdown */}
            {showThemePicker && (
              <div
                className="absolute top-full left-0 mt-1 w-72 max-h-96 overflow-y-auto glass-panel rounded-lg shadow-xl border border-borderLight scrollbar-thin"
                style={{
                  zIndex: 9999,
                  backgroundColor: currentTheme.palette.background
                }}
              >
                <div className="p-2">
                  <div className="text-xs font-semibold text-textMuted uppercase tracking-wider px-2 py-1 mb-1">
                    Themes
                  </div>
                  {themeCategories.map((category) => {
                    const categoryThemes = themes.filter((t) => t.category === category.id);
                    if (categoryThemes.length === 0) return null;

                    return (
                      <div key={category.id} className="mb-2">
                        <div className="text-xs text-textMuted px-2 py-1">
                          {category.name}
                        </div>
                        {categoryThemes.map((theme) => (
                          <button
                            key={theme.id}
                            onClick={() => {
                              handleThemeChange(theme.id);
                            }}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${currentThemeId === theme.id
                              ? 'bg-accent/20 text-accent'
                              : 'text-textPrimary hover:bg-glass'
                              }`}
                          >
                            {/* Color dots */}
                            <div className="flex gap-0.5">
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: theme.palette.accent }}
                              />
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: theme.palette.highlight.purple }}
                              />
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: theme.palette.highlight.green }}
                              />
                            </div>
                            <span className="flex-1 truncate">{theme.name}</span>
                            {currentThemeId === theme.id && (
                              <Check size={14} className="text-accent" />
                            )}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Settings Button */}
          <button
            onClick={() => openSettings()}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Settings"
          >
            <Settings size={16} />
          </button>
        </div>

        <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {/* Whispers Button */}
          <button
            onClick={() => setShowWhispersOverlay(true)}
            className="relative p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Whispers"
          >
            <MessageCircle size={16} />
            {/* Import indicator */}
            {whisperImportState.isImporting && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
            )}
          </button>

          {/* Profile Button */}
          <button
            onClick={() => setShowProfileOverlay(!showProfileOverlay)}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title={isAuthenticated ? 'Profile' : 'Login'}
          >
            {isAuthenticated && currentUser?.profile_image_url ? (
              <img
                src={currentUser.profile_image_url}
                alt="Profile"
                className="w-4 h-4 rounded-full object-cover"
              />
            ) : (
              <User size={16} />
            )}
          </button>

          {/* Compact View Button - only show when stream is playing */}
          {streamUrl && (
            <button
              onClick={toggleTheaterMode}
              className={`p-1.5 hover:bg-glass rounded transition-all duration-200 ${isTheaterMode ? 'text-accent' : 'text-textSecondary hover:text-textPrimary'
                }`}
              title={isTheaterMode ? 'Exit Compact View' : 'Compact View (1080x608)'}
            >
              <Proportions size={16} />
            </button>
          )}
          <button
            onClick={handleMinimize}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title="Minimize"
          >
            <Minus size={16} />
          </button>
          <button
            onClick={handleMaximize}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <CornersIn size={16} />
            ) : (
              <CornersOut size={16} />
            )}
          </button>
          <button
            onClick={handleClose}
            className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-glass rounded transition-all duration-200"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* About Widget */}
      {showAbout && <AboutWidget onClose={() => setShowAbout(false)} />}
    </>
  );
};

export default TitleBar;
