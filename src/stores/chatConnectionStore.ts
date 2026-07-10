// Per-channel Twitch chat state, owned by a single shared WebSocket bridge to
// the Rust IRC service. Multiple consumers (the main app's ChatWidget plus N
// MultiChat tab widgets) acquire channels through this store; the store
// reference-counts subscribers so we hold exactly one IRC connection regardless
// of how many UI surfaces are viewing the same channel.
//
// Wire-format contract with the Rust backend (`src-tauri/src/services/irc_service.rs`):
//   • Native IRC frames (PRIVMSG / USERNOTICE / etc.) carry `#channel` in their
//     own text and are routed here by inspecting that substring.
//   • Synthetic events `USER_BADGES:#<channel>:<badges>`,
//     `{"type":"ROOMSTATE","channel":…}`, `{"type":"CLEARMSG","channel":…}`,
//     `{"type":"CLEARCHAT","channel":…}` carry the channel explicitly.
//   • Global events `HEARTBEAT`, `IRC_CONNECTED`, `RECONNECTING:n`,
//     `RECONNECTED`, `RECONNECT_*`, `CONNECTION_WARNING:…` are not channel-
//     scoped and apply to every active channel slice.
//
// Channel keys are stored lowercase — IRC frames always carry lowercase, so
// upstream callers using mixed case still resolve correctly via `.toLowerCase()`
// at the API boundary.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ProviderId } from '../types/providers';
import { makeKey, parseKey } from '../utils/providerKey';
import { parseBadges } from '../services/twitchBadges';
import { invoke } from '@tauri-apps/api/core';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';
import { fetchAllEmotes, fetchKickChannelEmotes, type EmoteSet } from '../services/emoteService';
import { Logger } from '../utils/logger';
import { useAppStore } from './AppStore';
import type { SongMatch } from '../utils/songId';

// Hard caps borrowed from the prior single-channel hook. Keeping them as
// per-channel limits means a 5-channel MultiChat caps memory at 5x the
// historical single-channel ceiling — bounded and predictable.
const CHAT_HISTORY_MAX = 100;
const CHAT_BUFFER_SIZE = 150; // extra slack while a channel is paused (scrolled up)
const CHAT_MAX_WITH_BUFFER = CHAT_HISTORY_MAX + CHAT_BUFFER_SIZE;

const MAX_RECONNECT_ATTEMPTS = 10;
const WS_OPEN_RETRY_ATTEMPTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const STALE_WARNING_MS = 2 * 60_000;
const STALE_RECONNECT_MS = 3 * 60_000;

// --- Public types -----------------------------------------------------------

export interface ModerationContext {
  type: 'timeout' | 'ban' | 'deleted';
  duration?: number;
  username?: string;
}

export interface ClearedUserEntry {
  context: ModerationContext;
  affectedMessageIds: Set<string>;
}

export interface RoomState {
  followersOnly: number; // -1 off, 0 any followers, >0 minutes
  slow: number;
  subsOnly: boolean;
  emoteOnly: boolean;
  r9k: boolean;
}

export const EMPTY_ROOM_STATE: RoomState = {
  followersOnly: -1,
  slow: 0,
  subsOnly: false,
  emoteOnly: false,
  r9k: false,
};

export interface SendUserInfo {
  username: string;
  displayName: string;
  userId: string;
  color?: string;
  badges?: string;
}

/** Identity of a chosen secondary account to send a message AS. */
export interface SendAsAccount {
  userId: string;
  login: string;
  displayName: string;
  color?: string;
}

interface ChannelSlice {
  channel: string;
  /** Source platform. Twitch keeps bare-login keys; non-Twitch sources are
   *  keyed "provider:channel". MultiChat only; the main app is always twitch. */
  provider: ProviderId;
  channelId: string | null;
  messages: any[];
  isConnected: boolean;
  error: string | null;
  roomState: RoomState;
  userBadges: string | null;
  deletedMessageIds: Set<string>;
  clearedUserContexts: Map<string, ClearedUserEntry>;
  /** Currently pinned message (provider-driven; e.g. Kick's pin event). */
  pinnedMessage: any | null;
  refCount: number;
  isPausedForBuffer: boolean;
  /** Monotonic count of live messages appended to this channel since the slice
   *  was created. NEVER decremented — buffer trimming, moderation removals, and
   *  the cap don't touch it. This is the reliable baseline for "N new messages
   *  since you paused": `messages.length` can't be used because it's capped and
   *  trimmed. Historical backfill (prepended, not live) is intentionally
   *  excluded — only `pushMessage` bumps it. */
  liveMessageCount: number;
  // Internals (not surfaced via the per-channel hook):
  seenMessageIds: Set<string>;
  /** IRC USERSTATE badges string, used to repaint optimistic messages with the
   *  caller's tenure-correct badges for the channel. */
  userBadgesFromIrc: string | null;
  /** The connected user's own chat color from USERSTATE. Lets own optimistic
   *  messages paint in the real color from the first frame instead of flashing
   *  a default until the IRC echo round-trips. */
  userColorFromIrc: string | null;
}

interface ChatConnectionState {
  channels: Map<string, ChannelSlice>;
  wsPort: number | null;
  /** Bumped any time something inside a channel slice mutates in place. Used
   *  by the per-channel hook to drive re-renders without forcing the store to
   *  fully re-create slice objects (the slice holds Sets/Maps that we mutate
   *  in place for perf, which Zustand wouldn't otherwise notice). */
  revision: number;
}

export const useChatConnectionStore = create<ChatConnectionState>(() => ({
  channels: new Map(),
  wsPort: null,
  revision: 0,
}));

// --- Module-scope mutable bridge state --------------------------------------
//
// The WebSocket and its associated timers live outside the Zustand state
// because (a) they are not React-reactive values, and (b) keeping them in
// closures avoids subtle issues with stale references inside the WS callbacks.

let ws: WebSocket | null = null;
let wsConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageTime = Date.now();
let intentionalDisconnect = false;
let currentUserId: string | null = null;

// Every Twitch user id that belongs to the local user (primary + any linked
// secondary accounts). Used so a message we sent from a secondary account is
// recognized as "own" during optimistic reconciliation, even though the IRC
// reader's identity is always the primary. Populated by the send-account store.
let ownAccountIds = new Set<string>();

export function setOwnAccountIds(ids: string[]): void {
  ownAccountIds = new Set(ids);
}

function isOwnUserId(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return userId === currentUserId || ownAccountIds.has(userId);
}

// The last own chat color USERSTATE reported, persisted so a cold launch can
// seed new channel slices and paint the first optimistic message correctly
// before this session's USERSTATE has arrived. USERSTATE refreshes it on every
// JOIN and after every send, so a color change propagates on its own.
const OWN_COLOR_KEY = 'streamnook:lastOwnChatColor';

function lastOwnChatColor(): string | null {
  try {
    return localStorage.getItem(OWN_COLOR_KEY);
  } catch {
    return null;
  }
}

function persistOwnChatColor(color: string): void {
  try {
    localStorage.setItem(OWN_COLOR_KEY, color);
  } catch {
    // Storage unavailable (private mode / quota); the in-memory slice cache
    // still removes the flash for this session.
  }
}

// Shared per-channel emote cache. Replaces the prior `const [emotes] = useState`
// inside every ChatWidget instance — three split panes for the same channel
// used to hold three copies of the same EmoteSet (~5–10k entries each, every
// entry an Emote object with URL and metadata). Now they share one reference.
//
// Strictly keyed by lowercase channel login so 7TV emotes with the same name
// in different channels never collide (e.g. "Stare" in #xqc vs "Stare" in
// #anothername — different emote ids, different URLs, different actual emotes).
const emoteCache = new Map<string, EmoteSet>();
const inflightEmoteFetches = new Map<string, Promise<EmoteSet | null>>();
const emoteSubscribers = new Map<string, Set<() => void>>();

function notifyEmoteSubscribers(channelKey: string) {
  const subs = emoteSubscribers.get(channelKey);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb();
    } catch (err) {
      Logger.warn('[ChatStore] emote subscriber callback threw:', err);
    }
  }
}

/** Subscribe to emote-cache changes for a specific channel. Returns an
 *  unsubscribe function. Used by `useChannelEmotes` to drive re-renders. */
export function subscribeChannelEmotes(channel: string, cb: () => void): () => void {
  const key = channel.toLowerCase();
  let set = emoteSubscribers.get(key);
  if (!set) {
    set = new Set();
    emoteSubscribers.set(key, set);
  }
  set.add(cb);
  return () => {
    const s = emoteSubscribers.get(key);
    if (s) {
      s.delete(cb);
      if (s.size === 0) emoteSubscribers.delete(key);
    }
  };
}

/** Returns the cached EmoteSet for a channel if present, else null. Does NOT
 *  fetch — call `ensureChannelEmotes` first or alongside. */
export function getChannelEmotes(channel: string): EmoteSet | null {
  return emoteCache.get(channel.toLowerCase()) ?? null;
}

/** Fetch the channel's emote set if not already cached. Coalesces concurrent
 *  callers via inflight tracking so 3 ChatWidget instances mounting the same
 *  channel all share one network round-trip. */
/**
 * Force re-fetch emotes for a channel by busting the frontend cache and
 * re-running the fetch pipeline. Used by /refresh. The Rust-side emote cache
 * has its own 5-minute TTL, so very-recent re-fetches may return cached data
 * from the backend; the frontend bust still triggers a fresh re-render of the
 * picker so the user sees the latest state.
 */
export async function refreshChannelEmotes(
  channel: string,
  channelId: string,
): Promise<EmoteSet | null> {
  const key = channel.toLowerCase();
  emoteCache.delete(key);
  inflightEmoteFetches.delete(key);
  return ensureChannelEmotes(key, channelId);
}

// The emote-cache key namespaces non-Twitch providers so the SAME channel slug on
// two platforms (e.g. xqc on Twitch and Kick) keeps separate emote sets. Twitch
// stays a bare login so its path is byte-identical.
export function emoteCacheKey(channel: string, provider: ProviderId = 'twitch'): string {
  const c = channel.toLowerCase();
  return provider === 'twitch' ? c : `${provider}:${c}`;
}

export async function ensureChannelEmotes(
  channel: string,
  channelId: string,
  provider: ProviderId = 'twitch',
): Promise<EmoteSet | null> {
  const key = emoteCacheKey(channel, provider);
  const cached = emoteCache.get(key);
  if (cached) return cached;
  const inflight = inflightEmoteFetches.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      // Kick has its own 7TV path (by Kick user id); Twitch keeps the full
      // BTTV/FFZ/7TV/native fetch. YouTube + TikTok have no channel-emote fetch
      // this pass — their messages are plain text / native emoji baked at parse
      // time, so there's no picker set to fetch.
      const set =
        provider === 'kick'
          ? await fetchKickChannelEmotes(channel.toLowerCase())
          : provider === 'youtube' || provider === 'tiktok'
            ? null
            : await fetchAllEmotes(channel.toLowerCase(), channelId);
      if (set) {
        emoteCache.set(key, set);
        notifyEmoteSubscribers(key);
      }
      return set;
    } catch (err) {
      Logger.warn(`[ChatStore] ensureChannelEmotes failed for ${key}:`, err);
      return null;
    } finally {
      inflightEmoteFetches.delete(key);
    }
  })();
  inflightEmoteFetches.set(key, promise);
  return promise;
}

// --- Helpers ----------------------------------------------------------------

function bumpRevision() {
  useChatConnectionStore.setState((state) => ({ revision: state.revision + 1 }));
}

// --- Coalesced render flush --------------------------------------------------
//
// Each incoming chat frame used to call bumpRevision() directly, which is one
// React render per message. Player and chat share a single webview main thread,
// and hls.js feeds the video buffer from that same thread (MSE appends are
// main-thread). At hundreds of messages/sec the per-message render rate pins the
// thread, starves the buffer appends, and playback stalls (bufferStalledError).
//
// Instead, brand-new messages are queued and the array append + render happen
// once per animation frame, so render rate is bounded by the frame rate no
// matter how fast chat moves. The video buffer gets the idle gaps it needs.
//
// Dedup (seenMessageIds) and the in-place reconciliation paths (own-message echo
// upgrade, Helix id stamp, moderation) still run synchronously at ingestion;
// only the array append and the render are deferred. In-place paths call
// scheduleFlush() (mark the frame dirty); new messages call queueMessage().
const pendingByChannel = new Map<string, any[]>();
// Two independent schedulers race to drain the queue, and the gate is "is any
// timer armed" — never a sticky boolean. rAF is the fast path: while the window
// is visible it fires at frame rate (~16ms), giving the render-coalescing that
// keeps the shared video buffer from starving under fast chat. The timeout is
// the liveness guarantee: rAF callbacks are suspended — and can be dropped
// outright, not merely deferred — while a WebView2 window is occluded,
// minimized, or mid-fullscreen-transition. A lone rAF gate whose callback was
// dropped would wedge this (the only live-render path) permanently, with no
// recovery short of releasing the channel — which is why a stream refresh, that
// repopulates history through a separate synchronous path, appeared to "fix"
// the backlog while new messages stayed frozen. Arming a timeout alongside rAF
// caps a dropped flush at FLUSH_MAX_LATENCY_MS, never forever. Whichever fires
// first drains the queue and cancels the other.
let rafHandle: number | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

const FLUSH_MAX_LATENCY_MS = 250;

function runFlush(): void {
  // Disarm both schedulers and null the handles BEFORE flushing, so the next
  // queueMessage re-arms cleanly and a throw inside flushPending can never strand
  // a handle that would block every future flush.
  if (rafHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  flushPending();
}

function scheduleFlush(): void {
  // Already armed — whichever timer wins drains everything queued since.
  if (rafHandle !== null || timeoutHandle !== null) return;
  // Always arm the timeout (liveness). Add the rAF fast path when visible; when
  // hidden, the timeout alone drains the queue (throttled by the platform, but
  // it always fires, so chat is current the moment the window is shown again).
  timeoutHandle = setTimeout(runFlush, FLUSH_MAX_LATENCY_MS);
  if (typeof requestAnimationFrame === 'function' && !(typeof document !== 'undefined' && document.hidden)) {
    rafHandle = requestAnimationFrame(runFlush);
  }
}

function flushPending(): void {
  const state = useChatConnectionStore.getState();
  for (const [key, queued] of pendingByChannel) {
    if (queued.length === 0) continue;
    const slice = state.channels.get(key);
    if (!slice) continue;
    const historyMax = getActiveHistoryMax();
    const limit = slice.isPausedForBuffer ? historyMax + CHAT_BUFFER_SIZE : historyMax;
    // Coalesce under load: only the last `limit` queued messages can survive the
    // cap this frame anyway, so drop the older ones before paying to reconcile
    // rows that would be sliced off the same frame. liveMessageCount still counts
    // every received message (drives the accurate "N new since paused" badge).
    const tail = queued.length > limit ? queued.slice(queued.length - limit) : queued;
    for (const m of tail) slice.messages.push(m);
    slice.liveMessageCount += queued.length;
    if (slice.messages.length > limit) {
      slice.messages = slice.messages.slice(slice.messages.length - limit);
    }
  }
  pendingByChannel.clear();
  // flushPending only runs when something called scheduleFlush(), so a render is
  // always warranted (covers both new-message appends and in-place upgrades).
  bumpRevision();
}

// Drain any queued messages into their slices immediately, outside the scheduled
// frame. Used by paths that scan slice.messages and must see just-arrived
// messages (e.g. a CLEARCHAT computing which messages a ban affects).
function flushPendingNow(): void {
  runFlush();
}

// Queue a brand-new message for the next coalesced flush instead of rendering it
// immediately. Dedup + reconciliation have already run on the caller's side.
function queueMessage(channelKey: string, msg: any): void {
  let q = pendingByChannel.get(channelKey);
  if (!q) {
    q = [];
    pendingByChannel.set(channelKey, q);
  }
  q.push(msg);
  scheduleFlush();
}

function getSlice(channel: string): ChannelSlice | undefined {
  return useChatConnectionStore.getState().channels.get(channel.toLowerCase());
}

function withSlice(channel: string, mutator: (slice: ChannelSlice) => void): void {
  const slice = getSlice(channel);
  if (!slice) return;
  mutator(slice);
  bumpRevision();
}

function emptySlice(
  channel: string,
  channelId: string | null,
  provider: ProviderId = 'twitch',
): ChannelSlice {
  return {
    channel: channel.toLowerCase(),
    provider,
    channelId,
    messages: [],
    isConnected: false,
    error: null,
    roomState: { ...EMPTY_ROOM_STATE },
    userBadges: null,
    deletedMessageIds: new Set(),
    clearedUserContexts: new Map(),
    pinnedMessage: null,
    refCount: 0,
    isPausedForBuffer: false,
    liveMessageCount: 0,
    seenMessageIds: new Set(),
    userBadgesFromIrc: null,
    userColorFromIrc: lastOwnChatColor(),
  };
}

function setSlice(channel: string, slice: ChannelSlice) {
  useChatConnectionStore.setState((state) => {
    const next = new Map(state.channels);
    next.set(channel.toLowerCase(), slice);
    return { channels: next, revision: state.revision + 1 };
  });
}

function removeSlice(channel: string) {
  useChatConnectionStore.setState((state) => {
    const next = new Map(state.channels);
    next.delete(channel.toLowerCase());
    return { channels: next, revision: state.revision + 1 };
  });
}

// Resolve the active per-channel buffer cap. Settings can override the
// hardcoded 100 default within [50, 1000]. Out-of-range values fall back
// to the default rather than crashing.
function getActiveHistoryMax(): number {
  const setting = useAppStore.getState().settings.chat_render?.message_buffer_cap;
  if (typeof setting !== 'number' || !Number.isFinite(setting)) return CHAT_HISTORY_MAX;
  return Math.max(50, Math.min(1000, Math.round(setting)));
}

function pushMessage(slice: ChannelSlice, msg: any) {
  const historyMax = getActiveHistoryMax();
  const limit = slice.isPausedForBuffer ? historyMax + CHAT_BUFFER_SIZE : historyMax;
  slice.messages.push(msg);
  // Monotonic — counts the append regardless of any trim below. Drives the
  // accurate "N new since paused" badge.
  slice.liveMessageCount++;
  if (slice.messages.length > limit) {
    slice.messages = slice.messages.slice(slice.messages.length - limit);
  }
}

/**
 * Retroactively repaint the PRIMARY account's own optimistic messages with the
 * latest USERSTATE badge set, and report whether anything changed.
 *
 * Why this is necessary: Twitch never echoes your own PRIVMSG back over your own
 * IRC read connection, so an own message exists only as the local optimistic
 * copy — the id-match echo upgrade in handleRawIrcString / appendStructuredMessage
 * can't fire for it. Its `badges=` tag is frozen at build time to
 * `slice.userBadgesFromIrc` (USERSTATE). If you send before USERSTATE has landed,
 * that tag is empty and there is otherwise NO path to your real badges short of a
 * leave + rejoin backfill (parse_historical_messages). This closes that gap by
 * rewriting the tag the moment USERSTATE arrives. Mirrors the cosmetics-repaint
 * bridge in chatUserStore, but for native Twitch badges. Only raw-string copies
 * are touched — backfilled / reconciled messages are structured objects that
 * already carry authoritative server badges.
 */
function repaintOwnBadges(slice: ChannelSlice, badges: string): boolean {
  if (!currentUserId) return false;
  const ownTag = `user-id=${currentUserId}`;
  let changed = false;
  for (let i = 0; i < slice.messages.length; i++) {
    const m = slice.messages[i];
    if (typeof m !== 'string' || !m.includes(ownTag)) continue;
    const current = m.match(/(?:^|;)badges=([^;]*)/)?.[1] ?? '';
    if (current === badges) continue;
    slice.messages[i] = m.replace(/(^|;)badges=[^;]*/, (_full, sep) => `${sep}badges=${badges}`);
    changed = true;
  }
  return changed;
}

/**
 * Retroactively repaint the PRIMARY account's own optimistic messages with the
 * real chat color from USERSTATE. Same rationale as repaintOwnBadges: Twitch
 * doesn't echo your own PRIVMSG back over your own read connection, so an own
 * message's `color=` tag is frozen at build time. If it was built before
 * USERSTATE landed (or with the default fallback), this rewrites it the moment
 * the real color arrives so the username never stays a wrong color.
 */
function repaintOwnColor(slice: ChannelSlice, color: string): boolean {
  if (!currentUserId) return false;
  const ownTag = `user-id=${currentUserId}`;
  let changed = false;
  for (let i = 0; i < slice.messages.length; i++) {
    const m = slice.messages[i];
    if (typeof m !== 'string' || !m.includes(ownTag)) continue;
    const current = m.match(/(?:^|;)color=([^;]*)/)?.[1] ?? '';
    if (current === color) continue;
    slice.messages[i] = m.replace(/(^|;)color=[^;]*/, (_full, sep) => `${sep}color=${color}`);
    changed = true;
  }
  return changed;
}

function setAllChannelsConnected(connected: boolean) {
  for (const slice of useChatConnectionStore.getState().channels.values()) {
    slice.isConnected = connected;
  }
  bumpRevision();
}

function setAllChannelsError(error: string | null) {
  for (const slice of useChatConnectionStore.getState().channels.values()) {
    slice.error = error;
  }
  bumpRevision();
}

// Extract the lowercase channel from an IRC line by locating the ` #` segment.
function extractChannelFromIrc(line: string): string | null {
  const idx = line.indexOf(' #');
  if (idx === -1) return null;
  const after = line.slice(idx + 2);
  const end = after.search(/[\s\r\n]/);
  const name = end === -1 ? after : after.slice(0, end);
  return name ? name.toLowerCase() : null;
}

// --- WebSocket lifecycle ----------------------------------------------------

async function openWebSocketWithRetry(port: number): Promise<WebSocket> {
  for (let attempt = 0; attempt < WS_OPEN_RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = 500 + attempt * 500;
      Logger.debug(
        `[ChatStore] Waiting ${delay}ms before WS connection attempt ${attempt + 1}/${WS_OPEN_RETRY_ATTEMPTS}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const socket = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WS open timeout')), 5_000);
        socket.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('WS open error'));
        };
      });
      return socket;
    } catch (err) {
      Logger.error(`[ChatStore] WS open attempt ${attempt + 1} failed:`, err);
      if (attempt === WS_OPEN_RETRY_ATTEMPTS - 1) throw err;
    }
  }
  throw new Error('All WS open attempts failed');
}

function startHealthCheck() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const elapsed = Date.now() - lastMessageTime;
    if (elapsed > STALE_WARNING_MS && elapsed <= STALE_RECONNECT_MS) {
      Logger.warn(
        `[ChatStore] No frames for ${Math.floor(elapsed / 1000)}s — connection may be stale`,
      );
      setAllChannelsError(`Connection may be stale — no data for ${Math.floor(elapsed / 1000)}s`);
    } else if (elapsed > STALE_RECONNECT_MS) {
      Logger.debug('[ChatStore] No frames for 3+ minutes — checking stream / reconnecting');
      lastMessageTime = Date.now();

      const { handleStreamOffline, currentStream, isAutoSwitching } = useAppStore.getState();
      if (!currentStream || isAutoSwitching) return;
      (async () => {
        try {
          const online = await invoke<boolean>('check_stream_online', {
            channel: currentStream.user_login,
          });
          if (online) {
            Logger.debug('[ChatStore] Stream online but chat dead, reconnecting chat');
            scheduleReconnect(0);
          } else {
            Logger.debug('[ChatStore] Stream offline, triggering handleStreamOffline');
            handleStreamOffline();
          }
        } catch (err) {
          Logger.warn('[ChatStore] Stream online check failed, reconnecting anyway:', err);
          scheduleReconnect(0);
        }
      })();
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function clearHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function scheduleReconnect(delayMs: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void reconnectAll();
  }, delayMs);
}

async function reconnectAll() {
  const state = useChatConnectionStore.getState();
  const channels = Array.from(state.channels.keys());
  if (channels.length === 0) return;

  intentionalDisconnect = true;
  if (ws) {
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.onopen = null;
    try {
      ws.close(1000, 'Reconnect');
    } catch {
      // ignore
    }
    ws = null;
  }
  intentionalDisconnect = false;

  // Re-attach with the first channel, then re-claim the rest. The Rust side
  // records consumer claims per window label in a set, so re-claiming a
  // channel this window already holds is a no-op (claims cannot inflate) and
  // re-claiming after a true cold restart (the Rust IRC service died and its
  // claim table was wiped) correctly re-registers us. `reattach: true` tells
  // start_chat to skip its stale-claim sweep: that sweep assumes a window
  // claim-starting its bridge holds no channels, which is true for a first
  // acquire but not here.
  const first = channels[0];
  const firstSlice = state.channels.get(first);
  if (!firstSlice) return;

  try {
    await connectBridgeForFirstChannel(
      first,
      firstSlice.channelId,
      true,
      firstSlice.provider,
      parseKey(first).channel,
    );
    for (const ch of channels.slice(1)) {
      const provider = state.channels.get(ch)?.provider ?? 'twitch';
      try {
        if (provider === 'twitch') {
          await invoke('join_chat_channel', { channel: ch });
        } else {
          await invoke('provider_chat_connect', { provider, channel: parseKey(ch).channel });
        }
      } catch (err) {
        Logger.error(`[ChatStore] Failed to re-join ${ch} during reconnect:`, err);
      }
    }
  } catch (err) {
    Logger.error('[ChatStore] Reconnect failed:', err);
    setAllChannelsError('Reconnection failed');
  }
}

/**
 * Force every open chat channel to tear down and reconnect. Used after switching
 * the main account: the IRC connection authenticates as the main, so it must
 * re-auth as the new identity for sends (slash-commands, IRC fallback) and
 * user-state to be correct. No-op when no channels are open.
 */
export async function reconnectAllChannels(): Promise<void> {
  await reconnectAll();
}

/**
 * Hard-refresh a single channel's chat — the chat-side analog of restarting the
 * stream. Wipes the visible message buffer + dedup/moderation state, busts and
 * re-fetches the channel's emote set, then forces the shared IRC bridge to tear
 * down and reconnect (which re-preloads recent history into the cleared buffer).
 *
 * Used by the overlay Refresh button and the /reload command so a refresh
 * reloads BOTH the video and chat, not just the video. The plain "reconnect
 * because the channel is unchanged" path is a deliberate no-op (see
 * useTwitchChat.connectChat), so a true refresh has to go through here.
 * No-op when the channel isn't currently acquired.
 */
export async function hardRefreshChannel(
  channel: string,
  channelId: string | null,
): Promise<void> {
  const key = channel.toLowerCase();
  const slice = useChatConnectionStore.getState().channels.get(key);
  if (!slice) return;

  // Visibly reset the channel so the reconnect repopulates it from scratch:
  // empty buffer, cleared dedup set, no lingering moderation overlays.
  // liveMessageCount resets so the "N new since paused" baseline starts clean.
  withSlice(key, (s) => {
    s.messages = [];
    s.seenMessageIds = new Set();
    s.deletedMessageIds = new Set();
    s.clearedUserContexts = new Map();
    s.liveMessageCount = 0;
  });
  pendingByChannel.delete(key);

  // Bust the emote cache and re-fetch. Fire-and-forget — the picker re-renders
  // via its subscription when the fresh set lands; chat doesn't block on it.
  if (channelId) void refreshChannelEmotes(key, channelId);

  // Tear down + reconnect the IRC bridge. connectBridgeForFirstChannel re-runs
  // preloadChannel for the first channel, re-seeding recent history into the
  // buffer we just cleared.
  await reconnectAll();
}

// [ChatPerf] Instrumentation for the "chat blank for ~30s on join" hunt.
// Brackets the connect path so a single repro names where the time goes:
// start_chat (Rust IRC connect + bridge spawn), WS open, or first relayed frame.
let chatConnectStartedAt = 0;
let chatFirstFrameLogged = true;

async function connectBridgeForFirstChannel(
  channel: string,
  channelId: string | null,
  // True when re-attaching after a reconnect, when this window's store still
  // holds channels; it suppresses the Rust-side sweep of this window's stale
  // claims that a fresh first-acquire start performs (see reconnectAll).
  reattach = false,
  // Source platform. Twitch uses start_chat (its dedicated IRC bridge); other
  // providers bring up the SAME local-WS bridge via provider_chat_connect.
  provider: ProviderId = 'twitch',
  // Platform channel for non-Twitch provider_chat_connect (the bare slug, not
  // the composite slice key). Defaults to the slice key for Twitch.
  bareChannel?: string,
): Promise<void> {
  if (wsConnecting) {
    Logger.debug('[ChatStore] WS already connecting, skipping duplicate request');
    return;
  }
  wsConnecting = true;
  try {
    Logger.debug(`[ChatStore] Invoking bridge connect for ${channel} (${provider})`);
    chatConnectStartedAt = performance.now();
    chatFirstFrameLogged = false;
    const port =
      provider === 'twitch'
        ? await invoke<number>('start_chat', { channel, reattach })
        : await invoke<number>('provider_chat_connect', {
            provider,
            channel: bareChannel ?? channel,
          });
    Logger.info(`[ChatPerf] bridge connect took ${Math.round(performance.now() - chatConnectStartedAt)}ms`);
    useChatConnectionStore.setState({ wsPort: port });

    const tBeforeWs = performance.now();
    const socket = await openWebSocketWithRetry(port);
    Logger.info(`[ChatPerf] WS bridge open took ${Math.round(performance.now() - tBeforeWs)}ms (connect total ${Math.round(performance.now() - chatConnectStartedAt)}ms)`);
    ws = socket;
    reconnectAttempts = 0;
    lastMessageTime = Date.now();

    socket.onmessage = (event) => handleWsMessage(event.data);
    socket.onerror = (err) => {
      Logger.error('[ChatStore] WS error:', err);
      setAllChannelsError('Connection error');
      setAllChannelsConnected(false);
    };
    socket.onclose = (event) => {
      Logger.debug('[ChatStore] WS closed:', event.code, event.reason);
      setAllChannelsConnected(false);
      if (intentionalDisconnect) return;
      if (useChatConnectionStore.getState().channels.size === 0) return;
      if (event.code === 1006 || event.code === 1001) {
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(1_000 * 2 ** (reconnectAttempts - 1), 30_000);
          Logger.debug(
            `[ChatStore] Scheduling reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
          );
          setAllChannelsError(
            `Connection lost — reconnecting in ${Math.round(delay / 1000)}s (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
          );
          scheduleReconnect(delay);
        } else {
          setAllChannelsError('Max reconnection attempts reached. Refresh chat.');
        }
      } else {
        setAllChannelsError('Connection closed');
      }
    };

    setAllChannelsConnected(true);
    startHealthCheck();

    // After first-channel connect, pre-load recent messages (Twitch-only: the
    // badge cache + history backfill don't apply to other providers).
    if (provider === 'twitch') void preloadChannel(channel, channelId);
  } finally {
    wsConnecting = false;
  }
}

// Populate the Twitch badge metadata cache for a given channel. Without this,
// `parseBadges()` returns `{info:null}` and ChatMessage renders no badge image.
// Idempotent — initializeBadgeCache deduplicates on its end. Safe to call again
// when a channelId arrives late.
async function initializeBadgesForChannel(channelId: string | null): Promise<void> {
  if (!channelId) return;
  try {
    const { initializeBadgeCache } = await import('../services/twitchBadges');
    await initializeBadgeCache(channelId);
  } catch (err) {
    Logger.warn('[ChatStore] Badge cache init failed:', err);
  }
}

async function preloadChannel(channel: string, channelId: string | null): Promise<void> {
  if (!channelId) return;
  const __tBadges = performance.now();
  await initializeBadgesForChannel(channelId);
  Logger.info(`[ChatPerf] preload: initializeBadgesForChannel ${Math.round(performance.now() - __tBadges)}ms`);

  try {
    const __tRecent = performance.now();
    const raw = await fetchRecentMessagesAsIRC(channel, channelId);
    Logger.info(`[ChatPerf] preload: fetchRecentMessages ${Math.round(performance.now() - __tRecent)}ms (${raw.length} msgs)`);
    if (raw.length === 0) return;
    const __tParse = performance.now();
    let parsed: any[] | null = null;
    let attempts = 0;
    while (attempts < 3 && !parsed) {
      try {
        if (attempts > 0) await new Promise((r) => setTimeout(r, 200 * attempts));
        parsed = await invoke<any[]>('parse_historical_messages', {
          messages: raw,
          channelName: channel,
        });
      } catch (err: any) {
        attempts++;
        const msg = err?.message ?? String(err);
        if (
          (msg.includes('Failed to fetch') || msg.includes('ERR_CONNECTION_REFUSED')) &&
          attempts < 3
        ) {
          continue;
        }
        Logger.warn('[ChatStore] parse_historical_messages failed, using raw IRC:', err);
        break;
      }
    }
    Logger.info(`[ChatPerf] preload: parse_historical_messages ${Math.round(performance.now() - __tParse)}ms`);
    withSlice(channel, (slice) => {
      const useParsed = parsed && parsed.length > 0;
      const source: any[] = useParsed ? (parsed as any[]) : raw;

      // De-dupe against messages already in the slice. The WS subscription
      // starts streaming live messages the moment handle_local_ws upgrades
      // the connection, but `preloadChannel` is async — IVR fetch + Rust
      // parse take ~hundreds of ms. Any live message that lands in that
      // window has already been appended via `appendStructuredMessage` (and
      // its id added to seenMessageIds). If we prepended naively, the same
      // id would appear twice in the array, which React reconciles as a
      // duplicate key — manifests as either a "two children with the same
      // key" warning OR a more subtle bug where the live half is omitted
      // and the chat appears to "stop receiving messages" once it catches
      // up to the historical batch.
      // Also dedupe against ids ALREADY in the array, not just seenMessageIds.
      // An own message that was sent (not received) lives in slice.messages
      // stamped with its real Helix id, but that id is intentionally never added
      // to seenMessageIds (so a later IRC echo can upgrade it in place). Without
      // this set, a history backfill that includes your own recent message would
      // not see it as already-present and would prepend a SECOND copy with the
      // same id — a duplicate React key that breaks reconciliation and leaks DOM.
      const existingIds = new Set<string>();
      for (const m of slice.messages) {
        const eid = typeof m === 'string' ? m.match(/(?:^|;)id=([^;]+)/)?.[1] : (m as any)?.id;
        if (eid) existingIds.add(eid);
      }
      const filtered: any[] = [];
      for (const msg of source) {
        const id =
          typeof msg === 'string' ? msg.match(/(?:^|;)id=([^;]+)/)?.[1] : msg?.id;
        if (id) {
          if (slice.seenMessageIds.has(id) || existingIds.has(id)) continue;
          slice.seenMessageIds.add(id);
        }
        filtered.push(msg);
      }

      // Prepend so recent history appears before live messages
      slice.messages = [...filtered, ...slice.messages];
      const historyMax = getActiveHistoryMax();
      const limit = slice.isPausedForBuffer ? historyMax + CHAT_BUFFER_SIZE : historyMax;
      if (slice.messages.length > limit) {
        slice.messages = slice.messages.slice(slice.messages.length - limit);
      }
    });
  } catch (err) {
    Logger.error('[ChatStore] Failed to fetch recent messages:', err);
  }
}

/** MultiChat: a Twitch pane resolves its channelId after the pane mounts (the
 *  stream-info poll runs post-render). When a channel was acquired WITHOUT an id
 *  (a Go Live seed, or a saved source stored without one), the acquire-time
 *  preload bailed — so an OFFLINE channel, which has no live messages arriving,
 *  shows an empty pane even though the core app shows its recent chat. Once the
 *  pane has the id it calls this to run the one-time recent-history backfill.
 *  preloadChannel dedups against what's already in the slice, so this is safe
 *  even if a backfill already ran. */
export async function ensureChannelHistory(
  channel: string,
  channelId: string | null,
): Promise<void> {
  if (!channelId) return;
  await preloadChannel(channel.toLowerCase(), channelId);
}

// --- Incoming message routing ----------------------------------------------

function handleWsMessage(raw: string) {
  lastMessageTime = Date.now();

  // Global signals first
  if (raw === 'HEARTBEAT') {
    setAllChannelsError(null);
    return;
  }

  if (!chatFirstFrameLogged) {
    chatFirstFrameLogged = true;
    Logger.info(`[ChatPerf] first chat frame relayed ${Math.round(performance.now() - chatConnectStartedAt)}ms after connect start`);
  }
  if (raw === 'IRC_CONNECTED' || raw === 'RECONNECTED') {
    setAllChannelsConnected(true);
    setAllChannelsError(null);
    reconnectAttempts = 0;
    return;
  }
  if (raw === 'IRC_RECONNECTING') {
    setAllChannelsError('Reconnecting to chat...');
    return;
  }
  if (raw.startsWith('RECONNECTING:')) {
    setAllChannelsConnected(false);
    return;
  }
  if (raw.startsWith('RECONNECT_FAILED:')) {
    return;
  }
  if (raw === 'RECONNECT_STOPPED' || raw === 'RECONNECT_EXHAUSTED') {
    setAllChannelsError(
      raw === 'RECONNECT_EXHAUSTED'
        ? 'Unable to reconnect to chat. Please refresh.'
        : 'Connection stopped',
    );
    setAllChannelsConnected(false);
    return;
  }
  if (raw.startsWith('CONNECTION_WARNING:')) {
    const warn = raw.slice('CONNECTION_WARNING:'.length);
    setAllChannelsError(`Warning: ${warn}`);
    return;
  }

  // USER_BADGES:#<channel>:<badges>  (legacy: USER_BADGES:<badges>)
  if (raw.startsWith('USER_BADGES:')) {
    const payload = raw.slice('USER_BADGES:'.length);
    let channel: string | null = null;
    let badges: string;
    if (payload.startsWith('#')) {
      const colonIdx = payload.indexOf(':');
      if (colonIdx > 1) {
        channel = payload.slice(1, colonIdx).toLowerCase();
        badges = payload.slice(colonIdx + 1);
      } else {
        badges = payload;
      }
    } else {
      badges = payload;
    }
    if (channel) {
      withSlice(channel, (slice) => {
        slice.userBadgesFromIrc = badges;
        slice.userBadges = badges;
        // Repaint any already-sent own messages that were built before this
        // USERSTATE landed (withSlice bumps the render revision for us).
        repaintOwnBadges(slice, badges);
      });
    } else {
      // Legacy untagged badges — apply to whichever channel exists (only one
      // when running the pre-multi-channel main app shape). Multi-channel
      // builds always carry the tag.
      const channels = useChatConnectionStore.getState().channels;
      if (channels.size === 1) {
        const slice = channels.values().next().value as ChannelSlice;
        slice.userBadgesFromIrc = badges;
        slice.userBadges = badges;
        repaintOwnBadges(slice, badges);
        bumpRevision();
      }
    }
    return;
  }

  // USER_COLOR:#<channel>:<color>  (legacy: USER_COLOR:<color>)
  // The connected user's own chat color from USERSTATE. Cache it and repaint
  // any own messages already sent with the build-time default.
  if (raw.startsWith('USER_COLOR:')) {
    const payload = raw.slice('USER_COLOR:'.length);
    let channel: string | null = null;
    let color: string;
    if (payload.startsWith('#')) {
      const colonIdx = payload.indexOf(':');
      if (colonIdx > 1) {
        channel = payload.slice(1, colonIdx).toLowerCase();
        color = payload.slice(colonIdx + 1);
      } else {
        color = payload;
      }
    } else {
      color = payload;
    }
    if (color) {
      persistOwnChatColor(color);
      if (channel) {
        withSlice(channel, (slice) => {
          slice.userColorFromIrc = color;
          repaintOwnColor(slice, color);
        });
      } else {
        const channels = useChatConnectionStore.getState().channels;
        if (channels.size === 1) {
          const slice = channels.values().next().value as ChannelSlice;
          slice.userColorFromIrc = color;
          repaintOwnColor(slice, color);
          bumpRevision();
        }
      }
    }
    return;
  }

  // Channel-tagged JSON events
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'CLEARMSG' && parsed.target_msg_id) {
        const ch = (parsed.channel as string | undefined)?.toLowerCase();
        const modSettings = useAppStore.getState().settings.moderation;
        const ignoreClear = modSettings?.ignore_clear_chat ?? false;
        const showModMsgs = modSettings?.show_mod_messages ?? false;
        const apply = (slice: ChannelSlice) => {
          if (!ignoreClear) slice.deletedMessageIds.add(parsed.target_msg_id);
        };
        if (ch) withSlice(ch, apply);
        else for (const s of useChatConnectionStore.getState().channels.values()) apply(s);
        // The frame may not carry the author/text (Kick's delete event only gives
        // the message id), so recover them from chat history by that id — the
        // message is still in the slice (deletion only marks it, doesn't drop it).
        // Twitch's IRC CLEARMSG already includes both, so this only fills the gaps.
        let delLogin = (parsed.login as string | undefined) || undefined;
        let delMessage = (parsed.message as string | undefined) || undefined;
        if ((!delLogin || !delMessage) && ch) {
          const hit = useChatConnectionStore
            .getState()
            .channels.get(ch)
            ?.messages.find((m) => typeof m !== 'string' && m.id === parsed.target_msg_id);
          if (hit && typeof hit !== 'string') {
            delLogin = delLogin || hit.display_name || hit.username;
            delMessage = delMessage || hit.content;
          }
        }
        if (showModMsgs && ch) {
          const who = delLogin ?? 'a user';
          injectSystemMessage(ch, `${who}'s message was deleted by a moderator.`);
        }
        // Moderator log: message deletions are broadcast to every viewer over IRC,
        // so this populates the log even when you're not a mod. The EventSub feed
        // (mod-only) upgrades this entry in place with the acting moderator's name.
        useAppStore.getState().addModLog({
          id: `irc-${Date.now()}-${Math.random()}`,
          action: 'delete',
          timestamp: new Date().toISOString(),
          moderator_name: (parsed.moderator as string) || 'A moderator',
          target_user_name: delLogin || undefined,
          target_user_login: delLogin || undefined,
          message: delMessage || undefined,
          reason: (parsed.reason as string) || undefined,
          channel: ch,
          source: 'irc',
          details: parsed,
        });
        bumpRevision();
        return;
      }
      if (parsed.type === 'CLEARCHAT') {
        // Drain queued messages first so the affected-message scan below sees
        // anything that arrived in the current (not-yet-flushed) frame.
        flushPendingNow();
        const ch = (parsed.channel as string | undefined)?.toLowerCase();
        const modSettings = useAppStore.getState().settings.moderation;
        const ignoreClear = modSettings?.ignore_clear_chat ?? false;
        const showModMsgs = modSettings?.show_mod_messages ?? false;
        const apply = (slice: ChannelSlice) => {
          if (!parsed.target_user_id) return; // full chat clear — UI doesn't track this today
          if (ignoreClear) return; // user opted out of moderation strikethrough overlays
          const modType: 'timeout' | 'ban' =
            parsed.ban_duration !== undefined && parsed.ban_duration !== null
              ? 'timeout'
              : 'ban';
          const affected = new Set<string>();
          for (const msg of slice.messages) {
            const msgUserId =
              typeof msg !== 'string'
                ? msg.user_id
                : msg.match?.(/user-id=([^;]+)/)?.[1];
            const msgId =
              typeof msg !== 'string' ? msg.id : msg.match?.(/(?:^|;)id=([^;]+)/)?.[1];
            if (msgUserId === parsed.target_user_id && msgId) affected.add(msgId);
          }
          slice.clearedUserContexts.set(parsed.target_user_id, {
            context: {
              type: modType,
              duration: parsed.ban_duration,
              username: parsed.target_user,
            },
            affectedMessageIds: affected,
          });
        };
        if (ch) withSlice(ch, apply);
        else for (const s of useChatConnectionStore.getState().channels.values()) apply(s);
        if (showModMsgs && ch && parsed.target_user_id) {
          const who = parsed.target_user ?? 'A user';
          let line: string;
          if (parsed.ban_duration !== undefined && parsed.ban_duration !== null) {
            const secs = parsed.ban_duration as number;
            const human =
              secs >= 86400 ? `${Math.round(secs / 86400)}d` :
              secs >= 3600  ? `${Math.round(secs / 3600)}h` :
              secs >= 60    ? `${Math.round(secs / 60)}m` :
              `${secs}s`;
            line = `${who} was timed out for ${human}.`;
          } else {
            line = `${who} was banned.`;
          }
          injectSystemMessage(ch, line);
        } else if (showModMsgs && ch && !parsed.target_user_id) {
          injectSystemMessage(ch, 'Chat was cleared by a moderator.');
        }
        // Moderator log: timeouts/bans/clears are broadcast to every viewer over
        // IRC (anonymized — no acting moderator). This is the baseline feed that
        // works in any channel, live or offline, main or multi. The EventSub
        // channel.moderate feed upgrades these with the moderator name when you
        // moderate the channel.
        {
          const appState = useAppStore.getState();
          if (parsed.target_user_id) {
            const isTimeout = parsed.ban_duration !== undefined && parsed.ban_duration !== null;
            // Surface the target's most recent message in this channel as the
            // likely reason for the action — mirrors how deletions show the removed
            // text. CLEARCHAT carries no message, so read it back from chat history:
            // the messages are still present (CLEARCHAT only marks them cleared, it
            // doesn't drop them). Chronological order means the last match wins.
            // Recover what the action frame omits from chat history: the target's
            // display name (YouTube/Kick frames give only an id), their last removed
            // message, and how many of their messages were cleared.
            let lastMessage: string | undefined;
            let recoveredName: string | undefined;
            let removedCount = 0;
            const targetSlice = ch ? useChatConnectionStore.getState().channels.get(ch) : undefined;
            if (targetSlice) {
              for (const msg of targetSlice.messages) {
                const msgUserId =
                  typeof msg !== 'string'
                    ? msg.user_id
                    : msg.match?.(/user-id=([^;]+)/)?.[1];
                if (msgUserId !== parsed.target_user_id) continue;
                removedCount += 1;
                if (typeof msg !== 'string') {
                  recoveredName = msg.display_name || msg.username || recoveredName;
                }
                const text =
                  typeof msg !== 'string'
                    ? (msg.content as string | undefined)
                    : msg.match?.(/PRIVMSG #\w+ :(.+)$/)?.[1];
                if (typeof text === 'string' && text.trim()) lastMessage = text.trim();
              }
            }
            appState.addModLog({
              id: `irc-${Date.now()}-${Math.random()}`,
              // YouTube's anonymous feed can't distinguish a timeout from a permanent
              // ban (both are a duration-less "remove all by author"), so log those as
              // a neutral "removed" rather than mislabeling them "banned".
              action: isTimeout ? 'timeout' : parsed.provider === 'youtube' ? 'removed' : 'ban',
              timestamp: new Date().toISOString(),
              moderator_name: (parsed.moderator as string) || 'A moderator',
              target_user_name: (parsed.target_user as string) || recoveredName || undefined,
              target_user_id: (parsed.target_user_id as string) || undefined,
              target_user_login: (parsed.target_user as string) || undefined,
              duration: isTimeout ? (parsed.ban_duration as number) : undefined,
              removed_count: removedCount || undefined,
              message: lastMessage,
              channel: ch,
              source: 'irc',
              details: parsed,
            });
          } else {
            appState.addModLog({
              id: `irc-${Date.now()}-${Math.random()}`,
              action: 'clear',
              timestamp: new Date().toISOString(),
              moderator_name: (parsed.moderator as string) || 'A moderator',
              channel: ch,
              source: 'irc',
              details: parsed,
            });
          }
        }
        bumpRevision();
        return;
      }
      if (parsed.type === 'PINNED' || parsed.type === 'UNPINNED') {
        // Provider-driven pinned message (e.g. Kick's Pusher pin event). Stash it
        // on the slice; ChatWidget feeds it into the same pinned banner as Twitch.
        const ch = (parsed.channel as string | undefined)?.toLowerCase();
        const pin = parsed.type === 'PINNED' ? parsed.pin : null;
        if (ch) withSlice(ch, (slice) => { slice.pinnedMessage = pin; });
        bumpRevision();
        return;
      }
      if (parsed.type === 'ROOMSTATE') {
        const ch = (parsed.channel as string | undefined)?.toLowerCase();
        const apply = (slice: ChannelSlice) => {
          slice.roomState = {
            followersOnly: parsed.followers_only ?? slice.roomState.followersOnly,
            slow: parsed.slow ?? slice.roomState.slow,
            subsOnly: parsed.subs_only ?? slice.roomState.subsOnly,
            emoteOnly: parsed.emote_only ?? slice.roomState.emoteOnly,
            r9k: parsed.r9k ?? slice.roomState.r9k,
          };
        };
        if (ch) withSlice(ch, apply);
        else for (const s of useChatConnectionStore.getState().channels.values()) apply(s);
        bumpRevision();
        return;
      }
      if (parsed.type === 'NOTICE') {
        handleNotice(parsed);
        return;
      }

      // Structured ChatMessage (from Rust parser) — route by parsed.channel if
      // present (future server change), else by content.
      const messageId = parsed.id;
      if (messageId) {
        // Determine target channel: ChatMessage carries no explicit channel
        // field today, but the channel was used at parse time. Fall back to
        // the only acquired channel when ambiguous. For multi-channel
        // operation we may want Rust to emit a channel field on ChatMessage —
        // tracked as a follow-up.
        const channels = useChatConnectionStore.getState().channels;
        let targetChannel: string | null = null;
        if (parsed.channel) {
          targetChannel = (parsed.channel as string).toLowerCase();
        } else if (channels.size === 1) {
          targetChannel = channels.keys().next().value as string;
        }
        if (!targetChannel) return;
        const slice = channels.get(targetChannel);
        if (!slice) return;
        appendStructuredMessage(slice, parsed);
        return;
      }
    } catch (e) {
      Logger.error('[ChatStore] Failed to parse JSON message:', e);
      // fall through to raw-string handling
    }
  }

  // Raw IRC string — route by the `#channel` in the line.
  handleRawIrcString(raw);
}

function handleNotice(parsed: any) {
  const msgId = parsed.msg_id as string | undefined;
  const modActionMap: Record<string, string> = {
    host_on: 'host',
    host_off: 'unhost',
    slow_on: 'slow_mode_on',
    slow_off: 'slow_mode_off',
    subs_on: 'subscriber_only_on',
    subs_off: 'subscriber_only_off',
    emote_only_on: 'emote_only_on',
    emote_only_off: 'emote_only_off',
    followers_on: 'follower_only_on',
    followers_off: 'follower_only_off',
    followers_on_zero: 'follower_only_on',
    // timeout_success / ban_success intentionally omitted: those self-action
    // NOTICEs only fire for the moderator who acted and carry no target, while
    // CLEARCHAT now logs every timeout/ban universally with the real target.
    unban_success: 'unban',
    untimeout_success: 'untimeout',
    clear_chat: 'clear_chat',
  };

  if (msgId && modActionMap[msgId]) {
    const appState = useAppStore.getState();
    const eventSubAction = msgId.replace('_on', '').replace('_off', '').replace('_success', '');
    const recentlyAdded = appState.modLogs.some(
      (l) =>
        (l.action === eventSubAction || l.action === modActionMap[msgId]) &&
        new Date(l.timestamp).getTime() > Date.now() - 2_000,
    );
    if (!recentlyAdded) {
      appState.addModLog({
        id: `irc-${Date.now()}-${Math.random()}`,
        action: modActionMap[msgId],
        timestamp: new Date().toISOString(),
        moderator_name: 'Twitch System',
        target_user_name: 'Stream/Settings',
        reason: parsed.message,
        channel: parsed.channel,
        source: 'irc',
        details: parsed,
      });
    }
  }

  // Rejection: drop the most recent optimistic message within last 5s.
  const rejectionIds = new Set([
    'msg_followersonly',
    'msg_followersonly_followed',
    'msg_followersonly_zero',
    'msg_subsonly',
    'msg_slowmode',
    'msg_r9k',
    'msg_verified_email',
    'msg_ratelimit',
    'msg_duplicate',
    'msg_banned',
    'msg_timedout',
    'msg_rejected',
    'msg_rejected_mandatory',
    'msg_requires_verified_phone_number',
  ]);
  if (msgId && rejectionIds.has(msgId)) {
    const cutoff = Date.now() - 5_000;
    for (const slice of useChatConnectionStore.getState().channels.values()) {
      for (let i = slice.messages.length - 1; i >= 0; i--) {
        const m = slice.messages[i];
        if (typeof m !== 'string' || !m.includes('id=local-')) continue;
        const tsMatch = m.match(/tmi-sent-ts=(\d+)/);
        const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
        if (ts >= cutoff) {
          slice.messages.splice(i, 1);
          break;
        }
      }
    }
    bumpRevision();
  }

  // Surface notice as an inline system message in the channel it belongs to.
  // NOTICE JSON doesn't currently carry channel; for multi-channel correctness
  // we route to the only acquired channel (today's main-app shape) or skip.
  if (parsed.message) {
    const sysMsgId = `notice-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const channels = useChatConnectionStore.getState().channels;
    if (channels.size === 1) {
      const slice = channels.values().next().value as ChannelSlice;
      pushMessage(slice, {
        id: sysMsgId,
        username: 'System',
        display_name: 'Twitch',
        color: '#9147ff',
        badges: [{ key: 'staff/1', info: {} }],
        content: parsed.message,
        segments: [{ type: 'text', content: parsed.message }],
        is_action: false,
        is_first_message: false,
        is_mentioned: false,
        is_from_shared_chat: false,
        tags: new Map([
          ['user-id', 'tw-system'],
          ['id', sysMsgId],
        ]),
      });
      slice.seenMessageIds.add(sysMsgId);
      slice.error = parsed.message;
      bumpRevision();
      // Auto-clear the surfaced error after 3s
      setTimeout(() => {
        withSlice(slice.channel, (s) => {
          if (s.error === parsed.message) s.error = null;
        });
      }, 3_000);
    }
  }
}

function appendStructuredMessage(slice: ChannelSlice, parsed: any) {
  const messageId = parsed.id;
  if (!messageId) return;
  if (slice.seenMessageIds.has(messageId)) return;

  // Deterministic own-message upgrade: if we already hold a (string) copy with
  // this exact id — our own optimistic message stamped with the real Helix id,
  // now awaiting its full echo — replace it in place so it picks up real
  // badges/tenure. Only own stamped messages pre-exist with a server id, so this
  // never matches a fresh incoming message.
  const idMatchIdx = slice.messages.findIndex(
    (m) => typeof m === 'string' && m.match(/(?:^|;)id=([^;]+)/)?.[1] === messageId,
  );
  if (idMatchIdx !== -1) {
    slice.messages[idMatchIdx] = parsed;
    slice.seenMessageIds.add(messageId);
    scheduleFlush();
    return;
  }

  // Badge cache tracks only the PRIMARY (the IRC-connected account).
  if (parsed.user_id === currentUserId && Array.isArray(parsed.badges)) {
    slice.userBadgesFromIrc = parsed.badges
      .map((b: any) => `${b.name}/${b.version}`)
      .join(',');
  }

  // Replace an optimistic local-* copy of a message WE sent (from the primary OR
  // a linked secondary) when the content matches. This covers the race where a
  // secondary's IRC echo arrives before its Helix id is stamped onto the
  // optimistic; without it, the echo (a non-primary user-id) would be pushed as
  // a duplicate.
  if (isOwnUserId(parsed.user_id)) {
    const optimisticIdx = slice.messages.findIndex((m) => {
      if (typeof m !== 'string' || !m.includes('id=local-')) return false;
      const contentMatch = m.match(/PRIVMSG #\w+ :(.+)$/);
      return contentMatch ? contentMatch[1] === parsed.content : false;
    });
    if (optimisticIdx !== -1) {
      slice.messages[optimisticIdx] = parsed;
      slice.seenMessageIds.add(messageId);
      scheduleFlush();
      return;
    }
  }
  slice.seenMessageIds.add(messageId);
  // Cap the dedup set on the structured (production) path too. The raw-IRC path
  // already caps; without this, seenMessageIds grew unbounded until channel
  // release (~1.5 MB/hr in a busy chat).
  if (slice.seenMessageIds.size > CHAT_MAX_WITH_BUFFER) {
    slice.seenMessageIds = new Set(Array.from(slice.seenMessageIds).slice(-CHAT_MAX_WITH_BUFFER));
  }
  // TikTok likes are high-frequency engagement, not conversation. Keep them OUT of
  // the chat feed (they'd bury real chat) but still feed the activity panel below
  // (the producer reads `parsed` directly, not the slice, so skipping the queue is
  // safe). Follows / gifts stay inline like every other platform's events.
  const activityOnly = parsed.provider === 'tiktok' && parsed.metadata?.msg_type === 'tiktok_like';

  if (!activityOnly) {
    queueMessage(slice.channel, parsed);

    // Active /nuke future-window check. No-op if no nukes are armed for this
    // channel. Fire-and-forget; nuke action errors are logged inside the engine.
    if (slice.channel) {
      void import('../utils/nukeEngine').then((mod) => {
        void mod.checkActiveNukesForMessage(slice.channel, parsed);
      });
    }

    // Keyword reminders. No-op unless a keyword reminder is scoped to this channel.
    if (slice.channel) {
      void import('../utils/reminderEngine').then((mod) => {
        mod.checkRemindersForMessage(slice.channel, parsed);
      });
    }
  }

  // Mirror non-chat channel events (subs, gifts, ... and future follows/raids/
  // hosts) into the MultiChat activity panel. Only synthesized event messages
  // carry a `msg_type`, so normal chat skips this. Every provider (Twitch
  // USERNOTICE included) is parsed to a structured ChatMessage and lands here, so
  // this single path covers them all; the raw-IRC sub producer only fires on the
  // rare parse-failure fallback, so the two never both fire for one message.
  const pk = slice.channel ? parseKey(slice.channel) : null;
  if (pk) {
    const tags = (parsed.tags ?? {}) as Record<string, string>;
    const channelKey = makeKey(pk.provider, pk.channel);
    const eventMsgType = parsed.metadata?.msg_type;
    if (eventMsgType) {
      // Sub detail lives in the USERNOTICE msg-param tags (Twitch). Kick events
      // don't carry these, so they come through undefined and the row just omits
      // them. streak-months is "0" when the subber doesn't share it.
      const num = (v: string | undefined) => {
        const n = parseInt(v ?? '', 10);
        return Number.isFinite(n) ? n : undefined;
      };
      const cumulative = num(tags['msg-param-cumulative-months']);
      const streak = num(tags['msg-param-streak-months']);
      // Community gift bombs: the `submysterygift` carries the batch size, and
      // both it and its individual `subgift` follow-ups share an origin id, so
      // the normalizer can collapse the bunch into one "gifted N subs".
      const giftCount = num(tags['msg-param-mass-gift-count']);
      const originId = tags['msg-param-origin-id'] || tags['msg-param-community-gift-id'] || undefined;
      // YouTube Super Chat detail (stamped by the youtube adapter): amount + currency
      // drive the value pill, the comment shows as the row message.
      const scAmount = (() => {
        const n = parseFloat(tags['sc-amount'] ?? '');
        return Number.isFinite(n) ? n : undefined;
      })();
      // TikTok event detail (stamped by the tiktok adapter): gift name/count feed the
      // gift row, like count feeds the hearts pill.
      const ttGiftName = tags['tt-gift-name'] || undefined;
      const ttGiftCount = num(tags['tt-gift-count']);
      const ttGiftImage = tags['tt-gift-image'] || undefined;
      const ttGiftDiamonds = num(tags['tt-gift-diamonds']);
      const ttLikeCount = num(tags['tt-like-count']);
      // The chatter's avatar rides every TikTok/YouTube event message; show it on
      // the activity row (no per-row fetch).
      const actorAvatar = tags['avatar'] || undefined;
      // The stored message's badges are the RAW backend shape ({name, version},
      // no urls). Resolve them like chat does: Twitch via the badge cache (needs
      // the channel room-id), other providers via their baked image urls.
      let badges: { key: string; info: unknown }[] | undefined;
      if (Array.isArray(parsed.badges) && parsed.badges.length > 0) {
        if (pk.provider === 'twitch') {
          const badgeStr = parsed.badges
            .map((b: { name: string; version: string }) => `${b.name}/${b.version}`)
            .join(',');
          badges = parseBadges(badgeStr, tags['source-room-id'] || tags['room-id']);
        } else {
          badges = parsed.badges
            .filter((b: { image_url_1x?: string }) => b.image_url_1x)
            .map((b: { name: string; version: string; image_url_1x?: string; title?: string }) => ({
              key: `${b.name}/${b.version}`,
              info: { image_url_1x: b.image_url_1x, image_url_2x: b.image_url_1x, title: b.title },
            }));
        }
      }
      window.dispatchEvent(
        new CustomEvent('provider-activity-detected', {
          detail: {
            provider: pk.provider,
            channelKey,
            msgId: eventMsgType,
            username: parsed.username,
            displayName: parsed.display_name || parsed.username,
            userId: parsed.user_id,
            color: parsed.color,
            months: cumulative ?? parsed.metadata?.months,
            streak: streak && streak > 0 ? streak : undefined,
            tier: tags['msg-param-sub-plan'],
            giftCount: giftCount ?? ttGiftCount,
            giftName: ttGiftName,
            giftImage: ttGiftImage,
            giftDiamonds: ttGiftDiamonds,
            likeCount: ttLikeCount,
            avatarUrl: actorAvatar,
            originId,
            badges,
            systemText: parsed.metadata?.system_message,
            amount: scAmount,
            currency: tags['sc-currency'] || undefined,
            message: tags['sc-message'] || undefined,
          },
        }),
      );
    }

    // Channel-point redemptions that posted to chat (Twitch only): a highlighted
    // message or a reward that required text. On channels you only watch these
    // are the ONLY visible redemptions (the rest need broadcaster auth), and
    // Twitch sends just the reward id (no name) so custom rewards stay generic.
    if (pk.provider === 'twitch') {
      const isHighlight = tags['msg-id'] === 'highlighted-message';
      if (isHighlight || tags['custom-reward-id']) {
        window.dispatchEvent(
          new CustomEvent('provider-activity-detected', {
            detail: {
              provider: 'twitch',
              channelKey,
              msgId: 'channelpoints',
              username: parsed.username,
              displayName: parsed.display_name || parsed.username,
              userId: parsed.user_id,
              color: parsed.color,
              systemText: isHighlight ? 'highlighted message' : undefined,
            },
          }),
        );
      }
    }
  }
}

function handleRawIrcString(raw: string) {
  // USERNOTICE → dispatch global subscription event (for the badge/sub tracker)
  if (raw.includes('USERNOTICE')) {
    const loginMatch = raw.match(/(?:^|;)login=([^;]+)/);
    const msgIdMatch = raw.match(/(?:^|;)msg-id=([^;]+)/);
    const displayNameMatch = raw.match(/(?:^|;)display-name=([^;]+)/);
    const login = loginMatch?.[1];
    const msgId = msgIdMatch?.[1];
    const displayName = displayNameMatch?.[1];
    const subTypes = [
      'sub',
      'resub',
      'subgift',
      'submysterygift',
      'giftpaidupgrade',
      'primepaidupgrade',
      'anongiftpaidupgrade',
    ];
    if (login && msgId && subTypes.includes(msgId)) {
      window.dispatchEvent(
        new CustomEvent('twitch-subscription-detected', {
          detail: { login: login.toLowerCase(), msgId, displayName, rawMessage: raw },
        }),
      );
    }
  }

  const channel = extractChannelFromIrc(raw);
  if (!channel) return;
  const slice = useChatConnectionStore.getState().channels.get(channel);
  if (!slice) return;

  const idMatch = raw.match(/(?:^|;)id=([^;]+)/);
  const messageId = idMatch?.[1];
  const userIdMatch = raw.match(/user-id=([^;]+)/);
  const userId = userIdMatch?.[1];

  // Deterministic own-message upgrade (Helix-stamped real id awaiting its echo):
  // replace the stamped optimistic string in place with the full server line.
  if (messageId && !slice.seenMessageIds.has(messageId)) {
    const idMatchIdx = slice.messages.findIndex(
      (m) => typeof m === 'string' && m.match(/(?:^|;)id=([^;]+)/)?.[1] === messageId,
    );
    if (idMatchIdx !== -1) {
      slice.messages[idMatchIdx] = raw;
      slice.seenMessageIds.add(messageId);
      scheduleFlush();
      return;
    }
  }

  if (userId && isOwnUserId(userId)) {
    // Badge cache tracks only the PRIMARY (the IRC-connected account).
    if (userId === currentUserId) {
      const badgesMatch = raw.match(/(?:^|;)badges=([^;]*)/);
      if (badgesMatch && badgesMatch[1]) {
        slice.userBadgesFromIrc = badgesMatch[1];
      }
    }
    const contentMatch = raw.match(/PRIVMSG #\w+ :(.+)$/);
    const serverContent = contentMatch?.[1];
    if (serverContent) {
      const optimisticIdx = slice.messages.findIndex((m) => {
        if (typeof m !== 'string' || !m.includes('id=local-')) return false;
        const localMatch = m.match(/PRIVMSG #\w+ :(.+)$/);
        return localMatch ? localMatch[1] === serverContent : false;
      });
      if (optimisticIdx !== -1) {
        slice.messages[optimisticIdx] = raw;
        if (messageId) slice.seenMessageIds.add(messageId);
        scheduleFlush();
        return;
      }
    }
    // Primary with no matching optimistic: queue once here (prior behavior, e.g.
    // a message the user sent from another device). Secondaries fall through to
    // the generic id-deduped queue below so they still appear exactly once.
    if (userId === currentUserId) {
      if (messageId) slice.seenMessageIds.add(messageId);
      queueMessage(slice.channel, raw);
      return;
    }
  }

  if (messageId) {
    if (slice.seenMessageIds.has(messageId)) return;
    slice.seenMessageIds.add(messageId);
    if (slice.seenMessageIds.size > CHAT_MAX_WITH_BUFFER) {
      slice.seenMessageIds = new Set(Array.from(slice.seenMessageIds).slice(-CHAT_MAX_WITH_BUFFER));
    }
    queueMessage(slice.channel, raw);
  } else {
    queueMessage(slice.channel, raw);
  }
}

// --- Public API -------------------------------------------------------------

/** Acquire a chat connection for `channel`. Idempotent — if the channel is
 *  already acquired, just increments the ref count. */
export async function acquireChannel(
  channel: string,
  channelId: string | null,
  provider: ProviderId = 'twitch',
): Promise<void> {
  // Twitch keeps bare-login keys (byte-identical to before); non-Twitch sources
  // get a "provider:channel" composite key. MultiChat only.
  const key = provider === 'twitch' ? channel.toLowerCase() : makeKey(provider, channel);
  const state = useChatConnectionStore.getState();
  const existing = state.channels.get(key);

  if (existing) {
    existing.refCount += 1;
    if (channelId && !existing.channelId) {
      existing.channelId = channelId;
      // MultiChat opens panes before the channel's broadcaster_id has resolved
      // (the stream-info poll runs after first render). That means the initial
      // acquireChannel call comes through with channelId=null, preloadChannel
      // bails, and the badge metadata cache never gets populated for this
      // channel. When the real channelId arrives a moment later and the caller
      // re-acquires to refresh it, kick off the badge init we deferred so
      // Twitch channel badges (subscriber/bits/etc.) start resolving.
      if (provider === 'twitch') void initializeBadgesForChannel(channelId);
    }
    bumpRevision();
    Logger.debug(`[ChatStore] +1 ref on ${key} (now ${existing.refCount})`);
    return;
  }

  const slice = emptySlice(key, channelId, provider);
  slice.refCount = 1;
  setSlice(key, slice);

  // First channel ever: open the bridge + WS.
  if (state.channels.size === 0) {
    await connectBridgeForFirstChannel(key, channelId, false, provider, channel);
  } else if (provider === 'twitch') {
    // Bridge already up. If a Twitch IRC connection is already running (another
    // Twitch slice exists), JOIN onto it. If not - the bridge was opened by a
    // non-Twitch provider first - START the Twitch IRC on the shared bridge,
    // since join_chat_channel would have nothing to join. The WS is already open
    // so it isn't reopened. (In an all-Twitch session another Twitch slice always
    // exists here, so this stays join_chat_channel: byte-identical to before.)
    const hasOtherTwitch = Array.from(
      useChatConnectionStore.getState().channels.values(),
    ).some((s) => s.channel !== key && s.provider === 'twitch');
    try {
      await invoke(hasOtherTwitch ? 'join_chat_channel' : 'start_chat', { channel: key });
      slice.isConnected = true;
      bumpRevision();
      void preloadChannel(key, channelId);
    } catch (err) {
      Logger.error(`[ChatStore] twitch join/start failed for ${key}:`, err);
      slice.error = String(err);
      bumpRevision();
    }
  } else {
    // Non-Twitch source on the already-open bridge: connect its adapter (no
    // Twitch badge/history preload). The shared local-WS delivers its frames
    // once the adapter publishes, routed by the composite channel key.
    try {
      await invoke('provider_chat_connect', { provider, channel });
      slice.isConnected = true;
      bumpRevision();
    } catch (err) {
      Logger.error(`[ChatStore] provider_chat_connect failed for ${key}:`, err);
      slice.error = String(err);
      bumpRevision();
    }
  }
}

/** Release a chat connection for `channel`. When the last consumer releases,
 *  the channel is PARTed; when the last channel is released, the WebSocket
 *  and Rust IRC service are torn down. */
export async function releaseChannel(
  channel: string,
  provider: ProviderId = 'twitch',
): Promise<void> {
  const key = provider === 'twitch' ? channel.toLowerCase() : makeKey(provider, channel);
  const slice = useChatConnectionStore.getState().channels.get(key);
  if (!slice) return;
  slice.refCount -= 1;
  Logger.debug(`[ChatStore] -1 ref on ${key} (now ${slice.refCount})`);
  if (slice.refCount > 0) {
    bumpRevision();
    return;
  }
  // Last consumer for this channel — drop the slice and PART the channel on
  // the IRC side so messages stop flowing in for it. Critically, we do NOT
  // call `stop_chat` here even when this window's channel set goes empty —
  // the Rust IRC connection is process-wide and other windows (the main app,
  // sibling MultiChat popouts) may still be using it. Tearing down here
  // would kill chat for every other consumer in the process.
  removeSlice(key);
  // Free per-channel state the slice didn't own: the pending flush queue and the
  // resolved emote set (1 to 3 MB of metadata that otherwise stayed pinned for
  // the whole session after the last consumer left). emoteSubscribers is left to
  // its component-driven unsubscribe lifecycle.
  pendingByChannel.delete(key);
  emoteCache.delete(key);
  inflightEmoteFetches.delete(key);
  try {
    if (provider === 'twitch') {
      await invoke('leave_chat_channel', { channel: key });
    } else {
      await invoke('provider_chat_disconnect', { provider, channel });
    }
  } catch (err) {
    Logger.warn(`[ChatStore] leave failed for ${key}:`, err);
  }

  // If this window's local channel list is now empty, tear down only this
  // window's local WebSocket connection — the Rust IRC service keeps running
  // for other consumers. A subsequent acquireChannel from this window will
  // re-open its local socket via start_chat (which is now idempotent and
  // returns the existing port without disrupting other windows).
  const remaining = useChatConnectionStore.getState().channels.size;
  if (remaining === 0) {
    intentionalDisconnect = true;
    clearHealthCheck();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onopen = null;
      try {
        ws.close(1000, 'Last channel released');
      } catch {
        // ignore
      }
      ws = null;
    }
    intentionalDisconnect = false;
    useChatConnectionStore.setState({ wsPort: null });
  }
}

/** Send a message to `channel`. Constructs the optimistic IRC string with
 *  channel-correct room-id and badge metadata. */
export async function sendChannelMessage(
  channel: string,
  text: string,
  userInfo: SendUserInfo,
  replyParentMsgId?: string,
  senderAccount?: SendAsAccount | null,
): Promise<void> {
  if (!text.trim()) return;
  const key = channel.toLowerCase();
  const slice = useChatConnectionStore.getState().channels.get(key);
  if (!slice || !slice.isConnected) return;

  // currentUserId tracks the PRIMARY (the IRC-connected reader), regardless of
  // which account we're sending as.
  currentUserId = userInfo.userId;

  // Who the message is sent AS. Defaults to the primary; a chosen secondary
  // sends with its own identity + token (resolved in the backend by the
  // senderAccountId below). The secondary is registered as "own" so its echo
  // reconciles against the optimistic copy rather than duplicating.
  const sendingAsSecondary = !!senderAccount && senderAccount.userId !== userInfo.userId;
  const senderUserId = senderAccount?.userId ?? userInfo.userId;
  const senderUsername = sendingAsSecondary ? senderAccount!.login : userInfo.username;
  const senderDisplayName = sendingAsSecondary ? senderAccount!.displayName : userInfo.displayName;
  if (sendingAsSecondary) {
    ownAccountIds.add(senderUserId);
  }

  const tempId = `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = Date.now();
  // For the primary, prefer the real USERSTATE color (live, refreshes on /color)
  // over the build-time default so the username doesn't flash a wrong color until
  // the IRC echo lands. A secondary carries its own resolved color.
  const color =
    (sendingAsSecondary
      ? senderAccount!.color
      : userInfo.color || slice.userColorFromIrc) || '#9147FF';
  // USERSTATE-cached badges win because they're tenure-correct for this channel;
  // caller-provided badges are the fallback while USERSTATE hasn't landed. A
  // secondary isn't the IRC-connected user, so it has no cached badges; the real
  // echo repaints them via the id-match path.
  const badges = sendingAsSecondary ? '' : slice.userBadgesFromIrc || userInfo.badges || '';
  const roomIdTag = slice.channelId ?? '';

  let replyTags = '';
  if (replyParentMsgId) {
    const parent = slice.messages.find((m) => {
      if (typeof m === 'string') return m.includes(`id=${replyParentMsgId}`);
      return m && typeof m === 'object' && (m as any).id === replyParentMsgId;
    });
    if (parent) {
      let parentDisplayName = '';
      let parentUsername = '';
      let parentUserId = '';
      let parentMsgBody = '';
      if (typeof parent === 'string') {
        parentDisplayName = parent.match(/display-name=([^;]+)/)?.[1] ?? '';
        parentUsername =
          parent.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG/)?.[1] ?? '';
        parentUserId = parent.match(/user-id=([^;]+)/)?.[1] ?? '';
        parentMsgBody = parent.match(/PRIVMSG #\w+ :(.+)$/)?.[1] ?? '';
      } else {
        const p = parent as any;
        parentDisplayName = p.display_name || '';
        parentUsername = p.username || '';
        parentUserId = p.user_id || '';
        parentMsgBody = p.content || '';
      }
      const escaped = parentMsgBody
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\:')
        .replace(/ /g, '\\s')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
      replyTags = `reply-parent-msg-id=${replyParentMsgId};reply-parent-user-id=${parentUserId};reply-parent-user-login=${parentUsername};reply-parent-display-name=${parentDisplayName};reply-parent-msg-body=${escaped};`;
    } else {
      replyTags = `reply-parent-msg-id=${replyParentMsgId};`;
    }
  }

  const optimistic = `@badge-info=;badges=${badges};color=${color};display-name=${senderDisplayName};emotes=;first-msg=0;flags=;id=${tempId};mod=0;${replyTags}returning-chatter=0;room-id=${roomIdTag};subscriber=0;tmi-sent-ts=${timestamp};turbo=0;user-id=${senderUserId};user-type= :${senderUsername}!${senderUsername}@${senderUsername}.tmi.twitch.tv PRIVMSG #${key} :${text}`;

  slice.seenMessageIds.add(tempId);
  pushMessage(slice, optimistic);
  bumpRevision();

  try {
    const result = await invoke<{
      message_id: string | null;
      is_sent: boolean;
      drop_reason: string | null;
    }>('send_chat_message', {
      message: text,
      replyParentMsgId: replyParentMsgId || null,
      targetChannel: key,
      broadcasterId: slice.channelId || null,
      senderId: senderUserId || null,
      senderAccountId: sendingAsSecondary ? senderUserId : null,
    });

    // Twitch accepted the request but dropped the message (AutoMod, etc.).
    // Pull the optimistic copy and tell the user why.
    if (result && result.is_sent === false) {
      slice.messages = slice.messages.filter((m) => {
        if (typeof m === 'string') return !m.includes(`id=${tempId}`);
        return (m as any)?.id !== tempId;
      });
      slice.seenMessageIds.delete(tempId);
      bumpRevision();
      if (result.drop_reason) {
        injectSystemMessage(key, `Your message was not sent: ${result.drop_reason}`);
      }
      return;
    }

    // Helix returns the authoritative message id. Stamp it onto the optimistic
    // copy so deletes work immediately, with no dependency on catching the IRC
    // echo. We do NOT mark the real id as "seen": when the echo arrives it
    // upgrades this copy in place (real badges/tenure) via the id-match path in
    // appendStructuredMessage / handleRawIrcString.
    if (result && result.message_id) {
      const realId = result.message_id;
      const idx = slice.messages.findIndex(
        (m) => typeof m === 'string' && m.includes(`id=${tempId}`),
      );
      if (idx !== -1) {
        slice.messages[idx] = (slice.messages[idx] as string).replace(`id=${tempId}`, `id=${realId}`);
        slice.seenMessageIds.delete(tempId);
        bumpRevision();
      }
    }
  } catch (err) {
    Logger.error('[ChatStore] send_chat_message failed:', err);
    slice.messages = slice.messages.filter((m) => {
      if (typeof m === 'string') return !m.includes(`id=${tempId}`);
      return (m as any)?.id !== tempId;
    });
    slice.seenMessageIds.delete(tempId);
    bumpRevision();
    throw err;
  }
}

/** Inject a system message into the channel (mirrors the `twitch-system-message`
 *  custom event the old hook listened for). Used by `/mods` and similar local
 *  command results. */
export function injectSystemMessage(channel: string, message: string, songCard?: SongMatch): void {
  const sysMsgId = `sys-cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  withSlice(channel, (slice) => {
    pushMessage(slice, {
      id: sysMsgId,
      username: 'System',
      display_name: 'Twitch',
      color: '#9147ff',
      badges: [{ key: 'staff/1', info: {} }],
      content: message,
      segments: [{ type: 'text', content: message }],
      is_action: false,
      is_first_message: false,
      is_mentioned: false,
      is_from_shared_chat: false,
      songCard,
      tags: new Map([
        ['user-id', 'tw-system'],
        ['id', sysMsgId],
      ]),
    });
    slice.seenMessageIds.add(sysMsgId);
  });
}

/** Inject a no-input channel-points redemption as a chat row. Reuses the native
 *  highlight-message render path (via the `custom-reward-id` tag) so it reads as
 *  a redemption, with the redeemer as the author and the reward name as the body.
 *  No-ops when the channel's chat isn't open. Message-style rewards post their
 *  own PRIVMSG, so callers should only pass the no-input ones. */
export function injectRedemptionMessage(
  channel: string,
  r: {
    userLogin: string;
    userName: string;
    userId?: string;
    rewardId: string;
    rewardTitle: string;
    cost?: number;
    color?: string;
    redemptionId?: string;
  },
): void {
  // A stable id from Twitch's redemption id (when present) makes this idempotent:
  // the same redemption seen by two open chat views collapses to one row.
  const id = r.redemptionId
    ? `redeem-${r.redemptionId}`
    : `redeem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const login = r.userLogin || r.userName;
  const name = r.userName || r.userLogin || login;
  const body =
    r.cost && r.cost > 0 ? `${r.rewardTitle} (${r.cost.toLocaleString()})` : r.rewardTitle;
  withSlice(channel, (slice) => {
    if (slice.seenMessageIds.has(id)) return;
    pushMessage(slice, {
      id,
      username: login,
      display_name: name,
      color: r.color || '#9147ff',
      badges: [],
      content: body,
      segments: [{ type: 'text', content: body }],
      is_action: false,
      is_first_message: false,
      is_mentioned: false,
      is_from_shared_chat: false,
      user_id: r.userId || '',
      tags: new Map([
        ['user-id', r.userId || ''],
        ['id', id],
        ['display-name', name],
        // Triggers the redemption highlight + label in ChatMessage.
        ['custom-reward-id', r.rewardId || 'sn-redemption'],
      ]),
    });
    slice.seenMessageIds.add(id);
  });
}

export function setChannelPaused(channel: string, paused: boolean): void {
  withSlice(channel, (slice) => {
    slice.isPausedForBuffer = paused;
    const historyMax = getActiveHistoryMax();
    if (!paused && slice.messages.length > historyMax) {
      slice.messages = slice.messages.slice(slice.messages.length - historyMax);
    }
  });
}

// --- React hooks ------------------------------------------------------------

/** Snapshot shape consumed by ChatWidget / MultiChat tabs. */
export interface ChannelChatSnapshot {
  messages: any[];
  isConnected: boolean;
  error: string | null;
  roomState: RoomState;
  userBadges: string | null;
  deletedMessageIds: Set<string>;
  clearedUserContexts: Map<string, ClearedUserEntry>;
  /** Monotonic count of live messages received (see ChannelSlice). */
  liveMessageCount: number;
  /** Currently pinned message (provider-driven, e.g. Kick's pin event), or null.
   *  Shaped like ChatWidget's PinnedMessage so it can feed the same banner. */
  pinnedMessage: any | null;
}

const EMPTY_SNAPSHOT: ChannelChatSnapshot = {
  messages: [],
  isConnected: false,
  error: null,
  roomState: { ...EMPTY_ROOM_STATE },
  userBadges: null,
  deletedMessageIds: new Set(),
  clearedUserContexts: new Map(),
  liveMessageCount: 0,
  pinnedMessage: null,
};

/** React hook returning the live message count for a channel. */
export function useChannelMessageCount(channel: string | null | undefined): number {
  useChatConnectionStore((state) => state.revision);
  if (!channel) return 0;
  const slice = useChatConnectionStore.getState().channels.get(channel.toLowerCase());
  return slice ? slice.messages.length : 0;
}

/** True when this message mentions `login` (case-insensitive). Handles both
 *  the parsed-object form (Rust ChatMessage with optional `is_mentioned` set
 *  by the segment parser) and the raw IRC-string fallback (regex-scan the
 *  PRIVMSG body for `@login`). Used by the unread-mention counter, which only
 *  surfaces unread badges for @ mentions of the signed-in user. */
function messageMentionsLogin(msg: unknown, login: string): boolean {
  if (!msg || !login) return false;
  if (typeof msg === 'object') {
    const obj = msg as { is_mentioned?: boolean; content?: string };
    if (obj.is_mentioned) return true;
    if (typeof obj.content === 'string') {
      return obj.content.toLowerCase().includes(`@${login}`);
    }
    return false;
  }
  if (typeof msg === 'string') {
    const idx = msg.indexOf(' PRIVMSG ');
    if (idx === -1) return false;
    const colon = msg.indexOf(' :', idx);
    if (colon === -1) return false;
    return msg.slice(colon + 2).toLowerCase().includes(`@${login}`);
  }
  return false;
}

/** React hook returning the count of messages mentioning the supplied login
 *  in a channel. Used by the MultiChat popout's tab strip to drive @-mention
 *  unread indicators — comparing this count against a per-tab "last seen"
 *  snapshot reveals new mentions that arrived while the tab wasn't visible.
 *  Pass `null` for `login` (e.g. unauthenticated) and the count stays at 0. */
export function useChannelMentionCount(
  channel: string | null | undefined,
  login: string | null | undefined,
): number {
  useChatConnectionStore((state) => state.revision);
  if (!channel || !login) return 0;
  const slice = useChatConnectionStore.getState().channels.get(channel.toLowerCase());
  if (!slice) return 0;
  const target = login.toLowerCase();
  let count = 0;
  for (const msg of slice.messages) {
    if (messageMentionsLogin(msg, target)) count++;
  }
  return count;
}

/** React hook returning the shared per-channel emote set. Multiple components
 *  consuming the same channel share one EmoteSet reference (no duplication
 *  across split panes). Returns null until the fetch lands. */
export function useChannelEmotes(
  channel: string | null | undefined,
  channelId: string | null | undefined,
  provider: ProviderId = 'twitch',
): EmoteSet | null {
  const key = channel ? emoteCacheKey(channel, provider) : null;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!key || !channel) return;
    const unsubscribe = subscribeChannelEmotes(key, () => setVersion((v) => v + 1));
    // Kick fetches by slug (no channelId needed); Twitch needs the numeric id.
    if (provider === 'kick' || channelId) void ensureChannelEmotes(channel, channelId ?? '', provider);
    return unsubscribe;
  }, [key, channel, channelId, provider]);

  // Re-read on each version bump
  void version;
  return key ? emoteCache.get(key) ?? null : null;
}

/** React hook returning the per-channel snapshot. Pass `null` while no channel
 *  is acquired — the hook returns an empty snapshot in that case so callers
 *  don't need to null-guard the entire return object. */
export function useChannelChat(channel: string | null | undefined): ChannelChatSnapshot {
  const key = channel ? channel.toLowerCase() : null;
  // Subscribe to revision to drive updates; read the slice imperatively to
  // avoid Map.get returning new references on every render.
  useChatConnectionStore((state) => state.revision);
  if (!key) return EMPTY_SNAPSHOT;
  const slice = useChatConnectionStore.getState().channels.get(key);
  if (!slice) return EMPTY_SNAPSHOT;
  return {
    messages: slice.messages,
    isConnected: slice.isConnected,
    error: slice.error,
    roomState: slice.roomState,
    userBadges: slice.userBadges,
    deletedMessageIds: slice.deletedMessageIds,
    clearedUserContexts: slice.clearedUserContexts,
    liveMessageCount: slice.liveMessageCount,
    pinnedMessage: slice.pinnedMessage,
  };
}

// Listen for visibility regain to nudge a reconnect if the WS died while hidden
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!ws || ws.readyState === WebSocket.OPEN) return;
    if (useChatConnectionStore.getState().channels.size === 0) return;
    Logger.debug('[ChatStore] Visibility regained, scheduling reconnect');
    scheduleReconnect(0);
  });
}

// Listen for locally emitted system messages (matches the prior hook contract)
if (typeof window !== 'undefined') {
  window.addEventListener('twitch-system-message', ((e: CustomEvent) => {
    const message = e.detail?.message;
    if (!message) return;
    const songCard = e.detail?.songCard as SongMatch | undefined;
    const channels = useChatConnectionStore.getState().channels;
    if (channels.size === 0) return;
    // System messages from `/mods` etc. apply to the channel that issued the
    // command; today only one channel is acquired by the main app, so we
    // route to the single acquired channel. Multi-channel callers should use
    // `injectSystemMessage(channel, message)` directly.
    if (channels.size === 1) {
      const ch = channels.keys().next().value as string;
      injectSystemMessage(ch, message, songCard);
    }
  }) as EventListener);
}
