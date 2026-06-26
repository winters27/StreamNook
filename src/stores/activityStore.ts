import { create } from 'zustand';
import type { ActivityEvent } from '../types/activity';

// Standalone store for the MultiChat Activity feed. Kept separate from the main
// AppStore so nothing here can affect normal chat. Persisted to localStorage so a
// streamer's past activity is still there on reopen, capped PER SOURCE so one
// busy channel can't evict another's history. Purgeable per source or all.

const STORAGE_KEY = 'sn-activity-history-v1';
const PER_CHANNEL_CAP = 200; // newest events kept per source key
const TOTAL_CAP = 2500; // overall safety ceiling across all sources

// Keep the newest PER_CHANNEL_CAP per source (events are newest-first), bounded
// overall. Drops the oldest of a source once it exceeds its cap.
function capEvents(events: ActivityEvent[]): ActivityEvent[] {
  const counts = new Map<string, number>();
  const out: ActivityEvent[] = [];
  for (const e of events) {
    if (out.length >= TOTAL_CAP) break;
    const k = e.channel.toLowerCase();
    const n = counts.get(k) ?? 0;
    if (n >= PER_CHANNEL_CAP) continue;
    counts.set(k, n + 1);
    out.push(e);
  }
  return out;
}

function loadPersisted(): ActivityEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? capEvents(parsed) : [];
  } catch {
    return [];
  }
}

function write(events: ActivityEvent[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    /* quota exceeded or storage unavailable; the in-memory feed still works */
  }
}

interface ActivityState {
  events: ActivityEvent[];
  addEvent: (event: ActivityEvent) => void;
  /** Purge the stored history for the given composite source keys (in-memory + disk). */
  purgeChannels: (sourceKeys: string[]) => void;
  /** Purge ALL stored activity. */
  clear: () => void;
  /** Drop the in-memory events to free RAM when the panel closes, WITHOUT touching
   *  the persisted copy. `hydrate()` restores them on reopen. */
  release: () => void;
  /** Reload events from the persisted store (on panel open, after a release). */
  hydrate: () => void;
}

export const useActivityStore = create<ActivityState>((set) => ({
  // Hydrate the whole persisted history; the widget filters it to the open sources.
  events: loadPersisted(),
  addEvent: (event) =>
    set((state) => {
      // Dedup by id (sources can echo the same event); prepend newest-first, cap.
      if (event.id && state.events.some((e) => e.id === event.id)) return state;
      const events = capEvents([event, ...state.events]);
      // Merge with what's on disk before writing, so a second MultiChat window's
      // history never clobbers this one's (each window has its own store).
      const seen = new Set(events.map((e) => e.id));
      write(capEvents([...events, ...loadPersisted().filter((e) => !seen.has(e.id))]));
      return { events };
    }),
  purgeChannels: (sourceKeys) =>
    set((state) => {
      const drop = new Set(sourceKeys.map((k) => k.toLowerCase()));
      const keep = (e: ActivityEvent) => !drop.has(e.channel.toLowerCase());
      // Filter on-disk too (keeping other sources) so the purged ones don't
      // return on the next reopen.
      write(loadPersisted().filter(keep));
      return { events: state.events.filter(keep) };
    }),
  clear: () =>
    set(() => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return { events: [] };
    }),
  release: () => set({ events: [] }),
  hydrate: () => set({ events: loadPersisted() }),
}));
