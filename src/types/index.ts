export interface VideoPlayerSettings {
  low_latency_mode: boolean;
  max_buffer_length: number;
  autoplay: boolean;
  muted: boolean;
  volume: number;
  start_quality: number;
  lock_aspect_ratio: boolean;
}

export interface CacheSettings {
  enabled: boolean;
  expiry_days: number;
}

export interface StreamlinkSettings {
  stream_timeout: number;          // Native retry budget (seconds)
  retry_streams: number;           // Native retry delay between attempts (seconds)
  use_proxy: boolean;              // Route playlists through the ad-block proxy pool
  proxy_playlist: string;          // Proxy base URLs
  /** ID of the last proxy applied (persists through restarts/updates) */
  last_applied_proxy_id?: string;
  /** Whether the current proxy was auto-selected (optimizer can override on next launch) */
  proxy_auto_optimized?: boolean;
  /** Whether proxy optimization has been run at least once */
  proxy_optimized_once?: boolean;
  /** Request h265 + AV1 in addition to h264. Unlocks Twitch Enhanced
   *  Broadcasting tiers (1440p60 AV1, 720p60 HEVC). Default on. */
  enhanced_codecs?: boolean;
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

export interface FarmChannel {
  channel_id: string;
  channel_login: string;
  display_name: string;
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
  priority_farm_channels?: FarmChannel[]; // Channels to prioritize for channel points farming
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
  emote_scale?: number; // Emote size multiplier (0.5x to 3x). Default 1.
  emote_margin?: number; // Horizontal margin around emotes in rem. Negative values overlap. Default 0.125.
  // Height in pixels of the enlarged emote shown in the hover preview card.
  // Default 96 (one step up from the original fixed 64px preview).
  emote_hover_size?: number;
  // How deleted/moderated messages render. 'strikethrough' is the prior
  // default behavior. 'hidden' fully suppresses the row. 'dimmed' reduces
  // opacity without strike. 'keep' leaves the message rendered as if nothing
  // happened (useful for mods auditing what was said).
  deleted_message_style?: 'strikethrough' | 'hidden' | 'dimmed' | 'keep';
  // Suppress messages flagged as originating from another room in a Twitch
  // shared-chat session. Default false (keep them visible).
  hide_shared_chat?: boolean;
  // Toggle the inline paint render on @mentions in message bodies. Default
  // true (preserves prior always-painted behavior). Off renders the mention
  // chip in the mentioned user's flat color only.
  paint_mentions_in_body?: boolean;
  // Use compact emote tooltips (just the name) instead of the upscaled
  // emote preview. Default false (preview tooltip is the current behavior).
  compact_emote_tooltips?: boolean;
  // Show an in-chat notice when a channel's 7TV emote set changes live (a mod
  // adds, removes, or renames an emote). Default true.
  seventv_emote_notices?: boolean;
  // Auto-expand inline preview cards for links from trusted domains (YouTube,
  // Twitch, imgur, etc.). Other links stay plain clickable links. Default true.
  link_previews?: boolean;
  // When a link has a preview card, also keep the inline link visible in the
  // message ("Card + link"). When false, the inline link is hidden and only the
  // card is shown ("Clean"). Default false (clean). Ignored when previews are off.
  link_preview_keep_link?: boolean;
  // Show links as a compact host + truncated path label instead of the full
  // raw URL (the full URL stays the click target and hover tooltip). Default true.
  shorten_links?: boolean;
}

export interface HighlightPhrase {
  id: string;
  pattern: string;
  enabled: boolean;
  case_sensitive: boolean;
  whole_word: boolean;
  is_regex: boolean;
  color: string;
  // Optional sound played when the phrase matches. null/undefined = silent.
  sound_id?: string | null;
  // Per-phrase cooldown for the sound, in seconds. Default 3.
  cooldown_seconds?: number;
}

export interface ChatHighlightSettings {
  phrases: HighlightPhrase[];
  built_in?: BuiltInHighlightSettings;
  users?: HighlightUser[];
  badges?: HighlightBadge[];
  // Global appearance controls applied to every match (phrase / user / badge /
  // built-in event). Sound and title-flash still fire under 'none' — this only
  // governs the in-row visual.
  appearance?: HighlightAppearanceSettings;
}

export type HighlightDisplayStyle = 'standard' | 'minimal' | 'none';

export interface HighlightAppearanceSettings {
  display_style?: HighlightDisplayStyle; // default 'standard'
  opacity?: number; // 0-100, default 20. Modulates the row tint alpha only.
  // When true, any highlight match that arrives while the window is blurred
  // will flash document.title until the window regains focus. Default off.
  flash_title_when_unfocused?: boolean;
}

// Always-highlight specific users. Match by login (case-insensitive). The
// login is what we have at parse time without an extra Helix call, and it's
// stable enough for this UI use (users who change their name infrequently
// will just need the rule updated). User-id binding could be added later.
export interface HighlightUser {
  id: string; // rule id (UUID), not the Twitch user id
  enabled: boolean;
  username: string; // Twitch login, lowercased on save
  color: string;
  sound_id?: string | null;
  cooldown_seconds?: number;
}

// Highlight all messages from users carrying a specific badge. badge_key is
// the IRC tag format `name/version` (e.g. "moderator/1", "subscriber/12").
// A trailing /* matches any version (e.g. "subscriber/*" highlights every
// tier-1 sub regardless of tenure).
export interface HighlightBadge {
  id: string;
  enabled: boolean;
  badge_key: string;
  label?: string; // optional display name for the settings UI
  color: string;
  sound_id?: string | null;
  cooldown_seconds?: number;
}

// Built-in (flag-driven) message highlights. Each event is OFF by default to
// preserve the prior baseline; turning a row on applies a tinted background +
// left border in the configured color whenever the IRC tag is present.
export interface BuiltInHighlightRule {
  enabled: boolean;
  color: string;
}

export interface BuiltInHighlightSettings {
  // first-msg=1 IRC tag. Already shipped pre-2026-05-24 with a hardcoded
  // purple gradient; this entry lets the user re-color (or disable) it.
  first_time_chatter?: BuiltInHighlightRule;
  // returning-chatter=1 IRC tag.
  returning_chatter?: BuiltInHighlightRule;
  // Messages where parsed.user_id === currentUser.user_id.
  self_message?: BuiltInHighlightRule;
  // USERNOTICE msg-id=raid (the raid announcement row itself).
  raider?: BuiltInHighlightRule;
}

// Per-user customization. nickname and color are independent: either can be set
// without the other. Keyed by Twitch user_id (stable across name changes).
export interface UserChatOverride {
  user_id: string;
  // Last-seen real username, captured purely so the Settings UI can show the
  // user "Bob → Robert" without re-fetching. Not load-bearing.
  username?: string;
  nickname?: string | null;
  color?: string | null;
}

export interface ChatCustomizationSettings {
  user_overrides?: Record<string, UserChatOverride>;
}

// User-defined slash command. Trigger is the bare word matched at the start
// (and optionally end) of a message. Expansion is the templated message body.
// See `expandUserCommand` in utils/chatCommands.ts for the full placeholder
// grammar — {N}, {N+}, {*}, {{ }}, and dotted fields (user.name, user.id,
// channel.name, channel.id, stream.title, stream.game, stream.uptime).
export interface UserSlashCommand {
  id: string;
  trigger: string;
  expansion: string;
  description?: string;
  enabled: boolean;
  // When true (default), the trigger only matches messages starting with `/`
  // and the leading slash is stripped before matching. When false, the trigger
  // matches plain text and the message body is rewritten in place.
  require_slash?: boolean;
  // When true, the trigger also matches at the END of a message (suffix mode),
  // not just the start. Useful for shortcut catchphrases. Default false.
  also_match_suffix?: boolean;
}

export interface ChatCommandsSettings {
  user_commands: UserSlashCommand[];
}

// Chat input QoL options. Both default off — preserve prior behavior.
// 7TV / cosmetic visual controls. Today: paint drop-shadow render mode.
// Default 'all' preserves the prior behavior (whatever shadows the paint
// artist defined render in full). 'one' = first shadow only (faster + less
// busy). 'none' = no shadows (cleanest, best on busy backgrounds).
export interface CosmeticsSettings {
  paint_shadows?: 'all' | 'one' | 'none';
}

// Render / perf controls. All optional with defaults preserving prior behavior.
export interface ChatRenderSettings {
  // Animate the scroll when the user clicks the "Resume" button at the
  // bottom of the chat (a brisk eased glide back to the live bottom).
  // Defaults to on. Auto-scroll on new messages stays instant either way —
  // smooth-scrolling on every PRIVMSG would fight itself in fast chats.
  smooth_scroll_on_resume?: boolean;
  // Max messages held in the local buffer per channel. Default 100.
  // Range 50-1000. Larger = more scrollback at memory cost.
  message_buffer_cap?: number;
}

export interface ChatInputSettings {
  // Append an invisible suffix when sending the same message twice in a row,
  // so Twitch's duplicate-message rejection doesn't eat the second send.
  bypass_duplicate?: boolean;
  // Ctrl+Enter sends the message AND keeps it in the input box. Plain Enter
  // still sends + clears like normal.
  quick_send?: boolean;
  // Emote tab completion in the chat input. Tab cycles forward through
  // matching emotes/chatters, Shift+Tab cycles back.
  emote_tab_complete_enabled?: boolean;
  emote_tab_complete_match_mode?: 'starts_with' | 'includes';
  emote_tab_complete_include_chatters?: boolean;
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
  stay_in_offline_chat?: boolean;  // Do not auto-switch if stream goes offline, instead fallback to offline chat mode
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

export interface MultiNookSlot {
  id: string;             // Unique identifier for the slot (e.g., cell-1)
  channelLogin: string;   // The Twitch channel login name
  channelId?: string;     // The Twitch user ID for chat connection mapping
  channelName?: string;   // The capitalization-correct display name
  volume: number;         // 0.0 to 1.0
  muted: boolean;         // Mute state
  isFocused: boolean;     // Whether this stream has focus (unmuted while all others are muted)
  streamUrl?: string;     // The local proxy URL (ephemeral, not saved)
  isMinimized?: boolean;  // Whether the stream is tucked into the tray to save grid space
  profileImageUrl?: string; // Cache of the channel's profile avatar
  gameName?: string;         // Current stream category (for rich presence majority game)
  quality?: string;          // Preferred Streamlink quality for this tile (defaults to 'best')
}

/** Customizable keyboard shortcut overrides. Maps a bindable-command id to its
 *  user-assigned chord strings (e.g. { 'player.mute': ['M', 'Ctrl+M'] }). Absent
 *  ids fall back to the code-defined defaults; an explicit empty array means the
 *  user intentionally cleared all binds for that command. */
export type KeybindingOverrides = Record<string, string[]>;

export interface Settings {
  quality: string;
  chat_placement: string;
  accounts: string[];
  current_account: string;
  hide_search_bar_on_startup: boolean;
  discord_rpc_enabled: boolean;
  video_player: VideoPlayerSettings;
  cache: CacheSettings;
  streamlink?: StreamlinkSettings;
  drops: DropsSettings;
  favorite_streamers: string[];
  chat_design?: ChatDesignSettings;
  chat_highlights?: ChatHighlightSettings;
  chat_customization?: ChatCustomizationSettings;
  chat_commands?: ChatCommandsSettings;
  chat_input?: ChatInputSettings;
  chat_render?: ChatRenderSettings;
  cosmetics?: CosmeticsSettings;
  live_notifications?: LiveNotificationSettings;
  last_seen_version?: string;
  auto_switch?: AutoSwitchSettings;
  theme?: string; // Theme ID (e.g., 'winters-glass', 'dracula', 'nord')
  font?: string; // Interface font id (see FONT_OPTIONS in themes). Default 'satoshi'.
  error_reporting_enabled?: boolean; // Local diagnostic log verbosity; nothing is sent off-device (default: true)
  setup_complete?: boolean; // Whether the first-time setup wizard has been completed
  compact_view?: CompactViewSettings; // Compact view preset settings
  custom_themes?: CustomTheme[]; // User-created custom themes
  glass_transparency?: number; // Global glassiness, 0-100 (100 = full frosted glass, 0 = solid panels). Default 100.
  multi_nook_slots?: MultiNookSlot[]; // Persisted multi-nook grid configurations
  multi_nook_chat_hidden?: boolean; // Whether the chat panel is globally hidden in MultiNook
  show_mod_logs?: boolean; // Whether to display the Mod Logs pane
  moderation?: ModerationSettings;
  keybindings?: KeybindingOverrides; // Customizable keyboard shortcut overrides (id -> chords)
}

export interface ModerationSettings {
  // Surface CLEARCHAT / CLEARMSG IRC events as system rows even for non-mods.
  // Mods see them by default; this lets curious viewers see "X was timed out".
  show_mod_messages?: boolean;
  // When a mod runs /clear, suppress the local visual wipe so the user's
  // backlog stays readable. Inverse of the /clearmessages user command.
  ignore_clear_chat?: boolean;
  // Per-category highlight colors for the mod log, keyed by category
  // (see utils/modLogCategories). Unset keys fall back to the category default.
  mod_log_colors?: Record<string, string>;
  // How mod-log severity is shown: a filled card with a matching same-color
  // border (default), a colored left bar, or just a colored dot.
  mod_log_highlight_style?: 'box' | 'bar' | 'dot';
}

export interface ModLogEvent {
  id: string;
  action: string;
  timestamp: string;
  moderator_name: string;
  /** Acting moderator's id + login, when known (EventSub feed). Enables opening their profile. */
  moderator_id?: string;
  moderator_login?: string;
  target_user_name?: string;
  /** Target user's id + login, when known. Enables opening their profile. */
  target_user_id?: string;
  target_user_login?: string;
  /** The message content involved in the action (e.g. the deleted message text). */
  message?: string;
  reason?: string;
  duration?: number;
  details?: Record<string, unknown>;
  /** Lowercase channel login this action happened in (multi-stream routing + labeling). */
  channel?: string;
  /** Channel display name, when available. */
  channel_display?: string;
  /** Which feed produced this entry. EventSub carries the moderator's identity; IRC is anonymized but universal. */
  source?: 'eventsub' | 'irc';
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
  is_live?: boolean;
}

export interface TwitchClip {
  id: string;
  url: string;
  embed_url: string;
  broadcaster_id: string;
  broadcaster_name: string;
  creator_id: string;
  creator_name: string;
  video_id: string;
  game_id: string;
  game_name?: string;
  language: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  vod_offset?: number;
}

export interface TwitchVideo {
  id: string;
  stream_id?: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  viewable: string;
  view_count: number;
  language: string;
  type: string;
  duration: string;
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

export interface CategoryTag {
  id: string;
  localizedName: string;
}

export interface CategoryInfo {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  followersCount: number | null;
  boxArtUrl: string | null;
  tags: CategoryTag[] | null;
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


