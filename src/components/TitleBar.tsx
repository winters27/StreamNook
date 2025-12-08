import { Window } from '@tauri-apps/api/window';
import { Home, Gift, User, Settings, Proportions, Palette, Check } from 'lucide-react';
import { Minus, X, CornersOut, CornersIn, Medal } from 'phosphor-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../stores/AppStore';
import PenroseLogo from './PenroseLogo';
import AboutWidget from './AboutWidget';
import DynamicIsland from './DynamicIsland';
import ErrorBoundary from './ErrorBoundary';
import { invoke } from '@tauri-apps/api/core';
import { themes, themeCategories, getThemeById, applyTheme, Theme } from '../themes';

const TitleBar = () => {
  const store = useAppStore();
  const { openSettings, setShowProfileOverlay, setShowDropsOverlay, setShowBadgesOverlay, showProfileOverlay, isAuthenticated, currentUser, isMiningActive, isTheaterMode, toggleTheaterMode, streamUrl, settings, updateSettings, isHomeActive, toggleHome } = store;
  const [showAbout, setShowAbout] = useState(false);
  const [showSplash, setShowSplash] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [dropsSettings, setDropsSettings] = useState<any>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const prevMiningActive = useRef(isMiningActive);
  const themePickerRef = useRef<HTMLDivElement>(null);

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

          {/* Drops Button */}
          <div className="relative">
            {(() => {
              const isChannelPointsMining = dropsSettings?.auto_claim_channel_points ?? false;
              const isBothActive = isMiningActive && isChannelPointsMining;

              // Determine gift box color/shimmer class
              // Silver = channel points only, Gold = drops only, Iridescent = both
              let giftClass = '';
              let title = 'Drops & Points';

              if (isBothActive) {
                giftClass = 'gift-shimmer-iridescent';
                title = 'Drops & Points (Both Active)';
              } else if (isMiningActive) {
                giftClass = 'gift-shimmer-gold';
                title = 'Drops & Points (Drops Mining Active)';
              } else if (isChannelPointsMining) {
                giftClass = 'gift-shimmer-silver';
                title = 'Drops & Points (Channel Points Active)';
              }

              const isAnyMiningActive = isMiningActive || isChannelPointsMining;

              return (
                <button
                  onClick={() => setShowDropsOverlay(true)}
                  className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded transition-all duration-200"
                  title={title}
                >
                  <Gift size={16} className={isAnyMiningActive ? giftClass : ''} />
                </button>
              );
            })()}
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
