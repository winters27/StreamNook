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
import { invoke } from '@tauri-apps/api/core';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';
import { fetchAllEmotes, type EmoteSet } from '../services/emoteService';
import { Logger } from '../utils/logger';
import { useAppStore } from './AppStore';

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

interface ChannelSlice {
  channel: string;
  channelId: string | null;
  messages: any[];
  isConnected: boolean;
  error: string | null;
  roomState: RoomState;
  userBadges: string | null;
  deletedMessageIds: Set<string>;
  clearedUserContexts: Map<string, ClearedUserEntry>;
  refCount: number;
  isPausedForBuffer: boolean;
  // Internals (not surfaced via the per-channel hook):
  seenMessageIds: Set<string>;
  /** IRC USERSTATE badges string, used to repaint optimistic messages with the
   *  caller's tenure-correct badges for the channel. */
  userBadgesFromIrc: string | null;
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

const useChatConnectionStore = create<ChatConnectionState>(() => ({
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
export async function ensureChannelEmotes(
  channel: string,
  channelId: string,
): Promise<EmoteSet | null> {
  const key = channel.toLowerCase();
  const cached = emoteCache.get(key);
  if (cached) return cached;
  const inflight = inflightEmoteFetches.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const set = await fetchAllEmotes(key, channelId);
      if (set) {
        emoteCache.set(key, set);
        notifyEmoteSubscribers(key);
      }
      return set;
    } catch (err) {
      Logger.warn(`[ChatStore] fetchAllEmotes failed for ${key}:`, err);
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

function getSlice(channel: string): ChannelSlice | undefined {
  return useChatConnectionStore.getState().channels.get(channel.toLowerCase());
}

function withSlice(channel: string, mutator: (slice: ChannelSlice) => void): void {
  const slice = getSlice(channel);
  if (!slice) return;
  mutator(slice);
  bumpRevision();
}

function emptySlice(channel: string, channelId: string | null): ChannelSlice {
  return {
    channel: channel.toLowerCase(),
    channelId,
    messages: [],
    isConnected: false,
    error: null,
    roomState: { ...EMPTY_ROOM_STATE },
    userBadges: null,
    deletedMessageIds: new Set(),
    clearedUserContexts: new Map(),
    refCount: 0,
    isPausedForBuffer: false,
    seenMessageIds: new Set(),
    userBadgesFromIrc: null,
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

function pushMessage(slice: ChannelSlice, msg: any) {
  const limit = slice.isPausedForBuffer ? CHAT_MAX_WITH_BUFFER : CHAT_HISTORY_MAX;
  slice.messages.push(msg);
  if (slice.messages.length > limit) {
    slice.messages = slice.messages.slice(slice.messages.length - limit);
  }
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

  // Cold-start with the first channel; JOIN the rest. The Rust `start_chat`
  // calls `stop()` at the top so this also resets the server-side state cleanly.
  const first = channels[0];
  const firstSlice = state.channels.get(first);
  if (!firstSlice) return;

  try {
    await connectBridgeForFirstChannel(first, firstSlice.channelId);
    for (const ch of channels.slice(1)) {
      try {
        await invoke('join_chat_channel', { channel: ch });
      } catch (err) {
        Logger.error(`[ChatStore] Failed to JOIN ${ch} during reconnect:`, err);
      }
    }
  } catch (err) {
    Logger.error('[ChatStore] Reconnect failed:', err);
    setAllChannelsError('Reconnection failed');
  }
}

async function connectBridgeForFirstChannel(
  channel: string,
  channelId: string | null,
): Promise<void> {
  if (wsConnecting) {
    Logger.debug('[ChatStore] WS already connecting, skipping duplicate request');
    return;
  }
  wsConnecting = true;
  try {
    Logger.debug(`[ChatStore] Invoking start_chat for ${channel}`);
    const port = await invoke<number>('start_chat', { channel });
    useChatConnectionStore.setState({ wsPort: port });

    const socket = await openWebSocketWithRetry(port);
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

    // After first-channel connect, pre-load recent messages for that channel.
    void preloadChannel(channel, channelId);
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
  await initializeBadgesForChannel(channelId);

  try {
    const raw = await fetchRecentMessagesAsIRC(channel, channelId);
    if (raw.length === 0) return;
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
      const filtered: any[] = [];
      for (const msg of source) {
        const id =
          typeof msg === 'string' ? msg.match(/(?:^|;)id=([^;]+)/)?.[1] : msg?.id;
        if (id) {
          if (slice.seenMessageIds.has(id)) continue;
          slice.seenMessageIds.add(id);
        }
        filtered.push(msg);
      }

      // Prepend so recent history appears before live messages
      slice.messages = [...filtered, ...slice.messages];
      const limit = slice.isPausedForBuffer ? CHAT_MAX_WITH_BUFFER : CHAT_HISTORY_MAX;
      if (slice.messages.length > limit) {
        slice.messages = slice.messages.slice(slice.messages.length - limit);
      }
    });
  } catch (err) {
    Logger.error('[ChatStore] Failed to fetch recent messages:', err);
  }
}

// --- Incoming message routing ----------------------------------------------

function handleWsMessage(raw: string) {
  lastMessageTime = Date.now();

  // Global signals first
  if (raw === 'HEARTBEAT') {
    setAllChannelsError(null);
    return;
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
        bumpRevision();
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
        const apply = (slice: ChannelSlice) => {
          slice.deletedMessageIds.add(parsed.target_msg_id);
        };
        if (ch) withSlice(ch, apply);
        else for (const s of useChatConnectionStore.getState().channels.values()) apply(s);
        bumpRevision();
        return;
      }
      if (parsed.type === 'CLEARCHAT') {
        const ch = (parsed.channel as string | undefined)?.toLowerCase();
        const apply = (slice: ChannelSlice) => {
          if (!parsed.target_user_id) return; // full chat clear — UI doesn't track this today
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
        bumpRevision();
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
    timeout_success: 'timeout',
    ban_success: 'ban',
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

  // Replace optimistic local-* message from this user if content matches
  if (parsed.user_id === currentUserId) {
    if (Array.isArray(parsed.badges)) {
      slice.userBadgesFromIrc = parsed.badges
        .map((b: any) => `${b.name}/${b.version}`)
        .join(',');
    }
    const optimisticIdx = slice.messages.findIndex((m) => {
      if (typeof m !== 'string' || !m.includes('id=local-')) return false;
      const contentMatch = m.match(/PRIVMSG #\w+ :(.+)$/);
      return contentMatch ? contentMatch[1] === parsed.content : false;
    });
    if (optimisticIdx !== -1) {
      slice.messages[optimisticIdx] = parsed;
      slice.seenMessageIds.add(messageId);
      return;
    }
  }
  slice.seenMessageIds.add(messageId);
  pushMessage(slice, parsed);
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

  if (userId && currentUserId && userId === currentUserId) {
    const badgesMatch = raw.match(/(?:^|;)badges=([^;]*)/);
    if (badgesMatch && badgesMatch[1]) {
      slice.userBadgesFromIrc = badgesMatch[1];
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
        bumpRevision();
        return;
      }
    }
    if (messageId) slice.seenMessageIds.add(messageId);
    pushMessage(slice, raw);
    bumpRevision();
    return;
  }

  if (messageId) {
    if (slice.seenMessageIds.has(messageId)) return;
    slice.seenMessageIds.add(messageId);
    if (slice.seenMessageIds.size > CHAT_MAX_WITH_BUFFER) {
      slice.seenMessageIds = new Set(Array.from(slice.seenMessageIds).slice(-CHAT_MAX_WITH_BUFFER));
    }
    pushMessage(slice, raw);
    bumpRevision();
  } else {
    pushMessage(slice, raw);
    bumpRevision();
  }
}

// --- Public API -------------------------------------------------------------

/** Acquire a chat connection for `channel`. Idempotent — if the channel is
 *  already acquired, just increments the ref count. */
export async function acquireChannel(channel: string, channelId: string | null): Promise<void> {
  const key = channel.toLowerCase();
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
      void initializeBadgesForChannel(channelId);
    }
    bumpRevision();
    Logger.debug(`[ChatStore] +1 ref on ${key} (now ${existing.refCount})`);
    return;
  }

  const slice = emptySlice(key, channelId);
  slice.refCount = 1;
  setSlice(key, slice);

  // First channel ever: open the bridge + WS.
  if (state.channels.size === 0) {
    await connectBridgeForFirstChannel(key, channelId);
  } else {
    // Bridge already running: JOIN the new channel and preload it.
    try {
      await invoke('join_chat_channel', { channel: key });
      slice.isConnected = true;
      bumpRevision();
      void preloadChannel(key, channelId);
    } catch (err) {
      Logger.error(`[ChatStore] join_chat_channel failed for ${key}:`, err);
      slice.error = String(err);
      bumpRevision();
    }
  }
}

/** Release a chat connection for `channel`. When the last consumer releases,
 *  the channel is PARTed; when the last channel is released, the WebSocket
 *  and Rust IRC service are torn down. */
export async function releaseChannel(channel: string): Promise<void> {
  const key = channel.toLowerCase();
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
  try {
    await invoke('leave_chat_channel', { channel: key });
  } catch (err) {
    Logger.warn(`[ChatStore] leave_chat_channel failed for ${key}:`, err);
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
): Promise<void> {
  if (!text.trim()) return;
  const key = channel.toLowerCase();
  const slice = useChatConnectionStore.getState().channels.get(key);
  if (!slice || !slice.isConnected) return;

  currentUserId = userInfo.userId;

  const tempId = `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = Date.now();
  const color = userInfo.color || '#8A2BE2';
  // USERSTATE-cached badges win because they're tenure-correct for this channel;
  // caller-provided badges are the fallback while USERSTATE hasn't landed.
  const badges = slice.userBadgesFromIrc || userInfo.badges || '';
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

  const optimistic = `@badge-info=;badges=${badges};color=${color};display-name=${userInfo.displayName};emotes=;first-msg=0;flags=;id=${tempId};mod=0;${replyTags}returning-chatter=0;room-id=${roomIdTag};subscriber=0;tmi-sent-ts=${timestamp};turbo=0;user-id=${userInfo.userId};user-type= :${userInfo.username}!${userInfo.username}@${userInfo.username}.tmi.twitch.tv PRIVMSG #${key} :${text}`;

  slice.seenMessageIds.add(tempId);
  pushMessage(slice, optimistic);
  bumpRevision();

  try {
    await invoke('send_chat_message', {
      message: text,
      replyParentMsgId: replyParentMsgId || null,
      targetChannel: key,
    });
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
export function injectSystemMessage(channel: string, message: string): void {
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
      tags: new Map([
        ['user-id', 'tw-system'],
        ['id', sysMsgId],
      ]),
    });
    slice.seenMessageIds.add(sysMsgId);
  });
}

export function setChannelPaused(channel: string, paused: boolean): void {
  withSlice(channel, (slice) => {
    slice.isPausedForBuffer = paused;
    if (!paused && slice.messages.length > CHAT_HISTORY_MAX) {
      slice.messages = slice.messages.slice(slice.messages.length - CHAT_HISTORY_MAX);
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
}

const EMPTY_SNAPSHOT: ChannelChatSnapshot = {
  messages: [],
  isConnected: false,
  error: null,
  roomState: { ...EMPTY_ROOM_STATE },
  userBadges: null,
  deletedMessageIds: new Set(),
  clearedUserContexts: new Map(),
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
 *  PRIVMSG body for `@login`). Used by the unread-mention counter — Brandon's
 *  call to only surface unread badges for @ mentions of the signed-in user. */
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
): EmoteSet | null {
  const key = channel ? channel.toLowerCase() : null;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!key) return;
    const unsubscribe = subscribeChannelEmotes(key, () => setVersion((v) => v + 1));
    if (channelId) void ensureChannelEmotes(key, channelId);
    return unsubscribe;
  }, [key, channelId]);

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
    const channels = useChatConnectionStore.getState().channels;
    if (channels.size === 0) return;
    // System messages from `/mods` etc. apply to the channel that issued the
    // command; today only one channel is acquired by the main app, so we
    // route to the single acquired channel. Multi-channel callers should use
    // `injectSystemMessage(channel, message)` directly.
    if (channels.size === 1) {
      const ch = channels.keys().next().value as string;
      injectSystemMessage(ch, message);
    }
  }) as EventListener);
}
