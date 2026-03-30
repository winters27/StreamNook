import { useEffect, useState, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from './stores/AppStore';
import { useContextMenuStore } from './stores/contextMenuStore';
import { trackPresence, isSupabaseConfigured, incrementStat } from './services/supabaseService';
import TitleBar from './components/TitleBar';
import VideoPlayer from './components/VideoPlayer';
import ChatWidget from './components/ChatWidget';
import Home from './components/Home';
import SettingsDialog from './components/SettingsDialog';
import { usemultiNookStore } from './stores/multiNookStore';
import { MultiNookView } from './components/multi-nook/MultiNookView';
import MultiNookChatSwitcher from './components/multi-nook/MultiNookChatSwitcher';
import LoadingWidget from './components/LoadingWidget';
import ToastManager from './components/ToastManager';
import { TooltipManager } from './components/ui/TooltipManager';
import { Tooltip } from './components/ui/Tooltip';
import ProfileModal from './components/ProfileModal';
import { SearchProfileModal } from './components/SearchProfileModal';
import DropsOverlay from './components/DropsOverlay';
import BadgesOverlay from './components/BadgesOverlay';
import BadgeDetailOverlay from './components/BadgeDetailOverlay';
import ChangelogOverlay from './components/ChangelogOverlay';
import WhispersWidget from './components/WhispersWidget';
import SetupWizard from './components/SetupWizard';
import StreamlinkMissingDialog from './components/StreamlinkMissingDialog';
import Sidebar from './components/Sidebar';
import ErrorBoundary from './components/ErrorBoundary';
import { StreamContextMenu } from './components/StreamContextMenu';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { getThemeById, applyTheme, DEFAULT_THEME_ID, getThemeByIdWithCustom } from './themes';
import { getSelectedCompactViewPreset } from './constants/compactViewPresets';

import { Logger } from './utils/logger';
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
  const { loadSettings, chatPlacement, isLoading, currentStream, streamUrl, checkAuthStatus, showProfileOverlay, setShowProfileOverlay, addToast, setShowDropsOverlay, showBadgesOverlay, setShowBadgesOverlay, badgesOverlayInitialPaintId, badgesOverlayInitialBadgeId, showWhispersOverlay, setShowWhispersOverlay, settings, updateSettings, isTheaterMode, isHomeActive, toggleHome, stopStream, loadActiveDropsCache, profileModalUser, setProfileModalUser } = useAppStore();

  const [chatSize, setChatSize] = useState(chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH);
  const { isMultiNookActive, isChatHidden, slots } = usemultiNookStore();
  const visibleSlotsLength = slots.filter((s) => !s.isMinimized).length;
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
  const isMultiNookActiveRef = useRef(false);
  const multiNookSlotsLengthRef = useRef(0);
  const isAdjustingRef = useRef(false);

  // Handle placement changes - preserve video dimensions when moving chat around
  useEffect(() => {
    const handlePlacementChange = async () => {
      if (prevChatPlacementRef.current === chatPlacement) return;

      const oldPlacement = prevChatPlacementRef.current;
      const oldChatSize = prevChatSizeRef.current;

      Logger.debug('[ChatSize] Placement changed from', oldPlacement, 'to', chatPlacement);

      // Set appropriate default based on new placement
      const newSize = chatPlacement === 'bottom' ? DEFAULT_CHAT_HEIGHT : DEFAULT_CHAT_WIDTH;
      Logger.debug('[ChatSize] Setting chat size to', newSize);
      setChatSize(newSize);
      chatSizeRef.current = newSize;

      // Only resize window if aspect ratio lock is enabled and stream is playing
      // IMPORTANT: Use the reactive isTheaterMode value, not the ref, to avoid stale state
      // when entering/exiting theater mode (where chat placement changes simultaneously)
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentStreamUrl = streamUrlRef.current;
      const currentIsMultiNookActive = isMultiNookActiveRef.current;

      // Skip if in theater mode - compact view handles its own sizing
      if (isTheaterMode) {
        Logger.debug('[ChatSize] Skipping resize - theater/compact mode is active');
        prevChatPlacementRef.current = chatPlacement;
        prevChatSizeRef.current = newSize;
        return;
      }

      if (lockEnabled && (currentStreamUrl || currentIsMultiNookActive)) {
        try {
          const window = getCurrentWindow();

          // Don't adjust if window is maximized
          const isMaximized = await window.isMaximized();
          if (isMaximized) {
            Logger.debug('[ChatSize] Window is maximized, skipping resize');
            prevChatPlacementRef.current = chatPlacement;
            prevChatSizeRef.current = newSize;
            return;
          }

          const size = await window.innerSize();
          const titleBarHeight = 33;

          Logger.debug('[ChatSize] Calculating window size to preserve video dimensions');
          Logger.debug('[ChatSize] Old layout:', oldPlacement, 'with chat size', oldChatSize);
          Logger.debug('[ChatSize] New layout:', chatPlacement, 'with chat size', newSize);

          let targetAspectRatio = 16.0 / 9.0;
          
          // Dynamically measure sidebar instead of hardcoding
          let uiWidthOffset = 64;
          const sidebarEl = document.querySelector('.border-r.border-borderSubtle.flex-shrink-0');
          if (sidebarEl) {
            uiWidthOffset = sidebarEl.getBoundingClientRect().width;
          }
          let uiHeightOffset = 0;

          // Account for the chat resize separator
          if (chatPlacement === 'right') uiWidthOffset += 4;
          if (chatPlacement === 'bottom') uiHeightOffset += 4;

          if (currentIsMultiNookActive) {
            const len = multiNookSlotsLengthRef.current;
            uiWidthOffset += 16; // 8px padding on L/R
            uiHeightOffset += 16; // 8px padding on T/B

            // Add inner gaps (8px each) based on grid matrix
            if (len === 2) { targetAspectRatio = 16.0 / 18.0; uiHeightOffset += 8; }
            else if (len >= 3 && len <= 4) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 8; uiHeightOffset += 8; }
            else if (len >= 5 && len <= 6) { targetAspectRatio = 48.0 / 18.0; uiWidthOffset += 16; uiHeightOffset += 8; }
            else if (len >= 7 && len <= 9) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 16; uiHeightOffset += 16; }
            else if (len >= 10 && len <= 12) { targetAspectRatio = 64.0 / 27.0; uiWidthOffset += 24; uiHeightOffset += 16; }
            else if (len >= 13 && len <= 16) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 24; uiHeightOffset += 24; }
            else if (len >= 17 && len <= 20) { targetAspectRatio = 80.0 / 36.0; uiWidthOffset += 32; uiHeightOffset += 24; }
            else { uiWidthOffset += 32; uiHeightOffset += 32; }
          }

          const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size_preserve_video', {
            currentWidth: size.width,
            currentHeight: size.height,
            oldChatSize: oldChatSize,
            newChatSize: newSize,
            oldChatPlacement: oldPlacement,
            newChatPlacement: chatPlacement,
            titleBarHeight: titleBarHeight,
            targetAspectRatio: targetAspectRatio,
            uiWidthOffset: uiWidthOffset,
            uiHeightOffset: uiHeightOffset,
          });

          Logger.debug('[ChatSize] New window size to preserve video:', newWidth, newHeight);

          if (Math.abs(size.width - newWidth) > 5 || Math.abs(size.height - newHeight) > 5) {
            await window.setSize(new LogicalSize(newWidth, newHeight));
          }
        } catch (error) {
          Logger.error('[ChatSize] Failed to resize window:', error);
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

  // Global Context Menu Blocker (exempting inputs)
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('input, textarea, [contenteditable]');
        
        if (isInput) {
            e.preventDefault();
            useContextMenuStore.getState().openInputMenu(e, target as HTMLElement);
            return;
        }

        const selection = window.getSelection();
        if (selection && selection.toString().trim().length > 0) {
            e.preventDefault();
            useContextMenuStore.getState().openSelectionMenu(e);
            return;
        }

        e.preventDefault();
    };
    
    // Global Keydown Blocker for Developer Tools (F12, Ctrl+Shift+I, Cmd+Option+I)
    // Disabled automatically in development environment
    const handleKeyDown = (e: KeyboardEvent) => {
        if (import.meta.env.DEV) return;

        if (e.key === 'F12') {
            e.preventDefault();
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
            e.preventDefault();
        }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
        document.removeEventListener('contextmenu', handleContextMenu);
        document.removeEventListener('keydown', handleKeyDown);
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
          Logger.warn('[App] Failed to get app version for presence:', e);
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

      // Auto-optimize proxy routing on every launch
      // Ensures proxy is enabled, runs health check, and applies fastest proxy
      import('./services/proxyAutoOptimizer').then(({ runProxyOptimization }) => {
        runProxyOptimization();
      });

      // Pre-fetch cosmetics for current user
      const { currentUser, isAuthenticated } = useAppStore.getState();
      if (isAuthenticated && currentUser?.user_id) {
        Logger.debug('[App] Pre-fetching cosmetics for current user...');
        const { getCosmeticsWithFallback, getThirdPartyBadgesWithFallback } = await import('./services/cosmeticsCache');
        Promise.all([
          getCosmeticsWithFallback(currentUser.user_id),
          getThirdPartyBadgesWithFallback(currentUser.user_id)
        ]).catch((err: Error) =>
          Logger.error('[App] Failed to pre-fetch user cosmetics:', err)
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
        Logger.error(`[${category}] ${message}`);
      });

      // Listen for start-whisper events from standalone profile windows
      const unlistenStartWhisper = await listen<{ id: string; login: string; display_name: string; profile_image_url?: string }>('start-whisper', (event) => {
        Logger.debug('[App] Received start-whisper event:', event.payload);
        useAppStore.getState().openWhisperWithUser(event.payload);
      });

      // Listen for refresh-following-list events (triggered by follow/unfollow automation)
      const unlistenRefreshFollowing = await listen('refresh-following-list', () => {
        Logger.debug('[App] Received refresh-following-list event, refreshing...');
        useAppStore.getState().loadFollowedStreams();
      });

      // Listen for mining status updates (for title bar gift box animation)
      const unlistenMiningStatus = await listen<{ is_mining: boolean }>('mining-status-update', (event) => {
        Logger.debug('[App] Mining status update:', event.payload.is_mining);
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
            Logger.debug('[App] Whisper import completed:', conversations, 'conversations,', messages, 'messages');
            setWhisperImportState({
              isImporting: false,
              result: { conversations, messages },
              error: null
            });
            addToast(`Imported ${messages.toLocaleString()} whisper messages from ${conversations} conversations`, 'success');
          } else {
            Logger.error('[App] Whisper import failed:', message);
            setWhisperImportState({
              isImporting: false,
              error: message
            });
            addToast(`Whisper import failed: ${message}`, 'error');
          }
        }
      );

      // Listen for reserved stream going offline (watch token allocation feature)
      const unlistenReservedOffline = await listen('reserved-stream-offline', () => {
        Logger.debug('[App] Reserved stream went offline, clearing reservation');
        addToast('Reserved stream went offline - token returned to rotation', 'info');
      });

      // Listen for streamnook:// deep links (e.g. from Magne's "Watch Stream" button)
      let unlistenDeepLink: (() => void) | null = null;
      try {
        const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
        unlistenDeepLink = await onOpenUrl((urls: string[]) => {
          for (const url of urls) {
            Logger.debug('[App] Deep link received:', url);
            // Parse streamnook://watch/{channel}
            const match = url.match(/^streamnook:\/\/watch\/(.+)$/i);
            if (match) {
              const channel = match[1].replace(/\/$/, ''); // strip trailing slash
              Logger.info(`[App] Deep link: opening stream for ${channel}`);
              const { startStream } = useAppStore.getState();
              startStream(channel);
              // Bring window to front
              getCurrentWindow().setFocus().catch(() => {});
            }
          }
        });
      } catch (e) {
        Logger.warn('[App] Deep link plugin not available:', e);
      }

      // Set up periodic auth check to detect session expiry while watching
      // Check every 5 minutes
      const authCheckInterval = setInterval(async () => {
        const { isAuthenticated: wasAuthenticated, currentStream } = useAppStore.getState();

        // Only check if we were authenticated and are currently watching a stream
        if (wasAuthenticated && currentStream) {
          Logger.debug('[App] Performing periodic auth check...');
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
        unlistenReservedOffline();
        if (unlistenDeepLink) unlistenDeepLink();
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
      Logger.debug('[App] Applying theme:', theme.name);
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
        Logger.debug('[App] Setup already complete, skipping wizard');
        return;
      }

      try {
        // Check if streamlink is installed at the configured path
        const isInstalled = await invoke('verify_streamlink_installation', {
          path: settings.streamlink_path
        }) as boolean;

        if (!isInstalled) {
          Logger.debug('[App] Streamlink not found at', settings.streamlink_path, '- showing setup wizard');
          setShowSetupWizard(true);
        } else {
          // Streamlink is installed, mark setup as complete for existing users
          Logger.debug('[App] Streamlink found, marking setup as complete for existing user');
          await updateSettings({ ...settings, setup_complete: true });
        }
      } catch (error) {
        Logger.error('[App] Failed to check streamlink installation:', error);
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

        Logger.debug('[App] Version check - Current:', currentVersion, 'Last seen:', lastSeenVersion);

        // One-time force re-login for v4.9.1 webview features
        // This only triggers once per user, ever, and only if they're currently logged in
        const hasCompletedWebviewMigration = localStorage.getItem(WEBVIEW_RELOGIN_MIGRATION_KEY);
        if (!hasCompletedWebviewMigration && isAuthenticated) {
          Logger.debug('[App] One-time force re-login for webview features (v4.9.1)');

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
          Logger.debug('[App] One-time force re-login for v2.2.0 update');

          // Mark migration as complete BEFORE logout so it only happens once
          localStorage.setItem(V220_RELOGIN_MIGRATION_KEY, 'true');

          // Log the user out (clears app tokens)
          await logoutFromTwitch();

          // Also clear WebView2 browsing data (cookies, cache) so Twitch session is fully cleared
          try {
            await invoke('clear_webview_data');
            Logger.debug('[App] WebView2 data cleared successfully');
          } catch (e) {
            Logger.warn('[App] Failed to clear WebView2 data:', e);
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
          Logger.debug('[App] Version changed, showing changelog');
          setChangelogVersion(currentVersion);
          setShowChangelog(true);
        } else if (!lastSeenVersion) {
          // First run - just update the last seen version without showing changelog
          Logger.debug('[App] First run, setting initial version');
          updateSettings({ ...settings, last_seen_version: currentVersion });
        }
      } catch (error) {
        Logger.error('[App] Failed to check version:', error);
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
        Logger.debug('[App] Updated last_seen_version to:', changelogVersion);
      } catch (error) {
        Logger.error('[App] Failed to update last_seen_version:', error);
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

          // Title bar height is approximately 33px, window borders are 1px each side
          const titleBarHeight = 33;
          const windowBorderWidth = 2; // 1px border on each side
          // Subtract borders so total window width matches the preset exactly
          const targetWidth = preset.width - windowBorderWidth;
          // Recalculate height to maintain 16:9 aspect ratio based on adjusted width
          const videoHeight = Math.round(targetWidth / 16 * 9);
          const targetHeight = videoHeight + titleBarHeight;

          Logger.debug(`Entering compact view - resizing to: ${targetWidth}x${targetHeight} (${preset.name}, video: ${targetWidth}x${videoHeight})`);
          await window.setSize(new LogicalSize(targetWidth, targetHeight));
        } else if (savedWindowSize) {
          // Exiting theater mode - restore previous size
          Logger.debug('Exiting compact view - restoring to:', savedWindowSize.width, 'x', savedWindowSize.height);
          await window.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
          setSavedWindowSize(null);
          // Clear from localStorage
          localStorage.removeItem('streamnook-compact-saved-size');
        }
      } catch (error) {
        Logger.error('Failed to resize window for compact view:', error);
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
          Logger.debug('Restoring window size from previous session:', savedWindowSize.width, 'x', savedWindowSize.height);
          await window.setSize(new LogicalSize(savedWindowSize.width, savedWindowSize.height));
          setSavedWindowSize(null);
          localStorage.removeItem('streamnook-compact-saved-size');
        } catch (error) {
          Logger.error('Failed to restore window size:', error);
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

  useEffect(() => {
    isMultiNookActiveRef.current = isMultiNookActive;
  }, [isMultiNookActive]);

  useEffect(() => {
    multiNookSlotsLengthRef.current = visibleSlotsLength;
  }, [visibleSlotsLength]);

  // Track watch time and streams watched in Supabase
  useEffect(() => {
    if (!streamUrl || !isSupabaseConfigured()) return;

    const { currentUser, isAuthenticated } = useAppStore.getState();
    if (!isAuthenticated || !currentUser?.user_id) return;

    // Increment streams_watched when starting a new stream
    Logger.debug('[Stats] Stream started, incrementing streams_watched');
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
      const currentIsMultiNookActive = isMultiNookActiveRef.current;
      const multiNookCount = multiNookSlotsLengthRef.current;

      // Don't adjust if in theater mode - theater mode handles its own sizing
      if (theaterMode || !lockEnabled || (!currentStreamUrl && !currentIsMultiNookActive)) return;

      // Prevent re-entrant calls
      if (isAdjustingRef.current) return;
      isAdjustingRef.current = true;

      try {
        const window = getCurrentWindow();

        // Don't adjust if window is maximized
        const isMaximized = await window.isMaximized();
        if (isMaximized) {
          Logger.debug('Window is maximized, skipping aspect ratio adjustment');
          isAdjustingRef.current = false;
          return;
        }

        // Get current window size using Tauri's API
        const size = await window.innerSize();
        const width = size.width;
        const height = size.height;

        Logger.debug('[AspectRatio] Current window size:', width, height);
        Logger.debug('[AspectRatio] Chat size:', currentChatSize);
        Logger.debug('[AspectRatio] Chat placement:', currentChatPlacement);

        // Title bar height is approximately 33px
        const titleBarHeight = 33;

        let targetAspectRatio = 16.0 / 9.0;
        
        // Dynamically measure sidebar
        let uiWidthOffset = 64;
        const sidebarEl = document.querySelector('.border-r.border-borderSubtle.flex-shrink-0');
        if (sidebarEl) {
          uiWidthOffset = sidebarEl.getBoundingClientRect().width;
        }
        let uiHeightOffset = 0;

        // Account for the chat resize separator
        if (currentChatPlacement === 'right') uiWidthOffset += 4;
        if (currentChatPlacement === 'bottom') uiHeightOffset += 4;

        if (currentIsMultiNookActive) {
          const len = multiNookCount;
          uiWidthOffset += 16; // 8px padding on L/R
          uiHeightOffset += 16; // 8px padding on T/B

          if (len === 2) { targetAspectRatio = 16.0 / 18.0; uiHeightOffset += 8; }
          else if (len >= 3 && len <= 4) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 8; uiHeightOffset += 8; }
          else if (len >= 5 && len <= 6) { targetAspectRatio = 48.0 / 18.0; uiWidthOffset += 16; uiHeightOffset += 8; }
          else if (len >= 7 && len <= 9) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 16; uiHeightOffset += 16; }
          else if (len >= 10 && len <= 12) { targetAspectRatio = 64.0 / 27.0; uiWidthOffset += 24; uiHeightOffset += 16; }
          else if (len >= 13 && len <= 16) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 24; uiHeightOffset += 24; }
          else if (len >= 17 && len <= 20) { targetAspectRatio = 80.0 / 36.0; uiWidthOffset += 32; uiHeightOffset += 24; }
          else if (len > 20) { targetAspectRatio = 80.0 / 36.0; uiWidthOffset += 32; uiHeightOffset += 32; }
        }

        const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size', {
          currentWidth: width,
          currentHeight: height,
          chatSize: currentChatSize,
          chatPlacement: currentChatPlacement,
          titleBarHeight: titleBarHeight,
          targetAspectRatio: targetAspectRatio,
          uiWidthOffset: uiWidthOffset,
          uiHeightOffset: uiHeightOffset,
        });

        Logger.debug('[AspectRatio] Calculated new size:', newWidth, newHeight);

        // Only resize if dimensions changed significantly (more than 5px difference)
        if (Math.abs(width - newWidth) > 5 || Math.abs(height - newHeight) > 5) {
          Logger.debug('[AspectRatio] Resizing window to:', newWidth, newHeight);
          await window.setSize(new LogicalSize(newWidth, newHeight));
        } else {
          Logger.debug('[AspectRatio] Size difference too small, not resizing');
        }
      } catch (error) {
        Logger.error('Failed to adjust window for aspect ratio:', error);
      } finally {
        isAdjustingRef.current = false;
      }
    };

    // Initial adjustment when settings change
    adjustWindowForAspectRatio();
  }, [settings.video_player?.lock_aspect_ratio, chatSize, chatPlacement, streamUrl, isTheaterMode, isMultiNookActive, visibleSlotsLength]);

  // Separate effect for the resize listener - only set up once and use refs
  useEffect(() => {
    let debounceTimeout: NodeJS.Timeout | null = null;

    const adjustWindowForAspectRatio = async () => {
      // Use refs for current values
      const lockEnabled = aspectRatioLockEnabledRef.current;
      const currentChatSize = chatSizeRef.current;
      const currentChatPlacement = chatPlacementRef.current;
      const theaterMode = isTheaterModeRef.current;
      const currentStreamUrl = streamUrlRef.current;
      const currentIsMultiNookActive = isMultiNookActiveRef.current;
      const multiNookCount = multiNookSlotsLengthRef.current;

      if (theaterMode || !lockEnabled || (!currentStreamUrl && !currentIsMultiNookActive)) return;
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

        const titleBarHeight = 33;

        let targetAspectRatio = 16.0 / 9.0;
        // Dynamically measure sidebar
        let uiWidthOffset = 64;
        const sidebarEl = document.querySelector('.border-r.border-borderSubtle.flex-shrink-0');
        if (sidebarEl) {
          uiWidthOffset = sidebarEl.getBoundingClientRect().width;
        }
        let uiHeightOffset = 0;

        // Account for the chat resize separator
        if (currentChatPlacement === 'right') uiWidthOffset += 4;
        if (currentChatPlacement === 'bottom') uiHeightOffset += 4;

        if (currentIsMultiNookActive) {
          const len = multiNookCount;
          uiWidthOffset += 16; // 8px padding on L/R
          uiHeightOffset += 16; // 8px padding on T/B

          if (len === 2) { targetAspectRatio = 16.0 / 18.0; uiHeightOffset += 8; }
          else if (len >= 3 && len <= 4) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 8; uiHeightOffset += 8; }
          else if (len >= 5 && len <= 6) { targetAspectRatio = 48.0 / 18.0; uiWidthOffset += 16; uiHeightOffset += 8; }
          else if (len >= 7 && len <= 9) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 16; uiHeightOffset += 16; }
          else if (len >= 10 && len <= 12) { targetAspectRatio = 64.0 / 27.0; uiWidthOffset += 24; uiHeightOffset += 16; }
          else if (len >= 13 && len <= 16) { targetAspectRatio = 16.0 / 9.0; uiWidthOffset += 24; uiHeightOffset += 24; }
          else if (len >= 17 && len <= 20) { targetAspectRatio = 80.0 / 36.0; uiWidthOffset += 32; uiHeightOffset += 24; }
          else if (len > 20) { targetAspectRatio = 80.0 / 36.0; uiWidthOffset += 32; uiHeightOffset += 32; }
        }

        const [newWidth, newHeight] = await invoke<[number, number]>('calculate_aspect_ratio_size', {
          currentWidth: width,
          currentHeight: height,
          chatSize: currentChatSize,
          chatPlacement: currentChatPlacement,
          titleBarHeight: titleBarHeight,
          targetAspectRatio: targetAspectRatio,
          uiWidthOffset: uiWidthOffset,
          uiHeightOffset: uiHeightOffset,
        });

        if (Math.abs(width - newWidth) > 5 || Math.abs(height - newHeight) > 5) {
          Logger.debug('[AspectRatio] Resize event - adjusting to:', newWidth, newHeight);
          await window.setSize(new LogicalSize(newWidth, newHeight));
        }
      } catch (error) {
        Logger.error('Failed to adjust window for aspect ratio:', error);
      } finally {
        isAdjustingRef.current = false;
      }
    };

    let unlistenPromise: Promise<() => void> | null = null;
    const window = getCurrentWindow();
    
    unlistenPromise = window.onResized(async () => {
      // Debounce resize events
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(async () => {
        // Check refs for current state
        if (aspectRatioLockEnabledRef.current && !isTheaterModeRef.current && (streamUrlRef.current || isMultiNookActiveRef.current)) {
          await adjustWindowForAspectRatio();
        }
      }, 100);
    });

    return () => {
      if (unlistenPromise) {
        unlistenPromise.then(unlisten => {
          if (typeof unlisten === 'function') unlisten();
        });
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
              Logger.error('Auto-update failed:', e);
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
        Logger.error('Failed to check for bundle updates:', error);
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
          <AnimatePresence>
            {(isHomeActive || (!streamUrl && !isLoading && !isMultiNookActive)) && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="absolute inset-0 z-40 bg-background/85 backdrop-blur-2xl"
              >
                <Home />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading state when starting stream */}
          <AnimatePresence>
            {isLoading && !streamUrl && !isMultiNookActive && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="absolute inset-0 z-50 bg-black"
              >
                <LoadingWidget useFunnyMessages={true} showProxyNote={settings.ttvlol_plugin?.enabled ?? false} />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Stream/Chat View - kept mounted to preserve session */}
          <AnimatePresence>
            {(streamUrl || isMultiNookActive) && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                ref={containerRef}
                className={`flex flex-1 h-full ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'} ${isHomeActive ? 'pointer-events-none' : ''}`}
              >
                <div className="flex-1 relative overflow-hidden bg-background">
                  <AnimatePresence mode="wait">
                    {isMultiNookActive ? (
                      <motion.div 
                        key="multinook"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="w-full h-full absolute inset-0"
                      >
                        <MultiNookView />
                      </motion.div>
                    ) : (
                      <motion.div 
                        key="videoplayer"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="w-full h-full absolute inset-0"
                      >
                        <VideoPlayer key={streamUrl} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <AnimatePresence>
                    {isLoading && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute inset-0 z-20"
                      >
                        <LoadingWidget useFunnyMessages={true} showProxyNote={settings.ttvlol_plugin?.enabled ?? false} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                {/* Chat - kept mounted to prevent iframe reload stutter */}
                {chatPlacement !== 'hidden' && (
                  <motion.div
                    initial={{ opacity: 0, width: chatPlacement === 'right' ? 0 : undefined, height: chatPlacement === 'bottom' ? 0 : undefined }}
                    animate={{ 
                      opacity: (isMultiNookActive && isChatHidden) ? 0 : 1, 
                      width: chatPlacement === 'right' ? ((isMultiNookActive && isChatHidden) ? 0 : 'auto') : undefined, 
                      height: chatPlacement === 'bottom' ? ((isMultiNookActive && isChatHidden) ? 0 : 'auto') : undefined 
                    }}
                    transition={{ type: "spring", stiffness: 350, damping: 25 }}
                    className={`flex ${chatPlacement === 'bottom' ? 'flex-col' : 'flex-row'} flex-shrink-0`}
                    style={{ overflow: 'hidden' }}
                  >
                    {/* Resizable Separator */}
                    <Tooltip content={chatPlacement === 'right' ? 'Drag to resize chat width' : 'Drag to resize chat height'} delay={100}>
                      <div
                        onMouseDown={handleMouseDown}
                        className={`
                          ${chatPlacement === 'right' ? 'w-1 cursor-ew-resize' : 'h-1 cursor-ns-resize'}
                          bg-borderLight hover:bg-accent transition-colors flex-shrink-0 z-10
                          ${isResizing ? 'bg-accent' : ''}
                        `}
                      />
                    </Tooltip>
                    {/* Chat Widget */}
                    <div
                      className="flex-shrink-0 flex flex-col h-full overflow-hidden bg-background"
                      style={{
                        [chatPlacement === 'right' ? 'width' : 'height']: `${chatSize}px`
                      }}
                    >
                      {isMultiNookActive && <MultiNookChatSwitcher />}
                      <div className="flex-1 overflow-hidden relative">
                        <ChatWidget />
                      </div>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <SettingsDialog />
      <DropsOverlay />
      <ProfileModal
        isOpen={showProfileOverlay}
        onClose={() => setShowProfileOverlay(false)}
      />
      
      {profileModalUser && (
        <SearchProfileModal
          user={profileModalUser}
          onClose={() => setProfileModalUser(null)}
        />
      )}
      <AnimatePresence>
        {showBadgesOverlay && !selectedBadge && (
          <BadgesOverlay
            onClose={() => setShowBadgesOverlay(false)}
            onBadgeClick={(badge, setId) => setSelectedBadge({ badge, setId })}
            initialPaintId={badgesOverlayInitialPaintId}
            initialBadgeId={badgesOverlayInitialBadgeId}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
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
      </AnimatePresence>
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
      <TooltipManager />
      <StreamContextMenu />
    </div>
  );
}

export default App;

