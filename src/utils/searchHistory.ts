// Recent searches shown under the main search bar. Persisted to localStorage so
// the list survives restarts and is shared across windows, matching how other
// lightweight view preferences are stored.
//
// History is kept SEPARATELY per scope (the view a search was launched from:
// following / discover / categories) so each view has its own tidy list. The
// stored shape is an object of `scope -> RecentSearch[]`.

export type SearchMode = 'streamers' | 'categories';

export interface RecentSearch {
  query: string;
  mode: SearchMode;
}

type Store = Record<string, RecentSearch[]>;

const KEY = 'streamnook.search.recent';
const MAX = 8;

function isRecent(r: unknown): r is RecentSearch {
  return (
    !!r &&
    typeof (r as RecentSearch).query === 'string' &&
    ((r as RecentSearch).mode === 'streamers' || (r as RecentSearch).mode === 'categories')
  );
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Current shape is an object of scope -> array. Anything else (e.g. the
    // legacy single flat array) is discarded so each scope starts clean.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [scope, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) out[scope] = list.filter(isRecent).slice(0, MAX);
    }
    return out;
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

export function loadRecentSearches(scope: string): RecentSearch[] {
  return loadStore()[scope] ?? [];
}

// Prepend a search to its scope, dropping any earlier duplicate (same text +
// mode, case-insensitive) so the most recent use floats to the top. Returns the
// new list for that scope.
export function addRecentSearch(scope: string, query: string, mode: SearchMode): RecentSearch[] {
  const q = query.trim();
  const store = loadStore();
  const cur = store[scope] ?? [];
  if (!q) return cur;
  const rest = cur.filter((r) => !(r.query.toLowerCase() === q.toLowerCase() && r.mode === mode));
  const next = [{ query: q, mode }, ...rest].slice(0, MAX);
  store[scope] = next;
  saveStore(store);
  return next;
}

export function removeRecentSearch(scope: string, query: string, mode: SearchMode): RecentSearch[] {
  const store = loadStore();
  const next = (store[scope] ?? []).filter((r) => !(r.query === query && r.mode === mode));
  store[scope] = next;
  saveStore(store);
  return next;
}

export function clearRecentSearches(scope: string): RecentSearch[] {
  const store = loadStore();
  delete store[scope];
  saveStore(store);
  return [];
}

// Wipe every scope's history at once (used by the command palette action).
export function clearAllRecentSearches(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
