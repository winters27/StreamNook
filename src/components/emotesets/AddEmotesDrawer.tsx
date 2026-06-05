// Slide-in drawer for adding emotes to a set: searches the whole 7TV directory
// with filters and sort, supports add-by-URL/id, and adds with an optional
// custom alias and zero-width. This is the centerpiece "I want emote X" flow, so
// it sits one click from the Emotes tab.
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Search, X, Plus, Check, Loader2, Link2, Upload } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/AppStore';
import { Tooltip } from '../ui/Tooltip';
import {
  searchDirectory, resolveEmote, addEmote, emoteCdnUrl,
  SevenTVSessionExpired, SevenTVGraphQLError,
  type DirectoryEmote, type SortBy, type DirectoryFilters,
} from '../../services/seventvEditorService';

interface Props {
  setId: string;
  setName: string;
  onClose: () => void;
  onAdded: () => void;
  onOpenDetail: (e: DirectoryEmote) => void;
}

const SORTS: { label: string; value: SortBy }[] = [
  { label: 'Trending', value: 'TRENDING_WEEKLY' },
  { label: 'Top', value: 'TOP_ALL_TIME' },
  { label: 'Newest', value: 'UPLOAD_DATE' },
];

export default function AddEmotesDrawer({ setId, setName, onClose, onAdded, onOpenDetail }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [sort, setSort] = useState<SortBy>('TRENDING_WEEKLY');
  const [filters, setFilters] = useState<DirectoryFilters>({});
  const [results, setResults] = useState<DirectoryEmote[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  const [aliasFor, setAliasFor] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slower earlier search resolving after a newer one.
  const reqIdRef = useRef(0);

  const looksLikeRef = /emotes\/[0-9A-Za-z]+|^[0-9A-Za-z]{20,}$/.test(query.trim());

  const run = useCallback(async () => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await searchDirectory(activeQuery, { sortBy: sort, filters, page: 1, perPage: 60 });
      if (myReq !== reqIdRef.current) return;
      setResults(res.emotes);
    } catch (e) {
      if (myReq !== reqIdRef.current) return;
      if (e instanceof SevenTVSessionExpired) {
        addToast('Your 7TV session expired. Reconnect your 7TV account.', 'error');
      }
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      if (myReq === reqIdRef.current) setLoading(false);
    }
  }, [activeQuery, sort, filters, addToast]);

  useEffect(() => {
    run();
  }, [run]);

  // Drop any pending search debounce on unmount.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const onQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setActiveQuery(v.trim()), 350);
  };

  const doAdd = useCallback(
    async (emote: DirectoryEmote, alias?: string) => {
      setAddingId(emote.id);
      try {
        await addEmote(setId, emote.id, {
          alias: alias?.trim() || undefined,
          zeroWidth: emote.zeroWidth || undefined,
        });
        setAddedIds((s) => new Set(s).add(emote.id));
        onAdded();
      } catch (e) {
        if (e instanceof SevenTVSessionExpired) {
          addToast('Your 7TV session expired. Reconnect your 7TV account.', 'error');
        } else if (e instanceof SevenTVGraphQLError) {
          addToast(e.message || 'Could not add emote (name may already be in the set)', 'error');
        } else {
          addToast(e instanceof Error ? e.message : 'Could not add emote', 'error');
        }
      } finally {
        setAddingId(null);
        setAliasFor(null);
        setAliasDraft('');
      }
    },
    [setId, onAdded, addToast],
  );

  const addByRef = useCallback(async () => {
    setLoading(true);
    try {
      const emote = await resolveEmote(query);
      if (!emote) {
        addToast('Could not find that emote', 'warning');
        return;
      }
      setResults([emote]);
      setActiveQuery('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'Could not resolve emote', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, addToast]);

  const toggleFilter = (key: keyof DirectoryFilters) =>
    setFilters((f) => ({ ...f, [key]: f[key] ? undefined : true }));

  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/55" onClick={onClose} />
      <motion.div
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        // Opaque token surface: the emote grid sits directly behind the drawer,
        // so a translucent panel made the search hard to read.
        className="absolute top-0 right-0 bottom-0 z-30 w-[620px] max-w-[94%] bg-tertiary border-l border-borderSubtle shadow-[-12px_0_40px_rgba(0,0,0,0.5)] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-borderSubtle shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-textPrimary">Add emotes</div>
            <div className="text-[11px] text-textMuted truncate">to {setName}</div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-textSecondary hover:text-textPrimary hover:bg-glass rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search + controls */}
        <div className="px-4 py-2 space-y-2 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textMuted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search 7TV emotes, or paste a 7tv.app link"
              className="w-full pl-8 pr-3 py-2 rounded-lg bg-glass text-sm text-textPrimary placeholder:text-textMuted outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {looksLikeRef && (
            <button
              onClick={addByRef}
              className="w-full glass-button rounded px-3 py-1.5 text-sm text-textPrimary flex items-center justify-center gap-1.5"
            >
              <Link2 size={14} /> Resolve this link / id
            </button>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-glass rounded-lg p-0.5">
              {SORTS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSort(s.value)}
                  className={`px-2 py-1 rounded-md text-xs transition-colors ${
                    sort === s.value ? 'bg-glass-active text-textPrimary' : 'text-textSecondary hover:text-textPrimary'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <FilterChip label="Animated" on={!!filters.animated} onClick={() => toggleFilter('animated')} />
            <FilterChip label="Zero-width" on={!!filters.defaultZeroWidth} onClick={() => toggleFilter('defaultZeroWidth')} />
            <FilterChip label="Exact" on={!!filters.exactMatch} onClick={() => toggleFilter('exactMatch')} />
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-3">
          {loading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 size={20} className="animate-spin text-textSecondary" />
            </div>
          ) : error ? (
            <p className="text-sm text-textSecondary text-center mt-6 px-4">{error}</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-textMuted text-center mt-6">No emotes found.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {results.map((e) => {
                const added = addedIds.has(e.id);
                const adding = addingId === e.id;
                const aliasing = aliasFor === e.id;
                return (
                  <div key={e.id} className="group relative glass-panel rounded-lg p-2 flex flex-col items-center">
                    <button
                      onClick={() => onOpenDetail(e)}
                      className="h-16 w-full flex items-center justify-center cursor-pointer"
                    >
                      <DirImg id={e.id} alt={e.defaultName} />
                    </button>
                    <button
                      onClick={() => onOpenDetail(e)}
                      className="mt-1 w-full text-center text-[11px] text-textPrimary truncate hover:underline"
                    >
                      {e.defaultName}
                    </button>
                    {e.ownerName && (
                      <div className="w-full text-center text-[10px] text-textMuted truncate">{e.ownerName}</div>
                    )}

                    {aliasing ? (
                      <div className="mt-1 w-full flex items-center gap-1">
                        <input
                          autoFocus
                          value={aliasDraft}
                          onChange={(ev) => setAliasDraft(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') doAdd(e, aliasDraft);
                            else if (ev.key === 'Escape') { setAliasFor(null); setAliasDraft(''); }
                          }}
                          placeholder={e.defaultName}
                          className="flex-1 min-w-0 text-[11px] bg-glass rounded px-1 py-0.5 text-textPrimary outline-none focus:ring-1 focus:ring-accent/40"
                        />
                        <button onClick={() => doAdd(e, aliasDraft)} className="p-1 rounded bg-glass text-emerald-400 hover:bg-glass-active">
                          <Check size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1 flex items-center gap-1">
                        {added ? (
                          <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                            <Check size={12} /> Added
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() => doAdd(e)}
                              disabled={adding}
                              className="glass-button rounded px-2 py-1 text-[11px] text-textPrimary flex items-center gap-1 disabled:opacity-60"
                            >
                              {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
                              Add
                            </button>
                            <Tooltip content="Add with custom name" side="top" delay={200}>
                              <button
                                onClick={() => { setAliasFor(e.id); setAliasDraft(e.defaultName); }}
                                className="px-1.5 py-1 rounded text-[11px] text-textSecondary hover:text-textPrimary hover:bg-glass"
                              >
                                aA
                              </button>
                            </Tooltip>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Upload bridge: the one step that still lives on the site. */}
        <div className="px-4 py-2 border-t border-borderSubtle shrink-0">
          <button
            onClick={() => invoke('open_browser_url', { url: 'https://7tv.app/emotes' }).catch(() => {})}
            className="w-full text-left text-[11px] text-textMuted hover:text-textSecondary flex items-center gap-1.5"
          >
            <Upload size={12} />
            Can't find it? Upload a new emote on 7tv.app, then search for it here.
          </button>
        </div>
      </motion.div>
    </>
  );
}

function FilterChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded-full text-xs border transition-colors ${
        on
          ? 'bg-glass-active text-textPrimary border-accent/40'
          : 'text-textSecondary border-borderSubtle hover:text-textPrimary'
      }`}
    >
      {label}
    </button>
  );
}

function DirImg({ id, alt }: { id: string; alt: string }) {
  const [fallback, setFallback] = useState(false);
  const src = fallback ? `https://cdn.7tv.app/emote/${id}/3x.webp` : emoteCdnUrl(id, '3x');
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => !fallback && setFallback(true)}
      className="max-h-16 max-w-full object-contain"
    />
  );
}
