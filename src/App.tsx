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
import { getThemeById, applyTheme, DEFAULT_THEME_ID, getThemeByIdWithCustom } from './themes';
import { getSelectedCompactViewPreset } from './constants/compactViewPresets';

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

// One-time migration flag for v4.9.1 webview features
// This key is set after the force re-login to ensure it only happens once
const WEBVIEW_RELOGIN_MIGRATION_KEY = 'streamnook-webview-relogin-v4.9.1';

// One-time migration flag for v2.2.0 - force re-login with full webview data clear
const V220_RELOGIN_MIGRATION_KEY = 'streamnook-relogin-v2.2.0';

// Default sizes for different placements (outside component to avoid recreating on each render)
const DEFAULT_CHAT_WIDTH = 384; // For 'right' placement
const DEFAULT_CHAT_HEIGHT = 200; // For 'bottom' placement

function App() {
  const { loadSettings, chatPlacement, isLoading, currentStream, streamUrl, checkAuthStatus, showProfileOverlay, setShowProfileOverlay, addToast, setShowDropsOverlay, showBadgesOverlay, setShowBadgesOverlay, showWhispersOverlay, setShowWhispersOverlay, settings, updateSettings, isTheaterMode, isHomeActive, toggleHome, stopStream, loadActiveDropsCache } = useAppStore();

  const [chatSize, setChatSize] = useState(chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedBadge, setSelectedBadge] = useState<{ badge: BadgeVersion; setId: string } | null>(null);
  
  // Persist savedWindowSize to localStorage so it survives app restarts
  const [savedWindowSize, setSavedWindowSize] = useState<{ width: number; height: number } | null>(() => {
    try {
      const stored = localStorage.getItem('streamnook-compact-saved-size');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  
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
      // IMPORTANT: Use the reactive isTheaterMode value, not the ref, to avoid stale state
      // when entering/exiting theater mode (where chat placement changes simultaneously)
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentStreamUrl = streamUrlRef.current;

      // Skip if in theater mode - compact view handles its own sizing
      if (isTheaterMode) {
        console.log('[ChatSize] Skipping resize - theater/compact mode is active');
        prevChatPlacementRef.current = chatPlacement;
        prevChatSizeRef.current = newSize;
        return;
      }

      if (lockEnabled && currentStreamUrl) {
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
  }, [chatPlacement, isTheaterMode]); // Added isTheaterMode to deps so the check is always current

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

      // Clean up orphaned localStorage from migrated services (one-time cleanup)
      // Badge polling service moved to Rust - remove old localStorage keys
      localStorage.removeItem('streamnook_known_badges');
      localStorage.removeItem('streamnook_notified_available_badges');

      // Load active drops cache on startup (cached for 1 hour)
      loadActiveDropsCache();

      // Auto-sync universal cache if stale (>24 hours since last sync)
      // This downloads the latest badge manifest from GitHub in the background
      import('./services/universalCacheService').then(({ autoSyncUniversalCacheIfStale }) => {
        autoSyncUniversalCacheIfStale();
      });

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

      // Listen for refresh-following-list events (triggered by follow/unfollow automation)
      const unlistenRefreshFollowing = await listen('refresh-following-list', () => {
        console.log('[App] Received refresh-following-list event, refreshing...');
        useAppStore.getState().loadFollowedStreams();
      });

      // Listen for mining status updates (for title bar gift box animation)
      const unlistenMiningStatus = await listen<{ is_mining: boolean }>('mining-status-update', (event) => {
        console.log('[App] Mining status update:', event.payload.is_mining);
        useAppStore.getState().setMiningActive(event.payload.is_mining);
      });

      // Listen for whisper import events (global listener so import works from any UI)
      const unlistenWhisperProgress = await listen<{ step: number; status: string; detail: string; current: number; total: number }>(
        'whisper-import-progress',
        (event) => {
          const { step, status, detail, current, total } = event.payload;
          const { setWhisperImportState } = useAppStore.getState();
          setWhisperImportState({
            progress: { step, status: status as any, detail, current, total }
          });

          // Track export progress for step 3
          if (step === 3 && status === 'running') {
            const match = detail.match(/Exporting: (.+)/);
            setWhisperImportState({
              exportProgress: { current, total, username: match ? match[1] : '' }
            });
          }

          // When step 2 completes, set the estimated end time
          if (step === 2 && status === 'complete') {
            const countMatch = detail.match(/Found (\d+) conversations/);
            if (countMatch) {
              const count = parseInt(countMatch[1], 10);
              const SECONDS_PER_CONVERSATION = 3;
              const estimatedSeconds = count * SECONDS_PER_CONVERSATION;
              const endTime = Date.now() + (estimatedSeconds * 1000);
              setWhisperImportState({
                totalConversations: count,
                estimatedEndTime: endTime
              });
            }
          }
        }
      );

      const unlistenWhisperComplete = await listen<{ success: boolean; message: string; conversations: number; messages: number }>(
        'whisper-import-complete',
        (event) => {
          const { success, message, conversations, messages } = event.payload;
          const { setWhisperImportState, addToast } = useAppStore.getState();
          if (success) {
            console.log('[App] Whisper import completed:', conversations, 'conversations,', messages, 'messages');
            setWhisperImportState({
              isImporting: false,
              result: { conversations, messages },
              error: null
            });
            addToast(`Imported ${messages.toLocaleString()} whisper messages from ${conversations} conversations`, 'success');
          } else {
            console.error('[App] Whisper import failed:', message);
            setWhisperImportState({
              isImporting: false,
              error: message
            });
            addToast(`Whisper import failed: ${message}`, 'error');
          }
        }
      );

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
        unlistenRefreshFollowing();
        unlistenMiningStatus();
        unlistenWhisperProgress();
        unlistenWhisperComplete();
        clearInterval(authCheckInterval);
      };
    };

    initializeApp();
  }, [loadSettings, checkAuthStatus]);

  // Apply theme when settings are loaded or theme changes
  useEffect(() => {
    const themeId = settings.theme || DEFAULT_THEME_ID;
    const customThemes = settings.custom_themes || [];
    const theme = getThemeByIdWithCustom(themeId, customThemes) || getThemeById(DEFAULT_THEME_ID);
    if (theme) {
      console.log('[App] Applying theme:', theme.name);
      applyTheme(theme);
    }
  }, [settings.theme, settings.custom_themes]);

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

  // Check if we need to show the changelog after an update (and force relogin if needed)
  useEffect(() => {
    const checkForVersionChange = async () => {
      try {
        // Get the current app version
        const currentVersion = await invoke<string>('get_current_app_version');
        const { settings, logoutFromTwitch, isAuthenticated } = useAppStore.getState();
        const lastSeenVersion = settings.last_seen_version;

        console.log('[App] Version check - Current:', currentVersion, 'Last seen:', lastSeenVersion);

        // One-time force re-login for v4.9.1 webview features
        // This only triggers once per user, ever, and only if they're currently logged in
        const hasCompletedWebviewMigration = localStorage.getItem(WEBVIEW_RELOGIN_MIGRATION_KEY);
        if (!hasCompletedWebviewMigration && isAuthenticated) {
          console.log('[App] One-time force re-login for webview features (v4.9.1)');

          // Mark migration as complete BEFORE logout so it only happens once
          localStorage.setItem(WEBVIEW_RELOGIN_MIGRATION_KEY, 'true');

          // Log the user out
          await logoutFromTwitch();

          // Show a toast explaining why
          addToast(
            'Please log in again to enable new features (whisper import, follow/unfollow)',
            'info'
          );

          // Update last seen version
          await updateSettings({ ...settings, last_seen_version: currentVersion });

          // Show the setup wizard so they can log back in
          setShowSetupWizard(true);
          return;
        }

        // Mark migration as complete for users who weren't logged in (no action needed)
        if (!hasCompletedWebviewMigration) {
          localStorage.setItem(WEBVIEW_RELOGIN_MIGRATION_KEY, 'true');
        }

        // One-time force re-login for v2.2.0 with full webview data clear
        // This ensures Twitch session cookies are fully cleared so user must re-login
        const hasCompletedV220Migration = localStorage.getItem(V220_RELOGIN_MIGRATION_KEY);
        if (!hasCompletedV220Migration && isAuthenticated) {
          console.log('[App] One-time force re-login for v2.2.0 update');

          // Mark migration as complete BEFORE logout so it only happens once
          localStorage.setItem(V220_RELOGIN_MIGRATION_KEY, 'true');

          // Log the user out (clears app tokens)
          await logoutFromTwitch();

          // Also clear WebView2 browsing data (cookies, cache) so Twitch session is fully cleared
          try {
            await invoke('clear_webview_data');
            console.log('[App] WebView2 data cleared successfully');
          } catch (e) {
            console.warn('[App] Failed to clear WebView2 data:', e);
          }

          // Show a toast explaining why
          addToast(
            'Please log in again to continue using StreamNook',
            'info'
          );

          // Update last seen version
          await updateSettings({ ...settings, last_seen_version: currentVersion });

          // Show the setup wizard so they can log back in
          setShowSetupWizard(true);
          return;
        }

        // Mark migration as complete for users who weren't logged in (no action needed)
        if (!hasCompletedV220Migration) {
          localStorage.setItem(V220_RELOGIN_MIGRATION_KEY, 'true');
        }

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
  }, [settings.streamlink_path, updateSettings, addToast]);

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

  // Handle theater mode - resize window to user's selected compact view preset
  useEffect(() => {
    const handleTheaterMode = async () => {
      if (!streamUrl) return; // Only apply when a stream is playing

      try {
        const window = getCurrentWindow();

        if (isTheaterMode) {
          // Entering theater mode - save current size and resize to selected preset
          if (!savedWindowSize) {
            const currentSize = await window.innerSize();
            const sizeToSave = { width: currentSize.width, height: currentSize.height };
            setSavedWindowSize(sizeToSave);
            // Persist to localStorage so it survives app restart
            localStorage.setItem('streamnook-compact-saved-size', JSON.stringify(sizeToSave));
          }

          // Get the selected compact view preset
          const preset = getSelectedCompactViewPreset(
            settings.compact_view?.selectedPresetId,
            settings.compact_view?.customPresets
          );

          // Title bar height is approximately 32px, window borders are 1px each side
          const titleBarHeight = 32;
          const windowBorderWidth = 2; // 1px border on each side
          // Subtract borders so total window width matches the preset exactly
          const targetWidth = preset.width - windowBorderWidth;
          // Recalculate height to maintain 16:9 aspect ratio based on adjusted width
          const videoHeight = Math.round(targetWidth / 16 * 9);
          const targetHeight = videoHeight + titleBarHeight;

          console.log(`Entering compact view - resizing to: ${targetWidth}x${targetHeight} (${preset.name}, video: ${targetWidth}x${videoHeight})`);
          await window.setSize(new LogicalSize(targetWidth, targetHeight));
        } else if (savedWindowSize) {
          // Exiting theater mode - restore previous size
          console.log('Exiting compact view - restoring to:', savedWindowSize.width, 'x', savedWindowSize.height);
          await window.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
          setSavedWindowSize(null);
          // Clear from localStorage
          localStorage.removeItem('streamnook-compact-saved-size');
        }
      } catch (error) {
        console.error('Failed to resize window for compact view:', error);
      }
    };

    handleTheaterMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTheaterMode, streamUrl, settings.compact_view?.selectedPresetId]); // Re-run if preset changes while in compact view

  // On app startup, if we have a saved window size from a previous session where the app
  // closed while in compact view, restore it now (if not currently in theater mode)
  useEffect(() => {
    const restoreSavedWindowSize = async () => {
      // Only restore if we have a saved size AND we're not in theater mode
      if (savedWindowSize && !isTheaterMode) {
        try {
          const window = getCurrentWindow();
          console.log('Restoring window size from previous session:', savedWindowSize.width, 'x', savedWindowSize.height);
          await window.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
          setSavedWindowSize(null);
          localStorage.removeItem('streamnook-compact-saved-size');
        } catch (error) {
          console.error('Failed to restore window size:', error);
        }
      }
    };

    // Only run once on mount, with a small delay to ensure app is ready
    const timeout = setTimeout(restoreSavedWindowSize, 500);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only on mount

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
            <div className="absolute inset-0 z-10 bg-background/95 backdrop-blur-sm">
              <Home />
            </div>
          )}

          {/* Loading state when starting stream */}
          {isLoading && !streamUrl && (
            <div className="absolute inset-0 z-20 bg-black">
              <LoadingWidget useFunnyMessages={true} showProxyNote={settings.ttvlol_plugin?.enabled ?? false} />
            </div>
          )}

          {/* Stream/Chat View - blurred when Home is active but kept mounted to preserve session */}
          {streamUrl && (
            <div
              ref={containerRef}
              className={`flex flex-1 h-full ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'} ${isHomeActive ? 'absolute inset-0 z-0 blur-xl opacity-30 pointer-events-none' : ''}`}
            >
              <div className="flex-1 relative overflow-hidden">
                <div className="w-full h-full">
                  <VideoPlayer key={streamUrl} />
                </div>
                {isLoading && <LoadingWidget useFunnyMessages={true} showProxyNote={settings.ttvlol_plugin?.enabled ?? false} />}
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
