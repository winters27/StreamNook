import type { CSSProperties } from 'react';
import type { ActivityKind } from '../types/activity';

// Visual grouping for activity events. Each kind maps to a category that drives
// its accent color in the feed, and each kind has a short human label for the
// row. Mirrors the mod-log category pattern so the widget and any future filter
// UI never drift.

export interface ActivityCategory {
  key: string;
  label: string;
  color: string;
  kinds: ActivityKind[];
}

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  { key: 'money', label: 'Bits, super chats & rants', color: '#ffb224', kinds: ['bits', 'superchat', 'supersticker', 'rant'] },
  { key: 'sub', label: 'Subs & members', color: '#8e4ec6', kinds: ['sub', 'resub', 'subgift', 'giftbomb', 'membership', 'member_milestone'] },
  { key: 'gift', label: 'Gifts & likes', color: '#e5484d', kinds: ['gift', 'like'] },
  { key: 'raid', label: 'Raids & hosts', color: '#f76808', kinds: ['raid', 'host'] },
  { key: 'community', label: 'Follows, joins & shares', color: '#30a46c', kinds: ['follow', 'join', 'share'] },
  { key: 'channel', label: 'Channel points & hype', color: '#0091ff', kinds: ['channelpoints', 'hypetrain'] },
  { key: 'stream', label: 'Stream status', color: '#7c8694', kinds: ['stream_online', 'stream_offline'] },
  { key: 'other', label: 'Everything else', color: '#7c8694', kinds: ['other'] },
];

const KIND_TO_CATEGORY: Record<string, ActivityCategory> = (() => {
  const m: Record<string, ActivityCategory> = {};
  for (const c of ACTIVITY_CATEGORIES) for (const k of c.kinds) m[k] = c;
  return m;
})();

export function categoryForKind(kind: ActivityKind): ActivityCategory {
  return KIND_TO_CATEGORY[kind] ?? ACTIVITY_CATEGORIES[ACTIVITY_CATEGORIES.length - 1];
}

export function colorForKind(kind: ActivityKind): string {
  return categoryForKind(kind).color;
}

const KIND_LABEL: Record<ActivityKind, string> = {
  follow: 'followed',
  sub: 'subscribed',
  resub: 'resubscribed',
  subgift: 'gifted a sub',
  giftbomb: 'gifted subs',
  raid: 'raided',
  bits: 'cheered',
  superchat: 'super chat',
  supersticker: 'super sticker',
  membership: 'became a member',
  member_milestone: 'member milestone',
  gift: 'sent a gift',
  like: 'sent likes',
  share: 'shared the stream',
  join: 'joined',
  host: 'hosted',
  rant: 'rant',
  channelpoints: 'redeemed',
  hypetrain: 'hype train',
  stream_online: 'went live',
  stream_offline: 'went offline',
  other: 'event',
};

export function labelForKind(kind: ActivityKind): string {
  return KIND_LABEL[kind] ?? 'event';
}

// Faint fill + clean border, matching the mod-log "box" highlight recipe.
export function activityHighlightStyle(color: string): CSSProperties {
  return { backgroundColor: `${color}14`, borderColor: `${color}66` };
}
