// Seasonal "limited" accolades: earned by opening StreamNook during a holiday
// or season window. Earned accolades persist to the account (user_accolades)
// so they stay collected after the window closes. The list + the date
// detection live here so the login-time grant (AppStore) and the Overview
// display agree.
//
// Seasons are broad windows (you collect the current season just by being
// around), holidays are narrow. Cake Day is dynamic per-user (your Twitch
// account anniversary) so it is handled via isCakeDay() rather than a fixed
// window here.

export interface SeasonalWindow {
  fromM: number; // month 1-12
  fromD: number;
  toM: number;
  toD: number;
}

export interface SeasonalAccoladeDef {
  id: string; // stable id stored in user_accolades.accolade_id
  label: string;
  // How to earn it, shown on the locked accolade's tooltip.
  hint: string;
  window: SeasonalWindow;
}

export const CAKE_DAY_ID = 'cake_day';

export const SEASONAL_ACCOLADES: SeasonalAccoladeDef[] = [
  // ── Holidays (narrow windows) ──────────────────────────────────────────
  { id: 'new_year', label: "New Year's", hint: 'Open StreamNook around New Year (Dec 31 to Jan 1)', window: { fromM: 12, fromD: 31, toM: 1, toD: 1 } },
  { id: 'valentines', label: "Valentine's", hint: "Open StreamNook around Valentine's Day (Feb 14)", window: { fromM: 2, fromD: 13, toM: 2, toD: 15 } },
  { id: 'st_patricks', label: "St. Patrick's", hint: "Open StreamNook around St. Patrick's Day (Mar 17)", window: { fromM: 3, fromD: 16, toM: 3, toD: 18 } },
  { id: 'april_fools', label: "April Fools'", hint: 'Open StreamNook on April Fools (Apr 1)', window: { fromM: 4, fromD: 1, toM: 4, toD: 1 } },
  { id: 'may_fourth', label: 'May the 4th', hint: 'Open StreamNook on May 4', window: { fromM: 5, fromD: 4, toM: 5, toD: 4 } },
  { id: 'halloween', label: 'Halloween', hint: 'Open StreamNook around Halloween (Oct 31)', window: { fromM: 10, fromD: 30, toM: 11, toD: 1 } },
  { id: 'thanksgiving', label: 'Turkey Day', hint: 'Open StreamNook around Thanksgiving (late Nov)', window: { fromM: 11, fromD: 22, toM: 11, toD: 28 } },
  { id: 'winter_holiday', label: 'Winter Holiday', hint: 'Open StreamNook around the winter holidays (Dec 24 to 26)', window: { fromM: 12, fromD: 24, toM: 12, toD: 26 } },
  // ── Seasons (broad windows) ────────────────────────────────────────────
  { id: 'spring', label: 'Spring', hint: 'Open StreamNook during spring (Mar 20 to Jun 20)', window: { fromM: 3, fromD: 20, toM: 6, toD: 20 } },
  { id: 'summer', label: 'Summer', hint: 'Open StreamNook during summer (Jun 21 to Sep 21)', window: { fromM: 6, fromD: 21, toM: 9, toD: 21 } },
  { id: 'fall', label: 'Fall', hint: 'Open StreamNook during fall (Sep 22 to Dec 20)', window: { fromM: 9, fromD: 22, toM: 12, toD: 20 } },
  { id: 'winter', label: 'Winter', hint: 'Open StreamNook during winter (Dec 21 to Mar 19)', window: { fromM: 12, fromD: 21, toM: 3, toD: 19 } },
];

const inWindow = (date: Date, w: SeasonalWindow): boolean => {
  const cur = (date.getMonth() + 1) * 100 + date.getDate();
  const from = w.fromM * 100 + w.fromD;
  const to = w.toM * 100 + w.toD;
  // Windows that wrap the year boundary (e.g. winter, Dec 21 to Mar 19).
  return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
};

/** Every seasonal accolade id whose window contains `date` (a day can hit a
 *  holiday AND its season, e.g. Halloween + Fall). */
export const getActiveSeasonalAccoladeIds = (date: Date): string[] =>
  SEASONAL_ACCOLADES.filter((b) => inWindow(date, b.window)).map((b) => b.id);

/** True when `date`'s month/day matches the Twitch account creation date. */
export const isCakeDay = (createdAt: string, date: Date): boolean => {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return false;
  return created.getMonth() === date.getMonth() && created.getDate() === date.getDate();
};
