import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Settings, TwitchUser, TwitchStream, UserInfo, TwitchCategory, HypeTrainData } from '../types';
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

export type SettingsTab = 'Interface' | 'Player' | 'Chat' | 'Theme' | 'Network' | 'Integrations' | 'Notifications' | 'Cache' | 'Support' | 'Updates' | 'Analytics';

export type HomeTab = 'following' | 'recommended' | 'browse' | 'search' | 'category';

// Types for drops data - matches backend DropCampaign struct
export interface DropCampaign {
  id: string;
  name: string;
  game_id: string;
  game_name: string;
  description: string;
  image_url: string;
  start_at: string;
  end_at: string;
  time_based_drops: Array<{
    id: string;
    name: string;
    required_minutes_watched: number;
    benefit_edges: Array<{
      id: string;
      name: string;
      image_url: string;
    }>;
  }>;
  is_account_connected: boolean;
  allowed_channels: Array<{ id: string; name: string }>;
  is_acl_based: boolean;
  details_url?: string;
}

interface DropsCache {
  // All campaigns for reference
  campaigns: DropCampaign[];
  // Map from game_id to campaigns (can have multiple per game)
  byGameId: Map<string, DropCampaign[]>;
  // Map from game_name (lowercase) to campaigns
  byGameName: Map<string, DropCampaign[]>;
  // Timestamp when data was last fetched
  lastFetchedAt: number;
}

// Cache duration: 15 minutes in milliseconds (backend uses 5 min, we use 15 for frontend)
const DROPS_CACHE_DURATION = 15 * 60 * 1000;

// Whisper import progress tracking
export interface WhisperImportProgress {
  step: number;
  status: 'pending' | 'running' | 'complete' | 'error';
  detail: string;
  current: number;
  total: number;
}

export interface WhisperImportState {
  isImporting: boolean;
  progress: WhisperImportProgress;
  estimatedEndTime: number | null; // Unix timestamp when import should finish
  totalConversations: number;
  exportProgress: { current: number; total: number; username: string };
  result: { conversations: number; messages: number } | null;
  error: string | null;
}

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
  // Whisper import state (persistent across wizard open/close)
  whisperImportState: WhisperImportState;
  isHomeActive: boolean;
  isAuthenticated: boolean;
  currentUser: TwitchUser | null;
  isMiningActive: boolean;
  setMiningActive: (active: boolean) => void;
  isTheaterMode: boolean;
  originalChatPlacement: string | null;
  toasts: Toast[];
  isAutoSwitching: boolean;
  // Track when raid redirect occurred to prevent auto-switch from overriding
  lastRaidRedirectTime: number;
  // Navigation state for deep linking
  homeActiveTab: HomeTab;
  homeSelectedCategory: TwitchCategory | null;
  dropsSearchTerm: string;
  // Centralized drops cache
  dropsCache: DropsCache | null;
  isLoadingDropsCache: boolean;
  // Hype Train state
  currentHypeTrain: HypeTrainData | null;
  setCurrentHypeTrain: (train: HypeTrainData | null) => void;
  // Hype Train status for stream badges (channel_id -> { level, isGolden })
  activeHypeTrainChannels: Map<string, { level: number; isGolden: boolean }>;
  refreshHypeTrainStatuses: (channelIds: string[]) => Promise<void>;
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
  // Navigation actions for deep linking
  setHomeActiveTab: (tab: HomeTab) => void;
  setHomeSelectedCategory: (category: TwitchCategory | null) => void;
  setDropsSearchTerm: (term: string) => void;
  navigateToHomeTab: (tab: HomeTab, category?: TwitchCategory) => void;
  navigateToCategoryByName: (categoryName: string) => Promise<void>;
  openDropsWithSearch: (searchTerm: string) => void;
  // Centralized drops cache actions
  loadActiveDropsCache: (forceRefresh?: boolean) => Promise<void>;
  getDropsCampaignByGameId: (gameId: string) => DropCampaign | undefined;
  getDropsCampaignByGameName: (gameName: string) => DropCampaign | undefined;
  // Whisper import actions
  setWhisperImportState: (state: Partial<WhisperImportState>) => void;
  resetWhisperImportState: () => void;
}

// Flags to ensure we only show session toasts once per app session
let hasShownWelcomeBackToast = false;

// Store EventSub listener cleanup functions at module level
let eventSubListenerCleanup: (() => void)[] = [];

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
  setMiningActive: (active: boolean) => set({ isMiningActive: active }),
  isTheaterMode: false,
  originalChatPlacement: null,
  toasts: [],
  isAutoSwitching: false,
  // Track when raid redirect occurred to prevent auto-switch from overriding
  lastRaidRedirectTime: 0,
  // Navigation state for deep linking
  homeActiveTab: 'following' as HomeTab,
  homeSelectedCategory: null,
  dropsSearchTerm: '',
  // Centralized drops cache
  dropsCache: null,
  isLoadingDropsCache: false,
  // Hype Train state
  currentHypeTrain: null,
  setCurrentHypeTrain: (train) => set({ currentHypeTrain: train }),
  // Hype Train status for stream badges
  activeHypeTrainChannels: new Map(),
  refreshHypeTrainStatuses: async (channelIds: string[]) => {
    if (channelIds.length === 0) return;
    try {
      const results = await invoke('get_bulk_hype_train_status', { channelIds }) as Array<{
        channel_id: string;
        is_active: boolean;
        level: number;
        is_golden_kappa: boolean;
      }>;
      const newMap = new Map<string, { level: number; isGolden: boolean }>();
      for (const result of results) {
        if (result.is_active) {
          newMap.set(result.channel_id, { level: result.level, isGolden: result.is_golden_kappa });
        }
      }
      set({ activeHypeTrainChannels: newMap });
    } catch (e) {
      // Silently fail - Hype Train badges are non-critical
      console.warn('[HypeTrain] Failed to refresh bulk status:', e);
    }
  },
  // Whisper import state
  whisperImportState: {
    isImporting: false,
    progress: { step: 0, status: 'pending', detail: '', current: 0, total: 4 },
    estimatedEndTime: null,
    totalConversations: 0,
    exportProgress: { current: 0, total: 0, username: '' },
    result: null,
    error: null,
  },

  handleStreamOffline: async () => {
    const state = get();
    const { currentStream, settings, isAutoSwitching, lastRaidRedirectTime } = state;

    // Prevent multiple auto-switch attempts
    if (isAutoSwitching) {
      console.log('[AutoSwitch] Already in progress, skipping');
      return;
    }

    // Check if a raid redirect recently happened (within last 15 seconds)
    // This prevents auto-switch from overriding a raid redirect
    const timeSinceRaidRedirect = Date.now() - lastRaidRedirectTime;
    const RAID_COOLDOWN_MS = 15000; // 15 seconds
    if (lastRaidRedirectTime > 0 && timeSinceRaidRedirect < RAID_COOLDOWN_MS) {
      console.log(`[AutoSwitch] Skipping - raid redirect occurred ${Math.round(timeSinceRaidRedirect / 1000)}s ago`);
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

      // Clean up EventSub listeners
      console.log('[EventSub] Cleaning up listeners on stop...');
      for (const cleanup of eventSubListenerCleanup) {
        cleanup();
      }
      eventSubListenerCleanup = [];

      // Disconnect EventSub
      try {
        await invoke('disconnect_eventsub');
        console.log('🛑 Disconnected EventSub');
      } catch (e) {
        console.warn('Could not disconnect EventSub:', e);
      }

      set({ streamUrl: null, currentStream: null, currentHypeTrain: null });

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

          // Auto-reserve watch token for this stream (if enabled in settings)
          // This ensures the user is "present" in chat for gifted sub eligibility
          try {
            const dropsSettings = await invoke('get_drops_settings') as any;
            if (dropsSettings?.reserve_token_for_current_stream && dropsSettings?.auto_reserve_on_watch) {
              await invoke('set_reserved_channel', {
                channelId,
                channelLogin: channelName
              });
              console.log('🔒 Auto-reserved watch token for', channelName);
            }
          } catch (reserveError) {
            console.warn('Could not auto-reserve watch token:', reserveError);
            // Non-critical, stream can still work
          }
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

      // Connect to EventSub for real-time events (only if authenticated)
      const channelId = info.user_id;
      const autoRedirectOnRaid = get().settings.auto_switch?.auto_redirect_on_raid ?? true;

      if (channelId && get().isAuthenticated) {
        try {
          // Clean up any existing event listeners first
          console.log('[EventSub] Cleaning up existing listeners...');
          for (const cleanup of eventSubListenerCleanup) {
            cleanup();
          }
          eventSubListenerCleanup = [];

          // Disconnect any existing connection first
          await invoke('disconnect_eventsub');

          // Connect to Rust EventSub service
          await invoke('connect_eventsub', { broadcasterId: channelId });

          // Set up event listeners for Rust-emitted events
          // Listen for raid events
          const unlistenRaid = await listen('eventsub://raid', async (event: any) => {
            if (!autoRedirectOnRaid) return;
            
            const raidData = event.payload;
            console.log(`[EventSub] Raid detected! Redirecting to ${raidData.to_broadcaster_user_login} (${raidData.viewers} viewers)`);

            // Mark that a raid redirect is happening - this prevents auto-switch from overriding
            set({ lastRaidRedirectTime: Date.now() });

            // Show notification toast
            get().addToast(`🎉 Raid starting! Joining ${raidData.to_broadcaster_user_login}...`, 'info');

            // Small delay to let user see the notification
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Start the new stream (this will also set up new EventSub subscription)
            await get().startStream(raidData.to_broadcaster_user_login);
          });
          eventSubListenerCleanup.push(unlistenRaid);

          // Listen for stream offline events
          const unlistenOffline = await listen('eventsub://offline', () => {
            console.log('[EventSub] Stream went offline via EventSub notification');
            // Use the existing handleStreamOffline which has all the auto-switch logic
            get().handleStreamOffline();
          });
          eventSubListenerCleanup.push(unlistenOffline);

          // Listen for channel update events
          const unlistenUpdate = await listen('eventsub://channel-update', (event: any) => {
            const updateData = event.payload;
            const currentStream = get().currentStream;
            if (currentStream) {
              console.log(`[EventSub] Channel updated: "${updateData.title}" - ${updateData.category_name}`);
              set({
                currentStream: {
                  ...currentStream,
                  title: updateData.title,
                  game_name: updateData.category_name,
                  game_id: updateData.category_id,
                }
              });
            }
          });
          eventSubListenerCleanup.push(unlistenUpdate);

          // Start Hype Train GQL polling (works for any channel, no moderator access needed)
          // Adaptive polling: 15s when idle, 5s when train active
          let hypeTrainPollingActive = true;
          let hypeTrainPreviousLevel = 0;
          let hypeTrainTimeoutId: ReturnType<typeof setTimeout> | null = null;
          const IDLE_POLL_INTERVAL = 15000;  // 15 seconds when no train
          const ACTIVE_POLL_INTERVAL = 3000; // 3 seconds when train active
          
          const pollHypeTrain = async () => {
            if (!hypeTrainPollingActive) return;
            
            let isActive = false;
            try {
              const status = await invoke('get_hype_train_status', { channelId, channelLogin: channel }) as {
                is_active: boolean;
                id?: string;
                level: number;
                progress: number;
                goal: number;
                total: number;
                started_at?: string;
                expires_at?: string;
                is_level_up: boolean;
                is_golden_kappa: boolean;
              };
              
              isActive = status.is_active;
              
              if (status.is_active) {
                // Check for level up
                if (status.level > hypeTrainPreviousLevel && hypeTrainPreviousLevel > 0) {
                  console.log(`[HypeTrain GQL] 🚂 Level UP! ${hypeTrainPreviousLevel} → ${status.level}`);
                }
                hypeTrainPreviousLevel = status.level;
                
                // Map GQL status to HypeTrainData format
                const hypeTrainData = {
                  id: status.id || '',
                  broadcaster_user_id: channelId,
                  broadcaster_user_login: channel,
                  broadcaster_user_name: info.user_name,
                  level: status.level,
                  total: status.total,
                  progress: status.progress,
                  goal: status.goal,
                  top_contributions: [],
                  started_at: status.started_at || '',
                  expires_at: status.expires_at || '',
                  is_golden_kappa: status.is_golden_kappa,
                };
                set({ currentHypeTrain: hypeTrainData });
              } else {
                // Only clear if we previously had a hype train
                if (get().currentHypeTrain !== null) {
                  console.log('[HypeTrain GQL] 🚂 Hype Train ended');
                  hypeTrainPreviousLevel = 0;
                  set({ currentHypeTrain: null });
                }
              }
            } catch (e) {
              // Silently fail - GQL polling is non-critical
            }
            
            // Schedule next poll with adaptive interval
            if (hypeTrainPollingActive) {
              const nextInterval = isActive ? ACTIVE_POLL_INTERVAL : IDLE_POLL_INTERVAL;
              hypeTrainTimeoutId = setTimeout(pollHypeTrain, nextInterval);
            }
          };
          
          // Initial poll
          pollHypeTrain();
          
          // Add cleanup for polling
          eventSubListenerCleanup.push(() => {
            hypeTrainPollingActive = false;
            if (hypeTrainTimeoutId) {
              clearTimeout(hypeTrainTimeoutId);
            }
          });

          console.log(`🔔 Connected to EventSub (channel: ${info.user_name})`);
        } catch (e) {
          console.warn('[EventSub] Could not connect:', e);
          // Non-critical, stream can still work
        }
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

      // Open the verification URL in an in-app WebView window
      // This ensures Twitch session cookies are stored in WebView2's shared profile
      // which enables follow/unfollow and other web-based features
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const loginWindow = new WebviewWindow('twitch-login', {
          url: verificationUri,
          title: 'Log in to Twitch',
          width: 500,
          height: 700,
          center: true,
          resizable: true,
          minimizable: true,
          maximizable: false,
        });

        loginWindow.once('tauri://error', (e) => {
          console.error('Failed to open login window:', e);
          get().addToast(`Please visit ${verificationUri} and enter code: ${userCode}`, 'warning');
        });

        console.log('In-app login window opened successfully');
      } catch (e) {
        console.error('Failed to open login window:', e);
        get().addToast(`Please visit ${verificationUri} and enter code: ${userCode}`, 'warning');
      }

      // Listen for login completion event from backend
      const { listen } = await import('@tauri-apps/api/event');

      const unlisten = await listen('twitch-login-complete', async () => {
        console.log('Login complete event received');

        // Close the login window
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const loginWindow = await WebviewWindow.getByLabel('twitch-login');
          if (loginWindow) {
            console.log('[TwitchLogin] Closing twitch-login webview window');
            await loginWindow.close();
            console.log('[TwitchLogin] Successfully closed twitch-login window');
          } else {
            console.log('[TwitchLogin] No twitch-login window found to close');
          }
        } catch (e) {
          console.warn('[TwitchLogin] Failed to close twitch-login window:', e);
        }

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
      const unlistenError = await listen('twitch-login-error', async (event) => {
        console.error('Login error event received:', event.payload);
        const errorMessage = String(event.payload);
        get().addToast(`Login failed: ${errorMessage}`, 'error');
        set({ isLoading: false });

        // Also close the login window on error
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const loginWindow = await WebviewWindow.getByLabel('twitch-login');
          if (loginWindow) {
            console.log('[TwitchLogin] Closing twitch-login window after error');
            await loginWindow.close();
          }
        } catch (e) {
          console.warn('[TwitchLogin] Failed to close twitch-login window on error:', e);
        }

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

  // Navigation actions for deep linking
  setHomeActiveTab: (tab: HomeTab) => {
    set({ homeActiveTab: tab });
  },

  setHomeSelectedCategory: (category: TwitchCategory | null) => {
    set({ homeSelectedCategory: category });
  },

  setDropsSearchTerm: (term: string) => {
    set({ dropsSearchTerm: term });
  },

  navigateToHomeTab: (tab: HomeTab, category?: TwitchCategory) => {
    trackActivity(`Navigated to Home tab: ${tab}`);
    set({
      homeActiveTab: tab,
      homeSelectedCategory: category || null,
      isHomeActive: true,
      // Close any overlays
      showBadgesOverlay: false,
      showDropsOverlay: false,
    });
  },

  navigateToCategoryByName: async (categoryName: string) => {
    trackActivity(`Navigating to category: ${categoryName}`);

    // Create a partial category object with just the name
    // Home.tsx will detect this (no ID) and use get_streams_by_game_name to load streams
    const partialCategory: TwitchCategory = {
      id: '', // Empty ID signals Home.tsx to load by name
      name: categoryName,
      box_art_url: '',
    };

    // Navigate to the category view - Home.tsx will load streams by game name
    set({
      homeActiveTab: 'category',
      homeSelectedCategory: partialCategory,
      isHomeActive: true,
      showBadgesOverlay: false,
      showDropsOverlay: false,
    });

    get().addToast(`Loading ${categoryName} streams...`, 'info');
  },

  openDropsWithSearch: (searchTerm: string) => {
    trackActivity(`Opening Drops with search: ${searchTerm}`);
    set({
      dropsSearchTerm: searchTerm,
      showDropsOverlay: true,
      showBadgesOverlay: false,
    });
  },

  // Centralized drops cache loading with 15-minute cache duration
  loadActiveDropsCache: async (forceRefresh = false) => {
    const { dropsCache, isLoadingDropsCache } = get();

    // Don't reload if already loading
    if (isLoadingDropsCache) return;

    // Check if cache is still valid
    if (!forceRefresh && dropsCache) {
      const cacheAge = Date.now() - dropsCache.lastFetchedAt;
      if (cacheAge < DROPS_CACHE_DURATION) {
        console.log(`[DropsCache] Using cached data (${Math.round(cacheAge / 60000)}min old, ${dropsCache.campaigns.length} campaigns)`);
        return;
      }
    }

    set({ isLoadingDropsCache: true });

    try {
      // Use get_active_drop_campaigns which returns all 117+ active campaigns
      const campaigns = await invoke<DropCampaign[]>('get_active_drop_campaigns');

      if (campaigns && campaigns.length > 0) {
        const byGameId = new Map<string, DropCampaign[]>();
        const byGameName = new Map<string, DropCampaign[]>();

        for (const campaign of campaigns) {
          // Index by game_id (can have multiple campaigns per game)
          if (campaign.game_id) {
            const existing = byGameId.get(campaign.game_id) || [];
            existing.push(campaign);
            byGameId.set(campaign.game_id, existing);
          }
          // Index by game_name (lowercase for case-insensitive lookup)
          if (campaign.game_name) {
            const key = campaign.game_name.toLowerCase();
            const existing = byGameName.get(key) || [];
            existing.push(campaign);
            byGameName.set(key, existing);
          }
        }

        set({
          dropsCache: {
            campaigns,
            byGameId,
            byGameName,
            lastFetchedAt: Date.now(),
          },
          isLoadingDropsCache: false,
        });

        console.log(`[DropsCache] Loaded ${campaigns.length} active campaigns for ${byGameId.size} games`);
      } else {
        set({
          dropsCache: {
            campaigns: [],
            byGameId: new Map(),
            byGameName: new Map(),
            lastFetchedAt: Date.now(),
          },
          isLoadingDropsCache: false,
        });
        console.log('[DropsCache] No active campaigns found');
      }
    } catch (e) {
      console.error('[DropsCache] Failed to load active drops:', e);
      set({ isLoadingDropsCache: false });
    }
  },

  // Returns the first campaign for a game (for displaying indicator)
  getDropsCampaignByGameId: (gameId: string) => {
    const campaigns = get().dropsCache?.byGameId.get(gameId);
    return campaigns?.[0];
  },

  // Returns the first campaign for a game name (case-insensitive)
  getDropsCampaignByGameName: (gameName: string) => {
    const campaigns = get().dropsCache?.byGameName.get(gameName.toLowerCase());
    return campaigns?.[0];
  },

  // Whisper import state management
  setWhisperImportState: (state: Partial<WhisperImportState>) => {
    set((prev) => ({
      whisperImportState: { ...prev.whisperImportState, ...state },
    }));
  },

  resetWhisperImportState: () => {
    set({
      whisperImportState: {
        isImporting: false,
        progress: { step: 0, status: 'pending', detail: '', current: 0, total: 4 },
        estimatedEndTime: null,
        totalConversations: 0,
        exportProgress: { current: 0, total: 0, username: '' },
        result: null,
        error: null,
      },
    });
  },
}));
