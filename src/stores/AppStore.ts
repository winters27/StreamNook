import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Settings, TwitchUser, TwitchStream, UserInfo } from '../types';
import { trackActivity, isStreamlinkError, sendStreamlinkDiagnostics } from '../services/logService';
import { upsertUser } from '../services/supabaseService';

export interface Toast {
  id: number;
  message: string | React.ReactNode;
  type: 'info' | 'success' | 'warning' | 'error' | 'live';
  action?: {
    label: string;
    onClick: () => void;
  };
  timeoutId?: ReturnType<typeof setTimeout>;
  duration: number;
  createdAt: number;
}

export type SettingsTab = 'Interface' | 'Player' | 'Chat' | 'Integrations' | 'Notifications' | 'Cache' | 'Support' | 'Updates' | 'Analytics';

interface AppState {
  settings: Settings;
  followedStreams: TwitchStream[];
  recommendedStreams: TwitchStream[];
  recommendedCursor: string | null;
  hasMoreRecommended: boolean;
  isLoadingMore: boolean;
  streamUrl: string | null;
  currentStream: TwitchStream | null;
  chatPlacement: string;
  isLoading: boolean;
  isSettingsOpen: boolean;
  settingsInitialTab: SettingsTab | null;
  showLiveStreamsOverlay: boolean;
  showProfileOverlay: boolean;
  showDropsOverlay: boolean;
  showBadgesOverlay: boolean;
  showWhispersOverlay: boolean;
  showDashboardOverlay: boolean;
  showStreamlinkMissing: boolean;
  pendingStreamChannel: string | null;
  pendingStreamInfo: TwitchStream | null;
  whisperTargetUser: { id: string; login: string; display_name: string; profile_image_url?: string } | null;
  isHomeActive: boolean;
  isAuthenticated: boolean;
  currentUser: TwitchUser | null;
  isMiningActive: boolean;
  isTheaterMode: boolean;
  originalChatPlacement: string | null;
  toasts: Toast[];
  isAutoSwitching: boolean;
  handleStreamOffline: () => Promise<void>;
  addToast: (message: string | React.ReactNode, type: 'info' | 'success' | 'warning' | 'error' | 'live', action?: { label: string; onClick: () => void }) => void;
  removeToast: (id: number) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (newSettings: Settings) => Promise<void>;
  loadFollowedStreams: () => Promise<void>;
  loadRecommendedStreams: () => Promise<void>;
  loadMoreRecommendedStreams: () => Promise<void>;
  startStream: (channel: string, streamInfo?: TwitchStream) => Promise<void>;
  stopStream: () => Promise<void>;
  getAvailableQualities: () => Promise<string[]>;
  changeStreamQuality: (quality: string) => Promise<void>;
  openSettings: (initialTab?: SettingsTab) => void;
  closeSettings: () => void;
  setShowLiveStreamsOverlay: (show: boolean) => void;
  setShowProfileOverlay: (show: boolean) => void;
  setShowDropsOverlay: (show: boolean) => void;
  setShowBadgesOverlay: (show: boolean) => void;
  setShowWhispersOverlay: (show: boolean) => void;
  setShowDashboardOverlay: (show: boolean) => void;
  openWhisperWithUser: (user: { id: string; login: string; display_name: string; profile_image_url?: string }) => void;
  clearWhisperTargetUser: () => void;
  toggleTheaterMode: () => void;
  loginToTwitch: () => Promise<void>;
  logoutFromTwitch: () => Promise<void>;
  checkAuthStatus: () => Promise<void>;
  toggleFavoriteStreamer: (userId: string) => Promise<void>;
  isFavoriteStreamer: (userId: string) => boolean;
  toggleHome: () => void;
}

// Flags to ensure we only show session toasts once per app session
let hasShownWelcomeBackToast = false;

// Helper to save user context to localStorage for error reporting
const saveUserContextToLocalStorage = (currentUser: TwitchUser | null, currentStream: TwitchStream | null) => {
  try {
    const context = {
      currentUser: currentUser ? {
        display_name: currentUser.display_name,
        login: currentUser.login,
        user_id: currentUser.user_id,
      } : null,
      currentStream: currentStream ? {
        user_name: currentStream.user_name,
        user_login: currentStream.user_login,
        game_name: currentStream.game_name,
        title: currentStream.title,
      } : null,
    };
    localStorage.setItem('streamnook-app-state', JSON.stringify(context));
  } catch {
    // Ignore localStorage errors
  }
};

export const useAppStore = create<AppState>((set, get) => ({
  settings: {} as Settings,
  followedStreams: [],
  recommendedStreams: [],
  recommendedCursor: null,
  hasMoreRecommended: true,
  isLoadingMore: false,
  streamUrl: null,
  currentStream: null,
  chatPlacement: 'right',
  isLoading: false,
  isSettingsOpen: false,
  settingsInitialTab: null,
  showLiveStreamsOverlay: false,
  showProfileOverlay: false,
  showDropsOverlay: false,
  showBadgesOverlay: false,
  showWhispersOverlay: false,
  showDashboardOverlay: false,
  showStreamlinkMissing: false,
  pendingStreamChannel: null,
  pendingStreamInfo: null,
  whisperTargetUser: null,
  isHomeActive: true,
  isAuthenticated: false,
  currentUser: null,
  isMiningActive: false,
  isTheaterMode: false,
  originalChatPlacement: null,
  toasts: [],
  isAutoSwitching: false,

  handleStreamOffline: async () => {
    const state = get();
    const { currentStream, settings, isAutoSwitching } = state;

    // Prevent multiple auto-switch attempts
    if (isAutoSwitching) {
      console.log('[AutoSwitch] Already in progress, skipping');
      return;
    }

    // Check if auto-switch is enabled
    const autoSwitchEnabled = settings.auto_switch?.enabled ?? true;
    if (!autoSwitchEnabled) {
      console.log('[AutoSwitch] Disabled in settings');
      return;
    }

    if (!currentStream) {
      console.log('[AutoSwitch] No current stream to switch from');
      return;
    }

    const gameName = currentStream.game_name;
    const currentUserLogin = currentStream.user_login;

    console.log(`[AutoSwitch] Stream ${currentUserLogin} appears offline, verifying...`);
    set({ isAutoSwitching: true });

    try {
      // Step 1: Verify the stream is actually offline via Twitch API
      // We'll check twice with a delay to be sure (streams can have brief interruptions)
      let isOffline = false;

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          // Wait 3 seconds before second check
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        const streamData = await invoke('check_stream_online', { userLogin: currentUserLogin }) as TwitchStream | null;

        if (streamData) {
          console.log(`[AutoSwitch] Stream is still online (attempt ${attempt + 1}), aborting auto-switch`);
          set({ isAutoSwitching: false });
          return;
        }

        console.log(`[AutoSwitch] Stream confirmed offline (attempt ${attempt + 1})`);
      }

      isOffline = true;

      if (!isOffline) {
        set({ isAutoSwitching: false });
        return;
      }

      console.log(`[AutoSwitch] Stream ${currentUserLogin} confirmed offline`);

      // Step 2: Clean up current stream connections thoroughly
      console.log('[AutoSwitch] Cleaning up current stream connections...');

      try {
        await invoke('stop_stream');
        console.log('[AutoSwitch] Stream stopped');
      } catch (e) {
        console.warn('[AutoSwitch] Error stopping stream:', e);
      }

      try {
        await invoke('stop_chat');
        console.log('[AutoSwitch] Chat stopped');
      } catch (e) {
        console.warn('[AutoSwitch] Error stopping chat:', e);
      }

      try {
        await invoke('stop_drops_monitoring');
        console.log('[AutoSwitch] Drops monitoring stopped');
      } catch (e) {
        console.warn('[AutoSwitch] Error stopping drops monitoring:', e);
      }

      // Clear current stream state
      set({ streamUrl: null, currentStream: null });

      // Step 3: Find the next best stream based on mode
      const switchMode = settings.auto_switch?.mode ?? 'same_category';
      let streams: TwitchStream[] = [];

      if (switchMode === 'same_category') {
        // Switch to same category - find streams in the same game
        if (!gameName) {
          console.log('[AutoSwitch] No game category for current stream');
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. Unable to find similar streams.`, 'info');
          }
          set({ isAutoSwitching: false });
          return;
        }

        console.log(`[AutoSwitch] Looking for streams in category: ${gameName}`);

        streams = await invoke('get_streams_by_game_name', {
          gameName: gameName,
          excludeUserLogin: currentUserLogin,
          limit: 10
        }) as TwitchStream[];

        if (!streams || streams.length === 0) {
          console.log('[AutoSwitch] No other streams found in this category');
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. No other ${gameName} streams available.`, 'info');
          }
          set({ isAutoSwitching: false });
          return;
        }
      } else if (switchMode === 'followed_streams') {
        // Switch to followed streams - get live followed streamers
        console.log('[AutoSwitch] Looking for live followed streams');

        try {
          // Load fresh followed streams data
          const followedStreams = await invoke('get_followed_streams') as TwitchStream[];

          // Filter out the current (now offline) streamer
          streams = followedStreams.filter(s => s.user_login.toLowerCase() !== currentUserLogin.toLowerCase());

          if (!streams || streams.length === 0) {
            console.log('[AutoSwitch] No other followed streams are live');
            if (settings.auto_switch?.show_notification ?? true) {
              state.addToast(`${currentUserLogin} went offline. No other followed streams are live.`, 'info');
            }
            set({ isAutoSwitching: false });
            return;
          }

          // Sort by viewer count (highest first) to pick the most popular one
          streams.sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));

        } catch (e) {
          console.error('[AutoSwitch] Error fetching followed streams:', e);
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. Unable to load followed streams.`, 'error');
          }
          set({ isAutoSwitching: false });
          return;
        }
      }

      // The first stream is the highest viewer count (already sorted by API)
      const nextStream = streams[0];

      console.log(`[AutoSwitch] Found next stream: ${nextStream.user_name} (${nextStream.viewer_count} viewers)`);

      // Step 4: Show notification if enabled
      if (settings.auto_switch?.show_notification ?? true) {
        state.addToast(
          `${currentUserLogin} went offline. Switching to ${nextStream.user_name}...`,
          'info'
        );
      }

      // Step 5: Start the new stream
      // Small delay to ensure clean transition
      await new Promise(resolve => setTimeout(resolve, 500));

      await state.startStream(nextStream.user_login, nextStream);

      console.log(`[AutoSwitch] Successfully switched to ${nextStream.user_name}`);

    } catch (e) {
      console.error('[AutoSwitch] Error during auto-switch:', e);
      state.addToast('Auto-switch failed. Please select a new stream manually.', 'error');
    } finally {
      set({ isAutoSwitching: false });
    }
  },

  addToast: (message, type, action) => {
    const id = Date.now() + Math.random();
    const createdAt = Date.now();
    // Live toasts get longer duration (8 seconds), others get 5 seconds
    const duration = type === 'live' ? 8000 : 5000;

    // For live toasts, let ToastItem handle the timer (so we can pause on hover)
    // For other toasts, use the simple auto-dismiss
    if (type === 'live') {
      set(state => ({
        toasts: [...state.toasts, { id, message, type, action, duration, createdAt }]
      }));
    } else {
      const timeoutId = setTimeout(() => {
        set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
      }, duration);

      set(state => ({
        toasts: [...state.toasts, { id, message, type, action, timeoutId, duration, createdAt }]
      }));
    }
  },
  removeToast: (id) => {
    set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }));
  },
  loadSettings: async () => {
    const settings = await invoke('load_settings') as Settings;
    // Ensure cache settings have defaults if not present
    if (!settings.cache) {
      settings.cache = { enabled: true, expiry_days: 7 };
    }
    // Ensure favorite_streamers has a default if not present
    if (!settings.favorite_streamers) {
      settings.favorite_streamers = [];
    }
    set({ settings, chatPlacement: settings.chat_placement });

    // Connect to Discord if enabled
    if (settings.discord_rpc_enabled) {
      try {
        await invoke('connect_discord');
      } catch (e) {
        console.warn('Could not connect to Discord:', e);
      }
    }
  },
  updateSettings: async (newSettings) => {
    const oldSettings = get().settings;

    // Only save if settings actually changed to prevent unnecessary saves
    const settingsChanged = JSON.stringify(oldSettings) !== JSON.stringify(newSettings);
    if (!settingsChanged) {
      return;
    }

    await invoke('save_settings', { settings: newSettings });
    set({ settings: newSettings, chatPlacement: newSettings.chat_placement });

    // Handle Discord enable/disable toggle
    if (newSettings.discord_rpc_enabled !== oldSettings.discord_rpc_enabled) {
      if (newSettings.discord_rpc_enabled) {
        // Connect to Discord
        try {
          await invoke('connect_discord');
        } catch (e) {
          console.warn('Could not connect to Discord:', e);
        }
      } else {
        // Disconnect from Discord
        try {
          await invoke('disconnect_discord');
        } catch (e) {
          console.warn('Could not disconnect from Discord:', e);
        }
      }
    }
  },
  loadFollowedStreams: async () => {
    try {
      const streams = await invoke('get_followed_streams') as TwitchStream[];
      set({ followedStreams: streams });
    } catch (e) {
      console.warn('Could not load followed streams:', e);
      // User is not authenticated, this is expected on first launch
      set({ followedStreams: [] });

      // Show toast if user tries to view followed streams but isn't logged in
      const state = get();
      if (!state.isAuthenticated && state.showLiveStreamsOverlay) {
        state.addToast('Please log in to Twitch to view your followed streams', 'warning');
      }
    }
  },
  loadRecommendedStreams: async () => {
    try {
      const result = await invoke('get_recommended_streams_paginated', {
        cursor: null,
        limit: 20
      }) as [TwitchStream[], string | null];

      const [streams, cursor] = result;

      // Filter out streams that are already in followed streams
      const followedIds = new Set(get().followedStreams.map(s => s.user_id));
      const filteredStreams = streams.filter(s => !followedIds.has(s.user_id));

      set({
        recommendedStreams: filteredStreams,
        recommendedCursor: cursor,
        hasMoreRecommended: cursor !== null
      });
    } catch (e) {
      console.warn('Could not load recommended streams:', e);
      set({ recommendedStreams: [], recommendedCursor: null, hasMoreRecommended: false });
    }
  },

  loadMoreRecommendedStreams: async () => {
    const { recommendedCursor, hasMoreRecommended, isLoadingMore, followedStreams, recommendedStreams } = get();

    if (!hasMoreRecommended || isLoadingMore || !recommendedCursor) {
      return;
    }

    set({ isLoadingMore: true });

    try {
      const result = await invoke('get_recommended_streams_paginated', {
        cursor: recommendedCursor,
        limit: 20
      }) as [TwitchStream[], string | null];

      const [newStreams, cursor] = result;

      // Filter out streams that are already in followed streams or already loaded
      const followedIds = new Set(followedStreams.map(s => s.user_id));
      const existingIds = new Set(recommendedStreams.map(s => s.user_id));
      const filteredStreams = newStreams.filter(
        s => !followedIds.has(s.user_id) && !existingIds.has(s.user_id)
      );

      set({
        recommendedStreams: [...recommendedStreams, ...filteredStreams],
        recommendedCursor: cursor,
        hasMoreRecommended: cursor !== null,
        isLoadingMore: false
      });
    } catch (e) {
      console.warn('Could not load more recommended streams:', e);
      set({ isLoadingMore: false, hasMoreRecommended: false });
    }
  },
  stopStream: async () => {
    trackActivity('Stopped stream');
    try {
      await invoke('stop_stream');
      await invoke('stop_chat');

      // Stop drops monitoring
      try {
        await invoke('stop_drops_monitoring');
        console.log('🛑 Stopped drops monitoring');
      } catch (e) {
        console.warn('Could not stop drops monitoring:', e);
      }

      set({ streamUrl: null, currentStream: null });

      // Update user context for error reporting (stream stopped)
      saveUserContextToLocalStorage(get().currentUser, null);

      // Set idle Discord presence when not watching
      if (get().settings.discord_rpc_enabled) {
        try {
          await invoke('set_idle_discord_presence');
        } catch (e) {
          console.warn('Could not set idle Discord presence:', e);
        }
      }
    } catch (e) {
      console.error('Failed to stop stream:', e);
    }
  },

  getAvailableQualities: async () => {
    const currentStream = get().currentStream;
    if (!currentStream) {
      return [];
    }

    try {
      const qualities = await invoke('get_stream_qualities', {
        url: `https://twitch.tv/${currentStream.user_login}`
      }) as string[];

      console.log('[Qualities] Available from Streamlink:', qualities);
      return qualities;
    } catch (e) {
      console.error('Failed to get stream qualities:', e);
      return [];
    }
  },

  changeStreamQuality: async (quality: string) => {
    const currentStream = get().currentStream;
    if (!currentStream) {
      console.warn('No active stream to change quality');
      return;
    }

    trackActivity(`Changed quality to: ${quality}`);
    try {
      console.log(`[Quality] Changing to: ${quality}`);
      set({ isLoading: true });

      const url = await invoke('change_stream_quality', {
        url: `https://twitch.tv/${currentStream.user_login}`,
        quality: quality
      }) as string;

      // Update settings to persist the quality choice
      const newSettings = { ...get().settings, quality: quality };
      await invoke('save_settings', { settings: newSettings });

      set({ streamUrl: url, settings: newSettings, isLoading: false });
      get().addToast(`Quality changed to ${quality}`, 'success');
      console.log('[Quality] Stream URL updated:', url);
      console.log('[Quality] Settings updated with new quality:', quality);
    } catch (e) {
      console.error('Failed to change quality:', e);
      get().addToast(`Failed to change quality: ${e}`, 'error');
      set({ isLoading: false });
    }
  },
  startStream: async (channel, providedStreamInfo?) => {
    set({ isLoading: true });
    trackActivity(`Started watching: ${channel}`);
    try {
      // Check if streamlink is available before trying to start the stream
      const isAvailable = await invoke('is_streamlink_available') as boolean;
      if (!isAvailable) {
        console.log('[Stream] Streamlink not found, showing missing dialog');
        // Save the pending stream so we can resume after user selects a path
        set({
          isLoading: false,
          showStreamlinkMissing: true,
          pendingStreamChannel: channel,
          pendingStreamInfo: providedStreamInfo || null
        });
        return;
      }

      const url = await invoke('start_stream', { url: `https://twitch.tv/${channel}`, quality: get().settings.quality }) as string;

      // Use the provided stream info, or find it from followed streams, or fetch it
      let info: TwitchStream;
      if (providedStreamInfo) {
        info = providedStreamInfo;
      } else {
        // Find the stream info from our followed streams list
        const followedStreamInfo = get().followedStreams.find(s => s.user_login === channel);
        if (followedStreamInfo) {
          info = followedStreamInfo;
        } else {
          // Fallback: try to get channel info (for manually entered channels)
          try {
            info = await invoke('get_channel_info', { channelName: channel }) as TwitchStream;
          } catch (e) {
            // If that fails too, create a minimal info object
            console.warn('Could not get channel info:', e);
            info = {
              id: '',
              user_id: '',
              user_name: channel,
              user_login: channel,
              title: `Watching ${channel}`,
              viewer_count: 0,
              game_name: '',
              thumbnail_url: '',
              started_at: new Date().toISOString(),
            };
          }
        }
      }

      set({ streamUrl: url, currentStream: info });

      // Save user context for error reporting
      saveUserContextToLocalStorage(get().currentUser, info);

      // Start chat first - only if authenticated
      try {
        await invoke('start_chat', { channel });
      } catch (e) {
        console.warn('Could not start chat:', e);
        // Chat connection failed, but stream can still work
      }

      // Start drops and channel points monitoring
      try {
        const channelId = info.user_id || '';
        const channelName = info.user_login || channel;

        if (channelId && channelName) {
          await invoke('start_drops_monitoring', {
            channelId,
            channelName
          });
          console.log('🎮 Started drops monitoring for', channelName);
        }
      } catch (e) {
        console.warn('Could not start drops monitoring:', e);
        // Non-critical, stream can still work
      }

      // Update Discord with game matching (don't await - let it run in background)
      if (get().settings.discord_rpc_enabled) {
        console.log('[Discord] Updating presence for stream:', {
          user: info.user_name,
          title: info.title,
          game: info.game_name,
          channel: channel
        });

        invoke('update_discord_presence', {
          details: `Watching ${info.user_name}`,
          activityState: info.title || 'Live on Twitch',
          largeImage: 'icon_256x256', // Fallback image
          smallImage: 'twitch_logo', // Twitch logo as small image
          startTime: Date.now(),
          gameName: info.game_name || '', // Pass game name for matching
          streamUrl: `https://twitch.tv/${channel}`,
        }).then(() => {
          console.log('[Discord] Presence updated successfully');
        }).catch((e) => {
          // Discord errors are non-critical - log as warning, don't show to user
          console.warn('[Discord] Could not update presence (Discord may not be running):', e);
        });
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      console.error('Failed to start stream:', errorMessage);

      // Check if this is a streamlink-related error and send diagnostics
      if (isStreamlinkError(errorMessage)) {
        console.log('[Stream] Streamlink error detected, sending diagnostics to Discord...');
        sendStreamlinkDiagnostics(errorMessage).catch(err => {
          console.warn('[Stream] Failed to send streamlink diagnostics:', err);
        });
      }

      // Show toast error to user
      get().addToast(`Failed to start stream: ${errorMessage}`, 'error');
    } finally {
      set({ isLoading: false });
    }
  },
  openSettings: (initialTab?: SettingsTab) => {
    trackActivity('Opened Settings' + (initialTab ? ` (${initialTab})` : ''));
    set({ isSettingsOpen: true, settingsInitialTab: initialTab || null });
  },
  closeSettings: () => {
    trackActivity('Closed Settings');
    set({ isSettingsOpen: false, settingsInitialTab: null });
  },
  setShowLiveStreamsOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Live Streams');
    set({ showLiveStreamsOverlay: show });
  },
  setShowProfileOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Profile');
    set({ showProfileOverlay: show });
  },
  setShowDropsOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Drops');
    set({ showDropsOverlay: show });
  },
  setShowBadgesOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Badges');
    set({ showBadgesOverlay: show });
  },
  setShowWhispersOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Whispers');
    set({ showWhispersOverlay: show });
    // Clear target user when closing
    if (!show) set({ whisperTargetUser: null });
  },
  setShowDashboardOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Dashboard');
    set({ showDashboardOverlay: show });
  },

  openWhisperWithUser: (user) => {
    trackActivity(`Opened Whisper with ${user.display_name}`);
    set({ whisperTargetUser: user, showWhispersOverlay: true });
  },

  clearWhisperTargetUser: () => {
    set({ whisperTargetUser: null });
  },

  toggleTheaterMode: () => {
    const state = get();
    const newTheaterMode = !state.isTheaterMode;
    trackActivity(newTheaterMode ? 'Enabled Theater Mode' : 'Disabled Theater Mode');

    if (newTheaterMode) {
      // Entering theater mode - save current chat placement and hide chat
      set({
        isTheaterMode: true,
        originalChatPlacement: state.chatPlacement,
        chatPlacement: 'hidden'
      });
    } else {
      // Exiting theater mode - restore original chat placement
      set({
        isTheaterMode: false,
        chatPlacement: state.originalChatPlacement || 'right'
      });
    }
  },

  loginToTwitch: async () => {
    trackActivity('Started Twitch login');
    try {
      set({ isLoading: true });
      console.log('Starting Twitch Device Code login...');

      // Use Device Code flow (like Python app)
      const [verificationUri, userCode] = await invoke('twitch_login') as [string, string];

      console.log('Device code received:', userCode);
      console.log('Verification URI:', verificationUri);

      // Show the user code to the user
      get().addToast(`Enter code ${userCode} at twitch.tv/activate`, 'info');

      // Open the verification URL in browser
      try {
        await invoke('open_browser_url', { url: verificationUri });
        console.log('Browser opened successfully');
      } catch (e) {
        console.error('Failed to open browser:', e);
        get().addToast(`Please visit ${verificationUri} and enter code: ${userCode}`, 'warning');
      }

      // Listen for login completion event from backend
      const { listen } = await import('@tauri-apps/api/event');

      const unlisten = await listen('twitch-login-complete', async () => {
        console.log('Login complete event received');

        // After successful login, check auth status FIRST
        await get().checkAuthStatus();

        // Then show success message and load streams
        get().addToast('Login successful! You are now authenticated with Twitch.', 'success');
        await get().loadFollowedStreams();

        set({ isLoading: false });

        // Bring the app window to focus after successful login
        try {
          await invoke('focus_window');
        } catch (e) {
          console.warn('Could not focus window:', e);
        }

        // Clean up listener
        unlisten();
      });

      // Also listen for login errors
      const unlistenError = await listen('twitch-login-error', (event) => {
        console.error('Login error event received:', event.payload);
        const errorMessage = String(event.payload);
        get().addToast(`Login failed: ${errorMessage}`, 'error');
        set({ isLoading: false });
        unlistenError();
      });

    } catch (e) {
      console.error('Login failed:', e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      get().addToast(`Login failed: ${errorMessage}. Please try again.`, 'error');
      set({ isLoading: false });
    }
  },

  logoutFromTwitch: async () => {
    trackActivity('Logged out from Twitch');
    try {
      await invoke('twitch_logout');
      set({ isAuthenticated: false, currentUser: null, followedStreams: [] });

      // Clear user context for error reporting
      saveUserContextToLocalStorage(null, get().currentStream);

      get().addToast('Successfully logged out from Twitch', 'success');
    } catch (e) {
      console.error('Logout failed:', e);
      get().addToast('Failed to logout. Please try again.', 'error');
    }
  },

  checkAuthStatus: async () => {
    try {
      // Check if we have stored credentials first (only on initial check, not periodic checks)
      const wasAuthenticated = get().isAuthenticated;
      const hasCredentials = await invoke('has_stored_credentials') as boolean;



      // Try to get user info - if it works, we're authenticated
      const userInfo = await invoke('get_user_info') as UserInfo;
      const user: TwitchUser = {
        access_token: '', // We don't need to expose this
        username: userInfo.login,
        user_id: userInfo.id,
        login: userInfo.login,
        display_name: userInfo.display_name,
        profile_image_url: userInfo.profile_image_url,
      };

      set({ isAuthenticated: true, currentUser: user });

      // Save user context for error reporting
      saveUserContextToLocalStorage(user, get().currentStream);

      // Track user in Supabase for analytics (only on initial login, not periodic checks)
      if (!wasAuthenticated) {
        try {
          const appVersion = await invoke<string>('get_current_app_version');
          upsertUser(user, appVersion).catch((e) => {
            console.warn('[Auth] Failed to upsert user to Supabase:', e);
          });
        } catch (vErr) {
          console.warn('[Auth] Failed to get app version for stats:', vErr);
          upsertUser(user).catch((e) => {
            console.warn('[Auth] Failed to upsert user to Supabase:', e);
          });
        }
      }

      // If we successfully restored session from stored credentials, show success (only once)
      if (hasCredentials && !wasAuthenticated && !hasShownWelcomeBackToast) {
        hasShownWelcomeBackToast = true;
        get().addToast(`Welcome back, ${userInfo.display_name}!`, 'success');
      }

      // Start whisper listener after successful authentication
      try {
        await invoke('start_whisper_listener');
        console.log('[Auth] Whisper listener started');
      } catch (whisperError) {
        console.warn('[Auth] Could not start whisper listener:', whisperError);
      }
    } catch (e) {
      // Check if user was previously authenticated (session expired)
      const wasAuthenticated = get().isAuthenticated;
      const previousUser = get().currentUser;

      // If it fails, we're not authenticated
      set({ isAuthenticated: false, currentUser: null, followedStreams: [] });

      // Show session expired toast if user was previously logged in
      if (wasAuthenticated && previousUser) {
        get().addToast(
          'Your session has expired. Please log in again to continue.',
          'warning',
          {
            label: 'Log In',
            onClick: () => get().loginToTwitch()
          }
        );
      }
    }
  },

  toggleFavoriteStreamer: async (userId: string) => {
    const currentSettings = get().settings;
    const favorites = currentSettings.favorite_streamers || [];

    let newFavorites: string[];
    if (favorites.includes(userId)) {
      // Remove from favorites
      newFavorites = favorites.filter(id => id !== userId);
    } else {
      // Add to favorites
      newFavorites = [...favorites, userId];
    }

    const newSettings = {
      ...currentSettings,
      favorite_streamers: newFavorites
    };

    await get().updateSettings(newSettings);
  },

  isFavoriteStreamer: (userId: string) => {
    const favorites = get().settings.favorite_streamers || [];
    return favorites.includes(userId);
  },

  toggleHome: () => {
    const state = get();
    const newHomeActive = !state.isHomeActive;
    trackActivity(newHomeActive ? 'Opened Home' : 'Closed Home');
    set({ isHomeActive: newHomeActive });
  },
}));
