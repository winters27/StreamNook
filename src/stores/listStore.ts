// listStore: user-curated reference lists for the Lists panel.
//
// A list is a named collection of short text entries the user wants at hand
// while watching or moderating: known ban evaders, reusable chat commands,
// stream titles, giveaway winners: anything line-shaped. Entries carry an
// optional note (e.g. which main account an evader belongs to) that renders
// alongside the text but is never included when the entry is copied, so the
// copied value stays paste-clean for /ban and friends.
//
// Persistence + cross-window sync mirror snippetStore exactly: everything
// lives in localStorage, every mutation persists synchronously, and a Tauri
// event tells other windows to re-read. The originating window stamps a
// sender id so it can ignore its own broadcast.

import { create } from 'zustand';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Logger } from '../utils/logger';

const STORAGE_LISTS = 'streamnook.lists.v1';
const STORAGE_ACTIVE = 'streamnook.lists.active.v1';

const LISTS_UPDATED_EVENT = 'streamnook-lists-updated';

// Per-window-load random id, same pattern as snippetStore / settingsBroadcast.
const SENDER_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface ListEntry {
  id: string;
  /** The copyable value: a username, a command, a title. Single line. */
  text: string;
  /** Optional annotation rendered muted next to the text; never copied. */
  note?: string;
  addedAt: number;
}

export interface UserList {
  id: string;
  name: string;
  entries: ListEntry[];
  createdAt: number;
  updatedAt: number;
}

interface ListStoreState {
  lists: UserList[];
  /** Which list the panel shows; persisted so reopening lands where you were. */
  activeListId: string | null;

  createList: (name: string) => string;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  setActiveList: (id: string) => void;

  /** Add one entry per item: single adds and bulk paste share one path.
   *  Items can carry a note (spreadsheet-style "name⇥note" paste rows). */
  addEntries: (listId: string, items: Array<string | { text: string; note?: string }>) => void;
  updateEntry: (listId: string, entryId: string, patch: { text?: string; note?: string }) => void;
  removeEntry: (listId: string, entryId: string) => void;
}

// ---------- localStorage helpers --------------------------------------------

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (err) {
    Logger.warn(`[listStore] read ${key} failed:`, err);
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    Logger.warn(`[listStore] write ${key} failed:`, err);
  }
}

function isEntry(e: unknown): e is ListEntry {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as ListEntry).id === 'string' &&
    typeof (e as ListEntry).text === 'string'
  );
}

function loadLists(): UserList[] {
  const raw = readJSON<unknown>(STORAGE_LISTS, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (l): l is UserList =>
        !!l &&
        typeof l === 'object' &&
        typeof (l as UserList).id === 'string' &&
        typeof (l as UserList).name === 'string' &&
        Array.isArray((l as UserList).entries),
    )
    .map((l) => ({ ...l, entries: l.entries.filter(isEntry) }));
}

function loadActiveListId(lists: UserList[]): string | null {
  const raw = readJSON<unknown>(STORAGE_ACTIVE, null);
  if (typeof raw === 'string' && lists.some((l) => l.id === raw)) return raw;
  return lists[0]?.id ?? null;
}

function persist(lists: UserList[], activeListId: string | null): void {
  writeJSON(STORAGE_LISTS, lists);
  writeJSON(STORAGE_ACTIVE, activeListId);
  void broadcastUpdate();
}

async function broadcastUpdate(): Promise<void> {
  try {
    await emit(LISTS_UPDATED_EVENT, { source: SENDER_ID });
  } catch (err) {
    Logger.warn('[listStore] broadcast failed (non-fatal):', err);
  }
}

function makeId(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- Zustand store ---------------------------------------------------

const initialLists = loadLists();

export const useListStore = create<ListStoreState>((set, get) => ({
  lists: initialLists,
  activeListId: loadActiveListId(initialLists),

  createList: (name) => {
    const now = Date.now();
    const list: UserList = {
      id: makeId('list'),
      name: name.trim() || 'Untitled list',
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const lists = [...state.lists, list];
      persist(lists, list.id);
      return { lists, activeListId: list.id };
    });
    return list.id;
  },

  renameList: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const lists = state.lists.map((l) =>
        l.id === id ? { ...l, name: trimmed, updatedAt: Date.now() } : l,
      );
      persist(lists, state.activeListId);
      return { lists };
    });
  },

  deleteList: (id) => {
    set((state) => {
      const lists = state.lists.filter((l) => l.id !== id);
      const activeListId =
        state.activeListId === id ? lists[0]?.id ?? null : state.activeListId;
      persist(lists, activeListId);
      return { lists, activeListId };
    });
  },

  setActiveList: (id) => {
    if (!get().lists.some((l) => l.id === id)) return;
    set((state) => {
      persist(state.lists, id);
      return { activeListId: id };
    });
  },

  addEntries: (listId, items) => {
    const now = Date.now();
    const entries: ListEntry[] = items
      .map((item) => (typeof item === 'string' ? { text: item } : item))
      .map(({ text, note }) => ({ text: text.trim(), note: note?.trim() || undefined }))
      .filter((i) => i.text)
      .map(({ text, note }) => ({ id: makeId('entry'), text, note, addedAt: now }));
    if (entries.length === 0) return;
    set((state) => {
      const lists = state.lists.map((l) =>
        l.id === listId ? { ...l, entries: [...l.entries, ...entries], updatedAt: now } : l,
      );
      persist(lists, state.activeListId);
      return { lists };
    });
  },

  updateEntry: (listId, entryId, patch) => {
    set((state) => {
      const lists = state.lists.map((l) => {
        if (l.id !== listId) return l;
        return {
          ...l,
          updatedAt: Date.now(),
          entries: l.entries.map((e) => {
            if (e.id !== entryId) return e;
            const text = patch.text === undefined ? e.text : patch.text.trim() || e.text;
            const note = patch.note === undefined ? e.note : patch.note.trim() || undefined;
            return { ...e, text, note };
          }),
        };
      });
      persist(lists, state.activeListId);
      return { lists };
    });
  },

  removeEntry: (listId, entryId) => {
    set((state) => {
      const lists = state.lists.map((l) =>
        l.id === listId
          ? { ...l, entries: l.entries.filter((e) => e.id !== entryId), updatedAt: Date.now() }
          : l,
      );
      persist(lists, state.activeListId);
      return { lists };
    });
  },
}));

// ---------- Cross-window sync ----------------------------------------------

/** Reload the store from localStorage. Used by the cross-window listener. */
export function reloadListStore(): void {
  const lists = loadLists();
  useListStore.setState({ lists, activeListId: loadActiveListId(lists) });
}

/** Mount once per window: subscribes this window's store to updates emitted
 *  by other windows. Same idiom as startSnippetSync. */
export async function startListSync(): Promise<UnlistenFn | undefined> {
  try {
    return await listen<{ source: string }>(LISTS_UPDATED_EVENT, (event) => {
      if (event.payload?.source === SENDER_ID) return;
      reloadListStore();
    });
  } catch (err) {
    Logger.warn('[listStore] startListSync failed:', err);
    return undefined;
  }
}
