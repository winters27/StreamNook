import { useEffect, useState, useRef } from 'react';
import { useAppStore } from './stores/AppStore';
import { trackPresence, isSupabaseConfigured, incrementStat } from './services/supabaseService';
import TitleBar from './components/TitleBar';
import VideoPlayer from './components/VideoPlayer';
import ChatWidget from './components/ChatWidget';
import Home from './components/Home';
import SettingsDialog from './components/SettingsDialog';
import LoadingWidget from './components/LoadingWidget';
import ToastManager from './components/ToastManager';
import ProfileOverlay from './components/ProfileOverlay';
import DropsOverlay from './components/DropsOverlay';
import BadgesOverlay from './components/BadgesOverlay';
import BadgeDetailOverlay from './components/BadgeDetailOverlay';
import ChangelogOverlay from './components/ChangelogOverlay';
import WhispersWidget from './components/WhispersWidget';
import SetupWizard from './components/SetupWizard';
import StreamlinkMissingDialog from './components/StreamlinkMissingDialog';
import Sidebar from './components/Sidebar';
import ErrorBoundary from './components/ErrorBoundary';
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

// Default sizes for different placements (outside component to avoid recreating on each render)
const DEFAULT_CHAT_WIDTH = 384; // For 'right' placement
const DEFAULT_CHAT_HEIGHT = 200; // For 'bottom' placement

function App() {
  const { loadSettings, chatPlacement, isLoading, currentStream, streamUrl, checkAuthStatus, showProfileOverlay, setShowProfileOverlay, addToast, setShowDropsOverlay, showBadgesOverlay, setShowBadgesOverlay, showWhispersOverlay, setShowWhispersOverlay, settings, updateSettings, isTheaterMode, isHomeActive, toggleHome, stopStream, loadActiveDropsCache } = useAppStore();

  const [chatSize, setChatSize] = useState(chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedBadge, setSelectedBadge] = useState<{ badge: BadgeVersion; setId: string } | null>(null);
  const [savedWindowSize, setSavedWindowSize] = useState<{ width: number; height: number } | null>(null);
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogVersion, setChangelogVersion] = useState<string | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // Track previous placement and chat size to detect changes
  const prevChatPlacementRef = useRef(chatPlacement);
  const prevChatSizeRef = useRef(chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH);

  // Refs for aspect ratio lock to avoid stale closures
  const aspectRatioLockEnabledRef = useRef(false);
  const chatSizeRef = useRef(chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH);
  const chatPlacementRef = useRef(chatPlacement);
  const isTheaterModeRef = useRef(false);
  const streamUrlRef = useRef<string | null>(null);
  const isAdjustingRef = useRef(false);

  // Handle placement changes - preserve video dimensions when moving chat around
  useEffect(() => {
    const handlePlacementChange = async () => {
      if (prevChatPlacementRef.current === chatPlacement) return;

      const oldPlacement = prevChatPlacementRef.current;
      const oldChatSize = prevChatSizeRef.current;

      console.log('[ChatSize] Placement changed from', oldPlacement, 'to', chatPlacement);

      // Set appropriate default based on new placement
      const newSize = chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH;
      console.log('[ChatSize] Setting chat size to', newSize);
      setChatSize(newSize);
      chatSizeRef.current = newSize;

      // Only resize window if aspect ratio lock is enabled and stream is playing
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentStreamUrl = streamUrlRef.current;
      const theaterMode = isTheaterModeRef.current;

      if (lockEnabled && currentStreamUrl && !theaterMode) {
        try {
          const window = getCurrentWindow();

          // Don't adjust if window is maximized
          const isMaximized = await window.isMaximized();
          if (isMaximized) {
            console.log('[ChatSize] Window is maximized, skipping resize');
            prevChatPlacementRef.current = chatPlacement;
            prevChatSizeRef.current = newSize;
            return;
          }

          const size = await window.innerSize();
          const titleBarHeight = 32;

          console.log('[ChatSize] Calculating window size to preserve video dimensions');
          console.log('[ChatSize] Old layout:', oldPlacement, 'with chat size', oldChatSize);
          console.log('[ChatSize] New layout:', chatPlacement, 'with chat size', newSize);

          const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size_preserve_video', {
            currentWidth: size.width,
            currentHeight: size.height,
            oldChatSize: oldChatSize,
            newChatSize: newSize,
            oldChatPlacement: oldPlacement,
            newChatPlacement: chatPlacement,
            titleBarHeight: titleBarHeight,
          });

          console.log('[ChatSize] New window size to preserve video:', newWidth, newHeight);

          if (Math.abs(size.width - newWidth) > 5 || Math.abs(size.height - newHeight) > 5) {
            await window.setSize(new LogicalSize(newWidth, newHeight));
          }
        } catch (error) {
          console.error('[ChatSize] Failed to resize window:', error);
        }
      }

      prevChatPlacementRef.current = chatPlacement;
      prevChatSizeRef.current = newSize;
    };

    handlePlacementChange();
  }, [chatPlacement]);

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

  // Track presence in Supabase
  useEffect(() => {
    let cleanupPresence: (() => void) | null = null;

    const initPresence = async () => {
      if (isSupabaseConfigured()) {
        const { currentUser, isAuthenticated } = useAppStore.getState();
        let appVersion;
        try {
          appVersion = await invoke<string>('get_current_app_version');
        } catch (e) {
          console.warn('[App] Failed to get app version for presence:', e);
        }

        if (isAuthenticated && currentUser) {
          cleanupPresence = await trackPresence(currentUser.user_id, currentUser.display_name, appVersion);
        } else {
          // Track anonymous presence
          cleanupPresence = await trackPresence(undefined, undefined, appVersion);
        }
      }
    };

    initPresence();

    return () => {
      if (cleanupPresence) {
        cleanupPresence();
      }
    };
  }, []);

  useEffect(() => {
    const initializeApp = async () => {
      await loadSettings();
      await checkAuthStatus();

      // Load active drops cache on startup (cached for 1 hour)
      loadActiveDropsCache();

      // Pre-fetch cosmetics for current user
      const { currentUser, isAuthenticated } = useAppStore.getState();
      if (isAuthenticated && currentUser?.user_id) {
        console.log('[App] Pre-fetching cosmetics for current user...');
        const { getCosmeticsWithFallback, getThirdPartyBadgesWithFallback } = await import('./services/cosmeticsCache');
        Promise.all([
          getCosmeticsWithFallback(currentUser.user_id),
          getThirdPartyBadgesWithFallback(currentUser.user_id)
        ]).catch((err: Error) =>
          console.error('[App] Failed to pre-fetch user cosmetics:', err)
        );
      }

      // Set up event listeners for drops and channel points
      const unlistenChannelPoints = await listen('channel-points-claimed', (event: any) => {
        const claim = event.payload;
        addToast(`Claimed ${claim.points_earned} channel points!`, 'success');

        // Track channel points in Supabase
        if (isSupabaseConfigured()) {
          const { currentUser, isAuthenticated } = useAppStore.getState();
          if (isAuthenticated && currentUser?.user_id) {
            incrementStat(currentUser.user_id, 'channel_points_farmed', claim.points_earned);
          }
        }
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
          if (!savedWindowSize) {
            const currentSize = await window.innerSize();
            setSavedWindowSize({ width: currentSize.width, height: currentSize.height });
          }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTheaterMode, streamUrl]); // Remove savedWindowSize from deps to avoid infinite loop

  // Keep refs in sync with current values for use in resize listener
  useEffect(() => {
    aspectRatioLockEnabledRef.current = settings.video_player?.lock_aspect_ratio ?? false;
  }, [settings.video_player?.lock_aspect_ratio]);

  useEffect(() => {
    chatSizeRef.current = chatSize;
    prevChatSizeRef.current = chatSize;
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

  // Track watch time and streams watched in Supabase
  useEffect(() => {
    if (!streamUrl || !isSupabaseConfigured()) return;

    const { currentUser, isAuthenticated } = useAppStore.getState();
    if (!isAuthenticated || !currentUser?.user_id) return;

    // Increment streams_watched when starting a new stream
    console.log('[Stats] Stream started, incrementing streams_watched');
    incrementStat(currentUser.user_id, 'streams_watched', 1);

    // Track watch time every minute
    const watchTimeInterval = setInterval(() => {
      const { isAuthenticated: stillAuth, currentUser: user } = useAppStore.getState();
      if (stillAuth && user?.user_id) {
        // Increment by 1/60 of an hour (1 minute)
        incrementStat(user.user_id, 'hours_watched', 1 / 60);
      }
    }, 60000); // Every minute

    return () => {
      clearInterval(watchTimeInterval);
    };
  }, [streamUrl]);

  // Auto-trigger native PIP when navigating to Home while stream is playing
  useEffect(() => {
    const triggerPip = async () => {
      // Only trigger when going TO home (isHomeActive becomes true) and stream is playing
      if (isHomeActive && streamUrl) {
        // Find the video element inside the video player container
        const videoElement = document.querySelector('.video-player-container video') as HTMLVideoElement;

        if (videoElement && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
          try {
            console.log('[PIP] Entering Picture-in-Picture mode');
            await videoElement.requestPictureInPicture();
          } catch (error) {
            console.warn('[PIP] Failed to enter Picture-in-Picture:', error);
            // PIP might fail due to browser restrictions, user gesture requirements, etc.
            // The stream will still play in the background, just not visible
          }
        }
      }
    };

    triggerPip();
  }, [isHomeActive, streamUrl]);

  // Exit PIP when returning from Home to stream view
  useEffect(() => {
    const exitPip = async () => {
      // Only exit when leaving home (isHomeActive becomes false) and we're in PIP
      if (!isHomeActive && document.pictureInPictureElement) {
        try {
          console.log('[PIP] Exiting Picture-in-Picture mode');
          await document.exitPictureInPicture();
        } catch (error) {
          console.warn('[PIP] Failed to exit Picture-in-Picture:', error);
        }
      }
    };

    exitPip();
  }, [isHomeActive]);

  // Listen for PIP exit (e.g., user clicks "back to tab" in PIP window) to return to stream view
  useEffect(() => {
    const handleLeavePip = () => {
      // If we're in Home view and PIP was exited (by user clicking back to tab), return to stream
      if (isHomeActive && streamUrl) {
        console.log('[PIP] User exited PIP via back to tab, returning to stream view');
        toggleHome();
      }
    };

    // Listen for the leavepictureinpicture event on all video elements
    const videoElement = document.querySelector('.video-player-container video') as HTMLVideoElement;
    if (videoElement) {
      videoElement.addEventListener('leavepictureinpicture', handleLeavePip);
    }

    return () => {
      if (videoElement) {
        videoElement.removeEventListener('leavepictureinpicture', handleLeavePip);
      }
    };
  }, [isHomeActive, streamUrl, toggleHome]);

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

  // Check for bundle updates on startup
  useEffect(() => {
    const checkUpdates = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');

        interface BundleUpdateStatus {
          update_available: boolean;
          current_version: string;
          latest_version: string;
        }

        const bundleStatus = await invoke('check_for_bundle_update') as BundleUpdateStatus;

        if (bundleStatus.update_available) {
          const { addToast, openSettings, settings: currentSettings } = useAppStore.getState();

          // Check if auto-update is enabled
          if (currentSettings.auto_update_on_start) {
            addToast(
              `Update available! v${bundleStatus.current_version} → v${bundleStatus.latest_version}. Auto-updating...`,
              'info'
            );
            // Auto-update will be triggered by the backend
            try {
              await invoke('download_and_install_bundle');
            } catch (e) {
              console.error('Auto-update failed:', e);
              addToast(`Auto-update failed: ${e}`, 'error');
            }
          } else {
            addToast(
              `StreamNook update available! v${bundleStatus.current_version} → v${bundleStatus.latest_version}`,
              'info',
              {
                label: 'Update',
                onClick: () => openSettings('Updates')
              }
            );
          }
        }
      } catch (error) {
        console.error('Failed to check for bundle updates:', error);
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
      <ErrorBoundary
        componentName="TitleBar"
        fallback={
          <div className="h-8 bg-secondary backdrop-blur-md border-b border-borderSubtle flex items-center justify-center">
            <span className="text-textSecondary text-xs">Title bar error - restart app</span>
          </div>
        }
      >
        <TitleBar />
      </ErrorBoundary>
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - only visible when stream is playing */}
        <Sidebar />

        {/* Main content area with Home/PIP support */}
        <div className="flex-1 relative overflow-hidden">
          {/* Home View - shown when isHomeActive or no stream */}
          {(isHomeActive || (!streamUrl && !isLoading)) && (
            <div className="absolute inset-0 z-10 bg-background">
              <Home />
            </div>
          )}

          {/* Loading state when starting stream */}
          {isLoading && !streamUrl && (
            <div className="absolute inset-0 z-20 bg-black">
              <LoadingWidget useFunnyMessages={true} />
            </div>
          )}

          {/* Stream/Chat View - hidden when Home is active but kept mounted to preserve session */}
          {streamUrl && (
            <div
              ref={containerRef}
              className={`flex flex-1 h-full ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'} ${isHomeActive ? 'invisible absolute inset-0 -z-10' : ''}`}
            >
              <div className="flex-1 relative overflow-hidden">
                <div className="w-full h-full">
                  <VideoPlayer key={streamUrl} />
                </div>
                {isLoading && <LoadingWidget useFunnyMessages={true} />}
              </div>
              {/* Chat - hidden when Home is active but kept mounted */}
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
      <StreamlinkMissingDialog />
      <ToastManager />
    </div>
  );
}

export default App;
