// Overlay style config — the single source of truth for how the OBS chat
// overlay looks. Set in the in-app builder, saved per overlay, and read by both
// the builder preview and (later) the hosted overlay page, so the two can never
// drift. Phase 1 is builder + preview only; nothing here talks to a backend.

import type { ProviderId } from '../../types/providers';

// Overlay event categories — each stream event reflects its actual type (a watch
// streak is a Milestone, never a Subscription). Kept here (not in OverlayChat) so
// both the renderer and the builder's event filter share one source of truth.
export type EventCategory = 'subscription' | 'gift' | 'raid' | 'cheer' | 'milestone' | 'follow' | 'announcement';

export const EVENT_CATEGORIES: { id: EventCategory; label: string }[] = [
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'gift', label: 'Gifts' },
  { id: 'raid', label: 'Raids' },
  { id: 'cheer', label: 'Bits & Super Chats' },
  { id: 'milestone', label: 'Milestones' },
  { id: 'follow', label: 'Follows' },
  { id: 'announcement', label: 'Announcements' },
];

export type SourceTagMode = 'none' | 'dot' | 'label' | 'icon';
export type OverlayBackground = 'transparent' | 'solid';
export type OverlayDirection = 'newBottom' | 'newTop';
export type OverlayEntrance = 'none' | 'fade' | 'slide' | 'pop';

export interface OverlayStyle {
  /** Overlay canvas size in px (the Browser Source dimensions in OBS). Taller =
   *  more chat visible at once. */
  width: number;
  height: number;
  /** Platforms whose messages the overlay shows. */
  sources: ProviderId[];
  /** Whether/how to mark which platform each message came from. */
  sourceTag: SourceTagMode;

  /** Font family (a CSS font-family string, chosen from FONT_OPTIONS). */
  fontFamily: string;
  /** Base message font size in px. Emotes/badges scale off this. */
  fontSize: number;
  /** Line height multiplier for wrapped message text. */
  lineHeight: number;
  /** Vertical gap between messages in px. */
  messageGap: number;

  /** Inline emote size multiplier (1 = default 2em). */
  emoteScale: number;
  /** Badge size multiplier (1 = default, ~1.35em tall). */
  badgeScale: number;
  showBadges: boolean;
  showTimestamps: boolean;

  /** Color for plain message body text. Usernames keep their own color/paint. */
  bodyTextColor: string;
  /** Drop a subtle dark outline behind text so it stays legible over any scene. */
  textShadow: boolean;

  background: OverlayBackground;
  /** Used when background === 'solid'. */
  backgroundColor: string;
  /** 0–1, applied to the solid background only. */
  backgroundOpacity: number;

  /** How stream events render. Both show the sender decorated (badges + paint
   *  name) + the event action; 'streamnook' adds the app's signature multi-color
   *  gradient wash behind it, 'plain' keeps a subtle per-source tint. */
  eventStyle: 'plain' | 'streamnook';
  /** Hide messages from known bot accounts / users carrying a bot badge. */
  hideBots: boolean;
  /** Event categories to HIDE from the overlay (e.g. 'raid', 'cheer'). Empty =
   *  show all. See EventCategory. */
  hiddenEvents: string[];
  /** Per-platform event hides, keyed `provider:category` (e.g. 'tiktok:follow').
   *  Hides that category for ONE platform only, on top of the global hiddenEvents. */
  hiddenProviderEvents: string[];
  /** Target ISO currency to convert YouTube Super Chats into ('' = show as sent). */
  superchatCurrency: string;
  /** Per-source username blocklist, keyed `${provider}:${channel}` → usernames to
   *  hide (case-insensitive, matched against username OR display name). For bots the
   *  auto-hider misses. Matching is effectively per-platform (a name blocked on any
   *  source of a platform is hidden for that platform). */
  blockedUsers: Record<string, string[]>;
  /** Whether new messages appear at the bottom (chat-style) or the top. */
  direction: OverlayDirection;
  /** Entrance animation for incoming messages. */
  entrance: OverlayEntrance;
}

// Which event categories each platform can actually emit — drives the per-platform
// event toggles in the builder so a provider only shows togglable event types it
// produces (Twitch has raids/milestones, TikTok has follows, etc.).
export const PROVIDER_EVENT_CATEGORIES: Partial<Record<ProviderId, EventCategory[]>> = {
  twitch: ['subscription', 'gift', 'cheer', 'raid', 'milestone', 'announcement'],
  kick: ['subscription', 'gift', 'follow', 'raid'],
  youtube: ['subscription', 'gift', 'cheer'],
  tiktok: ['gift', 'cheer', 'follow'],
};

// Font choices mirror the app's Theme › Font list so an overlay can match the
// streamer's in-app look. Values are CSS font-family strings.
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Satoshi', value: "'Satoshi', system-ui, sans-serif" },
  { label: 'Geist', value: "'Geist', system-ui, sans-serif" },
  { label: 'Manrope', value: "'Manrope', system-ui, sans-serif" },
  { label: 'Outfit', value: "'Outfit', system-ui, sans-serif" },
  { label: 'Space Grotesk', value: "'Space Grotesk', system-ui, sans-serif" },
  { label: 'System', value: 'system-ui, sans-serif' },
];

export const DEFAULT_OVERLAY_STYLE: OverlayStyle = {
  width: 400,
  height: 640,
  sources: ['twitch', 'kick', 'youtube', 'tiktok'],
  sourceTag: 'dot',
  fontFamily: FONT_OPTIONS[0].value,
  fontSize: 15,
  lineHeight: 1.4,
  messageGap: 6,
  emoteScale: 1,
  badgeScale: 1,
  showBadges: true,
  showTimestamps: false,
  bodyTextColor: '#ffffff',
  textShadow: true,
  background: 'transparent',
  backgroundColor: '#0e0e10',
  backgroundOpacity: 0.8,
  eventStyle: 'plain',
  hideBots: false,
  hiddenEvents: [],
  hiddenProviderEvents: [],
  superchatCurrency: '',
  blockedUsers: {},
  direction: 'newBottom',
  entrance: 'fade',
};

// Clamp ranges so a builder (or a hand-edited saved config) can't produce a
// broken overlay. Mirrored by the renderer.
export const OVERLAY_LIMITS = {
  width: { min: 260, max: 900 },
  height: { min: 300, max: 1600 },
  fontSize: { min: 10, max: 48 },
  lineHeight: { min: 1, max: 2.2 },
  messageGap: { min: 0, max: 28 },
  emoteScale: { min: 0.5, max: 3 },
  badgeScale: { min: 0.5, max: 2.5 },
  backgroundOpacity: { min: 0, max: 1 },
} as const;

export const clampOverlayStyle = (s: OverlayStyle): OverlayStyle => {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  return {
    ...s,
    width: Math.round(clamp(s.width, OVERLAY_LIMITS.width.min, OVERLAY_LIMITS.width.max)),
    height: Math.round(clamp(s.height, OVERLAY_LIMITS.height.min, OVERLAY_LIMITS.height.max)),
    fontSize: clamp(s.fontSize, OVERLAY_LIMITS.fontSize.min, OVERLAY_LIMITS.fontSize.max),
    lineHeight: clamp(s.lineHeight, OVERLAY_LIMITS.lineHeight.min, OVERLAY_LIMITS.lineHeight.max),
    messageGap: clamp(s.messageGap, OVERLAY_LIMITS.messageGap.min, OVERLAY_LIMITS.messageGap.max),
    emoteScale: clamp(s.emoteScale, OVERLAY_LIMITS.emoteScale.min, OVERLAY_LIMITS.emoteScale.max),
    badgeScale: clamp(s.badgeScale, OVERLAY_LIMITS.badgeScale.min, OVERLAY_LIMITS.badgeScale.max),
    backgroundOpacity: clamp(s.backgroundOpacity, OVERLAY_LIMITS.backgroundOpacity.min, OVERLAY_LIMITS.backgroundOpacity.max),
  };
};
