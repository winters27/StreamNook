import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDroppable, useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { invoke } from '@tauri-apps/api/core';
import { usemultiNookStore } from '../../stores/multiNookStore';
import { MultiNookSlot } from '../../types';
import { Plus, Maximize2, MessageSquare, MessageSquareOff, Loader2, Users, X, ArrowLeft, RefreshCcw } from 'lucide-react';
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

const MultiNookToolbar: React.FC<MultiNookToolbarProps> = ({
  isDragging = false,
  dockDropId = 'dock-drop-zone',
  dockedPrefix = 'docked::',
}) => {
  const { slots, addSlot, undockSlot, swapDockedSlot, isChatHidden, toggleChatHidden, toggleMultiNook, resyncAllSlots } = usemultiNookStore();
  const minimizedSlots = slots.filter(s => s.isMinimized);

  const { setNodeRef: setDockRef, isOver } = useDroppable({ id: dockDropId });

  // --- Add Channel Search State ---
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<ChannelSearchResult[]>([]);
  const [isAdding, setIsAdding] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Focus input when search opens
  useEffect(() => {
    if (isSearchOpen) {
      // Small delay for the expand animation to start
      const t = setTimeout(() => inputRef.current?.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [isSearchOpen]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchInput('');
    setSearchResults([]);
    setIsSearching(false);
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

  // Debounced search
  useEffect(() => {
    if (!searchInput.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await invoke('search_channels', { query: searchInput }) as ChannelSearchResult[];
        // Filter out channels already in grid
        const existingLogins = new Set(slots.map(s => s.channelLogin.toLowerCase()));
        const filtered = results.filter(r => {
          const login = (r.user_login || r.broadcaster_login || '').toLowerCase();
          return !existingLogins.has(login);
        });
        setSearchResults(filtered.slice(0, 6));
      } catch (err) {
        Logger.error('multi-nook channel search failed:', err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 400);

    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchInput, slots]);


  const handleSelectResult = async (result: ChannelSearchResult) => {
    const login = result.user_login || result.broadcaster_login || '';
    if (!login) return;

    setIsAdding(true);
    await addSlot(login);
    closeSearch();
    setIsAdding(false);
  };

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSearch();
    } else if (e.key === 'Enter' && searchInput.trim() && searchResults.length === 0 && !isSearching) {
      // Fallback: raw text add
      setIsAdding(true);
      await addSlot(searchInput.trim());
      closeSearch();
      setIsAdding(false);
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
              <Tooltip content="Exit MultiNook" delay={200} side="bottom">
                <button
                  onClick={toggleMultiNook}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold tracking-wide rounded-lg transition-all whitespace-nowrap glass-button text-textSecondary hover:text-white hover:text-red-400 hover:bg-red-500/10"
                >
                  <ArrowLeft size={16} />
                  <span>Exit MultiNook</span>
                </button>
              </Tooltip>
            )}
          </div>

          {minimizedSlots.length > 0 && (
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
                    placeholder="Search channel..."
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

            {/* Search Results Dropdown */}
            {isSearchOpen && searchInput.trim() && (
              <div className="absolute right-0 top-full mt-2 w-72 z-50">
                {/* Frosted glass surface */}
                <div className="glass-panel overflow-hidden drop-shadow-2xl">

                  {isSearching && searchResults.length === 0 ? (
                    <div className="px-4 py-5 flex items-center justify-center gap-2.5">
                      <Loader2 size={14} className="text-accent animate-spin" />
                      <span className="text-xs text-textSecondary font-medium">Searching Twitch...</span>
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="max-h-80 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
                      {searchResults.map((result) => {
                        const login = result.user_login || result.broadcaster_login || '';
                        const displayName = result.user_name || result.display_name || login;
                        const id = result.user_id || result.id || '';
                        const avatarUrl = result.profile_image_url || result.thumbnail_url;

                        return (
                          <button
                            key={id}
                            onClick={() => handleSelectResult(result)}
                            disabled={isAdding}
                            className="w-full px-2.5 py-2 text-left rounded-lg hover:bg-white/[0.06] focus:bg-white/[0.06] transition-all duration-150 flex items-center gap-3 group disabled:opacity-40"
                          >
                            {/* Avatar with accent ring on hover */}
                            <div className="relative shrink-0">
                              {avatarUrl ? (
                                <img
                                  src={avatarUrl}
                                  alt={displayName}
                                  className="w-8 h-8 rounded-full object-cover ring-2 ring-transparent group-hover:ring-accent/30 transition-all duration-200 shadow-sm"
                                />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-white/[0.04] ring-2 ring-transparent group-hover:ring-accent/30 flex items-center justify-center transition-all duration-200">
                                  <Users size={13} className="text-textSecondary" />
                                </div>
                              )}
                              {/* Live dot on avatar */}
                              {result.is_live && (
                                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] border-2 border-surface/80"></span>
                              )}
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                              <span className="block text-[13px] font-semibold text-textPrimary group-hover:text-accent transition-colors truncate leading-tight">
                                {displayName}
                              </span>
                              <span className="block text-[11px] text-textMuted truncate mt-0.5 leading-tight">
                                {result.is_live && result.game_name
                                  ? result.game_name
                                  : result.is_live
                                    ? 'Live'
                                    : login
                                }
                              </span>
                            </div>

                            {/* Add indicator */}
                            <div className="w-6 h-6 rounded-full flex items-center justify-center bg-transparent group-hover:bg-accent/15 transition-all duration-200 shrink-0">
                              <Plus size={13} className="text-textMuted group-hover:text-accent transition-colors" />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : !isSearching ? (
                    <div className="px-4 py-5 text-center">
                      <span className="text-xs text-textMuted">No channels found for "{searchInput}"</span>
                    </div>
                  ) : null}
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

            {/* Chat Toggle */}
          <Tooltip content={isChatHidden ? 'Show Chat' : 'Hide Chat'} delay={200} side="bottom">
            <button
              onClick={toggleChatHidden}
              className={`w-8 h-8 flex items-center justify-center transition-all duration-200 glass-button ${
                isChatHidden
                  ? 'text-textSecondary hover:text-white'
                  : 'text-red-400 hover:text-red-300'
              }`}
            >
              {isChatHidden ? <MessageSquare size={15} /> : <MessageSquareOff size={15} />}
            </button>
          </Tooltip>
          </div>

        </div>
      </div>
    </div>
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

export default MultiNookToolbar;

