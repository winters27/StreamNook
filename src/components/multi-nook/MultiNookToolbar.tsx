import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { invoke } from '@tauri-apps/api/core';
import { usemultiNookStore } from '../../stores/multiNookStore';
import { useTutorialStore } from '../../stores/tutorialStore';
import { MultiNookSlot, TwitchStream } from '../../types';
import { Plus, Maximize2, Minimize2, MessageSquare, MessageSquareOff, Loader2, Users, X, ArrowLeft, RefreshCcw, ShieldCheck, Search, Radio } from 'lucide-react';
import { Logger } from '../../utils/logger';
import { Tooltip } from '../ui/Tooltip';
import { useAppStore } from '../../stores/AppStore';

interface ChannelSearchResult {
  id?: string;
  user_id?: string;
  user_login?: string;
  broadcaster_login?: string;
  user_name?: string;
  display_name?: string;
  thumbnail_url?: string;
  is_live?: boolean;
  game_name?: string;
  profile_image_url?: string;
}

interface MultiNookToolbarProps {
  isDragging?: boolean;
  dockDropId?: string;
  dockedPrefix?: string;
}

/** Normalized shape so live-follows and Twitch search results render through one row. */
interface ChannelItem {
  id: string;
  login: string;
  displayName: string;
  avatarUrl?: string;
  isLive: boolean;
  gameName?: string;
  source: 'following' | 'search';
}

const DEFAULT_AVATAR =
  'https://static-cdn.jtvnw.net/user-default-pictures-uv/75305d54-c7cc-40d1-bb9c-91c46bf27829-profile_image-70x70.png';

/** Followed-streams thumbnails are stream previews carrying {width}x{height} placeholders that
 *  won't load as-is, so prefer a real profile image and only fall back to a sized preview. */
function resolveAvatar(profileImageUrl?: string, thumbnailUrl?: string): string | undefined {
  if (profileImageUrl) return profileImageUrl;
  if (thumbnailUrl) return thumbnailUrl.replace('{width}', '150').replace('{height}', '150');
  return undefined;
}

function streamToItem(s: TwitchStream): ChannelItem {
  return {
    id: s.user_id,
    login: s.user_login,
    displayName: s.user_name || s.user_login,
    avatarUrl: resolveAvatar(s.profile_image_url, s.thumbnail_url),
    isLive: true, // followed-streams endpoint only returns live channels
    gameName: s.game_name,
    source: 'following',
  };
}

function resultToItem(r: ChannelSearchResult): ChannelItem {
  const login = r.user_login || r.broadcaster_login || '';
  return {
    id: r.user_id || r.id || login,
    login,
    displayName: r.user_name || r.display_name || login,
    avatarUrl: resolveAvatar(r.profile_image_url, r.thumbnail_url),
    isLive: !!r.is_live,
    gameName: r.game_name,
    source: 'search',
  };
}

const MultiNookToolbar: React.FC<MultiNookToolbarProps> = ({
  isDragging = false,
  dockDropId = 'dock-drop-zone',
  dockedPrefix = 'docked::',
}) => {
  const { slots, addSlot, undockSlot, swapDockedSlot, isChatHidden, toggleChatHidden, toggleMultiNook, resyncAllSlots } = usemultiNookStore();
  const minimizedSlots = slots.filter(s => s.isMinimized);
  const { isDocked: isTutorialDocked, setIsDocked: setTutorialDocked } = useTutorialStore();

  // Online following powers the "smart list" — the followed-streams cache holds only live channels.
  const followedStreams = useAppStore((s) => s.followedStreams);
  const loadFollowedStreams = useAppStore((s) => s.loadFollowedStreams);

  // Mod-view (Moderator Logs pane) visibility — the global, now-persisted setting.
  const showModLogs = useAppStore((s) => s.settings.show_mod_logs ?? false);
  const toggleModLogs = useCallback(() => {
    const st = useAppStore.getState();
    st.updateSettings({ ...st.settings, show_mod_logs: !(st.settings.show_mod_logs ?? false) });
  }, []);

  const { setNodeRef: setDockRef, isOver } = useDroppable({ id: dockDropId });

  // --- Add Channel Search State ---
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ChannelSearchResult[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when search opens, and refresh the live-following list so it's current the
  // moment the panel appears.
  useEffect(() => {
    if (isSearchOpen) {
      loadFollowedStreams();
      // Small delay for the expand animation to start
      const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 80);
      return () => clearTimeout(t);
    }
  }, [isSearchOpen, loadFollowedStreams]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchInput('');
    setSearchResults([]);
    setIsSearching(false);
    setHighlightIndex(0);
  }, []);

  // Click outside to close
  useEffect(() => {
    if (!isSearchOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        closeSearch();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isSearchOpen, closeSearch]);

  const query = searchInput.trim().toLowerCase();

  // Channels already in the grid — excluded from every list so you can't add a duplicate.
  const existingLogins = useMemo(
    () => new Set(slots.map(s => s.channelLogin.toLowerCase())),
    [slots]
  );

  // Online following, instantly filtered against the typed query (no network round-trip).
  const followingItems = useMemo(() => {
    const items = followedStreams
      .map(streamToItem)
      .filter(it => !existingLogins.has(it.login.toLowerCase()));
    if (!query) return items;
    return items.filter(it =>
      it.login.toLowerCase().includes(query) ||
      it.displayName.toLowerCase().includes(query) ||
      (it.gameName || '').toLowerCase().includes(query)
    );
  }, [followedStreams, existingLogins, query]);

  // Twitch search results, minus anything already in the grid or already shown as a live follow.
  const searchItems = useMemo(() => {
    const followingLogins = new Set(followingItems.map(it => it.login.toLowerCase()));
    return searchResults
      .map(resultToItem)
      .filter(it =>
        it.login &&
        !existingLogins.has(it.login.toLowerCase()) &&
        !followingLogins.has(it.login.toLowerCase())
      );
  }, [searchResults, followingItems, existingLogins]);

  // Flat list backing keyboard navigation (following first, then search).
  const visibleItems = useMemo(() => [...followingItems, ...searchItems], [followingItems, searchItems]);

  // Reset the highlight whenever the result set changes shape.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query, followingItems.length, searchItems.length]);

  // Keep the highlighted row scrolled into view during keyboard navigation.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlightIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  // Debounced Twitch search — only fires while there's a query; the live list above stays instant.
  useEffect(() => {
    if (!query) {
      setSearchResults([]);
      setIsSearching(false);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      return;
    }

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await invoke('search_channels', { query: searchInput.trim() }) as ChannelSearchResult[];
        setSearchResults(results.slice(0, 8));
      } catch (err) {
        Logger.error('multi-nook channel search failed:', err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchInput, query]);

  const handleSelectItem = useCallback(async (item: ChannelItem) => {
    if (!item.login) return;
    setIsAdding(true);
    await addSlot(item.login);
    closeSearch();
    setIsAdding(false);
  }, [addSlot, closeSearch]);

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSearch();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex(i => Math.min(i + 1, Math.max(visibleItems.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      const target = visibleItems[highlightIndex];
      if (target) {
        e.preventDefault();
        await handleSelectItem(target);
      } else if (searchInput.trim() && !isSearching) {
        // Fallback: add the raw text as a login (exact channel not surfaced by search)
        setIsAdding(true);
        await addSlot(searchInput.trim());
        closeSearch();
        setIsAdding(false);
      }
    }
  };

  return (
    <div className="relative z-10" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {/* Toolbar — also acts as the dock drop zone when dragging a visible stream */}
      <div
        ref={setDockRef}
        className={`
          relative flex items-center justify-between px-4 py-2 backdrop-blur-md border-b shadow-sm
          transition-all duration-300
          ${isDragging && isOver
            ? 'bg-accent/15 border-accent/50 shadow-[0_0_25px_rgba(167,139,250,0.2),0_2px_10px_rgba(167,139,250,0.15)]'
            : isDragging
              ? 'bg-surface/50 border-accent/30 shadow-[0_0_12px_rgba(167,139,250,0.08)]'
              : 'bg-surface/50 border-borderSubtle'
          }
        `}
      >
        {/* Animated shimmer overlay when dragging */}
        {isDragging && (
          <div
            className="absolute inset-0 pointer-events-none overflow-hidden rounded-[inherit]"
            style={{ opacity: isOver ? 0.7 : 0.35 }}
          >
            <div
              className="absolute inset-0"
              style={{
                background: 'linear-gradient(90deg, transparent 0%, rgba(167,139,250,0.35) 40%, rgba(167,139,250,0.5) 50%, rgba(167,139,250,0.35) 60%, transparent 100%)',
                animation: 'dock-shimmer 1.5s ease-in-out infinite',
              }}
            />
          </div>
        )}

        {/* Pulsing border glow when dragging (not hovering) */}
        {isDragging && !isOver && (
          <div
            className="absolute inset-0 pointer-events-none rounded-[inherit]"
            style={{
              boxShadow: '0 0 0 1px rgba(167,139,250,0.2)',
              animation: 'dock-pulse 1.5s ease-in-out infinite',
            }}
          />
        )}

        {/* Floating "Drop to dock" label */}
        <div
          className={`
            absolute left-1/2 -translate-x-1/2 bottom-0 translate-y-full
            px-3 py-1 rounded-b-md text-[10px] font-bold uppercase tracking-widest
            transition-all duration-300 pointer-events-none z-20
            ${isDragging && isOver
              ? 'opacity-100 bg-accent/25 text-accent border border-t-0 border-accent/30 backdrop-blur-md shadow-lg'
              : isDragging
                ? 'opacity-70 bg-glass/60 text-textMuted border border-t-0 border-borderSubtle backdrop-blur-md'
                : 'opacity-0'
            }
          `}
        >
          {isOver ? '↓ Release to dock' : '↑ Drag here to dock'}
        </div>

        <style>{`
          @keyframes dock-shimmer {
            0%, 100% { transform: translateX(-100%); }
            50% { transform: translateX(100%); }
          }
          @keyframes dock-pulse {
            0%, 100% { box-shadow: 0 0 0 1px rgba(167,139,250,0.15); }
            50% { box-shadow: 0 0 0 2px rgba(167,139,250,0.35), 0 0 15px rgba(167,139,250,0.1); }
          }
        `}</style>

        {/* Left side: Stats & Title */}
        <div className="flex items-center gap-4 flex-1 overflow-hidden mr-4">
          <div className="flex items-center gap-1.5 shrink-0">
            {slots.length > 0 ? (
              <>
                <Tooltip content="Browse Streams (Keep Playing)" delay={200} side="bottom">
                  <button
                    onClick={() => useAppStore.getState().toggleHome()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold tracking-wide rounded-lg transition-all whitespace-nowrap glass-button text-textSecondary hover:text-white"
                  >
                    <ArrowLeft size={16} />
                    <span>Browse</span>
                  </button>
                </Tooltip>

                <Tooltip content="Exit (Kill Streams)" delay={200} side="bottom">
                  <button
                    onClick={toggleMultiNook}
                    className="flex items-center justify-center w-[32px] h-[32px] rounded-lg transition-all glass-button text-textSecondary hover:text-red-400 hover:bg-red-500/10 shrink-0"
                  >
                    <X size={16} />
                  </button>
                </Tooltip>
              </>
            ) : (
              <Tooltip content="Close Grid Engine" delay={200} side="bottom">
                <button
                  onClick={toggleMultiNook}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold tracking-wide rounded-lg transition-all whitespace-nowrap glass-button text-textSecondary hover:text-white hover:text-red-400 hover:bg-red-500/10 group"
                >
                  <ArrowLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" />
                  <span>Exit</span>
                </button>
              </Tooltip>
            )}
          </div>

          {(minimizedSlots.length > 0 || (slots.length === 0 && isTutorialDocked)) && (
            <>
              <div className="h-4 w-px bg-borderSubtle shrink-0" />
              <div className="flex items-center gap-2 flex-1 overflow-x-auto scrollbar-none mask-edges">
                {minimizedSlots.map((slot) => (
                  <DraggableDockPill
                    key={slot.id}
                    slot={slot}
                    dockedPrefix={dockedPrefix}
                    onSwap={() => swapDockedSlot(slot.id)}
                    onUndock={() => undockSlot(slot.id)}
                  />
                ))}
                
                {slots.length === 0 && isTutorialDocked && (
                  <TutorialDockPill onUndock={() => setTutorialDocked(false)} />
                )}
              </div>
            </>
          )}
        </div>

        {/* Right side: Add Stream & Controls */}
        <div className="flex items-center gap-3 relative z-30">
          {/* Add Stream — Collapsible search */}
          <div ref={searchContainerRef} className="relative">
            <div className={`
              flex items-center rounded-full transition-all duration-300 overflow-hidden
              ${isSearchOpen
                ? 'w-56 glass-input'
                : 'w-8 h-8 glass-button group cursor-pointer text-textSecondary hover:text-white'
              }
            `}>
              {isSearchOpen ? (
                <>
                  <input
                    ref={inputRef}
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search or pick a live channel..."
                    className="bg-transparent border-none text-sm text-textPrimary placeholder:text-textMuted flex-1 px-3 py-1.5 outline-none h-8"
                    disabled={isAdding || slots.length >= 25}
                  />
                  {isSearching ? (
                    <div className="pr-2 flex items-center">
                      <Loader2 size={14} className="text-accent animate-spin" />
                    </div>
                  ) : searchInput && (
                    <button
                      onClick={closeSearch}
                      className="pr-2 text-textMuted hover:text-textPrimary transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </>
              ) : (
                <Tooltip content="Add Stream" delay={200} side="bottom">
                  <button
                    onClick={() => {
                      if (slots.length < 25) setIsSearchOpen(true);
                    }}
                    disabled={slots.length >= 25}
                    className="w-full h-full flex items-center justify-center transition-colors disabled:opacity-40"
                  >
                    <Plus size={16} />
                  </button>
                </Tooltip>
              )}
            </div>

            {/* Smart list — live following on open, instant filter + Twitch search while typing */}
            {isSearchOpen && (
              <div className="absolute right-0 top-full mt-2 w-72 z-50">
                {/* Frosted glass surface — explicit opaque base because this menu floats directly
                    over the (bright) video grid with no dimming scrim, where the glass-strength
                    tint alone reads as see-through. */}
                <div
                  className="liquid-glass-panel overflow-hidden"
                  style={{ backgroundColor: 'rgba(16, 16, 20, 0.92)' }}
                >
                  <div ref={listRef} className="max-h-80 overflow-y-auto custom-scrollbar p-1.5">

                    {/* Live following (instant, from cache) */}
                    {followingItems.length > 0 && (
                      <>
                        <div className="px-2.5 pt-1.5 pb-1 flex items-center gap-1.5">
                          <Radio size={11} className="text-red-500" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-textMuted">
                            {query ? 'Following · live' : 'Live now'}
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {followingItems.map((item, i) => (
                            <ChannelResultRow
                              key={`f-${item.id}`}
                              item={item}
                              index={i}
                              highlighted={highlightIndex === i}
                              isAdding={isAdding}
                              onSelect={handleSelectItem}
                              onHover={setHighlightIndex}
                            />
                          ))}
                        </div>
                      </>
                    )}

                    {/* Twitch search (debounced) — only while typing */}
                    {query && (searchItems.length > 0 || isSearching) && (
                      <>
                        <div className="px-2.5 pt-2 pb-1 flex items-center gap-1.5">
                          <Search size={11} className="text-textMuted" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-textMuted">
                            All channels
                          </span>
                          {isSearching && <Loader2 size={11} className="text-accent animate-spin ml-auto" />}
                        </div>
                        <div className="space-y-0.5">
                          {searchItems.map((item, i) => {
                            const idx = followingItems.length + i;
                            return (
                              <ChannelResultRow
                                key={`s-${item.id}`}
                                item={item}
                                index={idx}
                                highlighted={highlightIndex === idx}
                                isAdding={isAdding}
                                onSelect={handleSelectItem}
                                onHover={setHighlightIndex}
                              />
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Empty states */}
                    {visibleItems.length === 0 && (
                      query ? (
                        isSearching ? (
                          <div className="px-4 py-5 flex items-center justify-center gap-2.5">
                            <Loader2 size={14} className="text-accent animate-spin" />
                            <span className="text-xs text-textSecondary font-medium">Searching Twitch...</span>
                          </div>
                        ) : (
                          <div className="px-4 py-5 text-center">
                            <span className="text-xs text-textMuted">No channels found for "{searchInput}"</span>
                          </div>
                        )
                      ) : (
                        <div className="px-4 py-5 text-center">
                          <span className="text-xs text-textMuted">
                            {followedStreams.length === 0
                              ? 'No followed channels are live. Type to search.'
                              : 'Start typing to search any channel'}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 ml-2 border-l border-white/10 pl-2">
            {/* Resync Toggle */}
            <Tooltip content="Resynchronize Playback (Force Reload All)" delay={200} side="bottom">
              <button
                onClick={resyncAllSlots}
                disabled={slots.length === 0}
                className={`w-8 h-8 flex items-center justify-center transition-all duration-200 glass-button text-textSecondary hover:text-accent active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <RefreshCcw size={15} />
              </button>
            </Tooltip>

            {/* Mod View Toggle — shows/hides the Moderator Logs pane (persisted) */}
            <Tooltip content={showModLogs ? 'Hide Mod View' : 'Show Mod View'} delay={200} side="bottom">
              <button
                onClick={toggleModLogs}
                aria-pressed={showModLogs}
                className={`w-8 h-8 flex items-center justify-center transition-all duration-200 ${
                  showModLogs
                    ? 'glass-input text-emerald-400 drop-shadow-md'
                    : 'glass-button text-rose-400/80 hover:text-emerald-400'
                }`}
                style={{ borderRadius: '8px' }}
              >
                <ShieldCheck size={15} />
              </button>
            </Tooltip>

            {/* Chat Toggle */}
          <Tooltip content={isChatHidden ? 'Show Chat' : 'Hide Chat'} delay={200} side="bottom">
            <button
              onClick={toggleChatHidden}
              className={`w-8 h-8 flex items-center justify-center transition-all duration-200 ${
                isChatHidden
                  ? 'glass-input text-accent drop-shadow-md'
                  : 'glass-button text-textSecondary hover:text-red-400 hover:bg-red-500/10'
              }`}
              style={{ borderRadius: '8px' }}
            >
              {isChatHidden ? <MessageSquareOff size={15} /> : <MessageSquare size={15} />}
            </button>
          </Tooltip>
          </div>

        </div>
      </div>
    </div>
  );
};

/** One row in the add-stream smart list. Renders both live follows and Twitch search hits. */
const ChannelResultRow: React.FC<{
  item: ChannelItem;
  index: number;
  highlighted: boolean;
  isAdding: boolean;
  onSelect: (item: ChannelItem) => void;
  onHover: (index: number) => void;
}> = ({ item, index, highlighted, isAdding, onSelect, onHover }) => {
  return (
    <button
      data-idx={index}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHover(index)}
      disabled={isAdding}
      className={`w-full px-2.5 py-2 text-left rounded-lg transition-all duration-150 flex items-center gap-3 group disabled:opacity-40 ${
        highlighted ? 'bg-white/[0.06]' : 'hover:bg-white/[0.06]'
      }`}
    >
      {/* Avatar with accent ring when active */}
      <div className="relative shrink-0">
        {item.avatarUrl ? (
          <img
            src={item.avatarUrl}
            alt={item.displayName}
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.src !== DEFAULT_AVATAR) img.src = DEFAULT_AVATAR;
            }}
            className={`w-8 h-8 rounded-full object-cover ring-2 transition-all duration-200 shadow-sm ${
              highlighted ? 'ring-accent/30' : 'ring-transparent group-hover:ring-accent/30'
            }`}
          />
        ) : (
          <div
            className={`w-8 h-8 rounded-full bg-white/[0.04] ring-2 flex items-center justify-center transition-all duration-200 ${
              highlighted ? 'ring-accent/30' : 'ring-transparent group-hover:ring-accent/30'
            }`}
          >
            <Users size={13} className="text-textSecondary" />
          </div>
        )}
        {/* Live dot on avatar */}
        {item.isLive && (
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-surface/80"></span>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <span
          className={`block text-[13px] font-semibold truncate leading-tight transition-colors ${
            highlighted ? 'text-accent' : 'text-textPrimary group-hover:text-accent'
          }`}
        >
          {item.displayName}
        </span>
        <span className="block text-[11px] text-textMuted truncate mt-0.5 leading-tight">
          {item.isLive && item.gameName ? item.gameName : item.isLive ? 'Live' : item.login}
        </span>
      </div>

      {/* Add indicator */}
      <div
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 shrink-0 ${
          highlighted ? 'bg-accent/15' : 'bg-transparent group-hover:bg-accent/15'
        }`}
      >
        <Plus size={13} className={`transition-colors ${highlighted ? 'text-accent' : 'text-textMuted group-hover:text-accent'}`} />
      </div>
    </button>
  );
};

/** Draggable pill for a docked/minimized stream */
const DraggableDockPill: React.FC<{
  slot: MultiNookSlot;
  dockedPrefix: string;
  onSwap: () => void;
  onUndock: () => void;
}> = ({ slot, dockedPrefix, onSwap, onUndock }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging: isPillDragging,
  } = useDraggable({
    id: `${dockedPrefix}${slot.id}`,
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isPillDragging ? 50 : undefined,
      }
    : undefined;

  return (
    <Tooltip content="Drag to grid to restore · Click to swap" delay={500} side="bottom">
      <div
        ref={setNodeRef}
        style={style}
        className={`
          group flex items-center gap-2 pl-1 pr-1 py-1 rounded-full glass-button
          cursor-grab active:cursor-grabbing
          transition-all duration-300 shrink-0 touch-none
          ${isPillDragging
            ? 'opacity-80 scale-105 shadow-[0_0_20px_rgba(167,139,250,0.3)] ring-1 ring-accent'
            : 'hover:text-white'
          }
        `}
        onClick={() => !isPillDragging && onSwap()}
        {...attributes}
        {...listeners}
      >
        <div className="flex items-center gap-1.5 opacity-80 group-hover:opacity-100 transition-opacity">
        {slot.profileImageUrl ? (
          <img src={slot.profileImageUrl} alt="" className="w-5 h-5 rounded-full object-cover shadow-sm bg-black/20" />
        ) : (
          <div className="w-2 h-2 ml-2 rounded-full bg-accent animate-pulse"></div>
        )}
        <span className="text-xs font-semibold text-textPrimary truncate max-w-[100px] select-none pr-1">
          {slot.channelName || slot.channelLogin}
        </span>
      </div>
      <Tooltip content="Restore to Grid" delay={200} side="bottom">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUndock();
          }}
          className="w-5 h-5 flex items-center justify-center rounded-full bg-accent/10 text-accent hover:bg-accent hover:text-white transition-all ml-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Maximize2 size={10} strokeWidth={3} />
        </button>
      </Tooltip>
    </div>
  </Tooltip>
  );
};

/** Draggable fake pill for the tutorial */
const TutorialDockPill: React.FC<{
  onUndock: () => void;
}> = ({ onUndock }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: `docked::tutorial::dock`,
  });

  const style = transform
    ? {
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 50 : undefined,
      }
    : undefined;

  return (
    <Tooltip content="Drag to grid to restore" delay={500} side="bottom">
      <div
        ref={setNodeRef}
        style={style}
        className={`
          group flex items-center gap-2 pl-1 pr-1 py-1 rounded-full glass-button
          cursor-grab active:cursor-grabbing border-emerald-400/30 bg-emerald-400/10
          transition-all duration-300 shrink-0 touch-none
          ${isDragging
            ? 'opacity-80 scale-105 shadow-[0_0_20px_rgba(52,211,153,0.3)] ring-1 ring-emerald-400'
            : 'hover:text-white'
          }
        `}
        {...attributes}
        {...listeners}
      >
        <div className="flex items-center gap-1.5 opacity-80 group-hover:opacity-100 transition-opacity">
        <div className="w-5 h-5 rounded-full bg-emerald-400/20 flex items-center justify-center">
            <Minimize2 size={12} className="text-emerald-400" />
        </div>
        <span className="text-xs font-semibold text-emerald-400 truncate max-w-[130px] select-none pr-1">
          Docking Tutorial
        </span>
      </div>
      <Tooltip content="Restore to Grid" delay={200} side="bottom">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUndock();
          }}
          className="w-5 h-5 flex items-center justify-center rounded-full bg-emerald-400/20 text-emerald-400 hover:bg-emerald-400 hover:text-white transition-all ml-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Maximize2 size={10} strokeWidth={3} />
        </button>
      </Tooltip>
    </div>
  </Tooltip>
  );
};

export default MultiNookToolbar;

