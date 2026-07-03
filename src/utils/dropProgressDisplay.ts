import type { DropProgressStatus, DropProgress } from '../types';

export interface AutomationDisplay {
  dropId: string;
  currentMinutes: number;
  requiredMinutes: number;
  /** 0-100, rounded and clamped. */
  percent: number;
  /** Best known reward name, or '' when unknown — callers apply their own fallback. */
  dropName: string;
  dropImage?: string;
}

/**
 * Single source of truth for "what drop is being collected, and how far along."
 *
 * The drops UI shows automation progress in three places that must never disagree:
 * the title-bar badge, the overlay game cards, and the game detail panel. Each
 * used to derive the number its own way, so they drifted apart — most visibly,
 * the detail panel (which reads the live progress[] array) stayed current while
 * the card and title bar (which read dropProgress.current_drop directly) lagged
 * or showed nothing. This helper is the shared rule they all run through.
 *
 * Rule:
 *  - WHICH drop is shown is the backend's call, delivered via
 *    dropProgress.current_drop (the reward finishing first). We only derive the
 *    drop ourselves when current_drop is missing or points at a non-collectible
 *    (0-minute) reward.
 *  - HOW FAR along always prefers the freshest per-drop value from the live
 *    progress[] stream. progress[] is updated by every 'drops-progress-update'
 *    event (WebSocket + inventory poll) and refreshed authoritatively whenever
 *    inventory is fetched, whereas current_drop's own minutes only move on the
 *    slower backend poll — so progress[] is the value to trust when present.
 *
 * Returns null when nothing is being collected (or no progress is known yet).
 */
export function deriveDropProgressDisplay(
  dropProgress: DropProgressStatus | null,
  progress: DropProgress[],
): AutomationDisplay | null {
  if (!dropProgress?.active) return null;

  const liveFor = (dropId: string) =>
    progress.find((p) => p.drop_id === dropId) || null;

  // PRIMARY: the backend already chose the drop to display. Trust that choice,
  // but take its minutes from the live progress[] entry when we have one.
  const cd = dropProgress.current_drop;
  if (cd && cd.required_minutes > 0) {
    const live = liveFor(cd.drop_id);
    const required = live?.required_minutes_watched || cd.required_minutes;
    const current = Math.min(
      live ? live.current_minutes_watched : cd.current_minutes ?? 0,
      required,
    );
    return {
      dropId: cd.drop_id,
      currentMinutes: current,
      requiredMinutes: required,
      percent: required > 0 ? Math.min(100, Math.round((current / required) * 100)) : 0,
      dropName: cd.drop_name || live?.drop_name || '',
      dropImage: cd.drop_image || live?.drop_image,
    };
  }

  // FALLBACK: current_drop is missing (or a 0-minute reward). Mirror the
  // backend's rule from the live progress so a percentage still shows: the
  // active, unclaimed drop with the fewest watch-minutes remaining.
  const active = progress.filter(
    (p) =>
      !p.is_claimed &&
      p.current_minutes_watched > 0 &&
      p.current_minutes_watched < p.required_minutes_watched,
  );
  if (active.length === 0) return null;

  let best = active[0];
  let bestRemaining = best.required_minutes_watched - best.current_minutes_watched;
  for (const p of active) {
    const remaining = p.required_minutes_watched - p.current_minutes_watched;
    if (remaining < bestRemaining) {
      best = p;
      bestRemaining = remaining;
    }
  }

  const required = best.required_minutes_watched;
  const current = Math.min(best.current_minutes_watched, required);
  return {
    dropId: best.drop_id,
    currentMinutes: current,
    requiredMinutes: required,
    percent: required > 0 ? Math.min(100, Math.round((current / required) * 100)) : 0,
    dropName: best.drop_name || '',
    dropImage: best.drop_image,
  };
}
