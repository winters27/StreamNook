export interface VideoPlayerSettings {
  low_latency_mode: boolean;
  max_buffer_length: number;
  autoplay: boolean;
  muted: boolean;
  volume: number;
  start_quality: number;
  lock_aspect_ratio: boolean;
  jump_to_live?: boolean;
}

export interface CacheSettings {
  enabled: boolean;
  expiry_days: number;
}

export interface TtvlolPluginSettings {
  enabled: boolean;
  installed_version: string | null;
}

export interface StreamlinkSettings {
  low_latency_enabled: boolean;
  hls_live_edge: number;          // Segments from live edge (1-10)
  stream_timeout: number;          // Timeout in seconds (30-120)
  retry_streams: number;           // Auto-retry on errors (0-5)
  disable_hosting: boolean;        // Avoid hosted streams
  skip_ssl_verify: boolean;        // Skip SSL verification
  use_proxy: boolean;              // Use proxy servers
  proxy_playlist: string;          // Proxy playlist URLs
  custom_streamlink_path?: string; // Custom folder path for portable/installed Streamlink
}

export type RecoveryMode = 'Automatic' | 'Relaxed' | 'ManualOnly';

export interface RecoverySettings {
  recovery_mode?: RecoveryMode;
  stale_progress_threshold_seconds?: number;
  streamer_blacklist_duration_seconds?: number;
  campaign_deprioritize_duration_seconds?: number;
  detect_game_category_change?: boolean;
  notify_on_recovery_action?: boolean;
  max_recovery_attempts?: number;
}

export interface DropsSettings {
  auto_claim_drops: boolean;
  auto_claim_channel_points: boolean;
  notify_on_drop_available: boolean;
  notify_on_drop_claimed: boolean;
  notify_on_points_claimed: boolean;
  check_interval_seconds: number;
  // Mining settings
  auto_mining_enabled?: boolean;
  priority_games?: string[];
  excluded_games?: string[];
  priority_mode?: 'PriorityOnly' | 'EndingSoonest' | 'LowAvailFirst';
  watch_interval_seconds?: number;
  // Watch token allocation settings
  reserve_token_for_current_stream?: boolean; // Reserve one watch token for current stream (default: true)
  auto_reserve_on_watch?: boolean; // Automatically reserve token when starting a stream (default: true)
  // Recovery settings
  recovery_settings?: RecoverySettings;
}

export interface MiningChannel {
  id: string;
  name: string;
  display_name: string;
  game_name: string;
  viewer_count: number;
  is_live: boolean;
  drops_enabled: boolean;
}

export interface CurrentDropInfo {
  campaign_id: string;
  campaign_name: string;
  drop_id: string;
  drop_name: string;
  drop_image?: string; // Image URL from benefit_edges
  required_minutes: number;
  current_minutes: number;
  game_name: string;
}

export interface DropsDeviceCodeInfo {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
  expires_in: number;
}

export interface MiningStatus {
  is_mining: boolean;
  current_channel: MiningChannel | null;
  current_campaign: string | null;
  current_drop: CurrentDropInfo | null;
  eligible_channels: MiningChannel[];
  last_update: string;
}

export interface ChatDesignSettings {
  show_dividers: boolean;
  alternating_backgrounds: boolean;
  message_spacing: number; // 0-20 pixels
  font_size: number; // 10-20 pixels
  font_weight: number; // 300-700
  mention_color: string; // Hex color for @ mentions
  reply_color: string; // Hex color for reply threads
  mention_animation: boolean; // Enable red-shift animation for mentions
  show_timestamps?: boolean; // Show timestamp next to each message
  show_timestamp_seconds?: boolean; // Include seconds in timestamps
}

export interface LiveNotificationSettings {
  enabled: boolean;
  play_sound: boolean;
  sound_type?: string; // 'boop' | 'tick' | 'gentle' | 'soft' | 'whisper'
  // Notification type toggles
  show_live_notifications?: boolean;
  show_whisper_notifications?: boolean;
  show_update_notifications?: boolean;
  show_drops_notifications?: boolean;
  show_favorite_drops_notifications?: boolean; // Notify on startup when favorited categories have new drops
  show_channel_points_notifications?: boolean;
  show_badge_notifications?: boolean;
  // Notification method toggles (Dynamic Island vs Toast)
  use_dynamic_island?: boolean;
  use_toast?: boolean;
  // Native OS notifications (Windows/macOS)
  use_native_notifications?: boolean;
  native_only_when_unfocused?: boolean;
  // Quick update: clicking update toast immediately starts update
  quick_update_on_toast?: boolean;
}

export type AutoSwitchMode = 'same_category' | 'followed_streams';

export interface AutoSwitchSettings {
  enabled: boolean;
  mode: AutoSwitchMode;         // 'same_category' = switch to stream in same game, 'followed_streams' = switch to a followed streamer
  show_notification: boolean;   // Show toast when auto-switching
  auto_redirect_on_raid?: boolean; // Automatically follow raids to the target channel
}

// Compact View Presets
export interface CompactViewPreset {
  id: string;              // Unique identifier (e.g., 'preset-1080x608' or 'custom-1')
  name: string;            // Display name (e.g., "1080p Second Monitor")
  width: number;           // Window width in pixels
  height: number;          // Window height in pixels (excluding title bar)
  isBuiltIn: boolean;      // true for built-in presets, false for custom
}

export interface CompactViewSettings {
  selectedPresetId: string;           // Currently selected preset ID
  customPresets: CompactViewPreset[]; // User-defined custom presets
}

// Custom Theme Types
export interface CustomThemeColor {
  value: string;      // hex (#rrggbb) format
  opacity: number;    // 0-100 for colors that support opacity
}

export interface CustomThemePalette {
  // Core colors
  background: CustomThemeColor;
  backgroundSecondary: CustomThemeColor;
  backgroundTertiary: CustomThemeColor;
  
  // Surface colors
  surface: CustomThemeColor;
  surfaceHover: CustomThemeColor;
  surfaceActive: CustomThemeColor;
  
  // Text colors
  textPrimary: CustomThemeColor;
  textSecondary: CustomThemeColor;
  textMuted: CustomThemeColor;
  
  // Accent colors
  accent: CustomThemeColor;
  accentHover: CustomThemeColor;
  accentMuted: CustomThemeColor;
  
  // Border colors
  border: CustomThemeColor;
  borderLight: CustomThemeColor;
  borderSubtle: CustomThemeColor;
  
  // Semantic colors
  success: CustomThemeColor;
  warning: CustomThemeColor;
  error: CustomThemeColor;
  info: CustomThemeColor;
  
  // Special colors
  scrollbarThumb: CustomThemeColor;
  scrollbarTrack: CustomThemeColor;
  
  // Glass effect opacities (stored as decimal string, e.g., "0.15")
  glassOpacity: string;
  glassHoverOpacity: string;
  glassActiveOpacity: string;
  
  // Highlight colors
  highlight: {
    pink: CustomThemeColor;
    purple: CustomThemeColor;
    blue: CustomThemeColor;
    cyan: CustomThemeColor;
    green: CustomThemeColor;
    yellow: CustomThemeColor;
    orange: CustomThemeColor;
    red: CustomThemeColor;
  };
}

export interface CustomTheme {
  id: string;         // unique identifier (e.g., 'custom-1704567890')
  name: string;       // user-defined name
  createdAt: number;  // timestamp
  updatedAt: number;  // timestamp
  palette: CustomThemePalette;
}

export interface Settings {
  streamlink_path: string;
  streamlink_args: string;
  quality: string;
  chat_placement: string;
  accounts: string[];
  current_account: string;
  hide_search_bar_on_startup: boolean;
  discord_rpc_enabled: boolean;
  video_player: VideoPlayerSettings;
  cache: CacheSettings;
  ttvlol_plugin: TtvlolPluginSettings;
  streamlink?: StreamlinkSettings;
  drops: DropsSettings;
  favorite_streamers: string[];
  chat_design?: ChatDesignSettings;
  live_notifications?: LiveNotificationSettings;
  last_seen_version?: string;
  auto_switch?: AutoSwitchSettings;
  theme?: string; // Theme ID (e.g., 'winters-glass', 'dracula', 'nord')
  error_reporting_enabled?: boolean; // Opt-in error reporting (default: true)
  setup_complete?: boolean; // Whether the first-time setup wizard has been completed
  auto_update_on_start?: boolean; // Automatically update when app starts if update available
  compact_view?: CompactViewSettings; // Compact view preset settings
  custom_themes?: CustomTheme[]; // User-created custom themes
  network?: NetworkSettings; // Network bandwidth test results and settings
}

export interface ReleaseNotes {
  version: string;
  name: string;
  body: string;
  published_at: string;
}

export interface TwitchStream {
  id: string;
  user_id: string;
  user_name: string;
  user_login: string;
  title: string;
  viewer_count: number;
  game_id?: string;
  game_name: string;
  thumbnail_url: string;
  started_at: string;
  broadcaster_type?: string;
  has_shared_chat?: boolean;
  profile_image_url?: string;
}

export interface TwitchUser {
  access_token: string;
  username: string;
  user_id: string;
  login?: string;
  display_name?: string;
  profile_image_url?: string;
  broadcaster_type?: string;
}

export interface UserInfo {
  id: string;
  login: string;
  display_name: string;
  email?: string;
  profile_image_url?: string;
  broadcaster_type?: string;
}

export interface SevenTVBadge {
  id: string;
  name: string;
  tooltip: string;
  urls: Array<[string, string]>;
}

export interface SevenTVPaint {
  id: string;
  name: string;
  function: 'LINEAR_GRADIENT' | 'RADIAL_GRADIENT' | 'URL';
  color?: number;
  stops?: Array<{ at: number; color: number }>;
  repeat?: boolean;
  angle?: number;
  image_url?: string;
  shadows?: Array<{
    x_offset: number;
    y_offset: number;
    radius: number;
    color: number;
  }>;
}

export interface ChatUser {
  id: string;
  username: string;
  displayName: string;
  color?: string;
  badges?: Record<string, string>;
  seventvBadge?: SevenTVBadge;
  seventvPaint?: SevenTVPaint;
}

export interface TwitchGame {
  id: string;
  name: string;
  box_art_url: string;
  igdb_id?: string;
}

export interface TwitchCategory extends TwitchGame {
  viewer_count?: number;
  tags?: string[];
}

// Unified Game Interface for Drops UI Overhaul
export interface UnifiedGame {
  id: string;                          // Game ID
  name: string;                        // Game Name
  box_art_url: string;                 // Game artwork

  // Active campaign data
  active_campaigns: DropCampaign[];    // Currently running campaigns
  total_active_drops: number;          // Sum of drops across campaigns
  drops_in_progress: number;           // Drops being worked on

  // Inventory data
  inventory_items: InventoryItem[];    // Past/earned campaigns
  total_claimed: number;               // Total claimed drops for this game

  // Status
  is_mining: boolean;                  // Currently mining this game
  has_claimable: boolean;              // Has drops ready to claim
  all_drops_claimed: boolean;          // All available drops have been claimed (game complete)
}

// Drops inventory types
export interface DropBenefit {
  id: string;
  name: string;
  image_url: string;
  /** Distribution type - "BADGE" for Twitch chat badges, "DIRECT_ENTITLEMENT" for in-game items */
  distribution_type?: string;
}

export interface DropProgress {
  campaign_id: string;
  drop_id: string;
  current_minutes_watched: number;
  required_minutes_watched: number;
  is_claimed: boolean;
  last_updated: string;
  drop_instance_id?: string; // Required for claiming drops - compound ID from Twitch
  drop_name?: string; // Cached drop name from backend events
  drop_image?: string; // Cached drop image from backend events
}

export interface TimeBasedDrop {
  id: string;
  name: string;
  required_minutes_watched: number;
  benefit_edges: DropBenefit[];
  progress?: DropProgress;
  /** Whether this drop can be auto-mined. Drops with required_minutes_watched = 0 
   * are event-based, badge-based, or require special actions and cannot be auto-mined */
  is_mineable?: boolean;
}

export interface AllowedChannel {
  id: string;
  name: string;
}

export interface DropCampaign {
  id: string;
  name: string;
  game_id: string;
  game_name: string;
  description: string;
  image_url: string;
  start_at: string;
  end_at: string;
  time_based_drops: TimeBasedDrop[];
  is_account_connected: boolean;
  allowed_channels: AllowedChannel[];
  is_acl_based: boolean;
  account_link?: string; // URL to connect game account for drops
}

export type CampaignStatus = 'Active' | 'Upcoming' | 'Expired';

export interface InventoryItem {
  campaign: DropCampaign;
  status: CampaignStatus;
  progress_percentage: number;
  total_drops: number;
  claimed_drops: number;
  drops_in_progress: number;
}

export interface InventoryResponse {
  items: InventoryItem[];
  total_campaigns: number;
  active_campaigns: number;
  upcoming_campaigns: number;
  expired_campaigns: number;
  completed_drops: CompletedDrop[];
}

export interface CompletedDrop {
  id: string;
  name: string;
  image_url: string;
  game_name: string | null;
  is_connected: boolean;
  required_account_link: string | null;
  last_awarded_at: string;
  total_count: number;
}

export interface ClaimedDrop {
  id: string;
  campaign_id: string;
  drop_id: string;
  drop_name: string;
  game_name: string;
  benefit_name: string;
  benefit_image_url: string;
  claimed_at: string;
}

export interface ChannelPointsClaim {
  id: string;
  channel_id: string;
  channel_name: string;
  points_earned: number;
  claimed_at: string;
  claim_type: 'Watch' | 'Raid' | 'Prediction' | 'Bonus' | 'Other';
}

export interface ChannelPointsBalance {
  channel_id: string;
  channel_name: string;
  balance: number;
  last_updated: string;
  /** Custom channel points name (e.g., "Kisses" for Hamlinz). undefined = default */
  points_name?: string;
  /** Custom channel points icon URL. undefined = uses default Twitch icon */
  points_icon_url?: string;
}

/** A custom channel reward that users can redeem with channel points */
export interface ChannelReward {
  id: string;
  title: string;
  cost: number;
  prompt?: string;
  image_url?: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  is_user_input_required: boolean;
  cooldown_expires_at?: string;
  max_per_stream?: number;
  max_per_user_per_stream?: number;
  global_cooldown_seconds?: number;
}

/** Result of attempting to redeem a channel reward */
export interface RedemptionResult {
  success: boolean;
  error_code?: string;
  error_message?: string;
  new_balance?: number;
  /** For emote unlock rewards - contains info about the unlocked emote */
  unlocked_emote?: UnlockedEmote;
}

/** Information about an unlocked emote (for random emote unlock rewards) */
export interface UnlockedEmote {
  id: string;
  name: string;
  image_url: string;
}

export interface DropsStatistics {
  total_drops_claimed: number;
  total_channel_points_earned: number;
  active_campaigns: number;
  drops_in_progress: number;
  recent_claims: ClaimedDrop[];
  channel_points_history: ChannelPointsClaim[];
}

// Dynamic Island Notification Types
export type NotificationType = 'live' | 'whisper' | 'system' | 'update' | 'drops' | 'channel_points' | 'badge';

export interface DynamicIslandNotification {
  id: string;
  type: NotificationType;
  timestamp: number;
  read: boolean;
  data: LiveNotificationData | WhisperNotificationData | SystemNotificationData | UpdateNotificationData | DropsNotificationData | ChannelPointsNotificationData | BadgeNotificationData;
}

export interface LiveNotificationData {
  streamer_name: string;
  streamer_login: string;
  streamer_avatar?: string;
  game_name?: string;
  game_image?: string;
  stream_title?: string;
  is_live: boolean; // Current status - may change
}

export interface WhisperNotificationData {
  from_user_id: string;
  from_user_login: string;
  from_user_name: string;
  message: string;
  whisper_id: string;
  profile_image_url?: string;
}

export interface SystemNotificationData {
  title: string;
  message: string;
  icon?: string;
}

export interface UpdateNotificationData {
  current_version: string;
  latest_version: string;
  has_update: boolean;
}

export interface DropsNotificationData {
  drop_name: string;
  game_name: string;
  benefit_name?: string;
  benefit_image_url?: string;
}

export interface ChannelPointsNotificationData {
  channel_name: string;
  points_earned: number;
  total_points?: number;
}

export interface BadgeNotificationData {
  badge_name: string;
  badge_set_id: string;
  badge_version: string;
  badge_image_url: string;
  badge_description?: string;
  status: 'new' | 'available' | 'coming_soon';
  date_info?: string; // e.g., "Dec 1-12" or "Available now"
}

// Whisper Types
export interface Whisper {
  id: string;
  from_user_id: string;
  from_user_login: string;
  from_user_name: string;
  to_user_id: string;
  to_user_login: string;
  to_user_name: string;
  message: string;
  timestamp: number;
  is_sent: boolean; // true if sent by current user
}

export interface WhisperConversation {
  user_id: string;
  user_login: string;
  user_name: string;
  profile_image_url?: string;
  messages: Whisper[];
  last_message_timestamp: number;
  unread_count: number;
}

// Hype Train Types
export interface HypeTrainContributor {
  user_id: string;
  user_login: string;
  user_name: string;
  type: 'bits' | 'subscription' | 'other';
  total: number;
}

export interface HypeTrainData {
  id: string;
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  level: number;
  total: number;
  progress: number;
  goal: number;
  top_contributions: HypeTrainContributor[];
  started_at: string;
  expires_at: string;
  is_golden_kappa?: boolean;
}

// ===== Network Bandwidth Test Types =====

// Phase 1: Baseline Speed Test Types
export interface BaselineSpeedResult {
  download_mbps: number;              // Average download speed
  upload_mbps: number;                // Average upload speed (optional test)
  latency_ms: number;                 // Round-trip latency
  jitter_ms: number;                  // Latency variance
  stability_score: number;            // 0-100 based on variance
  test_server: string;                // CDN location used for test
  timestamp: string;
}

// Phase 2: Twitch-Specific Test Types
export interface BandwidthTestResult {
  quality: string;                    // e.g., "1080p60", "720p", "480p"
  average_video_bitrate_kbps: number; // Measured video bandwidth
  peak_video_bitrate_kbps: number;    // Peak video bandwidth
  buffering_events: number;           // Number of buffer stalls during test
  chat_messages_per_second: number;   // Chat throughput at this quality
  badge_load_time_ms: number;         // Average badge/emote load time
  stability_score: number;            // 0-100 score based on variance
  can_handle: boolean;                // Whether user's connection can handle this
  baseline_utilization_percent: number; // % of baseline speed used
}

export interface BandwidthTestConfig {
  test_duration_seconds: number;      // How long to test each quality
  test_stream_login?: string;         // Optional specific streamer (else auto-select)
  include_chat_test: boolean;         // Whether to measure chat bandwidth
  include_baseline_test: boolean;     // Whether to run Phase 1 first
  qualities_to_test: string[];        // Which qualities to test
}

export interface BandwidthTestProgress {
  phase: 'baseline' | 'finding_stream' | 'testing_quality' | 'complete' | 'error';
  current_quality?: string;
  current_quality_index?: number;
  total_qualities: number;
  elapsed_seconds: number;
  message: string;
  // Baseline results (available after Phase 1)
  baseline_result?: BaselineSpeedResult;
  // Test stream info (available after finding stream)
  test_stream_login?: string;
  test_stream_id?: string;
}

export interface BandwidthTestSummary {
  // Phase 1 results
  baseline: BaselineSpeedResult;
  
  // Phase 2 results  
  test_stream_name: string;
  test_stream_viewers: number;
  quality_results: BandwidthTestResult[];
  
  // Analysis
  recommended_video_quality: string;
  recommended_badge_quality: 'high' | 'medium' | 'low';
  recommended_emote_quality: 'high' | 'medium' | 'low';
  network_stability: 'excellent' | 'good' | 'fair' | 'poor';
  
  // Comparison insights
  twitch_vs_baseline_ratio: number;   // How much of baseline Twitch uses
  potential_throttling: boolean;      // True if Twitch << baseline
  
  timestamp: string;
}

export interface NetworkSettings {
  // Baseline test results
  last_baseline_result?: BaselineSpeedResult;
  
  // Recommendation results (persisted after test)
  last_test_timestamp?: string;
  recommended_quality?: string;
  recommended_badge_quality?: 'high' | 'medium' | 'low';
  recommended_emote_quality?: 'high' | 'medium' | 'low';
  
  // User overrides
  use_recommended_settings?: boolean;
  
  // Test history (last N full test summaries for trend analysis)
  test_history?: BandwidthTestHistoryEntry[];
}

/** Slimmed-down test history entry for storage efficiency */
export interface BandwidthTestHistoryEntry {
  timestamp: string;
  download_mbps: number;
  upload_mbps: number;
  latency_ms: number;
  stability_score: number;
  recommended_quality: string;
  network_stability: 'excellent' | 'good' | 'fair' | 'poor';
  had_throttling: boolean;
}

// ===== Proxy Health Types =====

/** A proxy server entry from the bundled list */
export interface ProxyServer {
  id: string;
  url: string;
  name: string;
  region: string;    // e.g., 'NA', 'EU', 'AS', 'SA', 'RU'
  provider: string;  // e.g., 'TTV-LOL-PRO', 'luminous-ttv', 'community'
  priority: number;
}

/** Result of a health check on a single proxy */
export interface ProxyHealthResult {
  id: string;
  url: string;
  name: string;
  region: string;
  is_healthy: boolean;
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
}

/** Aggregated proxy health check response */
export interface ProxyHealthCheckResponse {
  results: ProxyHealthResult[];
  best_proxy: ProxyHealthResult | null;
  check_duration_ms: number;
  total_checked: number;
  healthy_count: number;
}

/** Bundled proxy list structure */
export interface ProxyList {
  version: string;
  lastUpdated: string;
  proxies: ProxyServer[];
}

