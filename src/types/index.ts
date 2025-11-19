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
  chat_history_max: number;
  chat_design?: ChatDesignSettings;
  live_notifications?: LiveNotificationSettings;
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
