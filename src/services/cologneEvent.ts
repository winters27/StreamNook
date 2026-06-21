// CS2 Major Cologne 2026 event cosmetic: shared constants + theme helpers.
//
// Earned by watching the Major in-app (the accolade below). Once earned, the look
// is a selectable Atmosphere with three layers:
//   background = the animated glass texture. Free for anyone who earned it.
//   coin       = the gold coin watermark. Opt-in add-on, gated to supporters.
//   border     = the gold frame. Opt-in add-on, gated to subscribers.
// The add-ons are encoded as suffix flags on the single `profile_theme` string so
// they stay viewer-readable with no schema change.

export const MAJOR_COLOGNE_ACCOLADE_ID = 'cs2_major_cologne_2026';

// Base profile_theme value when the Cologne look is applied (background only).
export const MAJOR_COLOGNE_THEME_ID = 'cs2-major-cologne';

export interface CologneCosmetics {
  coin: boolean;
  frame: boolean;
}

export function isCologneTheme(theme: string | null | undefined): boolean {
  return typeof theme === 'string' && theme.startsWith(MAJOR_COLOGNE_THEME_ID);
}

// Parse the add-on flags out of a Cologne profile_theme (null if not Cologne).
export function parseCologneTheme(theme: string | null | undefined): CologneCosmetics | null {
  if (!isCologneTheme(theme)) return null;
  return { coin: theme!.includes('+coin'), frame: theme!.includes('+border') };
}

// Build the profile_theme string for a given set of add-ons.
export function buildCologneTheme(c: CologneCosmetics): string {
  return MAJOR_COLOGNE_THEME_ID + (c.coin ? '+coin' : '') + (c.frame ? '+border' : '');
}
