import type { CSSProperties } from 'react';

// Severity categories for the mod log. Each moderation action maps to one
// category; the category drives the highlight color (with per-category user
// overrides in settings.moderation.mod_log_colors). Shared by the widget and
// the settings UI so they never drift.

export interface ModLogCategory {
  key: string;
  label: string;
  defaultColor: string;
  /** Lowercase action strings (and IRC/NOTICE aliases) that fall in this category. */
  actions: string[];
}

// Rich, distinct hues that read well on dark surfaces both as a 1px border and a
// low-opacity fill. Severity reads as a warm gradient: red (ban) -> orange
// (timeout) -> amber (delete) -> yellow (warn); restorative greens; etc.
export const MOD_LOG_CATEGORIES: ModLogCategory[] = [
  { key: 'ban', label: 'Bans', defaultColor: '#e5484d', actions: ['ban', 'removed'] },
  { key: 'timeout', label: 'Timeouts', defaultColor: '#f76808', actions: ['timeout'] },
  { key: 'delete', label: 'Message deletions', defaultColor: '#ffb224', actions: ['delete'] },
  { key: 'warn', label: 'Warnings', defaultColor: '#f5d90a', actions: ['warn'] },
  {
    key: 'reversal',
    label: 'Unbans & reversals',
    defaultColor: '#30a46c',
    actions: ['unban', 'untimeout', 'approve_unban_request'],
  },
  {
    key: 'roles',
    label: 'Roles (mod / VIP)',
    defaultColor: '#8e4ec6',
    actions: ['mod', 'unmod', 'vip', 'unvip'],
  },
  {
    key: 'mode',
    label: 'Chat modes & clear',
    defaultColor: '#0091ff',
    actions: [
      'clear', 'clear_chat',
      'emoteonly', 'emote_only_on', 'emoteonlyoff', 'emote_only_off',
      'followers', 'follower_only_on', 'followersoff', 'follower_only_off',
      'subscribers', 'subscriber_only_on', 'subscribersoff', 'subscriber_only_off',
      'slow', 'slow_mode_on', 'slowoff', 'slow_mode_off',
      'uniquechat', 'uniquechatoff',
    ],
  },
  { key: 'other', label: 'Everything else', defaultColor: '#7c8694', actions: [] },
];

const ACTION_TO_CATEGORY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of MOD_LOG_CATEGORIES) {
    for (const a of c.actions) m[a] = c.key;
  }
  return m;
})();

export function categoryForAction(action: string): string {
  return ACTION_TO_CATEGORY[(action || '').toLowerCase()] ?? 'other';
}

/** Resolve the highlight color for an action: user override for its category, else the default. */
export function colorForAction(action: string, overrides?: Record<string, string>): string {
  const key = categoryForAction(action);
  const cat =
    MOD_LOG_CATEGORIES.find((c) => c.key === key) ??
    MOD_LOG_CATEGORIES[MOD_LOG_CATEGORIES.length - 1];
  return overrides?.[key] || cat.defaultColor;
}

export type HighlightStyleKey = 'box' | 'bar' | 'dot';

export const MOD_LOG_STYLES: { key: HighlightStyleKey; label: string }[] = [
  { key: 'box', label: 'Box' },
  { key: 'bar', label: 'Bar' },
  { key: 'dot', label: 'Dot' },
];

/** Container styling for a mod-log entry given the chosen highlight style + color. */
export function highlightContainerStyle(style: HighlightStyleKey, color: string): CSSProperties {
  if (style === 'box') return { backgroundColor: `${color}14`, borderColor: `${color}66` }; // faint ~8% fill + clean ~40% border (calm crisp edge, not a saturated rim)
  if (style === 'bar') return { borderLeftWidth: '3px', borderLeftColor: color };
  return {};
}
