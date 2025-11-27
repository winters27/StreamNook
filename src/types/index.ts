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

export interface TtvlolPluginSettings {
  enabled: boolean;
  installed_version: string | null;
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
  required_minutes: number;
  current_minutes: number;
  game_name: string;
}

export interface MiningStatus {
  is_mining: boolean;
  current_channel: MiningChannel | null;
  current_drop: CurrentDropInfo | null;
  eligible_channels: MiningChannel[];
  last_update: string;
}

export interface ChatDesignSettings {
  show_dividers: boolean;
  alternating_backgrounds: boolean;
  dark_mode: boolean; // Use black background instead of gray
  message_spacing: number; // 0-20 pixels
  font_size: number; // 10-20 pixels
  font_weight: number; // 300-700
  mention_color: string; // Hex color for @ mentions
  reply_color: string; // Hex color for reply threads
  mention_animation: boolean; // Enable red-shift animation for mentions
}

export interface LiveNotificationSettings {
  enabled: boolean;
  show_streamer_name: boolean;
  show_game_details: boolean;
  show_game_image: boolean;
  show_streamer_avatar: boolean;
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
  drops: DropsSettings;
  favorite_streamers: string[];
  chat_design?: ChatDesignSettings;
  live_notifications?: LiveNotificationSettings;
  last_seen_version?: string;
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

// Drops inventory types
export interface DropBenefit {
  id: string;
  name: string;
  image_url: string;
}

export interface DropProgress {
  campaign_id: string;
  drop_id: string;
  current_minutes_watched: number;
  required_minutes_watched: number;
  is_claimed: boolean;
  last_updated: string;
}

export interface TimeBasedDrop {
  id: string;
  name: string;
  required_minutes_watched: number;
  benefit_edges: DropBenefit[];
  progress?: DropProgress;
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
}

export interface DropsStatistics {
  total_drops_claimed: number;
  total_channel_points_earned: number;
  active_campaigns: number;
  drops_in_progress: number;
  recent_claims: ClaimedDrop[];
  channel_points_history: ChannelPointsClaim[];
}
