// Frontend side of the 7TV EventAPI bridge.
//
// The Rust seventv_eventapi service holds one shared WebSocket and emits
// `7tv://emote-set-update` to every window when a channel's 7TV emote set
// changes live. Each window applies it to ITS OWN per-window emote cache and
// injects the in-chat notice into its own chat store, so main and any MultiChat
// popout showing the channel both update independently.

import { injectSystemMessage, refreshChannelEmotes, systemSourceFor } from '../stores/chatConnectionStore';
import type { ProviderId } from '../types/providers';
import { forceRefreshCosmetics } from '../services/cosmeticsCache';
import { useAppStore } from '../stores/AppStore';
import { Logger } from '../utils/logger';

export interface EmoteSetUpdatePayload {
  channel: string; // lowercase channel key (login / slug / identifier)
  channel_id: string; // the platform's own channel id
  platform?: string; // 'twitch' (default) | 'kick' | 'youtube'
  actor_name: string;
  added: string[];
  removed: string[];
  renamed: { old: string; new: string }[];
}

/**
 * Apply a live 7TV emote-set change to the current window: refresh the channel's
 * emote cache (so the picker, autocomplete, and new messages pick up the change)
 * and, if enabled, drop a notice line in chat for each add/remove/rename.
 */
export async function handleSeventvEmoteSetUpdate(payload: EmoteSetUpdatePayload): Promise<void> {
  const { channel, channel_id, actor_name, added, removed, renamed } = payload;
  // 7TV supports all three platforms, so an update can be for any of them. The
  // chat slice is keyed by the composite key for a provider and by the bare
  // login for Twitch, and the emote refresh needs the provider so it hits that
  // platform's store rather than Twitch's Helix.
  const platform = (payload.platform || 'twitch') as ProviderId;
  const chatKey = platform === 'twitch' ? channel : `${platform}:${channel}`;

  // Refresh this window's emote cache from the (already refreshed) Rust cache.
  // refreshChannelEmotes busts the per-window cache and notifies subscribers,
  // so the emote picker and autocomplete repaint; chat does render-time emote
  // lookup, so new messages get the change with no extra work.
  try {
    await refreshChannelEmotes(channel, channel_id, platform);
  } catch (e) {
    Logger.warn('[7TV EventAPI] failed to refresh emotes for', channel, e);
  }

  const noticesEnabled =
    useAppStore.getState().settings.chat_design?.seventv_emote_notices ?? true;
  if (!noticesEnabled) return;

  const actor = actor_name || 'Someone';
  const source = systemSourceFor(chatKey);
  for (const name of added) {
    injectSystemMessage(chatKey, `${actor} added the emote ${name}`, undefined, source);
  }
  for (const name of removed) {
    injectSystemMessage(chatKey, `${actor} removed the emote ${name}`, undefined, source);
  }
  for (const r of renamed) {
    injectSystemMessage(chatKey, `${actor} renamed the emote ${r.old} to ${r.new}`, undefined, source);
  }
}

export interface CosmeticUpdatePayload {
  twitch_id: string;
  action: string; // 'create' | 'update' | 'delete'
}

/**
 * A present user's 7TV cosmetics changed (delivered live over the EventAPI).
 * We re-resolve the authoritative cosmetics through the existing v4 GQL path
 * (correct render shape, cached + coalesced), which publishes into the shared
 * cosmetics cache; the chatUserStore bridge then repaints their chat row if
 * they are visible, and a not-yet-seen user gets painted instantly on their
 * first message (the fetch pre-warmed the cache). The WS is the trigger; GQL
 * is the resolver.
 */
export async function handleSeventvCosmeticUpdate(payload: CosmeticUpdatePayload): Promise<void> {
  const { twitch_id } = payload;
  if (!twitch_id) return;

  // The WS says this user's cosmetics exist or just changed. Force a genuinely
  // fresh resolve (clears BOTH cache layers, incl. the lower-level 7TV
  // userCache) for every action: a 'create' can race a poisoned success-empty
  // from an earlier fetch, and 'update'/'delete' changed the selection. A plain
  // invalidate didn't reach the 7TV layer, so the stale entry was served for
  // its TTL and the change never showed.
  try {
    await forceRefreshCosmetics(twitch_id);
  } catch (e) {
    Logger.warn('[7TV EventAPI] cosmetics resolve failed for', twitch_id, e);
  }
}
