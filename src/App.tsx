import { useEffect, useState, useRef } from 'react';
import { useAppStore } from './stores/AppStore';
import TitleBar from './components/TitleBar';
import VideoPlayer from './components/VideoPlayer';
import ChatWidget from './components/ChatWidget';
import LiveOverlay from './components/LiveOverlay';
import SettingsDialog from './components/SettingsDialog';
import LoadingWidget from './components/LoadingWidget';
import ToastManager from './components/ToastManager';
import LiveStreamsOverlay from './components/LiveStreamsOverlay';
import ProfileOverlay from './components/ProfileOverlay';
import DropsOverlay from './components/DropsOverlay';
import BadgesOverlay from './components/BadgesOverlay';
import BadgeDetailOverlay from './components/BadgeDetailOverlay';
import ChangelogOverlay from './components/ChangelogOverlay';
import WhispersWidget from './components/WhispersWidget';
import SetupWizard from './components/SetupWizard';
import Sidebar from './components/Sidebar';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getThemeById, applyTheme, DEFAULT_THEME_ID } from './themes';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
  set_id?: string;
}

function App() {
  const { loadSettings, chatPlacement, isLoading, currentStream, streamUrl, checkAuthStatus, showProfileOverlay, setShowProfileOverlay, addToast, setShowDropsOverlay, showBadgesOverlay, setShowBadgesOverlay, showWhispersOverlay, setShowWhispersOverlay, settings, updateSettings, isTheaterMode } = useAppStore();
  const [chatSize, setChatSize] = useState(384); // Default 384px (w-96)
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedBadge, setSelectedBadge] = useState<{ badge: BadgeVersion; setId: string } | null>(null);
  const [savedWindowSize, setSavedWindowSize] = useState<{ width: number; height: number } | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogVersion, setChangelogVersion] = useState<string | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // Refs for aspect ratio lock to avoid stale closures
  const aspectRatioLockEnabledRef = useRef(false);
  const chatSizeRef = useRef(384);
  const chatPlacementRef = useRef(chatPlacement);
  const isTheaterModeRef = useRef(false);
  const streamUrlRef = useRef<string | null>(null);
  const isAdjustingRef = useRef(false);

  // Listen for badge detail events from chat
  useEffect(() => {
    const handleBadgeDetail = (event: CustomEvent) => {
      const { badge, setId } = event.detail;
      setSelectedBadge({ badge, setId });
    };

    window.addEventListener('show-badge-detail', handleBadgeDetail as EventListener);

    return () => {
      window.removeEventListener('show-badge-detail', handleBadgeDetail as EventListener);
    };
  }, []);

  useEffect(() => {
    const initializeApp = async () => {
      await loadSettings();
      await checkAuthStatus();

      // Pre-fetch cosmetics for current user
      const { currentUser, isAuthenticated } = useAppStore.getState();
      if (isAuthenticated && currentUser?.user_id) {
        console.log('[App] Pre-fetching cosmetics for current user...');
        const { prefetchAllUserData } = await import('./services/cosmeticsCache');
        prefetchAllUserData(currentUser.user_id).catch(err =>
          console.error('[App] Failed to pre-fetch user cosmetics:', err)
        );
      }

      // Set up event listeners for drops and channel points
      const unlistenChannelPoints = await listen('channel-points-claimed', (event: any) => {
        const claim = event.payload;
        addToast(`Claimed ${claim.points_earned} channel points!`, 'success');
      });

      // Listen for drops farming errors and report them to Discord via logService
      const unlistenDropsError = await listen('drops-error', (event: any) => {
        const { category, message } = event.payload;
        // Log as error - this will be picked up by logService and sent to Discord
        console.error(`[${category}] ${message}`);
      });

      // Listen for start-whisper events from standalone profile windows
      const unlistenStartWhisper = await listen<{ id: string; login: string; display_name: string; profile_image_url?: string }>('start-whisper', (event) => {
        console.log('[App] Received start-whisper event:', event.payload);
        useAppStore.getState().openWhisperWithUser(event.payload);
      });

      // Set up periodic auth check to detect session expiry while watching
      // Check every 5 minutes
      const authCheckInterval = setInterval(async () => {
        const { isAuthenticated: wasAuthenticated, currentStream } = useAppStore.getState();

        // Only check if we were authenticated and are currently watching a stream
        if (wasAuthenticated && currentStream) {
          console.log('[App] Performing periodic auth check...');
          await checkAuthStatus();
        }
      }, 5 * 60 * 1000); // 5 minutes

      // Cleanup listeners on unmount
      return () => {
        unlistenChannelPoints();
        unlistenDropsError();
        unlistenStartWhisper();
        clearInterval(authCheckInterval);
      };
    };

    initializeApp();
  }, [loadSettings, checkAuthStatus]);

  // Apply theme when settings are loaded or theme changes
  useEffect(() => {
    const themeId = settings.theme || DEFAULT_THEME_ID;
    const theme = getThemeById(themeId);
    if (theme) {
      console.log('[App] Applying theme:', theme.name);
      applyTheme(theme);
    }
  }, [settings.theme]);

  // Check if we need to show the first-time setup wizard
  useEffect(() => {
    const checkForFirstTimeSetup = async () => {
      // Skip if settings haven't loaded yet
      if (settings.streamlink_path === undefined) return;

      // Skip if setup is already complete
      if (settings.setup_complete) {
        console.log('[App] Setup already complete, skipping wizard');
        return;
      }

      try {
        // Check if streamlink is installed at the configured path
        const isInstalled = await invoke('verify_streamlink_installation', {
          path: settings.streamlink_path
        }) as boolean;

        if (!isInstalled) {
          console.log('[App] Streamlink not found at', settings.streamlink_path, '- showing setup wizard');
          setShowSetupWizard(true);
        } else {
          // Streamlink is installed, mark setup as complete for existing users
          console.log('[App] Streamlink found, marking setup as complete for existing user');
          await updateSettings({ ...settings, setup_complete: true });
        }
      } catch (error) {
        console.error('[App] Failed to check streamlink installation:', error);
        // On error, still show setup wizard to be safe
        setShowSetupWizard(true);
      }
    };

    checkForFirstTimeSetup();
  }, [settings.streamlink_path, settings.setup_complete, updateSettings]);

  // Check if we need to show the changelog after an update
  useEffect(() => {
    const checkForVersionChange = async () => {
      try {
        // Get the current app version
        const currentVersion = await invoke<string>('get_current_app_version');
        const { settings } = useAppStore.getState();
        const lastSeenVersion = settings.last_seen_version;

        console.log('[App] Version check - Current:', currentVersion, 'Last seen:', lastSeenVersion);

        // If there's no last seen version (first run) or the version has changed
        if (lastSeenVersion && lastSeenVersion !== currentVersion) {
          console.log('[App] Version changed, showing changelog');
          setChangelogVersion(currentVersion);
          setShowChangelog(true);
        } else if (!lastSeenVersion) {
          // First run - just update the last seen version without showing changelog
          console.log('[App] First run, setting initial version');
          updateSettings({ ...settings, last_seen_version: currentVersion });
        }
      } catch (error) {
        console.error('[App] Failed to check version:', error);
      }
    };

    // Only run after settings are loaded
    if (settings.streamlink_path !== undefined) {
      checkForVersionChange();
    }
  }, [settings.streamlink_path, updateSettings]);

  // Handle changelog close - update the last seen version
  const handleChangelogClose = async () => {
    setShowChangelog(false);

    if (changelogVersion) {
      try {
        const { settings } = useAppStore.getState();
        await updateSettings({ ...settings, last_seen_version: changelogVersion });
        console.log('[App] Updated last_seen_version to:', changelogVersion);
      } catch (error) {
        console.error('[App] Failed to update last_seen_version:', error);
      }
    }
  };

  // Handle theater mode - resize window to 16:9 (1920x1080)
  useEffect(() => {
    const handleTheaterMode = async () => {
      if (!streamUrl) return; // Only apply when a stream is playing

      try {
        const window = getCurrentWindow();

        if (isTheaterMode) {
          // Entering theater mode - save current size and resize to 16:9
          const currentSize = await window.innerSize();
          setSavedWindowSize({ width: currentSize.width, height: currentSize.height });

          // Title bar height is approximately 32px
          const titleBarHeight = 32;
          const targetWidth = 1080;
          // Calculate 16:9 height: 1080 / 16 * 9 = 607.5, rounded to 608
          const targetHeight = Math.round(targetWidth / 16 * 9) + titleBarHeight;

          console.log('Entering theater mode - resizing to:', targetWidth, 'x', targetHeight);
          await window.setSize(new LogicalSize(targetWidth, targetHeight));
        } else if (savedWindowSize) {
          // Exiting theater mode - restore previous size
          console.log('Exiting theater mode - restoring to:', savedWindowSize.width, 'x', savedWindowSize.height);
          await window.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
          setSavedWindowSize(null);
        }
      } catch (error) {
        console.error('Failed to resize window for theater mode:', error);
      }
    };

    handleTheaterMode();
  }, [isTheaterMode, streamUrl, savedWindowSize]);

  // Keep refs in sync with current values for use in resize listener
  useEffect(() => {
    aspectRatioLockEnabledRef.current = settings.video_player?.lock_aspect_ratio ?? false;
  }, [settings.video_player?.lock_aspect_ratio]);

  useEffect(() => {
    chatSizeRef.current = chatSize;
  }, [chatSize]);

  useEffect(() => {
    chatPlacementRef.current = chatPlacement;
  }, [chatPlacement]);

  useEffect(() => {
    isTheaterModeRef.current = isTheaterMode;
  }, [isTheaterMode]);

  useEffect(() => {
    streamUrlRef.current = streamUrl;
  }, [streamUrl]);

  // Handle aspect ratio locking when setting changes or chat is resized
  useEffect(() => {
    const adjustWindowForAspectRatio = async () => {
      // Use refs for values that might be stale in closures
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentChatSize = chatSizeRef.current;
      const currentChatPlacement = chatPlacementRef.current;
      const theaterMode = isTheaterModeRef.current;
      const currentStreamUrl = streamUrlRef.current;

      // Don't adjust if in theater mode - theater mode handles its own sizing
      if (theaterMode || !lockEnabled || !currentStreamUrl) return;

      // Prevent re-entrant calls
      if (isAdjustingRef.current) return;
      isAdjustingRef.current = true;

      try {
        const window = getCurrentWindow();

        // Don't adjust if window is maximized
        const isMaximized = await window.isMaximized();
        if (isMaximized) {
          console.log('Window is maximized, skipping aspect ratio adjustment');
          isAdjustingRef.current = false;
          return;
        }

        // Get current window size using Tauri's API
        const size = await window.innerSize();
        const width = size.width;
        const height = size.height;

        console.log('[AspectRatio] Current window size:', width, height);
        console.log('[AspectRatio] Chat size:', currentChatSize);
        console.log('[AspectRatio] Chat placement:', currentChatPlacement);

        // Title bar height is approximately 32px
        const titleBarHeight = 32;

        const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size', {
          currentWidth: width,
          currentHeight: height,
          chatSize: currentChatSize,
          chatPlacement: currentChatPlacement,
          titleBarHeight: titleBarHeight,
        });

        console.log('[AspectRatio] Calculated new size:', newWidth, newHeight);

        // Only resize if dimensions changed significantly (more than 5px difference)
        if (Math.abs(width - newWidth) > 5 || Math.abs(height - newHeight) > 5) {
          console.log('[AspectRatio] Resizing window to:', newWidth, newHeight);
          await window.setSize(new LogicalSize(newWidth, newHeight));
        } else {
          console.log('[AspectRatio] Size difference too small, not resizing');
        }
      } catch (error) {
        console.error('Failed to adjust window for aspect ratio:', error);
      } finally {
        isAdjustingRef.current = false;
      }
    };

    // Initial adjustment when settings change
    adjustWindowForAspectRatio();
  }, [settings.video_player?.lock_aspect_ratio, chatSize, chatPlacement, streamUrl, isTheaterMode]);

  // Separate effect for the resize listener - only set up once and use refs
  useEffect(() => {
    let resizeUnlisten: (() => void) | null = null;
    let debounceTimeout: NodeJS.Timeout | null = null;

    const adjustWindowForAspectRatio = async () => {
      // Use refs for current values
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentChatSize = chatSizeRef.current;
      const currentChatPlacement = chatPlacementRef.current;
      const theaterMode = isTheaterModeRef.current;
      const currentStreamUrl = streamUrlRef.current;

      if (theaterMode || !lockEnabled || !currentStreamUrl) return;
      if (isAdjustingRef.current) return;
      isAdjustingRef.current = true;

      try {
        const window = getCurrentWindow();

        const isMaximized = await window.isMaximized();
        if (isMaximized) {
          isAdjustingRef.current = false;
          return;
        }

        const size = await window.innerSize();
        const width = size.width;
        const height = size.height;

        const titleBarHeight = 32;

        const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size', {
          currentWidth: width,
          currentHeight: height,
          chatSize: currentChatSize,
          chatPlacement: currentChatPlacement,
          titleBarHeight: titleBarHeight,
        });

        if (Math.abs(width - newWidth) > 5 || Math.abs(height - newHeight) > 5) {
          console.log('[AspectRatio] Resize event - adjusting to:', newWidth, newHeight);
          await window.setSize(new LogicalSize(newWidth, newHeight));
        }
      } catch (error) {
        console.error('Failed to adjust window for aspect ratio:', error);
      } finally {
        isAdjustingRef.current = false;
      }
    };

    const setupResizeListener = async () => {
      const window = getCurrentWindow();
      resizeUnlisten = await window.onResized(async () => {
        // Debounce resize events
        if (debounceTimeout) {
          clearTimeout(debounceTimeout);
        }
        debounceTimeout = setTimeout(async () => {
          // Check refs for current state
          if (aspectRatioLockEnabledRef.current && !isTheaterModeRef.current && streamUrlRef.current) {
            await adjustWindowForAspectRatio();
          }
        }, 100);
      });
    };

    setupResizeListener();

    return () => {
      if (resizeUnlisten) {
        resizeUnlisten();
      }
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
    };
  }, []); // Empty deps - set up once and use refs for current values

  useEffect(() => {
    const checkUpdates = async () => {

      // Check for updates on startup (only once per component type)
      let streamlinkUpdateShown = false;
      let ttvlolUpdateShown = false;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const settings = useAppStore.getState().settings;

        // Check Streamlink updates
        if (settings.streamlink_path && !streamlinkUpdateShown) {
          const isInstalled = await invoke('verify_streamlink_installation', {
            path: settings.streamlink_path
          }) as boolean;

          if (isInstalled) {
            const installedVersion = await invoke('get_installed_streamlink_version', {
              path: settings.streamlink_path
            }) as string | null;

            if (installedVersion) {
              const latestVersion = await invoke('get_latest_streamlink_version') as string;

              if (installedVersion !== latestVersion) {
                streamlinkUpdateShown = true;
                const { addToast, openSettings } = useAppStore.getState();
                addToast(
                  `Streamlink update available! Current: ${installedVersion} → Latest: ${latestVersion}`,
                  'info',
                  {
                    label: 'Open Settings',
                    onClick: () => openSettings()
                  }
                );
              }
            }
          }
        }

        // Check TTV LOL plugin updates (if enabled)
        if (settings.ttvlol_plugin?.enabled && !ttvlolUpdateShown) {
          const installedVersion = await invoke('get_installed_ttvlol_version') as string | null;

          if (installedVersion) {
            const latestVersion = await invoke('get_latest_ttvlol_version') as string;

            if (installedVersion !== latestVersion) {
              ttvlolUpdateShown = true;
              const { addToast, openSettings } = useAppStore.getState();
              addToast(
                `TTV LOL plugin update available! Current: ${installedVersion} → Latest: ${latestVersion}`,
                'info',
                {
                  label: 'Open Settings',
                  onClick: () => openSettings()
                }
              );
            }
          }
        }
      } catch (error) {
        console.error('Failed to check for updates:', error);
      }
    };
    checkUpdates();
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return;

      const container = containerRef.current;
      const containerRect = container.getBoundingClientRect();

      if (chatPlacement === 'right') {
        // Calculate new width from the right edge
        const newWidth = containerRect.right - e.clientX;
        // Clamp between 250px and container width minus 200px (to leave space for video)
        const maxWidth = containerRect.width - 200;
        const clampedWidth = Math.max(250, Math.min(maxWidth, newWidth));
        setChatSize(clampedWidth);
      } else if (chatPlacement === 'bottom') {
        // Calculate new height from the bottom edge
        const newHeight = containerRect.bottom - e.clientY;
        // Clamp between 150px and container height minus 150px (to leave space for video)
        const maxHeight = containerRect.height - 150;
        const clampedHeight = Math.max(150, Math.min(maxHeight, newHeight));
        setChatSize(clampedHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      // Prevent text selection while dragging
      document.body.style.userSelect = 'none';
      document.body.style.cursor = chatPlacement === 'right' ? 'ew-resize' : 'ns-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing, chatPlacement]);

  return (
    <div className="flex flex-col h-screen bg-background backdrop-blur-md">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - only visible when stream is playing */}
        <Sidebar />

        {/* Main content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!streamUrl && !isLoading ? (
            // Show live overlay when no stream is playing
            <LiveOverlay />
          ) : isLoading && !streamUrl ? (
            // Show loading widget when starting a stream from no stream state
            <div className="flex-1 relative overflow-hidden bg-black">
              <LoadingWidget useFunnyMessages={true} />
            </div>
          ) : (
            // Show video player and chat when stream is playing
            <div
              ref={containerRef}
              className={`flex flex-1 overflow-hidden ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'}`}
            >
              <div className="flex-1 relative overflow-hidden">
                <VideoPlayer key={streamUrl} />
                {isLoading && <LoadingWidget useFunnyMessages={true} />}
              </div>
              {chatPlacement !== 'hidden' && (
                <>
                  {/* Resizable Separator */}
                  <div
                    onMouseDown={handleMouseDown}
                    className={`
                      ${chatPlacement === 'right' ? 'w-1 cursor-ew-resize hover:w-1.5' : 'h-1 cursor-ns-resize hover:h-1.5'}
                      bg-borderLight hover:bg-accent transition-all flex-shrink-0 z-10
                      ${isResizing ? (chatPlacement === 'right' ? 'w-1.5 bg-accent' : 'h-1.5 bg-accent') : ''}
                    `}
                    title={chatPlacement === 'right' ? 'Drag to resize chat width' : 'Drag to resize chat height'}
                  />
                  {/* Chat Widget */}
                  <div
                    className="flex-shrink-0 overflow-hidden"
                    style={{
                      [chatPlacement === 'right' ? 'width' : 'height']: `${chatSize}px`
                    }}
                  >
                    <ChatWidget />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <SettingsDialog />
      <LiveStreamsOverlay />
      <DropsOverlay />
      <ProfileOverlay
        isOpen={showProfileOverlay}
        onClose={() => setShowProfileOverlay(false)}
        anchorPosition={{ x: window.innerWidth, y: 32 }}
      />
      {showBadgesOverlay && !selectedBadge && (
        <BadgesOverlay
          onClose={() => setShowBadgesOverlay(false)}
          onBadgeClick={(badge, setId) => setSelectedBadge({ badge, setId })}
        />
      )}
      {selectedBadge && (
        <BadgeDetailOverlay
          badge={selectedBadge.badge}
          setId={selectedBadge.setId}
          onClose={() => {
            setSelectedBadge(null);
            setShowBadgesOverlay(false);
          }}
          onBack={() => setSelectedBadge(null)}
        />
      )}
      {showChangelog && changelogVersion && (
        <ChangelogOverlay
          version={changelogVersion}
          onClose={handleChangelogClose}
        />
      )}
      <WhispersWidget
        isOpen={showWhispersOverlay}
        onClose={() => setShowWhispersOverlay(false)}
      />
      <SetupWizard
        isOpen={showSetupWizard}
        onClose={() => setShowSetupWizard(false)}
      />
      <ToastManager />
    </div>
  );
}

export default App;
