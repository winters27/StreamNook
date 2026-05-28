// MultiChatWindow — top-level shell for a StreamNook MultiChat popout.
//
// Owns the channel list for this window: tabs along the top, "+" to add a
// channel by login, "×" on each tab to drop it. All channels stay
// reference-counted-acquired on the chatConnectionStore so switching tabs is
// lossless and instant; only the active tab is visible, but every tab's
// MultiChatPane stays mounted in the background to preserve drafts, scroll
// position, reply targets, and per-channel emote/badge caches.
//
// URL contract (set by openMultiChatWindow):
//   #/multichat?id=<windowId>&channel=<login>&channelId=<roomId>
//
// `id` keys the localStorage entry so the window restores its tab set across
// re-launches. `channel`+`channelId` seed the window when first opened from a
// "Pop out chat" action; once persisted state exists it takes precedence.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Minus, X, CornersOut, CornersIn, ArrowLineLeft } from 'phosphor-react';
import { Settings } from 'lucide-react';
import MultiChatPane from './MultiChatPane';
import ChatOnlySettingsModal from './ChatOnlySettingsModal';
import CommandPalette from '../CommandPalette';
import { useCommandPaletteHotkey } from '../../hooks/useCommandPaletteHotkey';
import { startSnippetSync } from '../../stores/snippetStore';
import { TooltipManager } from '../ui/TooltipManager';
import {
  acquireChannel,
  releaseChannel,
  useChannelMentionCount,
} from '../../stores/chatConnectionStore';
import { useAppStore } from '../../stores/AppStore';
import { listenForSettingsUpdates } from '../../utils/settingsBroadcast';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import type { TwitchStream } from '../../types';
import streamNookLogoUrl from '../../assets/streamnook-logo.png';

interface ChannelEntry {
  channel: string;
  channelId: string | null;
  /** Twitch display name (capitalization preserved as the user chose). Used
   *  for tab labels and the popout title bar. Falls back to `channel` if a
   *  lookup hasn't resolved yet — corrected on next refresh. */
  channelName: string;
}

/** Number of MultiChatPanes rendered simultaneously. `1` = tabs (single pane,
 *  active tab visible). 2/3/4 = side-by-side columns showing the first N
 *  channels in the list. Channels beyond N stay JOINed but aren't rendered. */
type LayoutMode = 1 | 2 | 3 | 4;

interface PersistedWindowState {
  channels: ChannelEntry[];
  layoutMode: LayoutMode;
}

interface ParsedMultiChatParams {
  id: string | null;
  channel: string | null;
  channelId: string | null;
  channelName: string | null;
}

function parseMultiChatParams(): ParsedMultiChatParams {
  const hash = window.location.hash;
  const queryIdx = hash.indexOf('?');
  if (queryIdx === -1) return { id: null, channel: null, channelId: null, channelName: null };
  const params = new URLSearchParams(hash.slice(queryIdx + 1));
  return {
    id: params.get('id'),
    channel: params.get('channel'),
    channelId: params.get('channelId'),
    channelName: params.get('channelName'),
  };
}

const STORAGE_PREFIX = 'streamnook.multichat.';

function storageKey(windowId: string | null): string | null {
  if (!windowId) return null;
  return `${STORAGE_PREFIX}${windowId}`;
}

function loadPersistedState(windowId: string | null): PersistedWindowState | null {
  const key = storageKey(windowId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Old format: just an array of channels. Newer format: { channels, layoutMode }.
    if (Array.isArray(parsed)) {
      return {
        channels: parsed.filter(
          (entry): entry is ChannelEntry =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as ChannelEntry).channel === 'string',
        ),
        layoutMode: 1,
      };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).channels)) {
      const mode = (parsed as any).layoutMode;
      const layoutMode: LayoutMode =
        mode === 2 || mode === 3 || mode === 4 ? mode : 1;
      return {
        channels: (parsed as any).channels.filter(
          (entry: unknown): entry is ChannelEntry =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as ChannelEntry).channel === 'string',
        ),
        layoutMode,
      };
    }
    return null;
  } catch (err) {
    Logger.warn('[MultiChatWindow] localStorage read failed:', err);
    return null;
  }
}

function persistState(
  windowId: string | null,
  channels: ChannelEntry[],
  layoutMode: LayoutMode,
) {
  const key = storageKey(windowId);
  if (!key) return;
  try {
    const payload: PersistedWindowState = { channels, layoutMode };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    Logger.warn('[MultiChatWindow] localStorage write failed:', err);
  }
}

async function closeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch (err) {
    Logger.error('[MultiChatWindow] close failed:', err);
  }
}

async function toggleMaximize(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const isMax = await win.isMaximized();
    if (isMax) await win.unmaximize();
    else await win.maximize();
  } catch (err) {
    Logger.error('[MultiChatWindow] maximize toggle failed:', err);
  }
}

async function minimizeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  } catch (err) {
    Logger.error('[MultiChatWindow] minimize failed:', err);
  }
}

export default function MultiChatWindow() {
  useCommandPaletteHotkey();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void startSnippetSync().then((u) => {
      if (cancelled) {
        u?.();
        return;
      }
      unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  const [params] = useState<ParsedMultiChatParams>(() => parseMultiChatParams());
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  // Badge picker / paint detail surfaces deliberately do NOT live here. Chat
  // badge clicks route through `utils/openBadgesInMain.ts`, which emits a
  // Tauri event picked up by main's tray bridge — main un-hides itself if
  // tray-hidden, focuses, and opens the overlay there. Keeps the popout slim
  // (chat-only surface) and avoids duplicating a heavy picker UI per window.

  // Initial channel list + layout: persisted state if any, else seeded from URL.
  const initial = useMemo(() => {
    const persisted = loadPersistedState(params.id);
    if (persisted && persisted.channels.length > 0) {
      return {
        channels: persisted.channels.map((c) => ({
          ...c,
          channelName: c.channelName || c.channel,
        })),
        layoutMode: persisted.layoutMode,
      };
    }
    if (params.channel) {
      const login = params.channel.toLowerCase();
      return {
        channels: [
          {
            channel: login,
            channelId: params.channelId,
            channelName: params.channelName || login,
          },
        ],
        layoutMode: 1 as LayoutMode,
      };
    }
    return { channels: [] as ChannelEntry[], layoutMode: 1 as LayoutMode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [channels, setChannels] = useState<ChannelEntry[]>(initial.channels);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(initial.layoutMode);

  const [activeChannel, setActiveChannel] = useState<string | null>(
    () => initial.channels[0]?.channel ?? null,
  );

  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // Each Tauri window has its own JS context, so the popout's AppStore boots
  // empty even when the main app is authenticated. Hydrate it on mount:
  //   - loadSettings pulls all user preferences from disk, including
  //     `chat_design` (font size/weight, spacing, dividers, timestamps,
  //     mention colors, mention animation, etc.). ChatMessage reads these
  //     directly via useAppStore, so loading them here gives the popout
  //     visual parity with the main app's chat without a separate settings
  //     surface.
  //   - checkAuthStatus pulls the cached user from the Rust-side token cache
  //     so the chat send input works without re-signing in.
  //   - loadFollowedStreams populates the live-following list (the add-
  //     channel dialog reads it for the quick-add panel).
  useEffect(() => {
    const store = useAppStore.getState();
    void store.loadSettings().catch((err) => {
      Logger.warn('[MultiChatWindow] loadSettings failed:', err);
    });
    void store.checkAuthStatus().catch((err) => {
      Logger.warn('[MultiChatWindow] checkAuthStatus failed:', err);
    });
    void store.loadFollowedStreams().catch((err) => {
      Logger.warn('[MultiChatWindow] loadFollowedStreams failed:', err);
    });

    // Refresh settings when ANY other window saves — keeps highlights, custom
    // commands, nicknames, etc. in sync across the main app and every open
    // MultiChat without needing a window reopen.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenForSettingsUpdates(() => {
      void useAppStore.getState().loadSettings();
    }).then((u) => {
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Persist whenever the channel list or layout changes.
  useEffect(() => {
    persistState(params.id, channels, layoutMode);
  }, [params.id, channels, layoutMode]);

  // Broadcast this popout's current channel set to the main window so it can
  // hide its own ChatWidget for channels we own — avoids duplicate chat
  // surfaces for the same channel. The Rust side handles the popout-closed
  // case by emitting `multichat-popout-closed` from on_window_event.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { emit } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const windowLabel = getCurrentWindow().label;
        if (cancelled) return;
        await emit('multichat-popout-channels', {
          windowLabel,
          channels: channels.map((c) => c.channel.toLowerCase()),
        });
      } catch (err) {
        Logger.warn('[MultiChatWindow] emit multichat-popout-channels failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channels]);

  // Acquire on add (and on initial mount), release on remove (and on unmount).
  // The "currently acquired set" mirrors `channels` exactly — diff that against
  // the previous render to figure out which to acquire and which to release.
  //
  // Naive release-all-then-acquire-all is wrong: useEffect cleanup runs BEFORE
  // the new effect body, so any channel present in BOTH the old and new lists
  // would briefly drop to refcount 0 on the chatConnectionStore AND on the
  // Rust IRC service. That triggers an IRC PART (and a WS teardown when this
  // window's slice map empties) followed by a JOIN — i.e. adding a new tab
  // would flash a disconnect on every existing tab, including the channel the
  // user was watching popped out from main. Per-channel cache loss + visible
  // chat reconnect = the user perceives it as being kicked out of the stream
  // they were watching. Diff against `acquiredKeysRef` so unchanged channels
  // keep their refcount steady.
  const acquiredKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(channels.map((c) => c.channel));
    for (const entry of channels) {
      if (!acquiredKeysRef.current.has(entry.channel)) {
        acquiredKeysRef.current.add(entry.channel);
        void acquireChannel(entry.channel, entry.channelId).catch((err) =>
          Logger.error('[MultiChatWindow] acquire failed:', err),
        );
      }
    }
    for (const key of Array.from(acquiredKeysRef.current)) {
      if (!current.has(key)) {
        acquiredKeysRef.current.delete(key);
        void releaseChannel(key).catch((err) =>
          Logger.warn('[MultiChatWindow] release failed:', err),
        );
      }
    }
  }, [channels]);

  // Release everything still held on unmount. The diffing effect above has no
  // cleanup of its own (it must not release on every `channels` change), so
  // window teardown needs its own release pass.
  useEffect(() => {
    return () => {
      for (const key of Array.from(acquiredKeysRef.current)) {
        void releaseChannel(key).catch((err) =>
          Logger.warn('[MultiChatWindow] release on unmount failed:', err),
        );
      }
      acquiredKeysRef.current.clear();
    };
  }, []);

  const addChannel = useCallback(
    async (rawLogin: string, providedDisplayName?: string) => {
      const login = rawLogin.trim().toLowerCase().replace(/^#/, '');
      if (!login) {
        setAddError('Channel name is required');
        return;
      }
      if (channels.some((c) => c.channel === login)) {
        setAddError(`#${login} is already open`);
        return;
      }
      setAddBusy(true);
      setAddError(null);
      try {
        // Resolve channel id (IRC room-id for optimistic sends) and the
        // broadcaster's display name so tabs render with proper capitalization.
        let channelId: string | null = null;
        let channelName = providedDisplayName ?? login;
        try {
          const info = await invoke<{ broadcaster_id?: string; broadcaster_name?: string }>(
            'get_channel_info',
            { channelName: login },
          );
          channelId = info?.broadcaster_id ?? null;
          if (info?.broadcaster_name) channelName = info.broadcaster_name;
        } catch (err) {
          Logger.warn(`[MultiChatWindow] get_channel_info failed for ${login}:`, err);
          // Still allow adding — chat JOINs and picks up room-id from the
          // first PRIVMSG/ROOMSTATE.
        }
        setChannels((prev) => [...prev, { channel: login, channelId, channelName }]);
        setActiveChannel(login);
        setAddInput('');
        setShowAdd(false);
      } finally {
        setAddBusy(false);
      }
    },
    [channels],
  );

  // Hand a channel back to the main app: emit the watch-channel-in-main event
  // so main starts watching the stream (and un-hides itself if tray-hidden).
  // Used both by the title-bar restore button and the per-tab "Watch in main
  // app" right-click action.
  const watchInMain = useCallback(async (entry: ChannelEntry) => {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('watch-channel-in-main', {
        channel: entry.channel,
        channelId: entry.channelId ?? undefined,
        channelName: entry.channelName,
      });
    } catch (err) {
      Logger.error('[MultiChatWindow] emit watch-channel-in-main failed:', err);
    }
  }, []);

  const removeChannel = useCallback((login: string) => {
    setChannels((prev) => {
      const next = prev.filter((c) => c.channel !== login);
      // If we removed the active tab, pick a neighbor.
      if (login === activeChannel) {
        const idx = prev.findIndex((c) => c.channel === login);
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        setActiveChannel(neighbor?.channel ?? null);
      }
      return next;
    });
  }, [activeChannel]);

  // Click a tab to focus it. In tabs mode that just switches the visible pane;
  // in split mode it also hoists the channel to position 0 so it lands in the
  // leftmost column.
  const selectChannel = useCallback(
    (login: string) => {
      setActiveChannel(login);
      if (layoutMode > 1) {
        setChannels((prev) => {
          const idx = prev.findIndex((c) => c.channel === login);
          if (idx <= 0) return prev;
          const next = [...prev];
          const [entry] = next.splice(idx, 1);
          next.unshift(entry);
          return next;
        });
      }
    },
    [layoutMode],
  );

  // Listen for `multichat-add-channel` events from main. Fired by
  // `openMultiChatWindow` when this popout already exists and the user
  // popped chat out from another stream — main focuses us and forwards the
  // channel here instead of spawning a second window. Dedup against the
  // current channel list (functional setter to avoid stale closure) and
  // either append + activate, or just activate if already a tab.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const u = await listen<{
          channel: string;
          channelId: string | null;
          channelName: string | null;
        }>('multichat-add-channel', (event) => {
          const login = (event.payload.channel || '').toLowerCase();
          if (!login) return;
          setChannels((prev) => {
            if (prev.some((c) => c.channel === login)) return prev;
            return [
              ...prev,
              {
                channel: login,
                channelId: event.payload.channelId ?? null,
                channelName: event.payload.channelName || login,
              },
            ];
          });
          setActiveChannel(login);
        });
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      } catch (err) {
        Logger.warn('[MultiChatWindow] listen multichat-add-channel failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Live 7TV emote-set updates pushed from the shared EventAPI socket in Rust.
  // This popout has its own per-window emote cache + chat store, so it applies
  // the change independently of the main window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { handleSeventvEmoteSetUpdate } = await import('../../services/seventvEventApi');
        const u = await listen<{
          channel: string;
          channel_id: string;
          actor_name: string;
          added: string[];
          removed: string[];
          renamed: { old: string; new: string }[];
        }>('7tv://emote-set-update', (event) => {
          void handleSeventvEmoteSetUpdate(event.payload);
        });
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      } catch (err) {
        Logger.warn('[MultiChatWindow] listen 7tv://emote-set-update failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Live 7TV cosmetics (paints/badges) for present users, delivered over the
  // same EventAPI socket. Re-resolves via GQL into this window's cosmetics cache.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { handleSeventvCosmeticUpdate } = await import('../../services/seventvEventApi');
        const u = await listen<{ twitch_id: string; action: string }>(
          '7tv://cosmetic-update',
          (event) => {
            void handleSeventvCosmeticUpdate(event.payload);
          },
        );
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
      } catch (err) {
        Logger.warn('[MultiChatWindow] listen 7tv://cosmetic-update failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Keyboard shortcuts scoped to this popout window. Tauri webviews don't
  // implement default browser behavior for these chords, so claiming them
  // doesn't fight the user agent:
  //   Ctrl+T            — open the Add Channel form
  //   Ctrl+W            — close the active tab (or the window if none)
  //   Ctrl+Tab          — cycle to the next tab
  //   Ctrl+Shift+Tab    — cycle to the previous tab
  //   Ctrl+1..9         — jump to tab N by index
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // Ignore shortcuts while typing in inputs / textareas / contenteditables,
      // except for Ctrl+Tab which is the most useful "I'm in the input and
      // want to switch tabs" case.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        if (e.key !== 'Tab') return;
      }

      if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        setShowAdd(true);
        setAddError(null);
        return;
      }
      if (e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (activeChannel) {
          removeChannel(activeChannel);
        } else {
          void closeWindow();
        }
        return;
      }
      if (e.key === 'Tab' && channels.length > 1) {
        e.preventDefault();
        const idx = channels.findIndex((c) => c.channel === activeChannel);
        const safeIdx = idx === -1 ? 0 : idx;
        const nextIdx = e.shiftKey
          ? (safeIdx - 1 + channels.length) % channels.length
          : (safeIdx + 1) % channels.length;
        selectChannel(channels[nextIdx].channel);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const targetIdx = parseInt(e.key, 10) - 1;
        const target = channels[targetIdx];
        if (target) {
          e.preventDefault();
          selectChannel(target.channel);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [channels, activeChannel, selectChannel, removeChannel]);

  // Channels currently rendered. Tabs mode = just the active one. Split mode =
  // first N from the list (channels beyond N stay JOINed in the background,
  // ready to swap in without re-JOINing).
  const visibleChannels = useMemo<ChannelEntry[]>(() => {
    if (layoutMode === 1) {
      const active = channels.find((c) => c.channel === activeChannel);
      return active ? [active] : [];
    }
    return channels.slice(0, layoutMode);
  }, [channels, activeChannel, layoutMode]);

  const visibleSet = useMemo(
    () => new Set(visibleChannels.map((c) => c.channel)),
    [visibleChannels],
  );

  // Title-bar heading. The logo handles the StreamNook brand visually, so the
  // text portion just identifies the surface / active channel:
  //   - empty window:   "MultiChat"
  //   - tabs mode:      the active channel's display name
  //   - split mode:     "MultiChat · N channels"
  const heading = useMemo(() => {
    if (channels.length === 0) return 'MultiChat';
    if (layoutMode > 1) {
      return `MultiChat · ${channels.length} channel${channels.length === 1 ? '' : 's'}`;
    }
    const active = channels.find((c) => c.channel === activeChannel);
    if (active) return active.channelName || active.channel;
    return 'MultiChat';
  }, [channels, activeChannel, layoutMode]);

  return (
    <div className="flex h-screen flex-col bg-background text-textPrimary">
      <TitleBar
        heading={heading}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        canSplit={channels.length > 0}
        // Restore is only meaningful when this popout owns exactly one channel
        // — otherwise we'd have to pick which one to hand back, which the user
        // didn't ask. For multi-channel popouts, per-tab right-click → "Watch
        // in main app" handles the more granular case.
        canRestore={channels.length === 1}
        onRestore={async () => {
          if (channels.length !== 1) return;
          await watchInMain(channels[0]);
          await closeWindow();
        }}
        onClose={closeWindow}
        onMinimize={minimizeWindow}
        onMaximize={toggleMaximize}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatOnlySettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TabStrip
        channels={channels}
        active={activeChannel}
        visibleSet={visibleSet}
        layoutMode={layoutMode}
        onSelect={selectChannel}
        onRemove={removeChannel}
        onWatchInMain={async (login) => {
          const entry = channels.find((c) => c.channel === login);
          if (!entry) return;
          await watchInMain(entry);
          // Drop the tab — main now owns this channel. Popout's auto-hide-main
          // event won't suppress main's chat anymore for it.
          removeChannel(login);
        }}
        onReorder={(source, target) => {
          setChannels((prev) => {
            const fromIdx = prev.findIndex((c) => c.channel === source);
            const toIdx = prev.findIndex((c) => c.channel === target);
            if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
            const next = [...prev];
            const [moved] = next.splice(fromIdx, 1);
            // Insert before the target's new index. After splicing the source
            // out, the target's index shifts left by 1 if source was earlier
            // in the list — compensate so the drop lands where the user
            // visually aimed.
            const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
            next.splice(insertAt, 0, moved);
            return next;
          });
        }}
        onAddClick={() => {
          setShowAdd(true);
          setAddError(null);
        }}
      />
      {showAdd && (
        <AddChannelPanel
          value={addInput}
          onChange={setAddInput}
          onCancel={() => {
            setShowAdd(false);
            setAddInput('');
            setAddError(null);
          }}
          onSubmit={() => void addChannel(addInput)}
          onSelectStream={(stream) =>
            void addChannel(stream.user_login, stream.user_name)
          }
          alreadyAdded={channels.map((c) => c.channel)}
          error={addError}
          busy={addBusy}
        />
      )}
      <div className="relative flex min-h-0 flex-1">
        {channels.length === 0 ? (
          <EmptyState onAddClick={() => setShowAdd(true)} />
        ) : visibleChannels.length === 0 ? null : (
          // Render the visible channels side-by-side. Tabs mode renders one;
          // split modes render 2–4 columns. Inactive/hidden channels stay
          // reference-counted-acquired on the chatConnectionStore (via the
          // window-level effect above) so their messages keep flowing in the
          // background; switching tabs swaps which channel renders without
          // re-JOINing IRC.
          visibleChannels.map((entry, idx) => (
            <div
              key={entry.channel}
              className={`min-w-0 flex-1 ${idx > 0 ? 'border-l border-borderSubtle' : ''}`}
            >
              <MultiChatPane
                channel={entry.channel}
                channelId={entry.channelId}
                channelName={entry.channelName}
              />
            </div>
          ))
        )}
      </div>

      {/* Tooltips render via portal to document.body, but they need a
          TooltipManager instance mounted in *this* window's React tree to
          observe the (window-local) TooltipStore. Without this mount,
          hovering a chat badge or any other tooltip-bearing element in the
          popout produces no UI. */}
      <TooltipManager />
      <CommandPalette />
    </div>
  );
}

// ---------- TitleBar ---------------------------------------------------------

interface TitleBarProps {
  heading: string;
  layoutMode: LayoutMode;
  canSplit: boolean;
  canRestore: boolean;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onRestore: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onOpenSettings: () => void;
}

function TitleBar({
  heading,
  layoutMode,
  canSplit,
  canRestore,
  onLayoutModeChange,
  onRestore,
  onClose,
  onMinimize,
  onMaximize,
  onOpenSettings,
}: TitleBarProps) {
  // Track maximized state so the corner-control icon swaps between
  // CornersOut (maximize) and CornersIn (restore) — same behavior as
  // the main app's TitleBar.
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    let unlistenResize: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const maximized = await win.isMaximized();
        if (!cancelled) setIsMaximized(maximized);
        const unlisten = await win.onResized(async () => {
          if (cancelled) return;
          setIsMaximized(await win.isMaximized());
        });
        unlistenResize = unlisten;
      } catch (err) {
        Logger.warn('[MultiChatWindow] isMaximized tracking failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlistenResize) unlistenResize();
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="relative z-50 flex h-[33px] select-none items-center justify-between border-b border-borderSubtle bg-secondary px-3 backdrop-blur-md"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex flex-shrink-0 items-center gap-2"
      >
        <img
          src={streamNookLogoUrl}
          alt="StreamNook"
          className="h-4 w-4 object-contain"
          draggable={false}
        />
        <span className="truncate text-xs font-semibold tracking-wide text-textSecondary">
          {heading}
        </span>
      </div>

      <div data-tauri-drag-region className="pointer-events-none flex-1" />

      {canSplit && (
        <div
          className="mr-2 flex items-center gap-0.5 rounded bg-tertiary/60 p-0.5"
          data-tauri-drag-region="false"
        >
          <LayoutToggleButton
            label="Tabs"
            active={layoutMode === 1}
            onClick={() => onLayoutModeChange(1)}
          >
            <LayoutIcon mode={1} />
          </LayoutToggleButton>
          <LayoutToggleButton
            label="2 columns"
            active={layoutMode === 2}
            onClick={() => onLayoutModeChange(2)}
          >
            <LayoutIcon mode={2} />
          </LayoutToggleButton>
          <LayoutToggleButton
            label="3 columns"
            active={layoutMode === 3}
            onClick={() => onLayoutModeChange(3)}
          >
            <LayoutIcon mode={3} />
          </LayoutToggleButton>
          <LayoutToggleButton
            label="4 columns"
            active={layoutMode === 4}
            onClick={() => onLayoutModeChange(4)}
          >
            <LayoutIcon mode={4} />
          </LayoutToggleButton>
        </div>
      )}

      <div className="flex space-x-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {canRestore && (
          <Tooltip content="Restore to main app" delay={200}>
            <button
              type="button"
              onClick={onRestore}
              data-tauri-drag-region="false"
              className="p-1.5 text-textSecondary hover:text-accent rounded transition-all duration-200"
            >
              <ArrowLineLeft size={16} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Chat settings" delay={200}>
          <button
            type="button"
            onClick={onOpenSettings}
            data-tauri-drag-region="false"
            className="settings-gear-btn p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
          >
            <Settings size={16} />
          </button>
        </Tooltip>
        <Tooltip content="Minimize" delay={200}>
          <button
            type="button"
            onClick={onMinimize}
            data-tauri-drag-region="false"
            className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
          >
            <Minus size={16} />
          </button>
        </Tooltip>
        <Tooltip content={isMaximized ? 'Restore' : 'Maximize'} delay={200}>
          <button
            type="button"
            onClick={onMaximize}
            data-tauri-drag-region="false"
            className="p-1.5 text-textSecondary hover:text-textPrimary rounded transition-all duration-200"
          >
            {isMaximized ? <CornersIn size={16} /> : <CornersOut size={16} />}
          </button>
        </Tooltip>
        <Tooltip content="Close" delay={200}>
          <button
            type="button"
            onClick={onClose}
            data-tauri-drag-region="false"
            className="p-1.5 text-textSecondary hover:text-red-400 rounded transition-all duration-200"
          >
            <X size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------- Layout toggle ---------------------------------------------------

interface LayoutToggleButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function LayoutToggleButton({ label, active, onClick, children }: LayoutToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-tauri-drag-region="false"
      className={`grid h-5 w-6 place-items-center rounded transition-colors ${
        active
          ? 'bg-surface text-accent shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]'
          : 'text-textMuted hover:text-textPrimary'
      }`}
    >
      {children}
    </button>
  );
}

// Tiny icon glyph showing the column geometry for the toggle. Each variant is
// a 12x10 rectangle subdivided into N equal columns.
function LayoutIcon({ mode }: { mode: LayoutMode }) {
  const cols = mode;
  const width = 12;
  const height = 10;
  const colWidth = width / cols;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
      <rect x="0.5" y="0.5" width={width - 1} height={height - 1} stroke="currentColor" strokeWidth="1" />
      {Array.from({ length: cols - 1 }, (_, i) => (
        <line
          key={i}
          x1={(i + 1) * colWidth}
          y1="0.5"
          x2={(i + 1) * colWidth}
          y2={height - 0.5}
          stroke="currentColor"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

// ---------- TabStrip --------------------------------------------------------

interface TabStripProps {
  channels: ChannelEntry[];
  active: string | null;
  visibleSet: Set<string>;
  layoutMode: LayoutMode;
  onSelect: (channel: string) => void;
  onRemove: (channel: string) => void;
  onWatchInMain: (channel: string) => void;
  onReorder: (sourceChannel: string, targetChannel: string) => void;
  onAddClick: () => void;
}

interface TabContextMenuState {
  channel: string;
  x: number;
  y: number;
}

// Tab strip mirrors `MultiNookChatSwitcher`'s glass-button / glass-input
// pattern so the popout's channel switcher looks and feels identical to the
// in-app MultiNook switcher. Active tab: `glass-input` + accent text;
// inactive: `glass-button` + secondary text → primary on hover.
function TabStrip({
  channels,
  active,
  visibleSet,
  layoutMode,
  onSelect,
  onRemove,
  onWatchInMain,
  onReorder,
  onAddClick,
}: TabStripProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenuState | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Close the context menu on outside click / Escape — matches the pattern
  // used by StreamContextMenu in the main app.
  useEffect(() => {
    if (!contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextMenu]);

  return (
    <div className="flex flex-shrink-0 items-center gap-2 overflow-x-auto scrollbar-thin border-b border-borderSubtle bg-glass/30 px-3 py-2 shadow-sm backdrop-blur-sm">
      <div className="flex min-w-max items-center gap-1.5">
        {channels.map((c) => {
          // In tabs mode the single active tab is highlighted; in split mode
          // every channel currently rendered as a column shows as active so
          // the strip mirrors which channels are visible.
          const isActive =
            layoutMode === 1 ? c.channel === active : visibleSet.has(c.channel);
          // In split mode all visible tabs are "seen" continuously; in tabs
          // mode only the active tab is seen.
          const isVisible = layoutMode === 1 ? isActive : visibleSet.has(c.channel);
          return (
            <TabButton
              key={c.channel}
              entry={c}
              isActive={isActive}
              isVisible={isVisible}
              isDragOver={dragOver === c.channel}
              onSelect={() => onSelect(c.channel)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ channel: c.channel, x: e.clientX, y: e.clientY });
              }}
              onRemove={() => onRemove(c.channel)}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/multichat-tab', c.channel);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/multichat-tab')) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOver(c.channel);
                }
              }}
              onDragLeave={() => {
                setDragOver((prev) => (prev === c.channel ? null : prev));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const source = e.dataTransfer.getData('application/multichat-tab');
                setDragOver(null);
                if (source && source !== c.channel) onReorder(source, c.channel);
              }}
            />
          );
        })}
        <button
          type="button"
          onClick={onAddClick}
          aria-label="Add channel"
          className="glass-button flex h-7 w-7 items-center justify-center text-textSecondary transition-all duration-200 hover:text-accent"
          style={{ borderRadius: '8px' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="6" y1="2" x2="6" y2="10" />
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
      </div>

      {contextMenu && (
        <TabContextMenu
          state={contextMenu}
          channelName={
            channels.find((c) => c.channel === contextMenu.channel)?.channelName ||
            contextMenu.channel
          }
          onClose={() => setContextMenu(null)}
          onWatchInMain={() => {
            onWatchInMain(contextMenu.channel);
            setContextMenu(null);
          }}
          onRemove={() => {
            onRemove(contextMenu.channel);
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- TabButton -------------------------------------------------------

interface TabButtonProps {
  entry: ChannelEntry;
  isActive: boolean;
  isVisible: boolean;
  isDragOver: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

// Per-tab presentation. Owns its own "last seen mention count" so the unread
// badge lights up only when the signed-in user is @-mentioned in a tab that
// isn't currently visible (tabs mode: not the active tab; split mode: not a
// rendered column). Generic "new message" activity is intentionally not
// surfaced — too noisy for chats with high volume.
function TabButton({
  entry,
  isActive,
  isVisible,
  isDragOver,
  onSelect,
  onContextMenu,
  onRemove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: TabButtonProps) {
  const currentUserLogin = useAppStore((s) => s.currentUser?.login ?? null);
  const mentionCount = useChannelMentionCount(entry.channel, currentUserLogin);
  // Initialize lastSeen at the current mention count when this tab first
  // mounts so historical mentions in IVR backfill don't trigger the badge on
  // tab creation. Mentions after creation count toward unread until the tab
  // becomes visible (active in tabs mode, or rendered in split mode).
  const [lastSeen, setLastSeen] = useState(mentionCount);

  useEffect(() => {
    if (isVisible) setLastSeen(mentionCount);
  }, [isVisible, mentionCount]);

  const unread = Math.max(0, mentionCount - lastSeen);
  const unreadLabel = unread > 99 ? '99+' : String(unread);

  return (
    <div
      className={`group relative transition-opacity ${
        isDragOver ? 'opacity-60' : ''
      }`}
      // Drop target only — drag-source role is on the inner <button> below.
      // Splitting them avoids the interactive-element quirk where mousedown
      // on a button is treated as click intent instead of starting a drag.
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        draggable
        onDragStart={onDragStart}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold tracking-wide transition-all duration-200 ${
          isActive
            ? 'glass-input text-accent font-extrabold'
            : 'glass-button text-textSecondary hover:text-textPrimary'
        }`}
        style={{ borderRadius: '8px', userSelect: 'none' }}
        title={entry.channelName || entry.channel}
      >
        <span className="truncate">{entry.channelName || entry.channel}</span>
        {unread > 0 && !isVisible && (
          <span
            className="grid h-4 min-w-[1rem] place-items-center rounded-full bg-accent px-1.5 text-[10px] font-bold leading-none text-background"
            aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
          >
            {unreadLabel}
          </span>
        )}
        <span
          role="button"
          aria-label={`Remove ${entry.channel}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="grid h-3.5 w-3.5 place-items-center rounded-full text-textMuted opacity-0 transition-all hover:bg-error/20 hover:text-error group-hover:opacity-100"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="1.5" y1="1.5" x2="6.5" y2="6.5" />
            <line x1="6.5" y1="1.5" x2="1.5" y2="6.5" />
          </svg>
        </span>
      </button>
      {isDragOver && (
        <span
          className="pointer-events-none absolute inset-y-0 -left-1 w-0.5 rounded-full bg-accent"
          aria-hidden
        />
      )}
    </div>
  );
}

// ---------- TabContextMenu --------------------------------------------------

interface TabContextMenuProps {
  state: TabContextMenuState;
  channelName: string;
  onClose: () => void;
  onWatchInMain: () => void;
  onRemove: () => void;
}

function TabContextMenu({
  state,
  channelName,
  onClose,
  onWatchInMain,
  onRemove,
}: TabContextMenuProps) {
  // Clamp position to viewport so the menu never opens partially off-screen
  // (matches StreamContextMenu's collision-detection pattern).
  const MENU_WIDTH = 200;
  const MENU_HEIGHT = 90;
  let x = state.x;
  let y = state.y;
  if (x + MENU_WIDTH > window.innerWidth) x = window.innerWidth - MENU_WIDTH - 4;
  if (y + MENU_HEIGHT > window.innerHeight) y = window.innerHeight - MENU_HEIGHT - 4;
  x = Math.max(4, x);
  y = Math.max(4, y);

  // Portal to document.body so the menu escapes the tab-strip's stacking
  // context. Without this, `z-[…]` is local to the strip's stacking context
  // and the menu can render UNDER taller-stack elements in sibling regions
  // (chat header, send input, etc.). Portaling lifts it to the document's
  // top stacking context where z-[9999] actually sits above everything.
  return createPortal(
    <div
      className="fixed inset-0 z-[9999] cursor-default"
      onPointerDown={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="absolute w-48 glass-panel rounded-xl flex flex-col p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        style={{ top: y, left: x }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-borderSubtle mb-1 text-[10px] uppercase tracking-wider text-textMuted">
          {channelName}
        </div>
        <button
          type="button"
          onClick={onWatchInMain}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-accent hover:bg-glass-hover transition-all"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="6 4 12 8 6 12 6 4" fill="currentColor" />
          </svg>
          <span>Watch in main app</span>
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-textSecondary hover:text-error hover:bg-glass-hover transition-all"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
          <span>Close tab</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------- AddChannelPanel -------------------------------------------------
//
// Rich add-channel surface: live followed channels listed first (quick-add by
// click), with a search input that both filters the followed list AND lets
// the user add any arbitrary channel via Enter — even ones they don't follow
// or that aren't live.

interface AddChannelPanelProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onSelectStream: (stream: TwitchStream) => void;
  alreadyAdded: string[];
  error: string | null;
  busy: boolean;
}

function AddChannelPanel({
  value,
  onChange,
  onSubmit,
  onCancel,
  onSelectStream,
  alreadyAdded,
  error,
  busy,
}: AddChannelPanelProps) {
  const followedStreams = useAppStore((s) => s.followedStreams);

  // Profile images from Helix `/users` — `get_followed_streams` doesn't
  // include `profile_image_url`, so we batch-fetch by user id and cache here.
  // Matches the pattern in Sidebar.tsx.
  const [profileImages, setProfileImages] = useState<Map<string, string>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const needed = followedStreams
      .map((s) => s.user_id)
      .filter(
        (id) =>
          !!id &&
          !profileImages.has(id) &&
          !inflightRef.current.has(id),
      );
    if (needed.length === 0) return;
    const unique = Array.from(new Set(needed));
    unique.forEach((id) => inflightRef.current.add(id));

    (async () => {
      try {
        const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
        for (let i = 0; i < unique.length; i += 100) {
          const batch = unique.slice(i, i + 100);
          const query = batch.map((id) => `id=${encodeURIComponent(id)}`).join('&');
          const resp = await fetch(`https://api.twitch.tv/helix/users?${query}`, {
            headers: {
              'Client-ID': clientId,
              Authorization: `Bearer ${token}`,
            },
          });
          if (!resp.ok) continue;
          const data = (await resp.json()) as {
            data?: Array<{ id: string; profile_image_url: string }>;
          };
          if (data.data && Array.isArray(data.data)) {
            setProfileImages((prev) => {
              const next = new Map(prev);
              for (const u of data.data!) {
                if (u.profile_image_url) next.set(u.id, u.profile_image_url);
              }
              return next;
            });
          }
        }
      } catch (err) {
        Logger.warn('[AddChannelPanel] profile image batch fetch failed:', err);
      } finally {
        unique.forEach((id) => inflightRef.current.delete(id));
      }
    })();
    // profileImages intentionally not in deps — the Set guards against
    // re-fetching ids we already have, and we don't want the effect to loop
    // when setProfileImages updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followedStreams]);

  const query = value.trim().toLowerCase();
  const alreadyAddedSet = useMemo(() => new Set(alreadyAdded), [alreadyAdded]);
  const filtered = useMemo(() => {
    if (!query) return followedStreams;
    return followedStreams.filter((s) => {
      const login = s.user_login.toLowerCase();
      const name = (s.user_name || '').toLowerCase();
      return login.includes(query) || name.includes(query);
    });
  }, [followedStreams, query]);

  const exactFollowedMatch = useMemo(() => {
    if (!query) return null;
    return followedStreams.find((s) => s.user_login.toLowerCase() === query) ?? null;
  }, [followedStreams, query]);

  // Show the "add arbitrary channel" affordance whenever there's a query that
  // doesn't exactly match a followed channel — covers both unfollowed streams
  // and offline channels.
  const showArbitraryAdd = !!query && !exactFollowedMatch;

  return (
    <div className="flex max-h-[60%] flex-col border-b border-borderSubtle bg-secondary/40 backdrop-blur-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit();
            else if (e.key === 'Escape') onCancel();
          }}
          disabled={busy}
          placeholder="Search your live following, or type any channel name"
          className="flex-1 rounded-md border border-borderSubtle bg-background px-3 py-1.5 text-xs text-textPrimary placeholder:text-textMuted focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="glass-button px-2.5 py-1.5 text-xs text-textSecondary transition-colors hover:text-textPrimary"
          style={{ borderRadius: '8px' }}
        >
          Cancel
        </button>
      </div>

      {error && <div className="px-3 pb-1.5 text-[11px] text-error">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-1 pb-2">
        {filtered.length === 0 && !showArbitraryAdd && (
          <div className="px-3 py-4 text-center text-[11px] text-textMuted">
            {followedStreams.length === 0
              ? 'No live channels in your following right now. Type a channel name and press Enter.'
              : `No follows match "${query}". Press Enter to add anyway.`}
          </div>
        )}

        {filtered.map((stream) => {
          const isAdded = alreadyAddedSet.has(stream.user_login.toLowerCase());
          return (
            <button
              key={stream.user_id || stream.user_login}
              type="button"
              disabled={busy || isAdded}
              onClick={() => onSelectStream(stream)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                isAdded
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:bg-surface-hover'
              }`}
            >
              <StreamerAvatar
                stream={stream}
                profileImageUrl={
                  stream.profile_image_url || profileImages.get(stream.user_id) || null
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-textPrimary">
                    {stream.user_name || stream.user_login}
                  </span>
                  {isAdded && (
                    <span className="rounded bg-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-textMuted">
                      Added
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-textSecondary">
                  {stream.game_name || 'Just chatting'}
                  {typeof stream.viewer_count === 'number' && (
                    <span className="ml-2 text-textMuted">
                      · {stream.viewer_count.toLocaleString()} viewers
                    </span>
                  )}
                </div>
              </div>
              <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-error">
                <span className="h-1.5 w-1.5 rounded-full bg-error animate-pulse" />
                Live
              </span>
            </button>
          );
        })}

        {showArbitraryAdd && (
          <button
            type="button"
            disabled={busy}
            onClick={onSubmit}
            className="mt-1 flex w-full items-center gap-3 rounded-md border border-dashed border-borderSubtle px-3 py-2 text-left transition-colors hover:bg-surface-hover hover:border-accent"
          >
            <div className="grid h-9 w-9 place-items-center rounded-full bg-surface text-textMuted">
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="2" x2="6" y2="10" />
                <line x1="2" y1="6" x2="10" y2="6" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-textPrimary">
                Add #{query}
              </div>
              <div className="truncate text-[11px] text-textSecondary">
                Open chat for this channel even if they're not in your following or not live.
              </div>
            </div>
          </button>
        )}
      </div>
    </div>
  );
}

// Renders the streamer's actual Twitch profile picture. NEVER falls back to
// `stream.thumbnail_url` (that's the live stream preview image, not a profile
// avatar). When the Helix batch fetch hasn't resolved yet — or the streamer
// has no profile image — we render an initial-letter placeholder over a
// muted surface tone instead.
function StreamerAvatar({
  stream,
  profileImageUrl,
}: {
  stream: TwitchStream;
  profileImageUrl: string | null;
}) {
  if (profileImageUrl) {
    return (
      <img
        src={profileImageUrl}
        alt=""
        className="h-9 w-9 rounded-full bg-surface object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
    );
  }
  return (
    <div className="grid h-9 w-9 place-items-center rounded-full bg-surface text-xs font-semibold text-textMuted">
      {(stream.user_login || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

// ---------- EmptyState ------------------------------------------------------

function EmptyState({ onAddClick }: { onAddClick: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-sm font-semibold text-textPrimary">No channels open</div>
      <div className="max-w-[260px] px-6 text-xs leading-relaxed text-textMuted">
        Add a channel to start watching its chat. Each window can hold multiple channels — tabs
        across the top let you flip between them.
      </div>
      <button
        type="button"
        onClick={onAddClick}
        className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-background transition-colors hover:bg-accent-hover"
      >
        Add a channel
      </button>
    </div>
  );
}
