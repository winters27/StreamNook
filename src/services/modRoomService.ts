// Mod-room WebSocket client. Trades the scoped Twitch token (held in Rust) for a
// short-lived room token via the `modroom_get_room_token` command, opens the room
// socket, and keeps it alive: it re-mints + reconnects before the token expires
// (the token TTL is the server's revocation window) and on a server-side expiry
// close (code 4001). A denial on (re)mint surfaces through `onDenied` so the UI
// can prompt a reconnect or an upsell instead of silently dropping.

import { invoke } from '@tauri-apps/api/core';

const WS_BASE = 'wss://modroom.streamnook.app/room';
const HTTP_BASE = 'https://modroom.streamnook.app';

// Re-mint this many ms before the token expires so the handoff never gaps.
const REFRESH_LEAD_MS = 60_000;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

export type ModRoomRole = 'broadcaster' | 'moderator';

export interface ModRoomChat {
  id: string;
  ts: number;
  userId: string;
  login: string;
  role: ModRoomRole;
  body: string;
  /** Image attachment URL (served by the worker /file route), if any. */
  attachment?: string;
  /** Unix ms when last edited, if it has been. */
  editedAt?: number;
}

export interface ModRoomMember {
  userId: string;
  login: string;
  role: ModRoomRole;
}

/** Why a (re)connect was refused. `needs_connect` means the scoped consent is
 *  missing or unrefreshable; the others map to the gate's verdicts. */
export type ModRoomDenial = 'needs_connect' | 'not_moderator' | 'not_entitled' | 'error';

export interface ModRoomHandlers {
  onState?: (state: ModRoomState) => void;
  /** The per-channel room key (base64), delivered with each (re)mint. */
  onKey?: (roomKeyB64: string) => void;
  /** The caller's own Twitch user id (for "edit own message"). */
  onIdentity?: (userId: string) => void;
  /** A message was edited (id, new ciphertext body, edited timestamp). */
  onEdit?: (id: string, body: string, editedAt: number) => void;
  onHistory?: (messages: ModRoomChat[]) => void;
  onChat?: (message: ModRoomChat) => void;
  onTyping?: (member: { userId: string; login: string }) => void;
  onPresence?: (members: ModRoomMember[]) => void;
  onDenied?: (reason: ModRoomDenial) => void;
}

export type ModRoomState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface RoomTokenResp {
  token: string;
  role: ModRoomRole;
  channel_id: string;
  expires_at: number;
  ttl: number;
  room_key: string;
  user_id: string;
}

export interface ModRoomController {
  send: (body: string, attachment?: string) => void;
  /** Replace an existing message's ciphertext body (only the author's own). */
  edit: (id: string, body: string) => void;
  sendTyping: () => void;
  /** Upload attachment bytes (encrypted or an image) and resolve to its URL. */
  upload: (body: BodyInit, contentType: string) => Promise<string>;
  close: () => void;
}

export function connectModRoom(channelId: string, handlers: ModRoomHandlers): ModRoomController {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoffIndex = 0;
  // Latest room token, kept so uploads can authenticate without the WS.
  let currentToken = '';
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (s: ModRoomState) => handlers.onState?.(s);

  const clearTimers = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
    backoffIndex += 1;
    setState('reconnecting');
    reconnectTimer = setTimeout(open, delay);
  };

  const open = async () => {
    if (closed) return;
    clearTimers();
    setState(ws ? 'reconnecting' : 'connecting');

    let resp: RoomTokenResp;
    try {
      resp = await invoke<RoomTokenResp>('modroom_get_room_token', { channelId });
    } catch (e) {
      const reason = String(e) as ModRoomDenial;
      const known: ModRoomDenial[] = ['needs_connect', 'not_moderator', 'not_entitled'];
      handlers.onDenied?.(known.includes(reason) ? reason : 'error');
      // A denial is terminal until the user acts (reconnect / upsell / consent).
      setState('closed');
      return;
    }
    if (closed) return;

    currentToken = resp.token;
    if (resp.room_key) handlers.onKey?.(resp.room_key);
    if (resp.user_id) handlers.onIdentity?.(resp.user_id);
    const socket = new WebSocket(`${WS_BASE}?channel=${encodeURIComponent(channelId)}&token=${encodeURIComponent(resp.token)}`);
    ws = socket;

    socket.onopen = () => {
      if (closed) {
        socket.close();
        return;
      }
      backoffIndex = 0;
      setState('connected');
      // Re-mint ahead of expiry; the new socket replaces this one seamlessly.
      const lead = Math.max(5_000, resp.ttl * 1000 - REFRESH_LEAD_MS);
      refreshTimer = setTimeout(open, lead);
    };

    socket.onmessage = (ev) => {
      let data: { t?: string; messages?: ModRoomChat[]; members?: ModRoomMember[] } & Partial<ModRoomChat> & {
        userId?: string;
        login?: string;
      };
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (data.t) {
        case 'history':
          handlers.onHistory?.(data.messages ?? []);
          break;
        case 'chat':
          if (data.id) handlers.onChat?.(data as ModRoomChat);
          break;
        case 'edit':
          if (data.id && data.body) handlers.onEdit?.(data.id, data.body, data.editedAt ?? 0);
          break;
        case 'typing':
          if (data.userId) handlers.onTyping?.({ userId: data.userId, login: data.login ?? '' });
          break;
        case 'presence':
          handlers.onPresence?.(data.members ?? []);
          break;
      }
    };

    socket.onclose = (ev) => {
      if (ws === socket) ws = null;
      if (closed) return;
      // 4001 = server closed because the room token expired. Re-mint immediately
      // (this is also where a now-demoted user gets denied instead of let back in).
      if (ev.code === 4001) {
        void open();
      } else {
        scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // The close handler drives recovery; nothing extra needed here.
    };
  };

  void open();

  return {
    send: (body: string, attachment?: string) => {
      const text = body.trim();
      if ((text || attachment) && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'chat', body: text, attachment }));
      }
    },
    edit: (id: string, body: string) => {
      if (id && body && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'edit', id, body }));
      }
    },
    upload: async (body: BodyInit, contentType: string): Promise<string> => {
      if (!currentToken) throw new Error('needs_connect');
      const res = await fetch(
        `${HTTP_BASE}/upload?channel=${encodeURIComponent(channelId)}&token=${encodeURIComponent(currentToken)}`,
        { method: 'POST', headers: { 'Content-Type': contentType }, body },
      );
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || 'upload_failed');
      }
      const data = (await res.json()) as { url: string };
      return data.url;
    },
    sendTyping: () => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'typing' }));
    },
    close: () => {
      closed = true;
      clearTimers();
      if (ws) {
        ws.close();
        ws = null;
      }
      setState('closed');
    },
  };
}

// Per-channel "this account moderates here" cache, so the mod-room toggle can
// appear instantly on revisit instead of waiting for the slow USERSTATE badge.
// Safe to be optimistic: the gate still verifies mod status server-side.
const MOD_CACHE_KEY = 'modroom_moderated_v1';
function loadModSet(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(MOD_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}
export function isCachedModerator(channelId?: string | null): boolean {
  return !!channelId && loadModSet()[channelId] === true;
}
export function setCachedModerator(channelId: string | null | undefined, isMod: boolean): void {
  if (!channelId) return;
  const set = loadModSet();
  if (isMod === (set[channelId] === true)) return; // no change
  if (isMod) set[channelId] = true;
  else delete set[channelId];
  try {
    localStorage.setItem(MOD_CACHE_KEY, JSON.stringify(set));
  } catch {
    // storage unavailable; the toggle just falls back to USERSTATE timing
  }
}

// Listeners notified whenever the moderated-channel list is (re)resolved, so the
// surfaces that cache it (the MultiChat Chat/Mods toggle + picker, the main chat
// toggle) refresh the instant consent lands instead of waiting for a restart.
type ModeratedListener = (ids: string[]) => void;
const moderatedListeners = new Set<ModeratedListener>();
export function subscribeModeratedChannels(fn: ModeratedListener): () => void {
  moderatedListeners.add(fn);
  return () => {
    moderatedListeners.delete(fn);
  };
}

// The account's moderated channel ids (Helix, via the scoped token). Cached per
// session; also seeds the per-channel cache so toggles resolve instantly. Returns
// [] when not connected (caller falls back to per-channel detection).
let moderatedPromise: Promise<string[]> | null = null;
export function loadModeratedChannelIds(force = false): Promise<string[]> {
  if (!moderatedPromise || force) {
    moderatedPromise = invoke<string[]>('modroom_list_moderated')
      .then((ids) => {
        ids.forEach((id) => setCachedModerator(id, true));
        moderatedListeners.forEach((fn) => fn(ids));
        return ids;
      })
      .catch(() => []);
  }
  return moderatedPromise;
}

/** Run the one-time scoped consent. Resolves to the connected login on success.
 *  On success the moderated list is force-refreshed: the pre-consent fetch came
 *  back empty and was memoized, so without this the toggle/picker would stay
 *  hidden until the app restarts. Subscribers repopulate as soon as it resolves. */
export async function connectModRoomConsent(): Promise<string | null> {
  const res = await invoke<{ connected: boolean; login: string | null }>('modroom_connect');
  if (res.connected) {
    void loadModeratedChannelIds(true);
  }
  return res.connected ? res.login : null;
}
