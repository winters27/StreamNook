import type { ProviderId } from './providers';

// A normalized, cross-platform channel event (non-chat): follows, subs, raids,
// gifts, YouTube super chats / members, TikTok hearts / gifts, etc. This lives
// in the MultiChat Activity feed only and never touches normal single-channel
// chat. Adapters (and the Twitch normalizer) produce this shape; the feed and
// any future filter UI consume it.

export type ActivityKind =
  | 'follow'
  | 'sub'
  | 'resub'
  | 'subgift'
  | 'giftbomb'
  | 'raid'
  | 'bits'
  | 'superchat'
  | 'supersticker'
  | 'membership'
  | 'member_milestone'
  | 'gift'
  | 'like'
  | 'share'
  | 'join'
  | 'host'
  | 'rant'
  | 'channelpoints'
  | 'hypetrain'
  | 'stream_online'
  | 'stream_offline'
  | 'other';

export interface ActivityActor {
  id?: string;
  username: string;
  display_name?: string;
  color?: string;
  avatar_url?: string;
  // Resolved Twitch badges captured at event time (already carry image urls), so
  // the row can show the same badges as chat. 7TV/third-party badges + paints are
  // looked up live from the cosmetics store by id, so they aren't stored here.
  badges?: Array<{
    key: string;
    info?: { title?: string; image_url_1x?: string; image_url_2x?: string; image_url_4x?: string };
  }>;
}

export interface ActivityEvent {
  // Stable de-dup id. Synthesized when the source provides none.
  id: string;
  provider: ProviderId;
  // Composite source key "<provider>:<channel>" this event belongs to.
  channel: string;
  // Display label for the channel (used in a per-source column header).
  channel_display?: string;
  timestamp: string; // ISO 8601
  kind: ActivityKind;
  actor: ActivityActor;
  // Type-specific payload; only the fields relevant to `kind` are set.
  amount?: number; // bits, super chat amount, rant amount
  currency?: string; // super chat / rant currency symbol
  tier?: string; // sub tier, gift tier
  months?: number; // resub cumulative months ("what they're at now")
  streak?: number; // resub consecutive-month streak (0/absent when not shared)
  viewers?: number; // raid viewers
  gift_name?: string; // TikTok / generic gift name
  gift_count?: number; // gift combo count
  gift_image_url?: string; // gift icon
  like_count?: number; // TikTok hearts in this batch
  message?: string; // attached user message (super chat / rant / resub)
  system_text?: string; // platform-provided summary line
}
