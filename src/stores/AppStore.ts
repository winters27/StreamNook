import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import type { Settings, TwitchUser, TwitchStream, UserInfo, TwitchCategory, HypeTrainData, TwitchVideo, ModLogEvent, MiningStatus } from '../types';
import { trackActivity } from '../services/logService';
import { Logger, setDiagnosticsEnabled } from '../utils/logger';
// Direct import (not via the keybindings index) to avoid a storecommands cycle.
import { getPlayerControls } from '../keybindings/playerControls';
import { qualitiesEquivalent } from '../utils/quality';
import { reportCodecPreference } from '../utils/codecPreference';
import { upsertUser, grantActiveSeasonalAccolades, grantCakeDayAccolade } from '../services/supabaseService';
import { emitSettingsUpdated } from '../utils/settingsBroadcast';

type StreamStartResult = {
  url: string;
  quality: string;
  /** How the live stream resolved: 'turbo' | 'subscribed' | 'auth-only' | 'plugin'. */
  mode?: string;
  /** True when Twitch's own entitlement (Turbo / channel sub) is serving an ad-free stream. */
  entitled?: boolean;
  /** Region label (e.g. 'EU') reported by a resolution-owning plugin. */
  proxy_region?: string;
  /** Quality menu the resolver discovered (variant names + best/worst). */
  available?: string[];
};

/** The current stream's ad source, surfaced as an unobtrusive note in the player. */
export type AdSource = {
  mode: string;
  entitled: boolean;
  region?: string;
};

/** Derive the player ad-source note from a stream start result. */
function adSourceFrom(result: StreamStartResult): AdSource | null {
  if (!result.mode) return null;
  return { mode: result.mode, entitled: !!result.entitled, region: result.proxy_region };
}

/**
 * Log when the resolver fell back to a different quality because the saved
 * preference wasn't offered for this stream. No longer toasts: that fired on
 * nearly every stream and was overbearing. The player surfaces the fallback as
 * part of its unobtrusive top-left stream note instead. Silent when the two are
 * equivalent (e.g. "480" vs "480p30"), which is just a naming difference.
 */
function logQualityFallback(requested: string, actual: string) {
  if (qualitiesEquivalent(requested, actual)) return;
  Logger.info(`[Stream] Quality fallback: ${requested} -> ${actual}`);
}

export interface Toast {
  id: number;
  message: string | React.ReactNode;
  type: 'info' | 'success' | 'warning' | 'error' | 'live' | 'channel_points';
  action?: {
    label: string;
    onClick: () => void;
  };
  timeoutId?: ReturnType<typeof setTimeout>;
  duration: number;
  createdAt: number;
}

export type SettingsTab = 'Profile' | 'Interface' | 'Player' | 'Chat' | 'Moderation' | 'Theme' | 'Integrations' | 'Plugins' | 'Notifications' | 'Cache' | 'Command Palette' | 'Keybindings' | 'Backup' | 'Support' | "What's New" | 'Analytics';

export type HomeTab = 'following' | 'recommended' | 'browse' | 'search' | 'category';

export interface MediaInfo {
  id?: string;
  broadcaster_id?: string;
  user_id?: string;
  broadcaster_name?: string;
  user_name?: string;
  title?: string;
  view_count?: number;
  thumbnail_url?: string;
  created_at?: string;
  game_id?: string;
  game_name?: string;
  language?: string;
}

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
  offlineFollowedChannels: TwitchStream[];
  setOfflineFollowedChannels: (channels: TwitchStream[]) => void;
  recommendedStreams: TwitchStream[];
  recommendedCursor: string | null;
  hasMoreRecommended: boolean;
  isLoadingMore: boolean;
  streamUrl: string | null;
  // The quality the resolver is actually serving right now (canonical name from
  // the playlist). May differ from `settings.quality` if the saved preference
  // wasn't offered for this stream and we fell back to the closest match.
  activeQuality: string | null;
  /** Quality menu for the current stream (variant names + best/worst), as
   *  resolved natively. The player's quality selector is built from this. */
  availableQualities: string[];
  /** How the current live stream is being served ad-free (entitlement vs proxy). */
  adSource: AdSource | null;
  currentStream: TwitchStream | null;
  /** Lowercase channel logins currently open in any StreamNook MultiChat
   *  popout window. The main app gates the in-app chat widget on this set —
   *  if you're watching a stream whose chat already lives in a popout, the
   *  popout becomes the sole chat surface for that channel (no duplicate
   *  chat panel in main). Maintained by the tray bridge from events the
   *  popout windows emit on their channel-list changes. */
  channelsInPopouts: Set<string>;
  currentMediaType: 'live' | 'clip' | 'video' | 'offline_chat' | null;
  originalMediaUrl: string | null;
  /** A Twitch clip playing in the centered overlay modal, or null. The modal is
   *  independent of the main stream pipeline (a clip is a direct MP4), so the
   *  current stream/chat stays mounted underneath and resumes on close — the
   *  viewer lands back exactly where they were. `created` (with `editUrl`) marks a
   *  clip the user just made, so the modal shows the full action bar underneath
   *  (Copy / Send to chat / Edit / Open) — the all-in-one post-create surface. */
  clipModal: { url: string; info: MediaInfo; created?: boolean; editUrl?: string; shareOnly?: boolean } | null;
  openClipModal: (
    url: string,
    info: MediaInfo,
    opts?: { created?: boolean; editUrl?: string; shareOnly?: boolean },
  ) => void;
  closeClipModal: () => void;
  /** True while a Create Clip request is in flight (drives the Clip button spinner). */
  isCreatingClip: boolean;
  /** Clip the channel/VOD currently being watched (live → instant Helix; VOD →
   *  opens the trim editor). */
  createClip: () => Promise<void>;
  /** Active trim-editor session (a VOD by `vodId` OR a live broadcast by
   *  `broadcastId`, plus where in it), or null. */
  clipEditor: {
    vodId?: string;
    broadcastId?: string;
    offsetSeconds: number;
    channelName: string;
  } | null;
  openClipEditor: (opts: {
    vodId?: string;
    broadcastId?: string;
    offsetSeconds: number;
    channelName: string;
  }) => void;
  closeClipEditor: () => void;
  setCurrentStream: (stream: TwitchStream | null) => void;
  chatPlacement: string;
  isLoading: boolean;
  isSettingsOpen: boolean;
  settingsInitialTab: SettingsTab | null;
  // DOM id of a settings section to scroll to when the dialog opens (e.g. from a
  // right-click shortcut). Consumed by SettingsDialog, cleared on close.
  settingsInitialSection: string | null;
  // Twitch user_id of the member whose public StreamNook profile is open in
  // the draggable viewer overlay, or null when closed.
  profileViewerUserId: string | null;
  // When set, the viewer is showing the CURRENT user's own profile as a LIVE
  // preview of what others see while they edit it in Settings. The overlay
  // PREFERS these values over its fetched/local state so edits reflect
  // instantly. null = a normal view (another member, or no preview). Cleared
  // whenever the viewer closes or opens a different (non-preview) profile.
  // `badgeRevision` is a bump counter: incrementing it makes the overlay
  // re-resolve the worn-badge row (a loadout edit) without a full reload.
  profileViewerPreview: {
    hiddenSections: string[];
    profileTheme: string;
    badgeRevision: number;
  } | null;
  isCommandPaletteOpen: boolean;
  updateInfo: { current_version: string; latest_version: string } | null;
  showLiveStreamsOverlay: boolean;
  showMarketplaceOverlay: boolean;
  setShowMarketplaceOverlay: (show: boolean) => void;
  showDropsOverlay: boolean;
  /**
   * Latches true the first time the user opens the drops overlay this session.
   * Sidebar gates its drops-inventory fetch on this so we don't poll Twitch
   * for inventory data when the user has shown no interest in drops.
   */
  dropsOverlayEverOpened: boolean;
  showBadgesOverlay: boolean;
  badgesOverlayInitialPaintId: string | null;
  badgesOverlayInitialBadgeId: string | null;
  badgesOverlayInitialStreamNook: boolean;
  // Generic deep-link target for tabs without a dedicated detail modal (Twitch,
  // BetterTTV, Chat Clients): open the overlay on `tab` and filter to `query`
  // (a badge title) so the clicked badge surfaces. Set by openBadgesWithTarget.
  badgesOverlayInitialTarget: { tab: string; query?: string } | null;
  // 7TV "Emote Sets" editor dashboard. Optional initial channel (by Twitch id)
  // and tab so a contextual launch (e.g. from the moderator menu) can open it
  // pre-selected.
  showEmoteSetsOverlay: boolean;
  emoteSetsOverlayInitialTwitchId: string | null;
  emoteSetsOverlayInitialTab: 'emotes' | 'sets' | 'editors' | null;
  // When set, the 7TV Emotes overlay shows a focused detail for this emote with
  // a cross-channel "add to a set" picker. Set by clicking an emote in chat.
  emoteSpotlight: { id: string; name: string } | null;
  showWhispersOverlay: boolean;
  showDashboardOverlay: boolean;
  whisperTargetUser: { id: string; login: string; display_name: string; profile_image_url?: string } | null;
  // Whisper import state (persistent across wizard open/close)
  whisperImportState: WhisperImportState;
  isHomeActive: boolean;
  isAuthenticated: boolean;
  currentUser: TwitchUser | null;
  isMiningActive: boolean;
  setMiningActive: (active: boolean) => void;
  // Latest live mining status, written by the always-mounted PluginMiningBridge
  // when a plugin powers mining. It survives the Drops overlay closing, so a
  // reopened overlay can immediately show what is being mined. Null when no
  // plugin is mining (the built-in miner's status is read on demand instead).
  liveMiningStatus: MiningStatus | null;
  setLiveMiningStatus: (status: MiningStatus | null) => void;
  isTheaterMode: boolean;
  originalChatPlacement: string | null;
  toasts: Toast[];
  isAutoSwitching: boolean;
  // Track when raid redirect occurred to prevent auto-switch from overriding
  lastRaidRedirectTime: number;
  profileModalUser: TwitchStream | null;
  setProfileModalUser: (user: TwitchStream | null) => void;
  /** Which tab the streamer profile modal opens on (About by default; the
   *  player-overlay "Clips & videos" button opens straight to Clips). */
  profileModalInitialTab: 'about' | 'clips' | 'videos';
  /** Open the streamer profile modal directly on its Clips/VODs view. */
  openStreamerMedia: (user: TwitchStream) => void;
  // Navigation state for deep linking
  homeActiveTab: HomeTab;
  homeSelectedCategory: TwitchCategory | null;
  streamOriginCategory: TwitchCategory | null;
  /**
   * Tab the most recent search was launched from. Used to send the user back to
   * a real page (instead of an empty "search" view) after they exit a stream
   * that was opened directly from search results.
   */
  searchReturnTab: HomeTab;
  homeCategoryTab: 'live' | 'clips' | 'videos';
  
  // Media sorting and filtering state
  clipsPeriod: string;
  videosSort: string;
  videosPeriod: string;
  mediaSearchQuery: string;
  setClipsPeriod: (period: string) => void;
  setVideosSort: (sort: string) => void;
  setVideosPeriod: (period: string) => void;
  setMediaSearchQuery: (query: string) => void;

  // Category cache
  cachedTopGames: TwitchCategory[];
  cachedGamesCursor: string | null;
  cachedHasMoreGames: boolean;
  cachedTopGamesTimestamp: number;
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
  addToast: (message: string | React.ReactNode, type: 'info' | 'success' | 'warning' | 'error' | 'live' | 'channel_points', action?: { label: string; onClick: () => void }, options?: { skipIsland?: boolean; alwaysShow?: boolean }) => void;
  removeToast: (id: number) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (newSettings: Settings) => Promise<void>;
  watchStreaks: Record<string, number>;
  loadFollowedStreams: () => Promise<void>;
  loadRecommendedStreams: () => Promise<void>;
  loadMoreRecommendedStreams: () => Promise<void>;
  startStream: (channel: string, streamInfo?: TwitchStream, skipChatRefresh?: boolean) => Promise<void>;
  startOfflineChat: (channel: string, streamInfo?: TwitchStream) => Promise<void>;
  playMedia: (type: 'clip' | 'video', url: string, info: MediaInfo) => Promise<void>;
  stopStream: (options?: { preserveBackend?: boolean }) => Promise<void>;
  restartStream: () => Promise<void>;  // Restart current stream (stops and starts again)
  isRestartingStream: boolean;  // True from restart begin until the new stream URL lands; the player freezes its loader on this so it doesn't poll a dead backend
  reloadStreamAndChat: () => Promise<void>;  // Hard refresh: restart the stream AND reconnect/reload chat
  getAvailableQualities: () => Promise<string[]>;
  changeStreamQuality: (quality: string) => Promise<void>;
  /** Apply a backend ad auto-pivot: the relay already hot-swapped to a clean
   *  region, so point the player at the fresh URL to resync cleanly. */
  applyAdPivot: (url: string, region?: string) => void;
  openSettings: (initialTab?: SettingsTab, initialSection?: string) => void;
  closeSettings: () => void;
  openProfileViewer: (userId: string) => void;
  closeProfileViewer: () => void;
  // Open the viewer in LIVE-PREVIEW mode for the current user's own profile,
  // seeding it with the values currently being edited in Settings.
  openProfilePreview: (
    userId: string,
    override: { hiddenSections: string[]; profileTheme: string },
  ) => void;
  // Merge a partial edit into the active preview override (no-op when no
  // preview is open). `bumpBadges` re-resolves the worn-badge row.
  updateProfilePreview: (
    partial: { hiddenSections?: string[]; profileTheme?: string; bumpBadges?: boolean },
  ) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;
  setUpdateInfo: (info: { current_version: string; latest_version: string } | null) => void;
  setShowLiveStreamsOverlay: (show: boolean) => void;
  setShowDropsOverlay: (show: boolean) => void;
  setShowBadgesOverlay: (show: boolean) => void;
  openBadgesWithPaint: (paintId: string) => void;
  openBadgesWithBadge: (badgeId: string) => void;
  openBadgesOnStreamNook: () => void;
  openBadgesWithTarget: (target: { tab: string; query?: string }) => void;
  setShowEmoteSetsOverlay: (show: boolean) => void;
  openEmoteSets: (opts?: { twitchId?: string; tab?: 'emotes' | 'sets' | 'editors' }) => void;
  openEmoteSpotlight: (emoteId: string, name: string) => void;
  setEmoteSpotlight: (e: { id: string; name: string } | null) => void;
  setShowWhispersOverlay: (show: boolean) => void;
  setShowDashboardOverlay: (show: boolean) => void;
  openWhisperWithUser: (user: { id: string; login: string; display_name: string; profile_image_url?: string }) => void;
  clearWhisperTargetUser: () => void;
  toggleTheaterMode: () => void;
  loginToTwitch: () => Promise<void>;
  logoutFromTwitch: () => Promise<void>;
  /** Make a linked account the main (watch & stream as it), then re-establish identity. */
  setActiveAccount: (userId: string) => Promise<void>;
  /** Sign out of the main; promote a linked account if one exists, else full sign-out. */
  signOutActiveAccount: () => Promise<void>;
  /** Internal: refresh watched identity + follows + accounts + chat after the primary slot changes. */
  reestablishIdentityAfterSwitch: () => Promise<void>;
  checkAuthStatus: () => Promise<void>;
  toggleFavoriteStreamer: (userId: string) => Promise<void>;
  isFavoriteStreamer: (userId: string) => boolean;
  toggleHome: () => void;
  exitStream: (options?: { preserveBackend?: boolean }) => Promise<void>;
  // Navigation actions for deep linking
  setHomeActiveTab: (tab: HomeTab) => void;
  setHomeSelectedCategory: (category: TwitchCategory | null) => void;
  setStreamOriginCategory: (category: TwitchCategory | null) => void;
  setSearchReturnTab: (tab: HomeTab) => void;
  setHomeCategoryTab: (tab: 'live' | 'clips' | 'videos') => void;
  
  // Category cache actions
  setCachedTopGames: (games: TwitchCategory[], cursor: string | null, hasMore: boolean) => void;
  appendCachedTopGames: (games: TwitchCategory[], cursor: string | null, hasMore: boolean) => void;
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
  // Mod Logs State
  modLogs: ModLogEvent[];
  /** Channels whose persisted history has already been merged in this session (avoids re-loading). */
  loadedModLogChannels: Set<string>;
  addModLog: (log: ModLogEvent) => void;
  /** Merge a channel's persisted mod-log history from disk into the live list. */
  loadModLogsForChannel: (channel: string) => Promise<void>;
  /** Drop in-memory entries (and the load-guard) for any channel not in the active set. */
  pruneModLogsToChannels: (activeChannels: string[]) => void;
  clearModLogs: () => void;
}

// Flags to ensure we only show session toasts once per app session
let hasShownWelcomeBackToast = false;

// Store EventSub listener cleanup functions at module level
let eventSubListenerCleanup: (() => void)[] = [];
let eventSubConnectionId = 0;

// Watch streak batch fetches are HEAVY — Twitch GraphQL with one sub-query
// per channel (28 sub-queries for a typical followed list), the response is
// a large JSON. `loadFollowedStreams` is called from 10+ call sites that
// cascade at startup, so without this guard the fetch fires 3-4× back-to-back
// for the same data. Cache for 1 hour; refetch only after that.
const WATCH_STREAKS_TTL_MS = 60 * 60 * 1000;
let lastWatchStreaksFetchAt = 0;

export const useAppStore = create<AppState>((set, get) => ({
  settings: {} as Settings,
  followedStreams: [],
  offlineFollowedChannels: [],
  setOfflineFollowedChannels: (channels: TwitchStream[]) => set({ offlineFollowedChannels: channels }),
  watchStreaks: {},
  recommendedStreams: [],
  recommendedCursor: null,
  hasMoreRecommended: true,
  isLoadingMore: false,
  streamUrl: null,
  isRestartingStream: false,
  activeQuality: null,
  availableQualities: [],
  adSource: null,
  currentStream: null,
  channelsInPopouts: new Set<string>(),
  currentMediaType: null,
  originalMediaUrl: null,
  clipModal: null,
  clipEditor: null,
  isCreatingClip: false,
  setCurrentStream: (stream: TwitchStream | null) => set({ currentStream: stream }),
  chatPlacement: 'right',
  isLoading: false,
  isSettingsOpen: false,
  settingsInitialTab: null,
  settingsInitialSection: null,
  profileViewerUserId: null,
  profileViewerPreview: null,
  isCommandPaletteOpen: false,
  updateInfo: null,
  showLiveStreamsOverlay: false,
  showMarketplaceOverlay: false,
  setShowMarketplaceOverlay: (show: boolean) => set({ showMarketplaceOverlay: show }),
  showDropsOverlay: false,
  dropsOverlayEverOpened: false,
  showBadgesOverlay: false,
  badgesOverlayInitialPaintId: null,
  badgesOverlayInitialBadgeId: null,
  badgesOverlayInitialStreamNook: false,
  badgesOverlayInitialTarget: null,
  showEmoteSetsOverlay: false,
  emoteSetsOverlayInitialTwitchId: null,
  emoteSetsOverlayInitialTab: null,
  emoteSpotlight: null,
  showWhispersOverlay: false,
  showDashboardOverlay: false,
  whisperTargetUser: null,
  isHomeActive: true,
  isAuthenticated: false,
  currentUser: null,
  isMiningActive: false,
  setMiningActive: (active: boolean) => set({ isMiningActive: active }),
  liveMiningStatus: null,
  setLiveMiningStatus: (status: MiningStatus | null) => set({ liveMiningStatus: status }),
  isTheaterMode: false,
  originalChatPlacement: null,
  toasts: [],
  isAutoSwitching: false,
  // Track when raid redirect occurred to prevent auto-switch from overriding
  lastRaidRedirectTime: 0,
  profileModalUser: null,
  profileModalInitialTab: 'about',
  setProfileModalUser: (user) => set({ profileModalUser: user, profileModalInitialTab: 'about' }),
  openStreamerMedia: (user) => set({ profileModalUser: user, profileModalInitialTab: 'clips' }),
  // Navigation state for deep linking
  homeActiveTab: 'following' as HomeTab,
  homeSelectedCategory: null,
  streamOriginCategory: null,
  searchReturnTab: 'following' as HomeTab,
  homeCategoryTab: 'live' as 'live' | 'clips' | 'videos',

  // Media sorting and filtering state
  clipsPeriod: 'all',
  videosSort: 'time',
  videosPeriod: 'all',
  mediaSearchQuery: '',
  setClipsPeriod: (period: string) => set({ clipsPeriod: period }),
  setVideosSort: (sort: string) => set({ videosSort: sort }),
  setVideosPeriod: (period: string) => set({ videosPeriod: period }),
  setMediaSearchQuery: (query: string) => set({ mediaSearchQuery: query }),
  
  // Category cache init
  cachedTopGames: [],
  cachedGamesCursor: null,
  cachedHasMoreGames: true,
  cachedTopGamesTimestamp: 0,
  modLogs: [],
  loadedModLogChannels: new Set<string>(),
  addModLog: (log) => {
    const MOD_LOG_CAP = 300; // newest-first, in-memory ceiling across channels
    // Decide the dedup outcome, then persist the FINAL entry so the on-disk
    // per-channel history matches what's shown.
    let toPersist: ModLogEvent | null = null;
    set((state) => {
      const currentLogs = state.modLogs || [];

      // IRC (CLEARCHAT/CLEARMSG/NOTICE) and EventSub channel.moderate both report
      // the same actions. IRC is universal but anonymized; EventSub carries the
      // moderator identity. De-dupe so the feeds don't double-log, and let a
      // richer EventSub entry upgrade a matching IRC one (or drop the IRC dup).
      const DEDUP_MS = 5000;
      const normAction = (a?: string) => {
        const s = (a || '').toLowerCase();
        return s === 'clear_chat' ? 'clear' : s;
      };
      const keyOf = (l: ModLogEvent) =>
        `${(l.channel || '').toLowerCase()}|${normAction(l.action)}|${(l.target_user_name || '').toLowerCase()}`;
      const newKey = keyOf(log);
      const now = Date.now();
      const dupIdx = currentLogs.findIndex(
        (l) => keyOf(l) === newKey && now - new Date(l.timestamp).getTime() < DEDUP_MS,
      );

      if (dupIdx !== -1) {
        if (log.source === 'eventsub' && currentLogs[dupIdx].source !== 'eventsub') {
          // Upgrade the anonymized IRC entry with EventSub detail, keeping its slot + id.
          // Preserve the message/reason the IRC entry captured (e.g. the timed-out
          // user's last message, which channel.moderate doesn't carry) when the
          // EventSub upgrade doesn't supply its own.
          const merged = currentLogs.slice();
          merged[dupIdx] = {
            ...log,
            id: currentLogs[dupIdx].id,
            message: log.message ?? currentLogs[dupIdx].message,
            reason: log.reason ?? currentLogs[dupIdx].reason,
          };
          toPersist = merged[dupIdx];
          return { modLogs: merged };
        }
        // Existing entry is as-good-or-better — drop the duplicate, persist nothing.
        return { modLogs: currentLogs };
      }

      toPersist = log;
      return { modLogs: [log, ...currentLogs].slice(0, MOD_LOG_CAP) };
    });

    // Durably store for this channel (slim copy, no raw `details`). Fire and
    // forget; the disk store dedups/replaces by id and caps per channel.
    if (toPersist && (toPersist as ModLogEvent).channel) {
      const slim: ModLogEvent = { ...(toPersist as ModLogEvent) };
      delete slim.details; // raw payload isn't rendered; keep the stored copy lean
      invoke('append_mod_log', { channel: slim.channel, entry: slim }).catch(() => {});
    }
  },
  loadModLogsForChannel: async (channel) => {
    const key = (channel || '').toLowerCase();
    if (!key) return;
    if (get().loadedModLogChannels.has(key)) return;
    // Mark loaded up-front so a re-render doesn't kick off a duplicate load.
    set((state) => ({ loadedModLogChannels: new Set(state.loadedModLogChannels).add(key) }));
    try {
      const entries = await invoke<ModLogEvent[]>('load_mod_logs', { channel: key });
      if (!entries || entries.length === 0) return;
      set((state) => {
        const seen = new Set(state.modLogs.map((l) => l.id));
        const fresh = entries.filter((e) => e && e.id && !seen.has(e.id));
        if (fresh.length === 0) return { modLogs: state.modLogs };
        const merged = [...state.modLogs, ...fresh]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 300);
        return { modLogs: merged };
      });
    } catch (e) {
      Logger.warn(`[ModLogs] Failed to load history for ${key}:`, e);
    }
  },
  pruneModLogsToChannels: (activeChannels) => set((state) => {
    const active = new Set(activeChannels.map((c) => c.toLowerCase()));
    const modLogs = state.modLogs.filter((l) => l.channel && active.has(l.channel.toLowerCase()));
    const loadedModLogChannels = new Set(
      Array.from(state.loadedModLogChannels).filter((c) => active.has(c)),
    );
    // No-op if nothing changed, to avoid render churn on every channel-set tick.
    if (
      modLogs.length === state.modLogs.length &&
      loadedModLogChannels.size === state.loadedModLogChannels.size
    ) {
      return {};
    }
    return { modLogs, loadedModLogChannels };
  }),
  clearModLogs: () => {
    const loaded = Array.from(get().loadedModLogChannels);
    set({ modLogs: [], loadedModLogChannels: new Set<string>() });
    // Make "Clear" durable: wipe the persisted history for the channels in view
    // so it doesn't just reappear on the next load.
    for (const channel of loaded) {
      invoke('clear_mod_logs', { channel }).catch(() => {});
    }
  },
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
      Logger.warn('[HypeTrain] Failed to refresh bulk status:', e);
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
      Logger.debug('[AutoSwitch] Already in progress, skipping');
      return;
    }

    // Check if a raid redirect recently happened (within last 15 seconds)
    // This prevents auto-switch from overriding a raid redirect
    const timeSinceRaidRedirect = Date.now() - lastRaidRedirectTime;
    const RAID_COOLDOWN_MS = 15000; // 15 seconds
    if (lastRaidRedirectTime > 0 && timeSinceRaidRedirect < RAID_COOLDOWN_MS) {
      Logger.debug(`[AutoSwitch] Skipping - raid redirect occurred ${Math.round(timeSinceRaidRedirect / 1000)}s ago`);
      return;
    }

    // Check if auto-switch is enabled
    const autoSwitchEnabled = settings.auto_switch?.enabled ?? true;
    if (!autoSwitchEnabled) {
      Logger.debug('[AutoSwitch] Disabled in settings');
      return;
    }

    if (!currentStream) {
      Logger.debug('[AutoSwitch] No current stream to switch from');
      return;
    }

    const gameName = currentStream.game_name;
    const currentUserLogin = currentStream.user_login;

    Logger.debug(`[AutoSwitch] Stream ${currentUserLogin} appears offline, verifying...`);
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
          Logger.debug(`[AutoSwitch] Stream is still online (attempt ${attempt + 1}), aborting auto-switch`);
          set({ isAutoSwitching: false });
          return;
        }

        Logger.debug(`[AutoSwitch] Stream confirmed offline (attempt ${attempt + 1})`);
      }

      isOffline = true;

      if (!isOffline) {
        set({ isAutoSwitching: false });
        return;
      }

      Logger.debug(`[AutoSwitch] Stream ${currentUserLogin} confirmed offline`);

      // Check if user prefers to stay in offline chat
      if (settings.auto_switch?.stay_in_offline_chat) {
        Logger.debug('[AutoSwitch] User prefers to stay in offline chat. Transitioning to offline chat mode...');
        set({ isAutoSwitching: false });
        
        // Stop the stream (video player) but DO NOT stop chat
        try {
          await invoke('stop_stream');
          Logger.debug('[AutoSwitch] Stream video stopped for offline mode');
        } catch (e) {
          Logger.warn('[AutoSwitch] Error stopping stream video:', e);
        }

        // We also want to trigger startOfflineChat to ensure we load the VOD and set the correct state
        if (currentStream) {
          // We can't await this directly without causing a loop if it fails, so we run it async
          setTimeout(() => {
            get().startOfflineChat(currentUserLogin, currentStream);
          }, 100);
        }
        return;
      }

      // Step 2: Clean up current stream connections thoroughly
      Logger.debug('[AutoSwitch] Cleaning up current stream connections...');

      try {
        await invoke('stop_stream');
        Logger.debug('[AutoSwitch] Stream stopped');
      } catch (e) {
        Logger.warn('[AutoSwitch] Error stopping stream:', e);
      }

      try {
        await invoke('stop_chat');
        Logger.debug('[AutoSwitch] Chat stopped');
      } catch (e) {
        Logger.warn('[AutoSwitch] Error stopping chat:', e);
      }

      try {
        await invoke('stop_drops_monitoring');
        Logger.debug('[AutoSwitch] Drops monitoring stopped');
      } catch (e) {
        Logger.warn('[AutoSwitch] Error stopping drops monitoring:', e);
      }

      // Clear current stream state
      set({ streamUrl: null, activeQuality: null, availableQualities: [], adSource: null, currentStream: null, currentMediaType: null });

      // Step 3: Find the next best stream based on mode
      const switchMode = settings.auto_switch?.mode ?? 'same_category';
      let streams: TwitchStream[] = [];

      if (switchMode === 'same_category') {
        // Switch to same category - find streams in the same game
        if (!gameName) {
          Logger.debug('[AutoSwitch] No game category for current stream');
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. Unable to find similar streams.`, 'info');
          }
          set({ isAutoSwitching: false });
          return;
        }

        Logger.debug(`[AutoSwitch] Looking for streams in category: ${gameName}`);

        const streamsResponse = await invoke('get_streams_by_game_name', {
          gameName: gameName,
          excludeUserLogin: currentUserLogin,
          limit: 10
        }) as [TwitchStream[], string | null];
        
        streams = streamsResponse[0] || [];

        if (!streams || streams.length === 0) {
          Logger.debug('[AutoSwitch] No other streams found in this category');
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. No other ${gameName} streams available.`, 'info');
          }
          set({ isAutoSwitching: false });
          return;
        }
      } else if (switchMode === 'followed_streams') {
        // Switch to followed streams - get live followed streamers
        Logger.debug('[AutoSwitch] Looking for live followed streams');

        try {
          // Load fresh followed streams data
          const followedStreams = await invoke('get_followed_streams') as TwitchStream[];

          // Filter out the current (now offline) streamer
          streams = followedStreams.filter(s => s.user_login.toLowerCase() !== currentUserLogin.toLowerCase());

          if (!streams || streams.length === 0) {
            Logger.debug('[AutoSwitch] No other followed streams are live');
            if (settings.auto_switch?.show_notification ?? true) {
              state.addToast(`${currentUserLogin} went offline. No other followed streams are live.`, 'info');
            }
            set({ isAutoSwitching: false });
            return;
          }

          // Sort by viewer count (highest first) to pick the most popular one
          streams.sort((a, b) => (b.viewer_count || 0) - (a.viewer_count || 0));

        } catch (e) {
          Logger.error('[AutoSwitch] Error fetching followed streams:', e);
          if (settings.auto_switch?.show_notification ?? true) {
            state.addToast(`${currentUserLogin} went offline. Unable to load followed streams.`, 'error');
          }
          set({ isAutoSwitching: false });
          return;
        }
      }

      // The first stream is the highest viewer count (already sorted by API)
      const nextStream = streams[0];

      Logger.debug(`[AutoSwitch] Found next stream: ${nextStream.user_name} (${nextStream.viewer_count} viewers)`);

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

      Logger.debug(`[AutoSwitch] Successfully switched to ${nextStream.user_name}`);

    } catch (e) {
      Logger.error('[AutoSwitch] Error during auto-switch:', e);
      state.addToast('Auto-switch failed. Please select a new stream manually.', 'error');
    } finally {
      set({ isAutoSwitching: false });
    }
  },

  addToast: (message, type, action, options) => {
    const ln = get().settings?.live_notifications;
    // error / warning always surface; so do callers that explicitly opt in via
    // { alwaysShow: true } — used for accolade / achievement unlocks (incl. the
    // hidden grind ones), which are celebratory milestones that should land
    // even when the user has muted routine notifications.
    const alwaysShow = type === 'error' || type === 'warning' || options?.alwaysShow === true;

    // Mirror action feedback into the Dynamic Island: these are notifications
    // too, so they should leave a record in the notification center even when
    // the toast surface is muted. Gated by the same island toggles the passive
    // notifications use. The passive callers (live/whisper/drop/badge...) pass
    // { skipIsland: true } because they already register their own island entry,
    // and the rich JSX toasts can't ride the (string-only) event bus anyway, so
    // this only fires for the ~80 string action toasts.
    if (!options?.skipIsland && typeof message === 'string') {
      const islandOn = !ln || (ln.enabled !== false && ln.use_dynamic_island !== false);
      if (islandOn) {
        emit('action-notification', { text: message, level: type }).catch(() => {});
      }
    }

    // Gate the minor "action feedback" toasts (copy, follow, mod result,
    // quality change, login, etc.) behind the user's notification settings.
    // A muted user should not get popped at for routine confirmations.
    //   - error / warning: ALWAYS surface. A failed or blocked action must
    //     never be silently swallowed, regardless of the toggles.
    //   - everything else (success / info / live / channel_points): only when
    //     notifications are enabled AND the Toast surface is on.
    // The passive notifications (went-live, whisper, drop, badge...) already
    // pass this gate, because DynamicIsland only routes them here when those
    // same toggles are on, so this is a no-op for them and a real gate for the
    // ~80 direct action callers that previously ignored the settings entirely.
    if (!alwaysShow) {
      if (ln && (ln.enabled === false || ln.use_toast === false)) {
        return;
      }
    }

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
    // Migrate the retired second OLED theme: it was a fixed-orange variant of the
    // now-unified OLED theme. Move those users onto OLED with the orange accent
    // preserved, so their look is unchanged.
    if (settings.theme === 'prince0fdubai-oled-v2') {
      settings.theme = 'prince0fdubai-oled';
      if (!settings.oled_accent) settings.oled_accent = '#ff9933';
    }
    const state = get();
    if (state.isTheaterMode) {
      set({ settings, originalChatPlacement: settings.chat_placement });
    } else {
      set({ settings, chatPlacement: settings.chat_placement });
    }

    // Sync diagnostic logging state to both frontend and backend
    const diagnosticsEnabled = settings.error_reporting_enabled !== false;
    setDiagnosticsEnabled(diagnosticsEnabled);
    invoke('set_diagnostics_enabled', { enabled: diagnosticsEnabled }).catch((e) => {
      Logger.warn('[Diagnostics] Failed to sync to backend:', e);
    });

    // Tell the resolver which video codecs this machine can decode (capability-probed
    // here in the webview), gated by the enhanced-codecs setting. Must run before any
    // stream resolves, so the resolver can prefer AV1/HEVC where decodable.
    reportCodecPreference(settings.streamlink?.enhanced_codecs ?? true);

    // Connect to Discord if enabled
    if (settings.discord_rpc_enabled) {
      try {
        await invoke('connect_discord');
      } catch (e) {
        Logger.warn('Could not connect to Discord:', e);
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
    // Broadcast so any other open windows (main + MultiChats) refresh their
    // in-memory settings without needing to be reopened. Fire-and-forget; the
    // helper swallows errors in non-Tauri contexts.
    void emitSettingsUpdated();

    const state = get();
    if (state.isTheaterMode) {
      // Don't un-hide the chat if we're in compact/theater mode, just quietly update the original placement
      set({ settings: newSettings, originalChatPlacement: newSettings.chat_placement });
    } else {
      set({ settings: newSettings, chatPlacement: newSettings.chat_placement });
    }

    // Sync diagnostic logging state if it changed
    if (newSettings.error_reporting_enabled !== oldSettings.error_reporting_enabled) {
      const diagnosticsEnabled = newSettings.error_reporting_enabled !== false;
      setDiagnosticsEnabled(diagnosticsEnabled);
      invoke('set_diagnostics_enabled', { enabled: diagnosticsEnabled }).catch((e) => {
        Logger.warn('[Diagnostics] Failed to sync to backend:', e);
      });
    }

    // Handle Discord enable/disable toggle
    if (newSettings.discord_rpc_enabled !== oldSettings.discord_rpc_enabled) {
      if (newSettings.discord_rpc_enabled) {
        try {
          await invoke('connect_discord');
          
          let multiNookModule;
          try { multiNookModule = await import('./multiNookStore'); } catch { /* ignore */ }
          const multiNookState = multiNookModule ? multiNookModule.usemultiNookStore.getState() : null;
          
          if (multiNookState && multiNookState.isMultiNookActive && multiNookState.slots.length > 0) {
            multiNookModule?.broadcastMultiNookPresence(multiNookState.slots);
          } else if (get().currentStream) {
            const currentStream = get().currentStream!;
            invoke('update_discord_presence', {
              details: `Watching ${currentStream.user_name}`,
              activityState: currentStream.title || 'Live on Twitch',
              largeImage: '',
              smallImage: '',
              startTime: Date.now(),
              gameName: currentStream.game_name || '',
              streamUrl: `https://twitch.tv/${currentStream.user_login}`,
            }).catch(() => {});
          } else {
             invoke('set_idle_discord_presence').catch(() => {});
          }
        } catch (e) {
          Logger.warn('Could not connect to Discord:', e);
        }
      } else {
        try {
          await invoke('disconnect_discord');
        } catch (e) {
          Logger.warn('Could not disconnect from Discord:', e);
        }
      }
    }
  },
  loadFollowedStreams: async () => {
    try {
      const streams = await invoke('get_followed_streams') as TwitchStream[];
      set({ followedStreams: streams });

      // Fetch batched watch streaks for live followed streams.
      // 1h TTL — see WATCH_STREAKS_TTL_MS above for why this matters.
      const now = Date.now();
      if (streams.length > 0 && now - lastWatchStreaksFetchAt > WATCH_STREAKS_TTL_MS) {
        lastWatchStreaksFetchAt = now; // Set optimistically to dedupe concurrent callers.
        const channelIds = streams.map(s => s.user_id);
        invoke('get_watch_streaks_batch', { channelIds })
          .then(res => {
            const streakData = res as Record<string, { streak_count: number; share_status: string }>;
            Logger.debug('[WatchStreak] Batched response data:', streakData);
            const formattedStreaks: Record<string, number> = {};
            for (const [id, summary] of Object.entries(streakData)) {
              if (summary.streak_count > 0) {
                formattedStreaks[id] = summary.streak_count;
              }
            }
            // Merge with existing streaks to avoid clearing others
            set(state => ({ watchStreaks: { ...state.watchStreaks, ...formattedStreaks } }));
          })
          .catch(e => {
            // Roll back the timestamp so a retry can happen
            lastWatchStreaksFetchAt = 0;
            Logger.debug('[Sidebar] Failed to fetch batched watch streaks:', e);
          });
      }

    } catch (e) {
      Logger.warn('Could not load followed streams:', e);
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
      Logger.warn('Could not load recommended streams:', e);
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
      Logger.warn('Could not load more recommended streams:', e);
      set({ isLoadingMore: false, hasMoreRecommended: false });
    }
  },
  openClipModal: (url, info, opts) => {
    trackActivity(`Opened clip modal: ${info?.title || url}`);
    set({
      clipModal: {
        url,
        info,
        created: opts?.created,
        editUrl: opts?.editUrl,
        shareOnly: opts?.shareOnly,
      },
    });
  },
  closeClipModal: () => set({ clipModal: null }),
  openClipEditor: (opts) => set({ clipEditor: opts }),
  closeClipEditor: () => set({ clipEditor: null }),
  createClip: async () => {
    const { currentStream, currentMediaType, addToast, isCreatingClip, originalMediaUrl } = get();
    if (isCreatingClip) return; // debounce rapid presses (keybind/button/palette)
    const isLive = currentMediaType === 'live';
    // A VOD is clippable whether it's playing directly (currentMediaType
    // 'video') OR auto-loaded into the offline-chat space — both expose it via
    // originalMediaUrl (https://twitch.tv/videos/<id>).
    const vodId = isLive ? undefined : originalMediaUrl?.match(/\/videos\/(\d+)/)?.[1];
    // A truly-offline channel (no VOD loaded) or a clip already playing can't be.
    if (!currentStream || (!isLive && !vodId)) {
      addToast('Play a live stream or VOD to clip it', 'warning');
      return;
    }
    const channelName = currentStream.user_name || currentStream.user_login || 'this channel';

    // Live AND VOD both go through the same GQL trim editor → clean share card.
    // Live: resolve the broadcast id + uptime first (the editor then captures the
    // recent ~90s of the live broadcast via the identical raw-media flow).
    if (isLive) {
      set({ isCreatingClip: true });
      try {
        const live = await invoke<{ broadcast_id: string; started_at: string }>(
          'get_live_broadcast',
          { broadcasterId: currentStream.user_id },
        );
        const offsetSeconds = live.started_at
          ? Math.max(0, Math.floor((Date.now() - new Date(live.started_at).getTime()) / 1000))
          : 0;
        // A clip grabs the ~30s before the live edge; a stream <30s old has
        // nothing to capture yet (endless "Preparing…"), so nudge instead.
        if (offsetSeconds < 30) {
          addToast('This stream just started — give it ~30s before clipping', 'warning');
          return;
        }
        trackActivity(`Created a clip of ${channelName}`);
        get().openClipEditor({ broadcastId: live.broadcast_id, offsetSeconds, channelName });
      } catch (e) {
        const code = String(e);
        const msg = code.includes('OFFLINE')
          ? 'You can only clip a live stream'
          : code.includes('REAUTH')
            ? 'Log out and back in to enable clip creation'
            : 'Could not start a clip';
        addToast(msg, 'error');
        Logger.error('[createClip] live failed:', e);
      } finally {
        set({ isCreatingClip: false });
      }
      return;
    }

    // VOD → the trim editor. A clip captures the ~30s BEFORE the playhead; in the
    // VOD's first 30s there's nothing to grab, so block it up front (the editor
    // refines the exact in/out from there).
    const vodOffset = Math.floor(getPlayerControls()?.getCurrentTime() ?? 0);
    if (vodOffset < 30) {
      addToast('Move ~30s into the VOD first — a clip grabs the previous 30s', 'warning');
      return;
    }
    get().openClipEditor({ vodId: vodId as string, offsetSeconds: vodOffset, channelName });
  },
  playMedia: async (type: 'clip' | 'video', url: string, info: MediaInfo) => {
    set({ isLoading: true });
    trackActivity(`Started watching ${type}: ${info?.title || info?.id}`);
    try {
      const { settings, stopStream, currentStream } = get();

      // Ensure exact channel termination
      if (currentStream) {
        await stopStream();
      }
      const result = await invoke<StreamStartResult>('start_stream', { url: url, quality: settings.quality });
      logQualityFallback(settings.quality, result.quality);
      const parsedInfo: TwitchStream = {
        id: info.id || '',
        user_id: info.broadcaster_id || info.user_id || '',
        user_name: info.broadcaster_name || info.user_name || 'StreamNook Media',
        user_login: '',
        title: info.title || `Twitch ${type}`,
        viewer_count: info.view_count || 0,
        game_name: type === 'clip' ? 'Twitch Clip' : 'Twitch Video',
        thumbnail_url: info.thumbnail_url || '',
        profile_image_url: '',
        started_at: info.created_at || new Date().toISOString(),
      };

      set({
        streamUrl: result.url,
        activeQuality: result.quality,
        adSource: adSourceFrom(result), availableQualities: result.available ?? [],
        currentStream: parsedInfo,
        currentMediaType: type,
        originalMediaUrl: url,
        isHomeActive: false,
        // Preserve the origin category so the back button works for clips/VODs.
        // stopStream() clears this, so we re-set it here from the current navigation context.
        streamOriginCategory: get().homeSelectedCategory || null,
      });
      
    } catch (e: unknown) {
      Logger.error(`Failed to start ${type}:`, e);
      get().addToast(`Failed to load ${type}: ${String(e)}`, 'error');
      set({ isHomeActive: true, currentMediaType: null, currentStream: null, streamUrl: null, activeQuality: null });
    } finally {
      set({ isLoading: false });
    }
  },
  stopStream: async (options) => {
    const preserveBackend = options?.preserveBackend ?? false;
    trackActivity('Stopped stream');
    try {
      await invoke('stop_stream');

      // preserveBackend: handing the channel off to MultiNook, which keeps
      // watching it. Leave the chat bridge, EventSub, drops monitoring and
      // active-channel registration running so MultiNook inherits them intact.
      // Tearing the chat bridge down here would race MultiNook's re-acquire of
      // the same channel and leave chat stuck "connecting" (the IRC connection
      // would already be gone — hence the "IRC connection not established" PART).
      if (!preserveBackend) {
        await invoke('stop_chat');

        // Stop drops monitoring
        try {
          await invoke('stop_drops_monitoring');
          Logger.debug('Stopped drops monitoring');
        } catch (e) {
          Logger.warn('Could not stop drops monitoring:', e);
        }

        const currentStream = get().currentStream;
        if (currentStream?.user_id) {
           invoke('unregister_active_channel', { channelId: currentStream.user_id }).catch(() => {});
        }

        // Clean up EventSub listeners
        Logger.debug('[EventSub] Cleaning up listeners on stop...');
        for (const cleanup of eventSubListenerCleanup) {
          cleanup();
        }
        eventSubListenerCleanup = [];

        // Disconnect EventSub
        try {
          await invoke('disconnect_eventsub');
          Logger.debug('Disconnected EventSub');
        } catch (e) {
          Logger.warn('Could not disconnect EventSub:', e);
        }

        // Drop the per-chatter store (mention list + each talker's paint/badge
        // data). It is otherwise only cleared on a channel SWITCH, so a plain
        // exit left every user from the last channel resident. Releasing it here
        // means a full exit actually frees that reference.
        try {
          const { useChatUserStore } = await import('./chatUserStore');
          useChatUserStore.getState().clearUsers();
        } catch (e) {
          Logger.warn('Could not clear chat user store on stop:', e);
        }
      }

      set({ streamUrl: null, activeQuality: null, availableQualities: [], adSource: null, currentStream: null, currentMediaType: null, currentHypeTrain: null, streamOriginCategory: null });

      // Set idle Discord presence when not watching (skip during a MultiNook
      // handoff — MultiNook publishes its own presence for the grid).
      if (!preserveBackend && get().settings.discord_rpc_enabled) {
        try {
          await invoke('set_idle_discord_presence');
        } catch (e) {
          Logger.warn('Could not set idle Discord presence:', e);
        }
      }

    } catch (e) {
      Logger.error('Failed to stop stream:', e);
    }
  },

  restartStream: async () => {
    const { currentStream, settings, currentMediaType } = get();
    if (!currentStream) {
      Logger.warn('[Stream] Cannot restart: no current stream');
      return;
    }

    if (currentMediaType && currentMediaType !== 'live') {
      Logger.warn('[Stream] Cannot restart non-live media (clips/videos).');
      return;
    }

    Logger.info(`[Stream] Restarting stream for ${currentStream.user_login}...`);
    trackActivity('Restarted stream');

    // Save current stream info
    const channel = currentStream.user_login;
    const streamInfo = { ...currentStream };
    const quality = settings.quality;

    // If we somehow landed here with an empty user_id (e.g. a previous startStream
    // hit a transient get_channel_info failure during a raid), repair it before
    // restarting — otherwise the Follow / Subscribe buttons stay broken across refresh.
    if (!streamInfo.user_id) {
      try {
        const rawInfo = await invoke<{ broadcaster_id?: string; broadcaster_name?: string; title?: string; game_name?: string }>('get_channel_info', { channelName: channel });
        if (rawInfo.broadcaster_id) {
          streamInfo.user_id = rawInfo.broadcaster_id;
          if (rawInfo.broadcaster_name) streamInfo.user_name = rawInfo.broadcaster_name;
          if (rawInfo.title) streamInfo.title = rawInfo.title;
          if (rawInfo.game_name) streamInfo.game_name = rawInfo.game_name;
          Logger.debug(`[Stream] Repaired missing user_id for ${channel} -> ${streamInfo.user_id}`);
        }
      } catch (e) {
        Logger.warn(`[Stream] Could not repair missing user_id for ${channel}:`, e);
      }
    }
    
    try {
      // Freeze the running player's loader BEFORE the backend goes down: the relay
      // and its LL origin stop here, but the old hls.js instance lives until the
      // new streamUrl lands (~1-2s of resolve), and polling a dead origin in that
      // window churns non-fatal errors (fragGap "GAP tag found", empty loads).
      set({ isRestartingStream: true });

      // Stop the current stream (but don't clean up everything)
      await invoke('stop_stream');

      // Small delay to ensure clean stop
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Restart with the same channel
      const url = `https://twitch.tv/${channel}`;
      Logger.debug(`[Stream] Restarting: ${url} at quality: ${quality}`);
      
      const result = await invoke<StreamStartResult>('start_stream', { url, quality });
      Logger.debug('[Stream] Restarted successfully:', result.url);
      logQualityFallback(quality, result.quality);

      set({ streamUrl: result.url, activeQuality: result.quality, adSource: adSourceFrom(result), availableQualities: result.available ?? [], currentStream: streamInfo, isRestartingStream: false });

      // Show toast notification
      get().addToast('Stream restarted with new settings', 'success');
    } catch (e) {
      Logger.error('[Stream] Failed to restart:', e);
      get().addToast('Failed to restart stream', 'error');

      // Try to recover by starting fresh
      try {
        await get().startStream(channel, streamInfo);
      } catch (retryError) {
        Logger.error('[Stream] Retry also failed:', retryError);
      }
    } finally {
      // Always release the freeze; on the recovery path startStream set a fresh
      // streamUrl and the remounted player must be allowed to load.
      if (get().isRestartingStream) set({ isRestartingStream: false });
    }
  },

  reloadStreamAndChat: async () => {
    const { currentStream, currentMediaType } = get();
    if (!currentStream) {
      Logger.warn('[Stream] Cannot reload: no current stream');
      return;
    }
    // Kick off the stream restart and the chat hard-refresh together so one
    // press reloads both at once instead of serially. Chat only applies to a
    // live channel (clips/VODs hold no IRC connection), matching restartStream's
    // own live-only guard. Promise.allSettled so a failure in one half doesn't
    // abort the other.
    const tasks: Promise<unknown>[] = [get().restartStream()];
    if (currentMediaType === 'live' && currentStream.user_login) {
      tasks.push(
        (async () => {
          // Dynamic import to avoid a static cycle (chatConnectionStore imports
          // this store). Mirrors how commandHandler reaches the chat store.
          const { hardRefreshChannel } = await import('./chatConnectionStore');
          await hardRefreshChannel(currentStream.user_login, currentStream.user_id ?? null);
        })(),
      );
    }
    await Promise.allSettled(tasks);
  },

  getAvailableQualities: async () => {
    // Primary source: the menu the native resolver already returned with the
    // stream start, so it always matches what's playing and needs no re-resolve.
    const stored = get().availableQualities;
    if (stored.length > 0) {
      return stored;
    }

    // Fallback (e.g. a resumed session where we don't have a fresh start
    // result): probe the backend directly.
    const currentStream = get().currentStream;
    if (!currentStream) {
      return [];
    }
    try {
      const { currentMediaType, originalMediaUrl } = get();
      const targetUrl = (currentMediaType !== 'live' && originalMediaUrl) ? originalMediaUrl : `https://twitch.tv/${currentStream.user_login}`;
      const qualities = await invoke('get_stream_qualities', { url: targetUrl }) as string[];
      Logger.debug('[Qualities] Available:', qualities);
      return qualities;
    } catch (e) {
      Logger.error('Failed to get stream qualities:', e);
      return [];
    }
  },

  applyAdPivot: (url, region) => {
    // A resolution-owning plugin already swapped the relay's upstream
    // (set_upstream); pointing the player at the fresh localhost URL re-inits
    // hls.js on the clean source (same mechanism as a quality change).
    const cur = get().adSource;
    Logger.info(`[AdPivot] reloading player on the swapped upstream${region ? ` (${region})` : ''}`);
    set({
      streamUrl: url,
      adSource: cur ? { ...cur, region } : { mode: 'plugin', entitled: false, region },
    });
  },

  changeStreamQuality: async (quality: string) => {
    const currentStream = get().currentStream;
    if (!currentStream) {
      Logger.warn('No active stream to change quality');
      return;
    }

    trackActivity(`Changed quality to: ${quality}`);
    try {
      Logger.debug(`[Quality] Changing to: ${quality}`);
      // Same freeze as restartStream: the backend relay restarts inside
      // change_stream_quality, so the old player must stop polling it.
      set({ isLoading: true, isRestartingStream: true });

      const { currentMediaType, originalMediaUrl } = get();
      const targetUrl = (currentMediaType !== 'live' && originalMediaUrl) ? originalMediaUrl : `https://twitch.tv/${currentStream.user_login}`;

      const result = await invoke<StreamStartResult>('change_stream_quality', {
        url: targetUrl,
        quality: quality
      });

      // Persist the user's choice (the *intent*), not the actually-played
      // quality — next stream might offer the requested one even if this one
      // didn't.
      const newSettings = { ...get().settings, quality: quality };
      await invoke('save_settings', { settings: newSettings });
      void emitSettingsUpdated();

      set({ streamUrl: result.url, activeQuality: result.quality, adSource: adSourceFrom(result), availableQualities: result.available ?? [], settings: newSettings, isLoading: false, isRestartingStream: false });
      if (qualitiesEquivalent(quality, result.quality)) {
        get().addToast(`Quality changed to ${result.quality}`, 'success');
      } else {
        Logger.info(`[Stream] Quality fallback: ${quality} -> ${result.quality}`);
        get().addToast(`Quality "${quality}" unavailable, switched to "${result.quality}"`, 'info');
      }
      Logger.debug('[Quality] Stream URL updated:', result.url);
      Logger.debug('[Quality] Settings updated with new quality preference:', quality);
    } catch (e) {
      Logger.error('Failed to change quality:', e);
      get().addToast(`Failed to change quality: ${e}`, 'error');
      set({ isLoading: false, isRestartingStream: false });
    }
  },
  startStream: async (channel, providedStreamInfo?, skipChatRefresh = false) => {
    set({ isLoading: true });
    trackActivity(`Started watching: ${channel}`);
    try {
      const requestedQuality = get().settings.quality;
      const result = await invoke<StreamStartResult>('start_stream', { url: `https://twitch.tv/${channel}`, quality: requestedQuality });
      logQualityFallback(requestedQuality, result.quality);

      // Use the provided stream info, or find it from followed streams, or fetch it
      let info: TwitchStream;
      
      // First try to find it in followed streams as it has the most complete, live data
      const followedStreamInfo = get().followedStreams.find(s => s.user_login.toLowerCase() === channel.toLowerCase());
      
      if (followedStreamInfo) {
        info = followedStreamInfo;
      } else if (providedStreamInfo && providedStreamInfo.user_id) {
        // Provided info has a user_id, so it's complete enough to drive the
        // stream. But a seeded object (e.g. a raid redirect, which only knows
        // the target's user_id) can arrive with an empty title and category.
        // Left blank, the player overlay drops its title and Home button (both
        // gated on a non-empty title) and Discord RPC falls back to the app
        // logo instead of the real category art. Backfill the missing fields
        // from a channel-info lookup. On failure we keep whatever was provided.
        info = providedStreamInfo;
        if (!info.title?.trim() || !info.game_name?.trim()) {
          try {
            const rawInfo = await invoke<{ title?: string; game_name?: string }>('get_channel_info', { channelName: channel });
            info = {
              ...info,
              title: info.title?.trim() ? info.title : (rawInfo.title || ''),
              game_name: info.game_name?.trim() ? info.game_name : (rawInfo.game_name || ''),
            };
          } catch (e) {
            Logger.warn('Could not backfill channel info for seeded stream:', e);
          }
        }
      } else {
        // Fallback: get channel info to get the user_id and other details
        try {
          const rawInfo = await invoke<{ title?: string; game_name?: string; broadcaster_id?: string; broadcaster_name?: string }>('get_channel_info', { channelName: channel });
          info = {
            id: providedStreamInfo?.id || '',
            user_id: rawInfo.broadcaster_id || '',
            user_name: rawInfo.broadcaster_name || providedStreamInfo?.user_name || channel,
            user_login: channel.toLowerCase(),
            title: rawInfo.title || providedStreamInfo?.title || `Watching ${channel}`,
            viewer_count: providedStreamInfo?.viewer_count || 0,
            game_name: rawInfo.game_name || providedStreamInfo?.game_name || '',
            thumbnail_url: providedStreamInfo?.thumbnail_url || '',
            profile_image_url: providedStreamInfo?.profile_image_url || '',
            started_at: providedStreamInfo?.started_at || new Date().toISOString(),
          };
        } catch (e) {
          Logger.warn('Could not get channel info:', e);
          info = providedStreamInfo || {
            id: '',
            user_id: '',
            user_name: channel,
            user_login: channel.toLowerCase(),
            title: `Watching ${channel}`,
            viewer_count: 0,
            game_name: '',
            thumbnail_url: '',
            started_at: new Date().toISOString(),
          };
        }
      }

      set({ streamUrl: result.url, activeQuality: result.quality, adSource: adSourceFrom(result), availableQualities: result.available ?? [], currentStream: info, currentMediaType: 'live', originalMediaUrl: null, isHomeActive: false });

      // Start chat first - only if authenticated and not skipping refresh
      if (get().isAuthenticated && !skipChatRefresh) {
        try {
          await invoke('start_chat', { channel });
        } catch (e) {
          Logger.warn('Could not start chat:', e);
          // Chat connection failed, but stream can still work
        }
      } else if (skipChatRefresh) {
        Logger.debug(`[Stream] Skipping chat refresh for ${channel} (Seamless Auto-Switch enabled)`);
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
          Logger.debug('Started drops monitoring for', channelName);
          
          invoke('register_active_channel', { channelId }).catch(() => {});

          // Auto-reserve watch token for this stream (if enabled in settings)
          // This ensures the user is "present" in chat for gifted sub eligibility
          try {
            const dropsSettings = await invoke<{ reserve_token_for_current_stream?: boolean; auto_reserve_on_watch?: boolean }>('get_drops_settings');
            if (dropsSettings?.reserve_token_for_current_stream && dropsSettings?.auto_reserve_on_watch) {
              await invoke('set_reserved_channel', {
                channelId,
                channelLogin: channelName
              });
              Logger.debug('Auto-reserved watch token for', channelName);
            }
          } catch (reserveError) {
            Logger.warn('Could not auto-reserve watch token:', reserveError);
            // Non-critical, stream can still work
          }
        }
      } catch (e) {
        Logger.warn('Could not start drops monitoring:', e);
        // Non-critical, stream can still work
      }

      // Update Discord with game matching (don't await - let it run in background)
      if (get().settings.discord_rpc_enabled) {
        const presenceArgs = {
          details: `Watching ${info.user_name}`,
          activityState: info.title || 'Live on Twitch',
          largeImage: 'icon_256x256',
          smallImage: 'twitch_logo',
          startTime: Date.now(),
          gameName: info.game_name || '',
          streamUrl: `https://twitch.tv/${channel}`,
        };

        Logger.debug('[Discord] Updating presence for stream:', {
          user: info.user_name,
          title: info.title,
          game: info.game_name,
          channel: channel
        });

        invoke('update_discord_presence', presenceArgs).then(() => {
          Logger.debug('[Discord] Presence updated successfully');
        }).catch((e) => {
          Logger.warn('[Discord] Could not update presence (Discord may not be running):', e);
        });
      }

      // Connect to EventSub for real-time events (only if authenticated)
      const channelId = info.user_id;
      const autoRedirectOnRaid = get().settings.auto_switch?.auto_redirect_on_raid ?? true;

      if (channelId && get().isAuthenticated) {
        try {
          const currentConnectionId = ++eventSubConnectionId;

          // Clean up any existing event listeners first
          Logger.debug('[EventSub] Cleaning up existing listeners...');
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
          const unlistenRaid = await listen<{
            from_broadcaster_user_id: string;
            from_broadcaster_user_login: string;
            from_broadcaster_user_name: string;
            to_broadcaster_user_id: string;
            to_broadcaster_user_login: string;
            to_broadcaster_user_name: string;
            viewers: number;
          }>('eventsub://raid', async (event) => {
            if (!autoRedirectOnRaid) return;

            const raidData = event.payload;
            Logger.debug(`[EventSub] Raid detected! Redirecting to ${raidData.to_broadcaster_user_login} (${raidData.viewers} viewers)`);

            // Mark that a raid redirect is happening - this prevents auto-switch from overriding
            set({ lastRaidRedirectTime: Date.now() });

            // Show notification toast
            get().addToast(`Raid starting! Joining ${raidData.to_broadcaster_user_login}...`, 'info');

            // Small delay to let user see the notification
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Seed startStream with the user_id Twitch already gave us on the raid event.
            // Without this, startStream falls back to get_channel_info; if that one Helix call
            // hiccups, currentStream.user_id ends up empty and the Follow button no-ops until
            // the user closes the stream and re-opens it via search.
            const raidedStreamInfo: TwitchStream = {
              id: '',
              user_id: raidData.to_broadcaster_user_id,
              user_login: raidData.to_broadcaster_user_login,
              user_name: raidData.to_broadcaster_user_name || raidData.to_broadcaster_user_login,
              title: '',
              viewer_count: raidData.viewers,
              game_name: '',
              thumbnail_url: '',
              started_at: new Date().toISOString(),
            };

            // Start the new stream (this will also set up new EventSub subscription)
            await get().startStream(raidData.to_broadcaster_user_login, raidedStreamInfo);
          });
          
          if (currentConnectionId === eventSubConnectionId) {
            eventSubListenerCleanup.push(unlistenRaid);
          } else {
            unlistenRaid();
          }

          // Listen for stream offline events
          const unlistenOffline = await listen('eventsub://offline', () => {
            Logger.debug('[EventSub] Stream went offline via EventSub notification');
            // Use the existing handleStreamOffline which has all the auto-switch logic
            get().handleStreamOffline();
          });
          
          if (currentConnectionId === eventSubConnectionId) {
            eventSubListenerCleanup.push(unlistenOffline);
          } else {
            unlistenOffline();
          }

          // Listen for stream online events
          const unlistenOnline = await listen<{ broadcaster_user_login: string; broadcaster_user_name: string; id: string; started_at: string }>('eventsub://online', (event) => {
            const onlineData = event.payload;
            Logger.debug(`[EventSub] Stream went online for ${onlineData.broadcaster_user_login}`);
            
            const state = get();
            
            // Auto-Switch Logic: If the user is currently parked in this channel's offline chat room
            if (state.currentStream && state.currentStream.user_login === onlineData.broadcaster_user_login) {
                if (state.currentMediaType === 'offline_chat') {
                    Logger.info(`[EventSub] Auto-switching from offline chat to newly live stream: ${onlineData.broadcaster_user_login}`);
                    state.addToast(`${onlineData.broadcaster_user_name} just went live! Seamlessly connecting...`, 'success');
                    
                    const liveStreamObject: TwitchStream = {
                        ...state.currentStream,
                        id: onlineData.id || state.currentStream.id,
                        is_live: true,
                        started_at: onlineData.started_at || new Date().toISOString(),
                    };
                    
                    state.startStream(liveStreamObject.user_login, liveStreamObject, true);
                }
            }
          });

          if (currentConnectionId === eventSubConnectionId) {
            eventSubListenerCleanup.push(unlistenOnline);
          } else {
            unlistenOnline();
          }

          // Listen for channel update events
          const unlistenUpdate = await listen<{ title: string; category_name: string; category_id: string }>('eventsub://channel-update', (event) => {
            const updateData = event.payload;
            const currentStream = get().currentStream;
            if (currentStream) {
              Logger.debug(`[EventSub] Channel updated: "${updateData.title}" - ${updateData.category_name}`);
              const updatedStream = {
                ...currentStream,
                title: updateData.title,
                game_name: updateData.category_name,
                game_id: updateData.category_id,
              };
              set({ currentStream: updatedStream });

              // Re-broadcast rich presence with updated metadata
              const presenceArgs = {
                details: `Watching ${updatedStream.user_name}`,
                activityState: updatedStream.title || 'Live on Twitch',
                largeImage: '',
                smallImage: '',
                startTime: Date.now(),
                gameName: updatedStream.game_name || '',
                streamUrl: `https://twitch.tv/${updatedStream.user_login}`,
              };

              if (get().settings.discord_rpc_enabled) {
                invoke('update_discord_presence', presenceArgs).catch((e) => {
                  Logger.warn('[Discord] Could not update presence on channel change:', e);
                });
              }
            }
          });
          eventSubListenerCleanup.push(unlistenUpdate);

          // NOTE: the `eventsub://channel-moderate` listener is NOT here anymore.
          // The mod view is now driven by the dedicated, chat-tied moderation
          // socket, so its listener is mounted persistently (App.tsx for the main
          // window, MultiChatWindow.tsx for popouts) rather than per-stream. See
          // utils/applyModerateEvent.ts.

          // Surface EventSub subscription failures (e.g. channel.moderate dying
          // on a missing scope) instead of letting the mod-log pane sit silently
          // empty. Only channel.moderate is user-facing here; the rest just log.
          const unlistenSubFailed = await listen<{ type: string; status: number; error: string }>('eventsub://subscription-failed', (event) => {
            const { type, status, error } = event.payload;
            Logger.error(`[EventSub] Subscription failed: ${type} (HTTP ${status}): ${error}`);
            if (type === 'channel.moderate') {
              get().addToast(
                `Mod logs unavailable: ${error || 'subscription failed'} (HTTP ${status})`,
                'warning'
              );
            }
          });
          eventSubListenerCleanup.push(unlistenSubFailed);

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
                  Logger.debug(`[HypeTrain GQL] Level UP! ${hypeTrainPreviousLevel} → ${status.level}`);
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
                  Logger.debug('[HypeTrain GQL] Hype Train ended');
                  hypeTrainPreviousLevel = 0;
                  set({ currentHypeTrain: null });
                }
              }
            } catch {
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

          Logger.debug(`Connected to EventSub (channel: ${info.user_name})`);
        } catch (e) {
          Logger.warn('[EventSub] Could not connect:', e);
          // Non-critical, stream can still work
        }
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      Logger.error('Failed to start stream:', errorMessage);

      // Show toast error to user
      get().addToast(`Failed to start stream: ${errorMessage}`, 'error');
    } finally {
      set({ isLoading: false });
    }
  },
  startOfflineChat: async (channel, providedStreamInfo?) => {
    set({ isLoading: true });
    trackActivity(`Joined offline chat: ${channel}`);
    try {
      // Use the provided stream info, or find it or construct it
      let info: TwitchStream;
      const followedStreamInfo = get().followedStreams.find(s => s.user_login.toLowerCase() === channel.toLowerCase());
      
      if (followedStreamInfo) {
        info = followedStreamInfo;
      } else if (providedStreamInfo && providedStreamInfo.user_id) {
        info = providedStreamInfo;
      } else {
        try {
          const rawInfo = await invoke<{ title?: string; game_name?: string; broadcaster_id?: string; broadcaster_name?: string }>('get_channel_info', { channelName: channel });
          info = {
            id: providedStreamInfo?.id || '',
            user_id: rawInfo.broadcaster_id || '',
            user_name: rawInfo.broadcaster_name || providedStreamInfo?.user_name || channel,
            user_login: channel.toLowerCase(),
            title: rawInfo.title || providedStreamInfo?.title || `Offline Chat: ${channel}`,
            viewer_count: 0,
            game_name: rawInfo.game_name || providedStreamInfo?.game_name || '',
            thumbnail_url: providedStreamInfo?.thumbnail_url || '',
            profile_image_url: providedStreamInfo?.profile_image_url || '',
            started_at: providedStreamInfo?.started_at || new Date().toISOString(),
          };
        } catch (e) {
          Logger.warn('Could not get channel info for offline chat:', e);
          info = providedStreamInfo || {
            id: '',
            user_id: '',
            user_name: channel,
            user_login: channel.toLowerCase(),
            title: `Offline Chat: ${channel}`,
            viewer_count: 0,
            game_name: '',
            thumbnail_url: '',
            started_at: new Date().toISOString(),
          };
        }
      }

      // Try to fetch the latest video for the streamer
      let latestVideoUrl: string | null = null;
      let resolvedStreamUrl: string | null = null;
      let resolvedQuality: string | null = null;
      let streamContextForUI = { ...info };

      if (info.user_id) {
        try {
          const [videos] = await invoke<[TwitchVideo[], string | null]>('get_user_videos', {
            userId: info.user_id,
            sort: 'time',
            limit: 1
          });
          if (videos && videos.length > 0) {
            const latestVod = videos[0];
            latestVideoUrl = `https://twitch.tv/videos/${latestVod.id}`;
            Logger.debug(`[Offline Chat] Found recent VOD for ${channel}: ${latestVideoUrl}`);

            // Enrich the stream UI context with accurate VOD metadata
            streamContextForUI = {
              ...info,
              title: latestVod.title,
              started_at: latestVod.created_at,
              viewer_count: latestVod.view_count
            };

            // Resolve the actual playback URL through the native resolver
            try {
              const requestedQuality = get().settings.quality;
              const result = await invoke<StreamStartResult>('start_stream', { url: latestVideoUrl, quality: requestedQuality });
              resolvedStreamUrl = result.url;
              resolvedQuality = result.quality;
              logQualityFallback(requestedQuality, result.quality);
              Logger.debug(`[Offline Chat] Resolved VOD playback URL: ${resolvedStreamUrl}`);
            } catch (resolveError) {
              Logger.warn(`[Offline Chat] Could not resolve playback URL for VOD, falling back to banner:`, resolveError);
            }
          }
        } catch (e) {
          Logger.warn(`[Offline Chat] Failed to fetch recent video for ${channel}`, e);
        }
      }

      set({
        streamUrl: resolvedStreamUrl || 'offline',
        activeQuality: resolvedQuality,
        adSource: null,
        currentStream: streamContextForUI,
        currentMediaType: 'offline_chat',
        originalMediaUrl: latestVideoUrl,
        isHomeActive: false
      });

      // Connect chat
      if (get().isAuthenticated) {
        try {
          await invoke('start_chat', { channel });
          Logger.debug(`[Offline Chat] Connected chat for ${channel}`);
        } catch (e) {
          Logger.warn(`[Offline Chat] Could not connect chat for ${channel}:`, e);
        }
      }
    } catch (e) {
      Logger.error('[Offline Chat] Failed to join offline chat:', e);
      get().addToast(`Failed to join offline chat: ${e}`, 'error');
    } finally {
      set({ isLoading: false });
    }
  },
  openSettings: (initialTab?: SettingsTab, initialSection?: string) => {
    trackActivity('Opened Settings' + (initialTab ? ` (${initialTab})` : ''));
    set({
      isSettingsOpen: true,
      settingsInitialTab: initialTab || null,
      settingsInitialSection: initialSection || null,
    });
  },
  closeSettings: () => {
    trackActivity('Closed Settings');
    set({ isSettingsOpen: false, settingsInitialTab: null, settingsInitialSection: null });
  },
  openProfileViewer: (userId: string) => {
    // A normal view (another member, or self from chat) is never a preview:
    // drop any stale override so it can't leak onto this profile.
    set({ profileViewerUserId: userId, profileViewerPreview: null });
  },
  closeProfileViewer: () => {
    set({ profileViewerUserId: null, profileViewerPreview: null });
  },
  openProfilePreview: (userId, override) => {
    set({
      profileViewerUserId: userId,
      profileViewerPreview: {
        hiddenSections: override.hiddenSections,
        profileTheme: override.profileTheme,
        badgeRevision: 0,
      },
    });
  },
  updateProfilePreview: (partial) => {
    const cur = get().profileViewerPreview;
    if (!cur) return; // preview not open — safe no-op
    set({
      profileViewerPreview: {
        hiddenSections: partial.hiddenSections ?? cur.hiddenSections,
        profileTheme: partial.profileTheme ?? cur.profileTheme,
        badgeRevision: partial.bumpBadges ? cur.badgeRevision + 1 : cur.badgeRevision,
      },
    });
  },
  openCommandPalette: () => {
    if (!get().isCommandPaletteOpen) trackActivity('Opened Command Palette');
    set({ isCommandPaletteOpen: true });
  },
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),
  toggleCommandPalette: () => {
    const isOpen = get().isCommandPaletteOpen;
    if (!isOpen) trackActivity('Opened Command Palette');
    set({ isCommandPaletteOpen: !isOpen });
  },
  setUpdateInfo: (info) => set({ updateInfo: info }),
  setShowLiveStreamsOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Live Streams');
    set({ showLiveStreamsOverlay: show });
  },
  setShowDropsOverlay: (show: boolean) => {
    if (show) {
      trackActivity('Opened Drops');
      // Latch the "ever opened" flag so the sidebar can start showing the
      // drops gift indicator. Once true, stays true for the session.
      set({ showDropsOverlay: true, dropsOverlayEverOpened: true });
    } else {
      set({ showDropsOverlay: false });
    }
  },
  setShowBadgesOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Badges');
    // Clear initial deep-link state when closing
    set({
      showBadgesOverlay: show,
      badgesOverlayInitialPaintId: show ? get().badgesOverlayInitialPaintId : null,
      badgesOverlayInitialBadgeId: show ? get().badgesOverlayInitialBadgeId : null,
      badgesOverlayInitialStreamNook: show ? get().badgesOverlayInitialStreamNook : false,
      badgesOverlayInitialTarget: show ? get().badgesOverlayInitialTarget : null,
    });
  },
  openBadgesWithPaint: (paintId: string) => {
    trackActivity('Opened Badges with Paint');
    set({ showBadgesOverlay: true, badgesOverlayInitialPaintId: paintId, badgesOverlayInitialBadgeId: null, badgesOverlayInitialStreamNook: false, badgesOverlayInitialTarget: null });
  },
  openBadgesWithBadge: (badgeId: string) => {
    trackActivity('Opened Badges with Badge');
    set({ showBadgesOverlay: true, badgesOverlayInitialBadgeId: badgeId, badgesOverlayInitialPaintId: null, badgesOverlayInitialStreamNook: false, badgesOverlayInitialTarget: null });
  },
  openBadgesOnStreamNook: () => {
    trackActivity('Opened Badges on StreamNook');
    set({ showBadgesOverlay: true, badgesOverlayInitialStreamNook: true, badgesOverlayInitialPaintId: null, badgesOverlayInitialBadgeId: null, badgesOverlayInitialTarget: null });
  },
  openBadgesWithTarget: (target: { tab: string; query?: string }) => {
    trackActivity('Opened Badges with Target');
    set({ showBadgesOverlay: true, badgesOverlayInitialTarget: target, badgesOverlayInitialPaintId: null, badgesOverlayInitialBadgeId: null, badgesOverlayInitialStreamNook: false });
  },
  setShowEmoteSetsOverlay: (show: boolean) => {
    if (show) trackActivity('Opened Emote Sets');
    set({
      showEmoteSetsOverlay: show,
      emoteSetsOverlayInitialTwitchId: show ? get().emoteSetsOverlayInitialTwitchId : null,
      emoteSetsOverlayInitialTab: show ? get().emoteSetsOverlayInitialTab : null,
      emoteSpotlight: show ? get().emoteSpotlight : null,
    });
  },
  openEmoteSets: (opts?: { twitchId?: string; tab?: 'emotes' | 'sets' | 'editors' }) => {
    trackActivity('Opened Emote Sets');
    set({
      showEmoteSetsOverlay: true,
      emoteSetsOverlayInitialTwitchId: opts?.twitchId ?? null,
      emoteSetsOverlayInitialTab: opts?.tab ?? null,
    });
  },
  openEmoteSpotlight: (emoteId: string, name: string) => {
    trackActivity('Opened 7TV emote spotlight');
    // Opens ONLY the lightweight quick-add modal, not the full overlay. The
    // modal has its own "Open in 7TV Emote Manager" button to escalate.
    set({ emoteSpotlight: { id: emoteId, name } });
  },
  setEmoteSpotlight: (e: { id: string; name: string } | null) => set({ emoteSpotlight: e }),
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
      Logger.debug('Starting Twitch Device Code login...');

      // Use Device Code flow
      const [verificationUri, userCode] = await invoke('twitch_login') as [string, string];

      Logger.debug('Device code received:', userCode);
      Logger.debug('Verification URI:', verificationUri);

      // Show the user code to the user
      get().addToast(`Enter code ${userCode} at twitch.tv/activate`, 'info');

      // Open the verification URL in an in-app WebView window, isolated to the
      // active account's Twitch web profile. A per-account profile means each
      // account keeps its own browser session, so a re-login lands on the same
      // account and can't silently inherit a different account's web session.
      try {
        await invoke('open_twitch_login_window', { url: verificationUri });
        Logger.debug('In-app login window opened successfully');
      } catch (e) {
        Logger.error('Failed to open login window:', e);
        get().addToast(`Please visit ${verificationUri} and enter code: ${userCode}`, 'warning');
      }

      // Listen for login completion event from backend
      const { listen } = await import('@tauri-apps/api/event');

      const unlisten = await listen('twitch-login-complete', async () => {
        Logger.debug('Login complete event received');

        // Close the login window
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const loginWindow = await WebviewWindow.getByLabel('twitch-login');
          if (loginWindow) {
            Logger.debug('[TwitchLogin] Closing twitch-login webview window');
            await loginWindow.close();
            Logger.debug('[TwitchLogin] Successfully closed twitch-login window');
          } else {
            Logger.debug('[TwitchLogin] No twitch-login window found to close');
          }
        } catch (e) {
          Logger.warn('[TwitchLogin] Failed to close twitch-login window:', e);
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
          Logger.warn('Could not focus window:', e);
        }

        // Clean up listener
        unlisten();
      });

      // Also listen for login errors
      const unlistenError = await listen('twitch-login-error', async (event) => {
        Logger.error('Login error event received:', event.payload);
        const errorMessage = String(event.payload);
        get().addToast(`Login failed: ${errorMessage}`, 'error');
        set({ isLoading: false });

        // Also close the login window on error
        try {
          const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const loginWindow = await WebviewWindow.getByLabel('twitch-login');
          if (loginWindow) {
            Logger.debug('[TwitchLogin] Closing twitch-login window after error');
            await loginWindow.close();
          }
        } catch (e) {
          Logger.warn('[TwitchLogin] Failed to close twitch-login window on error:', e);
        }

        unlistenError();
      });

    } catch (e) {
      Logger.error('Login failed:', e);
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

      get().addToast('Successfully logged out from Twitch', 'success');
    } catch (e) {
      Logger.error('Logout failed:', e);
      get().addToast('Failed to logout. Please try again.', 'error');
    }
  },

  // Re-establish the watched identity after the primary slot's token changed
  // (an account switch or a sign-out that promoted another account). Mirrors the
  // post-login refresh: re-read who we are, reload follows + the account list,
  // and reconnect chat so the IRC connection re-auths as the new identity.
  reestablishIdentityAfterSwitch: async () => {
    await get().checkAuthStatus();
    await get().loadFollowedStreams();
    try {
      const { useSendAccountStore } = await import('./sendAccountStore');
      await useSendAccountStore.getState().loadAccounts();
    } catch (e) {
      Logger.warn('[Accounts] Could not refresh account list after switch:', e);
    }
    try {
      const { reconnectAllChannels } = await import('./chatConnectionStore');
      await reconnectAllChannels();
    } catch (e) {
      Logger.warn('[Accounts] Chat reconnect after switch failed:', e);
    }
  },

  setActiveAccount: async (userId: string) => {
    trackActivity('Switched main account');
    try {
      const { setActiveAccount } = await import('../services/accountService');
      const account = await setActiveAccount(userId);
      await get().reestablishIdentityAfterSwitch();
      get().addToast(`Now watching as @${account.login}`, 'success');
    } catch (e) {
      Logger.error('Switch main account failed:', e);
      get().addToast(typeof e === 'string' ? e : 'Could not switch main account', 'error');
      throw e;
    }
  },

  signOutActiveAccount: async () => {
    trackActivity('Signed out of main account');
    try {
      const { signOutActiveAccount } = await import('../services/accountService');
      const promoted = await signOutActiveAccount();
      if (promoted) {
        // Signing out the main landed us on a linked account instead of fully out.
        await get().reestablishIdentityAfterSwitch();
        get().addToast(`Signed out. Now watching as @${promoted.login}`, 'success');
      } else {
        // That was the last account: a full sign-out.
        set({ isAuthenticated: false, currentUser: null, followedStreams: [] });
        get().addToast('Successfully signed out from Twitch', 'success');
      }
    } catch (e) {
      Logger.error('Sign out of main failed:', e);
      get().addToast('Failed to sign out. Please try again.', 'error');
    }
  },

  checkAuthStatus: async () => {
    let hasCredentials = false;
    let authErrorMsg = '';
    
    try {
      // Check if we have stored credentials first (only on initial check, not periodic checks)
      const wasAuthenticated = get().isAuthenticated;
      hasCredentials = await invoke('has_stored_credentials') as boolean;

      if (!hasCredentials) {
        throw new Error('No stored credentials');
      }

      // Explicitly check token health to catch missing scopes (like moderation upgrades)
      try {
        const health = await invoke<{ is_valid: boolean; needs_refresh: boolean; error?: string }>('verify_token_health');
        
        // If the token is invalid specifically because of missing scopes, we must abort auth.
        // If it's invalid but `needs_refresh` is true, we let get_user_info handle the auto-refresh cycle natively.
        // If it's simply a network error on Twitch's end, we don't maliciously destroy the session.
        if (!health.is_valid && health.error && health.error.includes('Missing scopes')) {
          throw new Error(health.error);
        }
      } catch (healthErr) {
        const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
        
        // Re-throw only if it's explicitly the missing scopes error we care about
        if (msg.includes('Missing scopes')) {
          throw new Error(msg);
        }
        
        // Otherwise, gracefully ignore the health check failure (e.g. offline network or temporary 500 code) 
        // and let get_user_info function as the true source of truth for auth state and auto-refresh.
        Logger.debug('[Auth] verify_token_health failed or threw network error, proceeding to get_user_info fallback');
      }

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

      // Track user in Supabase for analytics (only on initial login, not periodic checks)
      if (!wasAuthenticated) {
        try {
          const appVersion = await invoke<string>('get_current_app_version');
          upsertUser(user, appVersion).catch((e) => {
            Logger.warn('[Auth] Failed to upsert user to Supabase:', e);
          });
        } catch (vErr) {
          Logger.warn('[Auth] Failed to get app version for stats:', vErr);
          upsertUser(user).catch((e) => {
            Logger.warn('[Auth] Failed to upsert user to Supabase:', e);
          });
        }

        // Collect today's season/holiday badges + cake day if applicable.
        // Idempotent server-side; fire and forget.
        grantActiveSeasonalAccolades(user.user_id).catch((e) => {
          Logger.warn('[Auth] Failed to grant seasonal badge:', e);
        });
        grantCakeDayAccolade(user.user_id, user.login || '').catch((e) => {
          Logger.warn('[Auth] Failed to grant cake day badge:', e);
        });
      }

      // If we successfully restored session from stored credentials, show success (only once)
      if (hasCredentials && !wasAuthenticated && !hasShownWelcomeBackToast) {
        hasShownWelcomeBackToast = true;
        get().addToast(`Welcome back, ${userInfo.display_name}!`, 'success');
      }

      // Start whisper listener after successful authentication
      try {
        await invoke('start_whisper_listener');
        Logger.debug('[Auth] Whisper listener started');
      } catch (whisperError) {
        Logger.warn('[Auth] Could not start whisper listener:', whisperError);
      }
    } catch (e) {
      // Check if user was previously authenticated (session expired)
      const wasAuthenticated = get().isAuthenticated;
      const previousUser = get().currentUser;
      authErrorMsg = e instanceof Error ? e.message : String(e);

      // If it fails, we're not authenticated
      set({ isAuthenticated: false, currentUser: null, followedStreams: [] });

      const isMissingScopes = authErrorMsg.includes('Missing scopes');
      const isNetworkError = authErrorMsg.toLowerCase().includes('error sending request') || 
                             authErrorMsg.toLowerCase().includes('timeout') || 
                             authErrorMsg.toLowerCase().includes('network') ||
                             authErrorMsg.toLowerCase().includes('dns error') ||
                             authErrorMsg.toLowerCase().includes('proxy') ||
                             authErrorMsg.toLowerCase().includes('failed to fetch') ||
                             authErrorMsg.includes('500') ||
                             authErrorMsg.includes('502') ||
                             authErrorMsg.includes('503') ||
                             authErrorMsg.includes('504');

      // Proactively notify the user if they lost their session or needed a scope upgrade
      if (isMissingScopes) {
        get().addToast(
          'We added new features! Please log in again to grant the new permissions.',
          'warning',
          {
            label: 'Log In',
            onClick: () => get().loginToTwitch()
          }
        );
      } else if (isNetworkError) {
        // Don't mistakenly tell them their session expired if their internet is just out
        Logger.warn('[Auth] Network error during auth check, failing gracefully:', authErrorMsg);
      } else if (wasAuthenticated && previousUser) {
        // They were actively using the app and the session functionally died (like 401 Unauthorized)
        get().addToast(
          'Your session has expired. Please log in again to continue.',
          'warning',
          {
            label: 'Log In',
            onClick: () => get().loginToTwitch()
          }
        );
      } else if (hasCredentials && !wasAuthenticated && authErrorMsg !== 'No stored credentials') {
        // They booted up the app with a token on disk, but it was definitively invalid/expired
        get().addToast(
          'Your login session expired while away. Please log in again.',
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

  exitStream: async (options) => {
    trackActivity('Exited stream');
    const state = get();
    // Exit theater mode if active so window restores to normal size
    if (state.isTheaterMode) {
      state.toggleTheaterMode();
    }
    await state.stopStream(options);
    // During a MultiNook handoff the grid is already on screen — don't raise the
    // Home view on top of it. Otherwise return to Home as usual.
    if (options?.preserveBackend) {
      set({ streamOriginCategory: null });
    } else {
      set({ isHomeActive: true, streamOriginCategory: null });
    }
  },

  // Navigation actions for deep linking
  setHomeActiveTab: (tab: HomeTab) => {
    set({ homeActiveTab: tab });
  },

  setHomeSelectedCategory: (category: TwitchCategory | null) => {
    set({ homeSelectedCategory: category });
  },

  setStreamOriginCategory: (category: TwitchCategory | null) => {
    set({ streamOriginCategory: category });
  },

  setSearchReturnTab: (tab: HomeTab) => {
    set({ searchReturnTab: tab });
  },

  setHomeCategoryTab: (tab: 'live' | 'clips' | 'videos') => {
    set({ homeCategoryTab: tab });
  },

  setCachedTopGames: (games: TwitchCategory[], cursor: string | null, hasMore: boolean) => {
    set({ 
      cachedTopGames: games, 
      cachedGamesCursor: cursor, 
      cachedHasMoreGames: hasMore, 
      cachedTopGamesTimestamp: Date.now() 
    });
  },

  appendCachedTopGames: (games: TwitchCategory[], cursor: string | null, hasMore: boolean) => {
    set((state) => ({
      cachedTopGames: [...state.cachedTopGames, ...games],
      cachedGamesCursor: cursor,
      cachedHasMoreGames: hasMore,
      cachedTopGamesTimestamp: Date.now()
    }));
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
        Logger.debug(`[DropsCache] Using cached data (${Math.round(cacheAge / 60000)}min old, ${dropsCache.campaigns.length} campaigns)`);
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

        Logger.debug(`[DropsCache] Loaded ${campaigns.length} active campaigns for ${byGameId.size} games`);
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
        Logger.debug('[DropsCache] No active campaigns found');
      }
    } catch (e) {
      Logger.error('[DropsCache] Failed to load active drops:', e);
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
