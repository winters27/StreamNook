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
export type OverlayEntrance = 'none' | 'fade' | 'slide' | 'drift' | 'rise' | 'pop' | 'stamp';

export const OVERLAY_ENTRANCES: { value: OverlayEntrance; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'drift', label: 'Drift' },
  { value: 'rise', label: 'Rise' },
  { value: 'pop', label: 'Pop' },
  { value: 'stamp', label: 'Stamp' },
];
export type EmojiStyle = 'system' | 'apple' | 'google' | 'twitter' | 'facebook';
export type FirstTimeStyle = 'off' | 'twitch' | 'streamnook';
export type BubbleShape = 'rounded' | 'pill' | 'speech';

export const BUBBLE_SHAPES: { value: BubbleShape; label: string }[] = [
  { value: 'rounded', label: 'Rounded' },
  { value: 'pill', label: 'Pill' },
  { value: 'speech', label: 'Speech' },
];
/** Border accent animations (first-time highlight + Outline events). All ride the
 *  border only, never the fill: 'sheen' sweeps a glint across it, 'pulse'
 *  breathes it brighter, 'chase' sends a spark around the ring. */
export type OverlayAnimation = 'none' | 'sheen' | 'pulse' | 'chase';

export const OVERLAY_ANIMATIONS: { value: OverlayAnimation; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sheen', label: 'Sheen' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'chase', label: 'Chase' },
];

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

  /** How stream events render. Every style shows the sender decorated (badges +
   *  paint name) + the event action. 'plain' keeps a subtle per-source tint,
   *  'outline' draws a thin ring in the source's color, and 'streamnook' adds
   *  the app's signature multi-color gradient wash. */
  eventStyle: 'plain' | 'streamnook' | 'outline';
  /** Outline events only: a nearly-transparent color-matched tint inside the
   *  ring, so the event reads highlighted instead of just bordered. */
  eventFill: boolean;
  /** Outline events only: border accent when the event lands. See
   *  OverlayAnimation. Plays once on arrival unless eventAnimateRepeat. */
  eventAnimation: OverlayAnimation;
  /** Replay the event animation every ~5 seconds while the event is on screen. */
  eventAnimateRepeat: boolean;
  /** Hide messages from known bot accounts / users carrying a bot badge. */
  hideBots: boolean;
  /** Legacy global event hides (e.g. 'raid', 'cheer'), applied to every platform.
   *  Superseded by the per-source hiddenProviderEvents below: clampOverlayStyle
   *  folds anything here into per-source keys and clears this, so new configs
   *  leave it empty. Kept in the type only so old saved configs still parse. */
  hiddenEvents: string[];
  /** The per-source event filter: which event categories are hidden, keyed
   *  `provider:category` (e.g. 'tiktok:follow'). Each platform is filtered on its
   *  own, so a Twitch raid and a Kick raid toggle independently. Empty = show all. */
  hiddenProviderEvents: string[];
  /** Target ISO currency to convert YouTube Super Chats into ('' = show as sent). */
  superchatCurrency: string;
  /** Per-source username blocklist, keyed `${provider}:${channel}` → usernames to
   *  hide (case-insensitive, matched against username OR display name). For bots the
   *  auto-hider misses. Matching is effectively per-platform (a name blocked on any
   *  source of a platform is hidden for that platform). */
  blockedUsers: Record<string, string[]>;
  /** Hide chat messages whose body starts with a command prefix (e.g. "!title").
   *  Only applies to normal messages, never to events. */
  hideCommands: boolean;
  /** Command filters applied when hideCommands is on. Each entry has an explicit
   *  mode: 'prefix' hides every message starting with `value` (e.g. '!' or '#'),
   *  'exact' hides only messages whose first word equals `value` (e.g. '!title'). */
  commandFilters: { value: string; mode: 'prefix' | 'exact' }[];
  /** Show 7TV paints on usernames. */
  showPaints: boolean;
  /** Show third-party badges (7TV, FFZ, Chatterino, and similar). Native platform
   *  badges are controlled separately by showBadges. */
  showThirdPartyBadges: boolean;
  /** Show StreamNook atmosphere backgrounds behind a member's chat row. */
  showAtmospheres: boolean;
  /** Third-party badge providers to hide, by id (e.g. 'ffz', 'chatterino', 'bttv',
   *  '7tv'). Each provider toggles independently, on top of the global
   *  showThirdPartyBadges master. See THIRD_PARTY_BADGE_PROVIDERS. */
  hiddenBadgeProviders: string[];
  /** How unicode emoji render. 'system' uses the OS/font emoji (varies by machine);
   *  the vendor styles re-render EVERY emoji from every platform as that one style's
   *  images, so a merged overlay looks consistent regardless of platform or OS. */
  emojiStyle: EmojiStyle;
  /** Show chatter profile pictures (YouTube and TikTok carry avatars). */
  showAvatars: boolean;
  /** Show the @ some platforms put in front of usernames (YouTube handles are
   *  "@name"). Off strips the leading @ wherever a name renders. */
  showAtSign: boolean;
  /** Show the small "Replying to @name" context line above a reply. */
  showReplies: boolean;
  /** How a chatter's first-ever message in the channel is marked. 'twitch' draws
   *  the outline + label Twitch's own chat uses; 'streamnook' uses the app chat's
   *  purple highlight (gradient wash + left border + label). Twitch sends the
   *  signal; other platforms don't, so it only ever fires on Twitch messages. */
  firstTimeStyle: FirstTimeStyle;
  /** Twitch style only: a nearly-transparent color-matched tint inside the ring,
   *  so the row reads highlighted instead of just bordered. (The StreamNook
   *  style's gradient wash is its own fill.) */
  firstTimeFill: boolean;
  /** Border accent when a first-time chatter's message lands (around the ring
   *  for the Twitch style, down the left bar for StreamNook). See
   *  OverlayAnimation. Plays once on arrival unless firstTimeAnimateRepeat. */
  firstTimeAnimation: OverlayAnimation;
  /** Replay the animation every ~5 seconds while the message is on screen,
   *  instead of once on arrival. Costs a little OBS paint work while a
   *  first-time message is visible (an idle overlay otherwise paints nothing). */
  firstTimeAnimateRepeat: boolean;
  /** Whether new messages appear at the bottom (chat-style) or the top. */
  direction: OverlayDirection;
  /** Entrance animation for incoming messages. */
  entrance: OverlayEntrance;
  /** Draw each chat message in its own bubble that hugs the text, instead of
   *  bare text over the scene. A member's atmosphere wash replaces the bubble
   *  on their rows; events keep their own event styling. */
  bubble: boolean;
  /** Bubble silhouette: 'rounded' uses bubbleRadius on every corner, 'pill'
   *  fully rounds the ends, 'speech' keeps rounded corners but tucks the
   *  bottom-left one in (a messenger-style tail corner). */
  bubbleShape: BubbleShape;
  /** Corner radius in px for the rounded/speech shapes (pill ignores it). */
  bubbleRadius: number;
  /** Bubble background color. */
  bubbleColor: string;
  /** Bubble background opacity, 0 to 1. */
  bubbleOpacity: number;
  /** Custom accent for the first-time chatter highlight (outline, fill, bar,
   *  wash, and label all follow it). '' = the style's own default: Twitch pink
   *  or StreamNook purple. */
  firstTimeColor: string;
  /** Outline events only: one fixed ring color for every event. '' = each
   *  event uses its source platform's color. */
  eventOutlineColor: string;
  /** Hide chat messages containing any of these words/phrases (case-insensitive
   *  substring). Never hides events. */
  hidePhrases: string[];
  /** Remove a message this many seconds after it appeared on the overlay
   *  (0 = keep it until it scrolls off). */
  maxMessageAgeSec: number;
  /** Clamp each chat message to this many lines, ending in an ellipsis
   *  (0 = no limit). */
  maxMessageLines: number;
  /** Restore the last on-screen messages after an OBS/browser source reload.
   *  Off (default) = the overlay comes back cleared on reload / stream start. */
  restoreOnReload: boolean;
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

// Badge providers the overlay resolves, each independently toggleable under the
// showThirdPartyBadges master. The `id` matches the `source` tagged on each
// resolved badge (7TV is the separate seventvBadge, StreamNook is the separate
// member-badge slot, everything else arrives in extraBadges with its provider).
export const THIRD_PARTY_BADGE_PROVIDERS: { id: string; label: string }[] = [
  { id: 'streamnook', label: 'StreamNook' },
  { id: '7tv', label: '7TV' },
  { id: 'ffz', label: 'FFZ' },
  { id: 'chatterino', label: 'Chatterino' },
  { id: 'homies', label: 'Homies' },
  { id: 'bttv', label: 'BTTV' },
  { id: 'chatsen', label: 'Chatsen' },
  { id: 'chatty', label: 'Chatty' },
  { id: 'dankchat', label: 'DankChat' },
];

// Font choices mirror the app's Theme › Font list so an overlay can match the
// streamer's in-app look. Values are CSS font-family strings.
// Unicode emoji rendering styles. 'system' = the OS/font emoji; the rest are image
// sets served from jsDelivr (emoji-datasource-<style>), sharing one codepoint
// filename convention so every emoji renders in the chosen style.
export const EMOJI_STYLES: { value: EmojiStyle; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'apple', label: 'Apple' },
  { value: 'google', label: 'Google' },
  { value: 'twitter', label: 'Twitter' },
  { value: 'facebook', label: 'Facebook' },
];

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
  eventFill: false,
  eventAnimation: 'none',
  eventAnimateRepeat: false,
  hideBots: false,
  hiddenEvents: [],
  hiddenProviderEvents: [],
  superchatCurrency: '',
  blockedUsers: {},
  hideCommands: false,
  commandFilters: [{ value: '!', mode: 'prefix' }],
  showPaints: true,
  showThirdPartyBadges: true,
  showAtmospheres: true,
  hiddenBadgeProviders: [],
  emojiStyle: 'apple',
  bubble: false,
  bubbleShape: 'rounded',
  bubbleRadius: 10,
  bubbleColor: '#0e0e10',
  bubbleOpacity: 0.55,
  firstTimeColor: '',
  eventOutlineColor: '',
  hidePhrases: [],
  maxMessageAgeSec: 0,
  maxMessageLines: 0,
  showAvatars: true,
  showAtSign: true,
  showReplies: true,
  firstTimeStyle: 'off',
  firstTimeFill: false,
  firstTimeAnimation: 'none',
  firstTimeAnimateRepeat: false,
  direction: 'newBottom',
  entrance: 'fade',
  restoreOnReload: false,
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
  bubbleOpacity: { min: 0.05, max: 1 },
  bubbleRadius: { min: 0, max: 24 },
  maxMessageAgeSec: { min: 0, max: 600 },
  maxMessageLines: { min: 0, max: 6 },
} as const;

// Coerce commandFilters into valid { value, mode } entries. Repairs legacy shapes
// (a plain string from an earlier version → inferred mode) and drops empties, so a
// stale saved config can never render blank/garbage chips or filter on nothing.
export function sanitizeCommandFilters(raw: unknown): { value: string; mode: 'prefix' | 'exact' }[] {
  if (!Array.isArray(raw)) return [];
  const out: { value: string; mode: 'prefix' | 'exact' }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let value = '';
    let mode: 'prefix' | 'exact' = 'prefix';
    if (typeof item === 'string') {
      value = item.trim();
      mode = /[a-z0-9]/i.test(value) ? 'exact' : 'prefix';
    } else if (item && typeof item === 'object') {
      const rec = item as { value?: unknown; mode?: unknown };
      value = String(rec.value ?? '').trim();
      mode = rec.mode === 'exact' ? 'exact' : 'prefix';
    }
    if (!value) continue;
    const key = `${mode}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, mode });
  }
  return out;
}

export const clampOverlayStyle = (s: OverlayStyle): OverlayStyle => {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  // Phrases: trimmed, non-empty, deduped case-insensitively, bounded so a
  // hand-edited config can't ship an absurd list.
  const phrases: string[] = [];
  const seenPhrases = new Set<string>();
  for (const p of Array.isArray(s.hidePhrases) ? s.hidePhrases : []) {
    const v = String(p ?? '').trim();
    const key = v.toLowerCase();
    if (!v || seenPhrases.has(key)) continue;
    seenPhrases.add(key);
    phrases.push(v);
    if (phrases.length >= 100) break;
  }
  // Event filtering is per-source (hiddenProviderEvents, keyed `provider:category`).
  // Fold the legacy global hiddenEvents in: each global hide expands to that
  // category on every platform that can emit it, then the global list is dropped.
  // Idempotent once migrated, so it is safe on every render (preview + hosted).
  const providerEvents = new Set(
    (Array.isArray(s.hiddenProviderEvents) ? s.hiddenProviderEvents : [])
      .filter((k) => typeof k === 'string' && k.includes(':')),
  );
  for (const cat of Array.isArray(s.hiddenEvents) ? s.hiddenEvents : []) {
    for (const [provider, cats] of Object.entries(PROVIDER_EVENT_CATEGORIES)) {
      if ((cats ?? []).includes(cat as EventCategory)) providerEvents.add(`${provider}:${cat}`);
    }
  }
  return {
    ...s,
    commandFilters: sanitizeCommandFilters(s.commandFilters),
    hidePhrases: phrases,
    hiddenEvents: [],
    hiddenProviderEvents: Array.from(providerEvents),
    bubbleOpacity: clamp(s.bubbleOpacity ?? 0.55, OVERLAY_LIMITS.bubbleOpacity.min, OVERLAY_LIMITS.bubbleOpacity.max),
    bubbleRadius: Math.round(clamp(s.bubbleRadius ?? 10, OVERLAY_LIMITS.bubbleRadius.min, OVERLAY_LIMITS.bubbleRadius.max)),
    maxMessageAgeSec: Math.round(clamp(s.maxMessageAgeSec ?? 0, OVERLAY_LIMITS.maxMessageAgeSec.min, OVERLAY_LIMITS.maxMessageAgeSec.max)),
    maxMessageLines: Math.round(clamp(s.maxMessageLines ?? 0, OVERLAY_LIMITS.maxMessageLines.min, OVERLAY_LIMITS.maxMessageLines.max)),
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
