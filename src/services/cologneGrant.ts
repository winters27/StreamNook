// CS2 Major Cologne 2026 grant: earn the accolade by watching the
// Counter-Strike category in-app during the event window. Called from the
// watch-time tracker (App.tsx) on stream start and once a minute while watching.
//
// The event window is enforced SERVER-SIDE: this client resolves whether the
// watched stream is Counter-Strike (a signal only the client has) and then asks
// claim_drop to grant it. The server checks the deadline against its own clock,
// so rolling the system clock back can't reopen a closed drop, and the deadline
// can be changed in Supabase with no app release.
import { invoke } from '@tauri-apps/api/core';
import { claimReward } from './supabaseService';
import { MAJOR_COLOGNE_ACCOLADE_ID } from './cologneEvent';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

// The reward id matches the accolade id (this reward grants that accolade).
const MAJOR_COLOGNE_REWARD_ID = MAJOR_COLOGNE_ACCOLADE_ID;

// Twitch lists CS2 under the "Counter-Strike" category (the old name was
// "Counter-Strike: Global Offensive"); both contain this substring.
function isCounterStrike(gameName: string | null | undefined): boolean {
  return !!gameName && gameName.toLowerCase().includes('counter-strike');
}

// Granted-this-session guard so we don't re-claim every watch-minute once we've
// had a definitive answer for this user. The claim is idempotent server-side;
// this just avoids the redundant round-trips.
const grantedThisSession = new Set<string>();

// Latches once the server reports the window has closed, so the per-minute
// tracker stops asking for the rest of the session.
let windowClosed = false;

export async function maybeGrantCologneFromWatch(
  userId: string | undefined | null,
  channelLogin: string | undefined | null,
  gameNameHint: string | null | undefined,
): Promise<void> {
  if (!userId || windowClosed || grantedThisSession.has(userId)) return;

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

  // Server decides the window and writes the accolade. The category is passed as
  // context (audit only; the server can't independently verify what was watched).
  const res = await claimReward(userId, MAJOR_COLOGNE_REWARD_ID, { category: game });

  if (res.reason === 'window_closed') {
    windowClosed = true;
    Logger.info('[Cologne] drop window closed');
    return;
  }
  if (!res.ok) {
    // Transient (RLS / network / function not deployed): let a later watch-minute retry.
    Logger.warn('[Cologne] claim not ok:', res.reason ?? 'unknown');
    return;
  }

  // Definitive answer this session; stop re-claiming for this user.
  grantedThisSession.add(userId);

  if (res.granted) {
    // Celebrate a genuinely NEW earn (server reports granted:false when already
    // held, so re-watching doesn't re-announce). alwaysShow so it lands even
    // when routine toasts are muted, matching the other achievement unlocks.
    // Granting only UNLOCKS the look in the picker; the member chooses to wear
    // it from profile customization.
    useAppStore.getState().addToast(
      'Achievement unlocked: CS2 Major Cologne. Apply your new event look from profile customization.',
      'success',
      undefined,
      { alwaysShow: true },
    );
    Logger.info('[Cologne] accolade granted to ' + userId);
  } else {
    Logger.info('[Cologne] accolade already held for ' + userId);
  }
}
