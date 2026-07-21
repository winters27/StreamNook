// VOD chat replay engine: historical Twitch chat synced to VOD playback.
//
// VODs have no live IRC feed. The backend `get_vod_comments` command fetches a
// VOD's recorded chat (Twitch's own VideoComments GQL) and returns each comment
// already parsed into the same shape live chat uses. This store drips those
// comments into the chat panel as the player's playhead passes each comment's
// offset, so ChatWidget renders replay through its existing message path.
//
// The reactive surface is tiny (`messages` + a `version` counter); the buffer,
// pointer, and timers live in module scope so ticking never forces a React
// render unless the visible list actually changed.

import { create } from 'zustand';
import { useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getPlayerControls } from '../keybindings/playerControls';
import type { BackendChatMessage } from '../services/twitchChat';
import { EMPTY_ROOM_STATE } from './chatConnectionStore';
import { Logger } from '../utils/logger';

interface VodComment {
  content_offset_seconds: number;
  message: BackendChatMessage;
}

const VISIBLE_MAX = 200; // rendered-message cap (headroom for scroll-back)
const TICK_MS = 750; // playhead poll interval
const SEEK_BACK_S = 2; // backward jump beyond this = a seek, re-sync
const SEEK_FWD_S = 20; // forward jump beyond this = a seek, re-sync
const BACKLOG_LEAD_S = 15; // seed/seek fetch starts this far before the playhead
const REFILL_WITHIN = 40; // refill when fewer than this many buffered comments remain
const SEEK_SETTLE_MS = 400; // wait for scrubbing to settle before re-fetching

interface ReplayStore {
  /** True while a VOD replay session is active (drives ChatWidget's toggle availability). */
  active: boolean;
  /** Bumped on each `beginVodReplay` — ChatWidget resets its replay/live toggle to
   *  replay when this changes, so a new VOD always starts in replay. */
  sessionId: number;
  /** Bumped whenever `messages` changes — ChatWidget's list memo keys off this. */
  version: number;
  messages: BackendChatMessage[];
  error: string | null;
}

export const useVodReplayStore = create<ReplayStore>(() => ({
  active: false,
  sessionId: 0,
  version: 0,
  messages: [],
  error: null,
}));

// --- engine state (module-scoped, non-reactive) -----------------------------
let vodId: string | null = null;
let channelLogin: string | null = null;
let buffer: VodComment[] = []; // sorted ascending by offset
let ptr = 0; // index of the next not-yet-shown comment in `buffer`
let visible: BackendChatMessage[] = [];
const seen = new Set<string>(); // comment ids already buffered (dedup same-second overlap)
let lastTime = 0; // previous tick's playhead position
let fetching = false; // single in-flight fetch guard (kills scrub-thrash)
let nextFetchOffset = 0; // offset requested by the next refill
let reachedFrontier = false; // last fetch added nothing new — pause refills until playhead moves on
let ticker: ReturnType<typeof setInterval> | null = null;
let seekTimer: ReturnType<typeof setTimeout> | null = null;

function publish(messages: BackendChatMessage[], error: string | null = null): void {
  useVodReplayStore.setState((s) => ({ messages, error, version: s.version + 1 }));
}

async function fetchAt(offset: number): Promise<void> {
  if (fetching || !vodId || !channelLogin) return;
  fetching = true;
  const requestVod = vodId;
  try {
    const page = await invoke<VodComment[]>('get_vod_comments', {
      videoId: vodId,
      channelLogin,
      offsetSeconds: Math.max(0, offset),
    });
    // A stop()/begin() may have swapped the session while we awaited.
    if (vodId !== requestVod) return;

    let added = 0;
    let maxOffset = nextFetchOffset;
    for (const c of page) {
      if (!c.message || seen.has(c.message.id)) continue;
      seen.add(c.message.id);
      buffer.push(c);
      added++;
      if (c.content_offset_seconds > maxOffset) maxOffset = c.content_offset_seconds;
    }
    if (added > 0) {
      // Refills always fetch at/after the last offset we hold, so new comments
      // land at the tail; sorting keeps ascending order without disturbing the
      // already-emitted head (ptr stays valid).
      buffer.sort((a, b) => a.content_offset_seconds - b.content_offset_seconds);
    }
    nextFetchOffset = maxOffset;
    reachedFrontier = added === 0; // only-seen/empty ⇒ at the live frontier of buffered data
    if (useVodReplayStore.getState().error) publish(visible.slice()); // clear a prior error
  } catch (e) {
    Logger.warn('[VodReplay] get_vod_comments failed:', e);
    useVodReplayStore.setState((s) => ({ ...s, error: 'Could not load chat replay' }));
  } finally {
    fetching = false;
  }
}

function scheduleSeekResync(): void {
  if (seekTimer) clearTimeout(seekTimer);
  seekTimer = setTimeout(() => {
    seekTimer = null;
    const now = getPlayerControls()?.getCurrentTime() ?? lastTime;
    buffer = [];
    ptr = 0;
    visible = [];
    seen.clear();
    reachedFrontier = false;
    nextFetchOffset = Math.max(0, now - BACKLOG_LEAD_S);
    publish([]);
    void fetchAt(nextFetchOffset);
  }, SEEK_SETTLE_MS);
}

function tick(): void {
  const t = getPlayerControls()?.getCurrentTime();
  if (t == null || Number.isNaN(t)) return; // player not mounted yet (R2)

  // Seek detection is purely positional — no Plyr event wiring needed.
  if (t < lastTime - SEEK_BACK_S || t > lastTime + SEEK_FWD_S) {
    lastTime = t;
    scheduleSeekResync();
    return;
  }
  lastTime = t;
  if (seekTimer) return; // mid-seek settle: hold emissions until the resync fires

  let emitted = false;
  while (ptr < buffer.length && buffer[ptr].content_offset_seconds <= t) {
    visible.push(buffer[ptr].message);
    ptr++;
    emitted = true;
  }
  if (emitted) {
    if (visible.length > VISIBLE_MAX) visible = visible.slice(-VISIBLE_MAX);
    publish(visible.slice()); // fresh ref so the list memo re-renders
  }

  // Keep the buffer ahead of the playhead.
  if (!fetching && !reachedFrontier && buffer.length - ptr < REFILL_WITHIN) {
    void fetchAt(nextFetchOffset);
  } else if (!fetching && reachedFrontier && ptr >= buffer.length && t > nextFetchOffset + 1) {
    // We'd drained everything and the last fetch was empty, but the playhead has
    // since moved past that frontier — try again from the current position.
    reachedFrontier = false;
    void fetchAt(Math.floor(t));
  }
}

/** Start a replay session for a VOD. `channelLogin` keys the channel's
 *  third-party emote set for parsing. Safe to call over an existing session. */
export function beginVodReplay(id: string, login: string): void {
  stopVodReplay();
  vodId = id;
  channelLogin = login.toLowerCase();
  buffer = [];
  ptr = 0;
  visible = [];
  seen.clear();
  fetching = false;
  reachedFrontier = false;
  const t = getPlayerControls()?.getCurrentTime() ?? 0;
  lastTime = Number.isNaN(t) ? 0 : t; // avoid a spurious first-tick seek on resume
  nextFetchOffset = Math.max(0, lastTime - BACKLOG_LEAD_S);
  useVodReplayStore.setState((s) => ({
    active: true,
    sessionId: s.sessionId + 1,
    version: 0,
    messages: [],
    error: null,
  }));
  void fetchAt(nextFetchOffset);
  ticker = setInterval(tick, TICK_MS);
}

/** Force an immediate sync to the current playhead — e.g. when the viewer
 *  toggles back to replay from live chat. The engine keeps running in the
 *  background across a live/replay toggle, so this only catches up instantly
 *  instead of waiting for the next poll; it never clears or resets position. */
export function nudgeVodReplay(): void {
  tick();
}

/** Tear down the active replay session (called on stopStream / VOD swap). */
export function stopVodReplay(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  if (seekTimer) {
    clearTimeout(seekTimer);
    seekTimer = null;
  }
  vodId = null;
  channelLogin = null;
  buffer = [];
  ptr = 0;
  visible = [];
  seen.clear();
  fetching = false;
  reachedFrontier = false;
  useVodReplayStore.setState({ active: false, messages: [], error: null });
}

const NOOP = async (): Promise<void> => {};
const EMPTY_SET: Set<string> = new Set();
const EMPTY_MAP = new Map();

/** Chat-source object shaped exactly like `useTwitchChat()` / the provider chat,
 *  so ChatWidget can select it with no other structural change. Read-only:
 *  connect/send are no-ops (you can't post into a recorded stream). */
export function useVodReplaySnapshot() {
  const messages = useVodReplayStore((s) => s.messages);
  const version = useVodReplayStore((s) => s.version);
  const error = useVodReplayStore((s) => s.error);
  return useMemo(
    () => ({
      messages,
      connectChat: NOOP,
      sendMessage: NOOP,
      isConnected: true,
      error,
      setPaused: () => {},
      deletedMessageIds: EMPTY_SET,
      clearedUserContexts: EMPTY_MAP,
      roomState: { ...EMPTY_ROOM_STATE },
      userBadges: null,
      liveMessageCount: version,
    }),
    [messages, version, error],
  );
}
