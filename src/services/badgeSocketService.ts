// Badge-drop feed client. Holds a WebSocket to the Cloudflare relay
// (modroom.streamnook.app/badges) so new Twitch badge drops arrive instantly,
// mid-session. While the socket is down it falls back to polling the
// edge-cached latest.json, and on startup it does one catch-up read so drops
// that landed while the app was closed still surface. Each drop is deduped by
// id (localStorage) and handed to the Rust push_badge_notification command,
// which emits the same `badge-notification` event the UI already renders.

import { invoke } from '@tauri-apps/api/core';
import { Logger } from '../utils/logger';

const WS_URL = 'wss://modroom.streamnook.app/badges';
const LATEST_URL = 'https://modroom.streamnook.app/badges/latest.json';
const POLL_INTERVAL_MS = 120_000;
const RECONNECT_BACKOFF_MS = [2_000, 5_000, 10_000, 30_000];
const SEEN_KEY = 'badge_feed_seen_v1';
const SEEN_CAP = 200;

interface BadgePayload {
  badge_name: string;
  badge_set_id: string;
  badge_version: string;
  badge_image_url: string;
  badge_description?: string;
  status: 'new' | 'available' | 'coming_soon';
  date_info?: string;
}

interface Drop {
  id: string;
  ts: number;
  badge: BadgePayload;
}

let started = false;
let closed = false;
let ws: WebSocket | null = null;
let backoffIndex = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let seen: Set<string> = new Set();

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(): void {
  try {
    // Keep the most recent ids only, so the set can't grow without bound.
    const ids = [...seen].slice(-SEEN_CAP);
    seen = new Set(ids);
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // storage full or unavailable; dedupe just falls back to in-memory
  }
}

async function surface(drop: Drop): Promise<void> {
  if (!drop || !drop.id || !drop.badge) return;
  if (seen.has(drop.id)) return;
  seen.add(drop.id);
  saveSeen();
  try {
    await invoke('push_badge_notification', { badge: drop.badge });
  } catch (e) {
    Logger.error('[BadgeSocket] push_badge_notification failed:', e);
  }
}

function handleMessage(ev: MessageEvent): void {
  let data: { t?: string; drops?: Drop[]; id?: string; ts?: number; badge?: BadgePayload };
  try {
    data = JSON.parse(ev.data as string);
  } catch {
    return;
  }
  if (data.t === 'history') {
    for (const d of data.drops ?? []) void surface(d);
  } else if (data.t === 'drop' && data.id && data.badge) {
    void surface({ id: data.id, ts: data.ts ?? Date.now(), badge: data.badge });
  }
}

async function pollOnce(): Promise<void> {
  try {
    const res = await fetch(LATEST_URL);
    if (!res.ok) return;
    const drops = (await res.json()) as Drop[];
    for (const d of drops) void surface(d);
  } catch {
    // offline or relay down; the next tick retries
  }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function scheduleReconnect(): void {
  if (closed || reconnectTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(backoffIndex, RECONNECT_BACKOFF_MS.length - 1)];
  backoffIndex += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  if (closed) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    if (closed) {
      socket.close();
      return;
    }
    backoffIndex = 0;
    // Live socket is authoritative; pause the poll fallback while connected.
    stopPolling();
  };
  socket.onmessage = handleMessage;
  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (closed) return;
    // Poll while we are without a socket, then keep trying to reconnect.
    startPolling();
    scheduleReconnect();
  };
  socket.onerror = () => {
    // onclose drives recovery; nothing extra needed here.
  };
}

/** Start the badge feed. Idempotent; safe to call once on app startup. */
export function startBadgeFeed(): void {
  if (started) return;
  started = true;
  closed = false;
  seen = loadSeen();
  // One immediate read catches drops that landed while the app was closed.
  void pollOnce();
  connect();
}

/** Tear down the feed (e.g. on app shutdown). */
export function stopBadgeFeed(): void {
  closed = true;
  started = false;
  stopPolling();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
