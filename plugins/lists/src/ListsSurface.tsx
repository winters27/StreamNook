// ListsSurface: the shared core of the Lists feature, hosted by three
// chromes: the in-app floating panel (ListsPanel), the standalone popout
// window, and the Moderator Logs dock column. Everything list-shaped lives
// here; the hosts only provide positioning, sizing, and window controls.
//
// Interaction model:
//   - Click an entry to copy its text. Feedback is an inline check on the row
//     (no toast, copying in bursts is the core workflow).
//   - Hover an entry for insert-into-chat / edit / delete actions.
//   - Paste a whole list into the add box (lines, commas, or spreadsheet rows)
//     and every entry is added at once.
//   - Entries carry an optional note (shown muted, never copied) so "alt of
//     someone" annotations don't pollute what gets pasted into /ban.
//   - Toolbar: live entry count, A-Z / added-order sort, copy-the-whole-list.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ClipboardEvent as ReactClipboardEvent, ReactNode, FC } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownAZ,
  Check,
  ChevronDown,
  ClipboardCopy,
  ClipboardList,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { getApi } from './host';
import { useListStore, type ListEntry, type UserList } from './listStore';

const COPIED_FLASH_MS = 1200;
const FLASH_MS = 1800;
/** Search box appears once a list is big enough that scanning beats scrolling. */
const SEARCH_THRESHOLD = 8;

type SortMode = 'added' | 'az';

/** Turn pasted text into list entries. Newlines always split. A single line
 *  of comma/semicolon-separated tokens ("user1, user2, user3") also reads as
 *  a list, but only when every segment is one word, so titles and commands
 *  containing ", " stay a single entry. Tab-separated cells (a spreadsheet
 *  row) become text + note. */
function splitPastedList(text: string): { text: string; note?: string }[] {
  let lines = text.split(/\r?\n/);
  if (lines.length === 1) {
    const parts = lines[0].split(/[,;]/).map((p) => p.trim());
    if (parts.length > 1 && parts.every((p) => !/\s/.test(p))) lines = parts;
  }
  return lines
    .map((line) => {
      const [first, ...rest] = line.split('\t');
      const note = rest.join(' ').trim();
      return { text: first.trim(), note: note || undefined };
    })
    .filter((e) => e.text);
}

export interface ListsSurfaceProps {
  /** 'floating' = the in-app corner panel; 'window' = the popout OS window;
   *  'docked' = a column inside the Mod Logs pane. */
  variant: 'floating' | 'window' | 'docked';
  /** Right-aligned header controls supplied by the host chrome (pop out,
   *  close). The window host leaves this empty; its titlebar has the controls. */
  trailing?: ReactNode;
  /** Floating host passes its drag-start here so the header doubles as the
   *  drag handle. */
  onHeaderPointerDown?: (e: ReactPointerEvent) => void;
  /** Switch to this list on mount (palette "Open list: X" rows). */
  initialListId?: string | null;
}

export const ListsSurface: FC<ListsSurfaceProps> = ({
  variant,
  trailing,
  onHeaderPointerDown,
  initialListId,
}) => {
  const api = getApi();
  const { Tooltip } = api.components;

  // Insert-into-chat needs the main window's compose box: present when a
  // stream is watched or the multi-stream grid is up. The popout window (and
  // the Mod Logs pane inside a MultiChat popout) has no such box, and there
  // the host's per-window state is empty, so the gate self-resolves.
  const hasTarget = api.chat.useHasTarget();
  const hasChat = variant !== 'window' && hasTarget;

  const lists = useListStore((s) => s.lists);
  const activeListId = useListStore((s) => s.activeListId);
  const { createList, renameList, deleteList, setActiveList, addEntries, updateEntry, removeEntry } =
    useListStore.getState();

  const activeList: UserList | undefined =
    lists.find((l) => l.id === activeListId) ?? lists[0];

  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sort, setSort] = useState<SortMode>('added');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; note: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newListName, setNewListName] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  // Palette "Open list: X" rows land here with a specific list preselected.
  useEffect(() => {
    if (initialListId) setActiveList(initialListId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialListId]);

  // Reset transient state when switching lists.
  useEffect(() => {
    setQuery('');
    setEditing(null);
  }, [activeList?.id]);

  // Close the list-switcher menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
        setRenaming(null);
        setArmedDelete(null);
        setCreating(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  const visibleEntries = useMemo(() => {
    if (!activeList) return [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? activeList.entries.filter(
          (e) => e.text.toLowerCase().includes(q) || e.note?.toLowerCase().includes(q),
        )
      : activeList.entries;
    if (sort === 'az') {
      return [...filtered].sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: 'base' }));
    }
    return filtered;
  }, [activeList, query, sort]);

  // ---- actions ---------------------------------------------------------

  const flashMessage = (message: string) => {
    setFlash(message);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  };

  const copyEntry = async (entry: ListEntry) => {
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), COPIED_FLASH_MS);
    } catch (err) {
      api.log.warn('[ListsSurface] clipboard write failed:', err);
    }
  };

  const copyAllVisible = async () => {
    if (visibleEntries.length === 0) return;
    try {
      await navigator.clipboard.writeText(visibleEntries.map((e) => e.text).join('\n'));
      flashMessage(`Copied ${visibleEntries.length} ${visibleEntries.length === 1 ? 'entry' : 'entries'}`);
    } catch (err) {
      api.log.warn('[ListsSurface] clipboard write failed:', err);
    }
  };

  const insertEntry = (entry: ListEntry) => {
    // Fall back to copying when no chat compose box is mounted.
    if (!api.chat.insertText(entry.text)) void copyEntry(entry);
  };

  const submitDraft = () => {
    if (!activeList) return;
    const value = draft.trim();
    if (!value) return;
    addEntries(activeList.id, [value]);
    setDraft('');
  };

  const handleDraftPaste = (e: ReactClipboardEvent<HTMLInputElement>) => {
    if (!activeList) return;
    const items = splitPastedList(e.clipboardData.getData('text'));
    // A plain single value falls through to the default paste so it can still
    // be edited before submitting; anything list-shaped is added directly.
    if (items.length < 2 && !items[0]?.note) return;
    e.preventDefault();
    addEntries(activeList.id, items);
    setDraft('');
    flashMessage(`Added ${items.length} ${items.length === 1 ? 'entry' : 'entries'}`);
  };

  const submitNewList = () => {
    const name = newListName.trim();
    if (!name) return;
    createList(name);
    setNewListName('');
    setCreating(false);
    setMenuOpen(false);
  };

  const saveEdit = () => {
    if (!editing || !activeList) return;
    updateEntry(activeList.id, editing.id, { text: editing.text, note: editing.note });
    setEditing(null);
  };

  // ---- render ------------------------------------------------------------

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header: list switcher + host controls (doubles as drag handle when floating) */}
      <div
        onPointerDown={onHeaderPointerDown}
        className={`flex items-center gap-2 px-3 py-2.5 select-none shrink-0 ${
          onHeaderPointerDown ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
      >
        <ClipboardList size={16} className="text-accent shrink-0" />
        {lists.length > 0 ? (
          <div className="relative flex-1 min-w-0" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 max-w-full text-textPrimary hover:text-accent transition-colors"
            >
              <span className="text-sm font-semibold truncate">{activeList?.name}</span>
              <ChevronDown
                size={13}
                className={`shrink-0 text-textSecondary transition-transform ${menuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {menuOpen && (
              <div className="absolute top-full left-0 mt-1.5 w-56 glass-panel border border-white/10 bg-background/95 backdrop-blur-md z-10 py-1 max-h-64 overflow-y-auto scrollbar-thin">
                {lists.map((list) => (
                  <div
                    key={list.id}
                    className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer ${
                      list.id === activeList?.id ? 'text-accent' : 'text-textSecondary'
                    }`}
                    onClick={() => {
                      if (renaming?.id === list.id) return;
                      setActiveList(list.id);
                      setMenuOpen(false);
                    }}
                  >
                    {renaming?.id === list.id ? (
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: list.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            renameList(list.id, renaming.name);
                            setRenaming(null);
                          }
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 glass-input text-xs px-2 py-1"
                      />
                    ) : (
                      <>
                        <span className="flex-1 min-w-0 text-xs font-medium truncate">{list.name}</span>
                        <span className="text-[10px] text-textMuted">{list.entries.length}</span>
                        <span className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenaming({ id: list.id, name: list.name });
                              setArmedDelete(null);
                            }}
                            className="p-0.5 text-textMuted hover:text-textPrimary transition-colors"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (armedDelete === list.id) {
                                deleteList(list.id);
                                setArmedDelete(null);
                              } else {
                                setArmedDelete(list.id);
                              }
                            }}
                            className={`p-0.5 transition-colors ${
                              armedDelete === list.id
                                ? 'text-error'
                                : 'text-textMuted hover:text-textPrimary'
                            }`}
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                ))}

                {creating ? (
                  <div className="px-3 py-1.5">
                    <input
                      autoFocus
                      value={newListName}
                      onChange={(e) => setNewListName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitNewList();
                        if (e.key === 'Escape') setCreating(false);
                      }}
                      placeholder="List name"
                      className="w-full glass-input text-xs px-2 py-1 placeholder-textMuted"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setCreating(true)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-textSecondary hover:text-accent hover:bg-surface-hover transition-colors"
                  >
                    <Plus size={12} />
                    New list
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <span className="flex-1 text-sm font-semibold text-textPrimary">Lists</span>
        )}

        {trailing}
      </div>

      {/* Toolbar: count + sort + copy all */}
      {activeList && activeList.entries.length > 0 && (
        <div className="flex items-center justify-between px-3 pb-1.5 shrink-0">
          <span className="text-[10px] text-textMuted">
            {query.trim()
              ? `${visibleEntries.length} of ${activeList.entries.length}`
              : `${activeList.entries.length} ${activeList.entries.length === 1 ? 'entry' : 'entries'}`}
          </span>
          <div className="flex items-center gap-0.5">
            <Tooltip content={sort === 'az' ? 'Back to added order' : 'Sort A to Z'} delay={300}>
              <button
                onClick={() => setSort((s) => (s === 'az' ? 'added' : 'az'))}
                className={`p-1 rounded transition-colors ${
                  sort === 'az' ? 'text-accent' : 'text-textMuted hover:text-textPrimary'
                }`}
              >
                <ArrowDownAZ size={13} />
              </button>
            </Tooltip>
            <Tooltip content={query.trim() ? 'Copy matching entries' : 'Copy whole list'} delay={300}>
              <button
                onClick={() => void copyAllVisible()}
                className="p-1 text-textMuted hover:text-textPrimary rounded transition-colors"
              >
                <ClipboardCopy size={13} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Search, once the list is big enough for scanning to hurt */}
      {activeList && activeList.entries.length >= SEARCH_THRESHOLD && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textMuted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${activeList.name}`}
              className="w-full glass-input text-xs pl-7 pr-2 py-1.5 placeholder-textMuted"
            />
          </div>
        </div>
      )}

      {/* Entries */}
      <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0 px-1.5 pb-1">
        {!activeList ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <ClipboardList size={32} className="mb-3 text-accent/40" />
            <p className="text-sm text-textSecondary mb-1">No lists yet</p>
            <p className="text-xs text-textMuted mb-4">
              Keep usernames, commands, or titles at hand while you watch.
            </p>
            <input
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewList();
              }}
              placeholder="List name, press Enter"
              className="w-full glass-input text-xs px-2.5 py-1.5 placeholder-textMuted"
            />
          </div>
        ) : activeList.entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <p className="text-xs text-textMuted">
              Add entries below. Paste a whole list (lines or commas) to add every entry at once.
            </p>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-textMuted">No matches</p>
          </div>
        ) : (
          visibleEntries.map((entry) =>
            editing?.id === entry.id ? (
              <div key={entry.id} className="px-1 py-1 space-y-1">
                <input
                  autoFocus
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  className="w-full glass-input text-sm px-2 py-1"
                />
                <div className="flex items-center gap-1">
                  <input
                    value={editing.note}
                    onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    placeholder="Note (optional, not copied)"
                    className="flex-1 glass-input text-xs px-2 py-1 placeholder-textMuted"
                  />
                  <Tooltip content="Save" delay={300}>
                    <button
                      onClick={saveEdit}
                      className="p-1.5 text-accent hover:bg-surface-hover rounded transition-colors"
                    >
                      <Check size={13} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ) : (
              <div
                key={entry.id}
                onClick={() => void copyEntry(entry)}
                className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-textPrimary truncate">{entry.text}</span>
                  {entry.note && (
                    <span className="block text-[11px] text-textMuted truncate">{entry.note}</span>
                  )}
                </span>
                {copiedId === entry.id ? (
                  <span className="flex items-center gap-1 text-accent text-[10px] font-medium shrink-0">
                    <Check size={12} />
                    Copied
                  </span>
                ) : (
                  <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                    {hasChat && (
                      <Tooltip content="Insert into chat" delay={300}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            insertEntry(entry);
                          }}
                          className="p-1 text-textMuted hover:text-accent rounded transition-colors"
                        >
                          <MessageSquarePlus size={13} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Edit" delay={300}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ id: entry.id, text: entry.text, note: entry.note ?? '' });
                        }}
                        className="p-1 text-textMuted hover:text-textPrimary rounded transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Remove" delay={300}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeEntry(activeList.id, entry.id);
                        }}
                        className="p-1 text-textMuted hover:text-error rounded transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  </span>
                )}
              </div>
            ),
          )
        )}
      </div>

      {/* Add entry */}
      {activeList && (
        <div className="relative px-3 py-2.5 shrink-0">
          <AnimatePresence>
            {flash !== null && (
              <motion.span
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute -top-4 right-3 text-[10px] text-accent font-medium pointer-events-none"
              >
                {flash}
              </motion.span>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft();
              }}
              onPaste={handleDraftPaste}
              placeholder="Add entry"
              className="flex-1 glass-input text-xs px-2.5 py-1.5 placeholder-textMuted"
            />
            <Tooltip content="Add" delay={300}>
              <button
                onClick={submitDraft}
                disabled={!draft.trim()}
                className="p-1.5 text-textSecondary hover:text-accent rounded transition-colors disabled:opacity-40"
              >
                <Plus size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </div>
  );
};

export default ListsSurface;
