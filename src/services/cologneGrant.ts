// CS2 Major Cologne 2026 grant: earn the accolade by watching the
// Counter-Strike category in-app during the event window. Called from the
// watch-time tracker (App.tsx) on stream start and once a minute while watching.
import { invoke } from '@tauri-apps/api/core';
import { grantAccolade, getAccolades } from './supabaseService';
import { MAJOR_COLOGNE_ACCOLADE_ID } from './cologneEvent';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

// Universal cutoff: one absolute UTC instant ~24 hours from when this shipped, so
// the window ends at the same moment worldwide and no timezone is shorted
// (rounded up to a clean hour so everyone gets a full 24 hours). Comparing epoch
// ms is timezone-agnostic. After it closes, watching no longer grants it, but
// anyone who already earned it keeps it (accolades are permanent).
const MAJOR_COLOGNE_END_MS = Date.parse('2026-06-22T19:00:00Z');

function withinWindow(now: Date): boolean {
  return now.getTime() <= MAJOR_COLOGNE_END_MS;
}

// Twitch lists CS2 under the "Counter-Strike" category (the old name was
// "Counter-Strike: Global Offensive"); both contain this substring.
function isCounterStrike(gameName: string | null | undefined): boolean {
  return !!gameName && gameName.toLowerCase().includes('counter-strike');
}

// Granted-this-session guard so we don't write to Supabase every watch-minute.
// The DB upsert is idempotent anyway; this just avoids the redundant calls.
const grantedThisSession = new Set<string>();

export async function maybeGrantCologneFromWatch(
  userId: string | undefined | null,
  channelLogin: string | undefined | null,
  gameNameHint: string | null | undefined,
): Promise<void> {
  if (!userId || grantedThisSession.has(userId)) return;
  if (!withinWindow(new Date())) return;

  // The stream object's game_name is empty on some open paths (direct channel
  // open, raids), so don't trust it alone. If the hint doesn't already say CS,
  // ask the backend for the channel's real category before deciding.
  let game = gameNameHint ?? null;
  if (!isCounterStrike(game) && channelLogin) {
    try {
      const info = await invoke<{ game_name?: string }>('get_channel_info', { channelName: channelLogin });
      game = info?.game_name ?? game;
    } catch (e) {
      Logger.warn('[Cologne] get_channel_info failed:', e);
    }
  }

  Logger.info(`[Cologne] watch check channel=${channelLogin ?? '?'} game=${game ?? 'null'} match=${isCounterStrike(game)}`);
  if (!isCounterStrike(game)) return;

  grantedThisSession.add(userId);
  try {
    // Only ANNOUNCE a genuinely new earn. The grant is idempotent and a fresh
    // session re-runs this check, so re-watching after already holding it must
    // not re-toast "unlocked"; skip the write entirely when already held.
    const alreadyEarned = (await getAccolades(userId)).includes(MAJOR_COLOGNE_ACCOLADE_ID);
    if (alreadyEarned) {
      Logger.info('[Cologne] accolade already held for ' + userId);
      return;
    }
    // Granting only UNLOCKS the look in the picker; it does not auto-apply. The
    // member chooses to wear it from profile customization.
    await grantAccolade(userId, MAJOR_COLOGNE_ACCOLADE_ID);
    // Celebrate the unlock so they know they earned it, and point them at where
    // to wear it (the look is opt-in). alwaysShow so it lands even when routine
    // toasts are muted, matching the other achievement unlocks.
    useAppStore.getState().addToast(
      'Achievement unlocked: CS2 Major Cologne. Apply your new event look from profile customization.',
      'success',
      undefined,
      { alwaysShow: true },
    );
    Logger.info('[Cologne] accolade granted to ' + userId);
  } catch (e) {
    // Let a later watch-minute retry if the write failed.
    grantedThisSession.delete(userId);
    Logger.warn('[Cologne] grant failed:', e);
  }
}
