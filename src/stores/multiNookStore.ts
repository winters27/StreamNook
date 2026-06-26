import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './AppStore';
import { MultiNookSlot, MultiNookPresetChannel } from '../types';
import { Logger } from '../utils/logger';

/** Slot ids whose proxy start is currently in flight. The loader effect re-fires
 *  on every slots change, so this guards against re-invoking start_multi_nook for
 *  a tile that's already starting (which would otherwise re-attempt a slow/offline
 *  stream on each sibling that resolves). */
const inFlightStarts = new Set<string>();

/** True if `activeId` still matches one of the current slots (by channel id or
 *  login — the chat switcher stores either form). */
function isActiveChatValid(slots: MultiNookSlot[], activeId: string | null): boolean {
  if (!activeId) return false;
  return slots.some((s) => s.channelId === activeId || s.channelLogin === activeId);
}

/** Pick which chat to select: the focused (non-minimized) slot, else the first
 *  visible slot, else the first slot. Returns its channel id, or login when the
 *  id hasn't resolved yet (ChatWidget matches either). null only when empty. */
function pickActiveChatChannel(slots: MultiNookSlot[]): string | null {
  if (slots.length === 0) return null;
  const visible = slots.filter((s) => !s.isMinimized);
  const pool = visible.length > 0 ? visible : slots;
  const choice = pool.find((s) => s.isFocused) ?? pool[0];
  return choice?.channelId ?? choice?.channelLogin ?? null;
}

export const broadcastMultiNookPresence = (slots: MultiNookSlot[]) => {
  const allSlots = slots;
  
  if (allSlots.length === 0) return;

  // Determine majority game category
  const gameCounts: Record<string, number> = {};
  let maxGame = '';
  let maxCount = 0;
  
  for (const slot of allSlots) {
    if (slot.gameName && slot.gameName.trim() !== '') {
      gameCounts[slot.gameName] = (gameCounts[slot.gameName] || 0) + 1;
      if (gameCounts[slot.gameName] > maxCount) {
        maxCount = gameCounts[slot.gameName];
        maxGame = slot.gameName;
      }
    }
  }

  // Deterministic randomize phrasing based on channel names length
  const phraseHash = allSlots.reduce((acc, s) => acc + s.channelLogin.length, 0);
  
  const phrases = [
    `Watching ${allSlots.length} Streams`,
    `Multi-POV: ${allSlots.length} Streams`,
    `MultiNook \u2014 ${allSlots.length} Streams`
  ];
  const detailsPhrase = phrases[phraseHash % phrases.length];

  const details = allSlots.length === 1
    ? `Watching ${allSlots[0].channelName || allSlots[0].channelLogin}`
    : detailsPhrase;

  // Deterministic randomize separator
  const separators = [', ', ' \u00B7 ', ' | '];
  const separator = separators[(phraseHash + 1) % separators.length];

  let streamerNames = allSlots
    .map(s => s.channelName || s.channelLogin)
    .join(separator);
  
  if (streamerNames.length > 120) {
    streamerNames = streamerNames.substring(0, 110) + `... +${allSlots.length} more`; // Ensure it fits Discord's 128 char limit
  }

  const activityState = allSlots.length === 1
    ? 'MultiNook'
    : streamerNames;

  const presenceArgs = {
    details,
    activityState,
    largeImage: '', // Will be resolved by rust backend based on gameName
    smallImage: '',
    startTime: Date.now(),
    gameName: maxGame,
    streamUrl: 'https://streamnook.app',
  };

  // Discord (gated by settings toggle)
  const settings = useAppStore.getState().settings;
  if (settings?.discord_rpc_enabled) {
    invoke('update_discord_presence', presenceArgs).catch(() => {});
  }
};


interface MultiNookState {
  isMultiNookActive: boolean;
  isChatHidden: boolean;
  activeChatChannelId: string | null;
  /** Id of the preset the current grid was loaded from, or null. Drives the
   *  toolbar's "equipped preset" icon and the Stop action. Persisted with slots. */
  activePresetId: string | null;
  /** Id of the slot currently filling the whole grid area (solo-like), or null.
   *  Ephemeral view state: never persisted, always cleared on exit/teardown. The
   *  maximized tile is restyled in place (no remount) so its HLS player keeps
   *  running; the other tiles stay mounted but hidden behind it. */
  maximizedSlotId: string | null;
  slots: MultiNookSlot[];
  flyingAnimation: { x: number; y: number; id: number } | null;
  suckUpLogin: string | null;
  recallAnimation: { sourceX: number; sourceY: number; targetX: number; targetY: number; id: number } | null;
  materializingLogin: string | null;
  
  // Actions
  toggleMultiNook: () => void;
  triggerAddAnimation: (x: number, y: number, channelLogin: string) => void;
  triggerRecallAnimation: (channelLogin: string, cardX: number, cardY: number) => void;
  addSlot: (channelLogin: string) => Promise<void>;
  removeSlot: (id: string) => Promise<void>;
  removeSlotByLogin: (channelLogin: string) => Promise<void>;
  updateSlot: (id: string, updates: Partial<MultiNookSlot>) => void;
  changeSlotQuality: (id: string, quality: string) => Promise<void>;
  retrySlot: (id: string) => void;
  reorderSlots: (newSlots: MultiNookSlot[]) => void;
  toggleFocusSlot: (id: string) => void;
  /** Toggle a tile filling the whole grid area. Maximizing also focuses the tile
   *  (takes over audio + chat) so it behaves like the solo player. Passing the
   *  already-maximized id, or any id while it is maximized, restores the grid. */
  toggleMaximizeSlot: (id: string) => void;
  /** Directly set (or clear with null) the maximized tile. Used by Esc / teardown. */
  setMaximizedSlot: (id: string | null) => void;
  dockSlot: (id: string) => void;
  undockSlot: (id: string) => void;
  swapDockedSlot: (id: string) => void;
  setActiveChatChannelId: (id: string | null) => void;
  toggleChatHidden: () => void;
  batchLoadMissingStreams: () => Promise<void>;
  loadPresetChannels: (channels: MultiNookPresetChannel[], mode: 'replace' | 'append', presetId?: string) => Promise<void>;
  /** Tag the current grid with the preset it was loaded from (null = no equipped preset). Persisted. */
  setActivePresetId: (id: string | null) => Promise<void>;
  /** Stop and tear down every tile, leaving an empty grid (used by "Stop preset"). Stays in MultiNook. */
  clearAllSlots: () => Promise<void>;
  
  // Synchronization
  resyncAllSlots: () => void;
  
  // Persistence
  loadStoredSlots: () => void;
  saveSlots: () => Promise<void>;
}

export const usemultiNookStore = create<MultiNookState>((set, get) => ({
  isMultiNookActive: false,
  isChatHidden: false,
  activeChatChannelId: null,
  activePresetId: null,
  maximizedSlotId: null,
  slots: [],
  flyingAnimation: null,
  suckUpLogin: null,
  recallAnimation: null,
  materializingLogin: null,

  batchLoadMissingStreams: async () => {
    const slots = get().slots;
    // Skip tiles already loaded, already flagged offline, or with a start in flight.
    const missing = slots.filter((s) => !s.streamUrl && !s.loadError && !inFlightStarts.has(s.id));
    if (missing.length === 0) return;

    missing.forEach((s) => inFlightStarts.add(s.id));

    // Start each proxy independently and apply its result the moment it lands, so a
    // single offline/unreachable stream can't hold up the rest of the grid. The
    // post-load buffer stall this used to cause was NOT a contention problem (no
    // stagger needed): the MultiNook relay wasn't rewriting Twitch's over-declared
    // playlist targetduration, so hls.js under-polled and the buffer drained. That
    // is fixed in the relay (multi_nook_server retarget_playlist), so tiles can
    // cold-start together again.
    await Promise.all(
      missing.map(async (slot) => {
        try {
          const url = await invoke<string>('start_multi_nook', {
            streamId: slot.id,
            url: `https://twitch.tv/${slot.channelLogin}`,
            quality: slot.quality || 'best', // Per-tile quality (set via the focused tile's gear menu)
          });
          set((state) => ({
            slots: state.slots.map((s) => (s.id === slot.id ? { ...s, streamUrl: url, loadError: false } : s)),
          }));
        } catch (err) {
          Logger.error(`Failed to start multi-nook proxy for ${slot.channelLogin}:`, err);
          // Flag the tile offline so it shows the friendly overlay and the loader
          // stops re-attempting it (retry is user-driven via retrySlot / resync).
          set((state) => ({
            slots: state.slots.map((s) => (s.id === slot.id ? { ...s, loadError: true } : s)),
          }));
        } finally {
          inFlightStarts.delete(slot.id);
        }
      }),
    );
  },

  loadPresetChannels: async (channels, mode, presetId) => {
    // Drop duplicate logins inside the preset itself, preserving order.
    const seen = new Set<string>();
    const unique = channels.filter((ch) => {
      const key = ch.channelLogin.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (mode === 'append') {
      // Reuse the single-add path so dedup-against-grid, the 25 cap, proxy start,
      // and fresh Twitch metadata enrichment all behave exactly like a manual add.
      for (const ch of unique) {
        await get().addSlot(ch.channelLogin);
      }
      return;
    }

    // --- replace mode ---
    // Tear down every live proxy/HLS for the outgoing grid BEFORE swapping slots so
    // nothing is left running (no orphaned proxies = no leak from loading presets).
    const outgoing = get().slots;
    try {
      await invoke('stop_all_multi_nooks');
    } catch (e) {
      Logger.error('[MultiNook] Failed to stop proxies before loading preset', e);
    }
    for (const slot of outgoing) {
      if (slot.channelId) {
        invoke('unregister_active_channel', { channelId: slot.channelId }).catch(() => {});
      }
    }

    const MAX_SLOTS = 25;
    const capped = unique.slice(0, MAX_SLOTS);
    if (unique.length > MAX_SLOTS) {
      useAppStore.getState().addToast(
        `Preset has ${unique.length} channels; loaded the first ${MAX_SLOTS}`,
        'info',
      );
    }

    // Build fresh slots from the preset's cached metadata, with no per-channel Twitch
    // round-trip, so a preset opens instantly. First tile is focused/unmuted; the
    // rest start muted, matching how a normal grid fills in.
    const base = Date.now();
    const newSlots: MultiNookSlot[] = capped.map((ch, i) => ({
      id: `cell-${base}-${i}`,
      channelLogin: ch.channelLogin,
      channelId: ch.channelId || undefined,
      channelName: ch.channelName || ch.channelLogin,
      profileImageUrl: ch.profileImageUrl || undefined,
      quality: ch.quality || undefined,
      volume: 0.5,
      muted: i > 0,
      isFocused: i === 0,
    }));

    // streamUrl is intentionally left undefined: MultiNookView's missing-stream
    // loader picks these up and concurrently starts the proxies on the next frame.
    // Tag the grid with the preset it came from (replace mode = the grid IS this preset).
    set({ slots: newSlots, activeChatChannelId: pickActiveChatChannel(newSlots), activePresetId: presetId ?? null, maximizedSlotId: null });

    for (const slot of newSlots) {
      if (slot.channelId) {
        invoke('register_active_channel', { channelId: slot.channelId }).catch(() => {});
      }
    }

    if (newSlots.length > 0) {
      broadcastMultiNookPresence(newSlots);
    }
    await get().saveSlots();
  },

  setActivePresetId: async (id: string | null) => {
    if (get().activePresetId === id) return;
    set({ activePresetId: id });
    await get().saveSlots();
  },

  clearAllSlots: async () => {
    // Stop every live proxy/HLS and drop the grid, but stay in MultiNook (empty
    // grid). Used by "Stop preset": closes out everything the preset opened
    // without deleting the preset, and clears the equipped-preset tag.
    const current = get().slots;
    try {
      await invoke('stop_all_multi_nooks');
    } catch (e) {
      Logger.error('[MultiNook] Failed to stop proxies on clearAllSlots', e);
    }
    for (const slot of current) {
      if (slot.channelId) {
        invoke('unregister_active_channel', { channelId: slot.channelId }).catch(() => {});
      }
    }
    set({ slots: [], activeChatChannelId: null, activePresetId: null, maximizedSlotId: null });

    // Revert presence to idle since nothing is playing.
    const settings = useAppStore.getState().settings;
    if (settings?.discord_rpc_enabled) {
      invoke('set_idle_discord_presence').catch(() => {});
    }
    await get().saveSlots();
  },

  triggerAddAnimation: (x: number, y: number, channelLogin: string) => {
    const id = Date.now();
    // Start suck-up immediately, delay flying dot until card dissolve finishes (350ms)
    set({ suckUpLogin: channelLogin.toLowerCase() });
    // Spawn flying dot after suck-up animation completes
    setTimeout(() => {
      set({ flyingAnimation: { x, y, id } });
    }, 350);
    // Clear suckUpLogin after suck-up animation finishes so card transitions to ghost
    setTimeout(() => {
      if (get().suckUpLogin === channelLogin.toLowerCase()) {
        set({ suckUpLogin: null });
      }
    }, 400);
    // Clear flying animation after it completes so it doesn't replay on component remounts
    setTimeout(() => {
      if (get().flyingAnimation?.id === id) {
        set({ flyingAnimation: null });
      }
    }, 1400);
  },

  triggerRecallAnimation: (channelLogin: string, cardX: number, cardY: number) => {
    const id = Date.now();
    const login = channelLogin.toLowerCase();
    
    // Get the MultiNook badge position as the flying dot source
    const badgeBtn = document.getElementById('multinook-return-button');
    const badgeRect = badgeBtn?.getBoundingClientRect();
    const sourceX = badgeRect ? badgeRect.right - 10 : window.innerWidth / 2;
    const sourceY = badgeRect ? badgeRect.top - 5 : 0;
    
    // Set materializing FIRST — card will render content but CSS animation-delay holds it invisible
    set({ materializingLogin: login });
    
    // Then remove the slot — card is no longer "queued" but materializingLogin keeps it in animation mode
    get().removeSlotByLogin(login);
    
    // Spawn reverse flying dot from badge → card position
    set({ recallAnimation: { sourceX, sourceY, targetX: cardX, targetY: cardY, id } });
    
    // Clean up flying dot after it arrives
    setTimeout(() => {
      if (get().recallAnimation?.id === id) {
        set({ recallAnimation: null });
      }
    }, 550);
    
    // Clear materializing after animation-delay (550ms) + animation duration (350ms) completes
    setTimeout(() => {
      if (get().materializingLogin === login) {
        set({ materializingLogin: null });
      }
    }, 950);
  },

  resyncAllSlots: () => {
    Logger.info("[MultiNook] Forcing concurrent resynchronization of all streams");
    set(state => ({
      slots: state.slots.map(slot => ({
        ...slot,
        streamUrl: undefined, // Clearing streamUrl forces MultiNookCell to natively remount and concurrently invoke start_multi_nook
        loadError: false,     // Give previously-offline tiles another chance
      }))
    }));
  },

  retrySlot: (id: string) => {
    // Clear the offline flag and URL so the loader effect re-attempts this proxy.
    set((state) => ({
      slots: state.slots.map((s) => (s.id === id ? { ...s, streamUrl: undefined, loadError: false } : s)),
    }));
  },

  removeSlotByLogin: async (channelLogin: string) => {
    const slot = get().slots.find(s => s.channelLogin.toLowerCase() === channelLogin.toLowerCase());
    if (slot) {
      await get().removeSlot(slot.id);
    }
  },

  toggleMultiNook: async () => {
    const currentState = get().isMultiNookActive;
    const newState = !currentState;
    
    if (newState) {
      // Entering multi-nook mode
      if (get().slots.length === 0) {
        get().loadStoredSlots();
      }

      // Always have a chat selected on entry so messages start loading right
      // away (loadStoredSlots seeds it; this covers slots already in memory).
      const slotsNow = get().slots;
      if (!isActiveChatValid(slotsNow, get().activeChatChannelId)) {
        set({ activeChatChannelId: pickActiveChatChannel(slotsNow) });
      }

      // Ensure Home view is hidden
      if (useAppStore.getState().isHomeActive) {
        useAppStore.getState().toggleHome();
      }
      
      // Broadcast restored slots after a short delay
      setTimeout(() => {
        const currentSlots = get().slots;
        if (currentSlots.length > 0) {
          broadcastMultiNookPresence(currentSlots);
          for (const slot of currentSlots) {
            if (slot.channelId) {
               invoke('register_active_channel', { channelId: slot.channelId }).catch(() => {});
            }
          }
        }
      }, 500);
    } else {
      // Exiting multi-nook mode
      try {
        await invoke('stop_all_multi_nooks');
      } catch (e) {
        Logger.error('Failed to stop multi-nook proxies', e);
      }
      
      const currentSlots = get().slots;
      for (const slot of currentSlots) {
        if (slot.channelId) {
           invoke('unregister_active_channel', { channelId: slot.channelId }).catch(() => {});
        }
      }

      set({ activeChatChannelId: null, slots: [], maximizedSlotId: null }); // Maintain chat hidden state

      // Restore Home view if no single stream is playing
      if (!useAppStore.getState().streamUrl) {
        useAppStore.setState({ isHomeActive: true });
      }
      
      // Revert to idle presence
      const settings = useAppStore.getState().settings;
      if (settings?.discord_rpc_enabled) {
        invoke('set_idle_discord_presence').catch(() => {});
      }
    }

    set({ isMultiNookActive: newState });
  },

  addSlot: async (channelLogin: string) => {
    if (get().slots.length >= 25) {
      useAppStore.getState().addToast('Maximum of 25 streams reached', 'warning');
      return;
    }
    
    if (get().slots.some(s => s.channelLogin.toLowerCase() === channelLogin.toLowerCase())) {
      useAppStore.getState().addToast(`${channelLogin} is already in the view`, 'info');
      return;
    }

    let resolvedId = '';
    let resolvedName = '';
    let resolvedImage = '';
    let resolvedGameName = '';
    try {
      const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
      const response = await fetch(`https://api.twitch.tv/helix/users?login=${channelLogin}`, {
        headers: {
          'Client-ID': clientId,
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data.length > 0) {
          resolvedId = data.data[0].id;
          resolvedName = data.data[0].display_name;
          resolvedImage = data.data[0].profile_image_url;
          
          // Fetch channel info to get current game category
          try {
            const channelResponse = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${resolvedId}`, {
              headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${token}`
              }
            });
            if (channelResponse.ok) {
              const channelData = await channelResponse.json();
              if (channelData.data && channelData.data.length > 0) {
                resolvedGameName = channelData.data[0].game_name;
              }
            }
          } catch (e) {
            Logger.warn('[multiNookStore] Failed to fetch channel info for game name', e);
          }
        }
      }
    } catch (e) {
      Logger.warn('[multiNookStore] Failed to resolve channel details for', channelLogin, e);
    }

    // Capture latest state AFTER async operations to prevent race conditions from concurrent adds
    const { slots, saveSlots } = get();
    
    // Double check it wasn't added concurrently while we were fetching
    if (slots.some(s => s.channelLogin.toLowerCase() === channelLogin.toLowerCase())) {
      return;
    }

    const newSlot: MultiNookSlot = {
      id: `cell-${Date.now()}`,
      channelLogin,
      channelId: resolvedId || undefined,
      channelName: resolvedName || channelLogin,
      profileImageUrl: resolvedImage || undefined,
      gameName: resolvedGameName || undefined,
      volume: 0.5,
      muted: slots.length > 0, // Auto-mute if it's not the first one
      isFocused: slots.length === 0, // First slot is focused by default
    };

    const newSlots = [...slots, newSlot];
    set({ slots: newSlots });

    // Keep a chat selected: if nothing valid is selected yet (first slot, or the
    // previous selection is gone), focus the slot we just added.
    if (!isActiveChatValid(newSlots, get().activeChatChannelId)) {
       set({ activeChatChannelId: newSlot.channelId ?? newSlot.channelLogin });
    }
    
    if (newSlot.channelId) {
       invoke('register_active_channel', { channelId: newSlot.channelId }).catch(() => {});
    }
    // The mod view (EventSub channel.moderate) follows the chat connection now,
    // wired in the Rust IRC service, so opening a tile's chat subscribes it
    // automatically. No per-slot call needed here.

    broadcastMultiNookPresence(newSlots);
    await saveSlots();
  },

  removeSlot: async (id: string) => {
    const { slots, saveSlots } = get();
    const slotToRemove = slots.find(s => s.id === id);
    
    if (slotToRemove?.streamUrl) {
      try {
        await invoke('stop_multi_nook', { streamId: id });
      } catch (e) {
        Logger.error(`Failed to stop proxy for slot ${id}`, e);
      }
    }
    
    if (slotToRemove?.channelId) {
       invoke('unregister_active_channel', { channelId: slotToRemove.channelId }).catch(() => {});
    }

    const newSlots = slots.filter(s => s.id !== id);
    
    // If we removed the focused slot, all visible slots should unmute since there's no longer a focused slot
    if (slotToRemove?.isFocused && newSlots.length > 0) {
      newSlots.forEach(s => {
        if (!s.isMinimized) {
          s.muted = false;
        }
      });
    }
    
    // Removing the maximized tile drops back to the grid.
    if (get().maximizedSlotId === id) {
      set({ maximizedSlotId: null });
    }

    // Removing the last tile also un-equips the preset (the grid is now empty).
    set(newSlots.length === 0 ? { slots: newSlots, activePresetId: null } : { slots: newSlots });

    // Always keep a valid selection: if the active chat is now gone (or was
    // never set), fall back to the focused/first remaining slot so chat keeps
    // loading. Resolves to null only when no slots remain.
    if (!isActiveChatValid(newSlots, get().activeChatChannelId)) {
      set({ activeChatChannelId: pickActiveChatChannel(newSlots) });
    }
    
    if (newSlots.length > 0) {
      broadcastMultiNookPresence(newSlots);
    } else {
      // Revert to idle presence since there are no streams
      const settings = useAppStore.getState().settings;
      if (settings?.discord_rpc_enabled) {
        invoke('set_idle_discord_presence').catch(() => {});
      }
    }

    await saveSlots();
  },

  updateSlot: (id: string, updates: Partial<MultiNookSlot>) => {
    const { slots, saveSlots } = get();
    const newSlots = slots.map(s => s.id === id ? { ...s, ...updates } : s);
    set({ slots: newSlots });
    
    // Only save to settings if it's a persistent config change (not streamUrl)
    if ('volume' in updates || 'muted' in updates || 'isFocused' in updates || 'channelLogin' in updates || 'isMinimized' in updates || 'profileImageUrl' in updates) {
      saveSlots();
    }
  },

  changeSlotQuality: async (id: string, quality: string) => {
    const slot = get().slots.find(s => s.id === id);
    if (!slot || slot.quality === quality) return;

    // Stop the current proxy first so the restart picks up the new quality
    // cleanly (the proxy is keyed by streamId, so a fresh start replaces it).
    if (slot.streamUrl) {
      try {
        await invoke('stop_multi_nook', { streamId: id });
      } catch (e) {
        Logger.warn(`[MultiNook] Failed to stop proxy before quality change for ${id}`, e);
      }
    }

    // Persist the new quality and clear the URL. MultiNookView's missing-stream
    // loader re-invokes start_multi_nook at slot.quality and the cell remounts
    // on the new URL — same path resyncAllSlots uses.
    set(state => ({
      slots: state.slots.map(s => (s.id === id ? { ...s, quality, streamUrl: undefined, loadError: false } : s)),
    }));
    await get().saveSlots();
  },

  reorderSlots: (newSlots: MultiNookSlot[]) => {
    set({ slots: newSlots });
    get().saveSlots();
  },

  toggleFocusSlot: (id: string) => {
    const { slots, saveSlots } = get();
    const slot = slots.find(s => s.id === id);
    if (!slot) return;
    
    const isCurrentlyFocused = slot.isFocused;
    
    const newSlots = slots.map(s => {
      if (isCurrentlyFocused) {
        // We are toggling focus off. Clear focus from all, unmute all non-docked
        return {
          ...s,
          isFocused: false,
          muted: s.isMinimized ? true : false,
        };
      } else {
        // We are focusing THIS slot. Make it focused and unmuted. Mute all others.
        return {
          ...s,
          isFocused: s.id === id,
          muted: s.id !== id,
        };
      }
    });
    
    set({ slots: newSlots });
    saveSlots();
    
    // Jump chat focus to this slot if we are focusing it
    if (!isCurrentlyFocused && slot.channelId) {
       set({ activeChatChannelId: slot.channelId });
    }
  },

  toggleMaximizeSlot: (id: string) => {
    const { slots, maximizedSlotId, saveSlots } = get();
    const slot = slots.find(s => s.id === id);
    // Only visible tiles can be maximized (docked tiles aren't on the grid).
    if (!slot || slot.isMinimized) return;

    // Already filling the space (this tile or, defensively, any tile) → restore grid.
    if (maximizedSlotId) {
      set({ maximizedSlotId: null });
      return;
    }

    // Maximize this tile AND focus it: unmute it, mute everyone else, so it acts
    // exactly like the solo player. Mirrors toggleFocusSlot's "focus this" branch.
    const newSlots = slots.map(s => ({
      ...s,
      isFocused: s.id === id,
      muted: s.id !== id,
    }));
    set({ maximizedSlotId: id, slots: newSlots });
    saveSlots();

    // Move chat to the maximized stream so chat matches what you're watching.
    if (slot.channelId) {
      set({ activeChatChannelId: slot.channelId });
    }
  },

  setMaximizedSlot: (id: string | null) => {
    set({ maximizedSlotId: id });
  },

  dockSlot: (id: string) => {
    const { slots, saveSlots } = get();
    const slot = slots.find(s => s.id === id);
    if (!slot || slot.isMinimized) return;

    // Docking acts similarly to muting & minimizing
    const wasFocused = slot.isFocused;
    
    const newSlots = slots.map(s => {
      if (s.id === id) {
        return { ...s, isMinimized: true, muted: true, isFocused: false };
      }
      // If we are docking the focused stream, it loses focus, so we unmute the rest of visible streams
      if (wasFocused && !s.isMinimized) {
        return { ...s, muted: false };
      }
      return s;
    });

    // Docking the maximized tile takes it off the grid → restore the grid view.
    set(get().maximizedSlotId === id ? { slots: newSlots, maximizedSlotId: null } : { slots: newSlots });
    saveSlots();
  },

  undockSlot: (id: string) => {
    const { slots, saveSlots } = get();
    const slot = slots.find(s => s.id === id);
    if (!slot || !slot.isMinimized) return;
    
    const hasFocusedStream = slots.some(s => s.isFocused);
    
    const newSlots = slots.map(s => {
      if (s.id === id) {
        return { 
          ...s, 
          isMinimized: false,
          // Unmute if there is NO focused stream. If someone HAS focus, stay muted.
          muted: hasFocusedStream ? true : false 
        };
      }
      return s;
    });
    
    set({ slots: newSlots });
    saveSlots();
  },

  swapDockedSlot: (id: string) => {
    const { slots, saveSlots } = get();
    const slotToRestore = slots.find(s => s.id === id);
    if (!slotToRestore || !slotToRestore.isMinimized) return;

    const visibleSlots = slots.filter(s => !s.isMinimized);
    if (visibleSlots.length === 0) {
      get().undockSlot(id);
      return;
    }
    
    // Choose target to dock: prefer the focused slot, otherwise the first visible one
    const slotToDock = visibleSlots.find(s => s.isFocused) || visibleSlots[0];
    
    const newSlots = slots.map(s => {
      if (s.id === id) {
        // Restore and focus
        return { ...s, isMinimized: false, isFocused: true, muted: false };
      }
      if (s.id === slotToDock.id) {
        // Dock the old one. If it was the maximized tile, the grid restore is
        // handled below by clearing maximizedSlotId.
        return { ...s, isMinimized: true, isFocused: false, muted: true };
      }
      // If we are swapping, we assume 1-stream viewing mode, so mute all others
      return { ...s, isFocused: false, muted: true };
    });

    // A swap reshuffles which tile is the active one, so drop any fill-the-space
    // overlay back to the grid (the swapped-in tile is freshly restored/focused).
    set(get().maximizedSlotId ? { slots: newSlots, maximizedSlotId: null } : { slots: newSlots });
    saveSlots();

    if (slotToRestore.channelId) {
      set({ activeChatChannelId: slotToRestore.channelId });
    }
  },

  setActiveChatChannelId: (id: string | null) => {
    set({ activeChatChannelId: id });
  },

  toggleChatHidden: async () => {
    const currentState = get().isChatHidden;
    const newState = !currentState;
    set({ isChatHidden: newState });
    
    const appStore = useAppStore.getState();
    const currentSettings = appStore.settings;
    if (currentSettings) {
      const newSettings = {
        ...currentSettings,
        multi_nook_chat_hidden: newState,
      };
      try {
        await invoke('save_settings', { settings: newSettings });
        useAppStore.setState({ settings: newSettings });
      } catch (e) {
        Logger.error('Failed to save multi_nook_chat_hidden state', e);
      }
    }
  },

  loadStoredSlots: () => {
    const appSettings = useAppStore.getState().settings;
    if (appSettings) {
      if (appSettings.multi_nook_slots && Array.isArray(appSettings.multi_nook_slots)) {
        // Clean up old minimized state on load - anything that was explicitly minimized
        const cleanedSlots = appSettings.multi_nook_slots.map(s => {
          const cleaned = { ...s };
          delete cleaned.streamUrl;
          delete cleaned.loadError;
          return cleaned as MultiNookSlot;
        });
        // Seed the chat selection so a restored grid opens with chat loading,
        // not blank. Restore the equipped-preset tag so the toolbar icon matches.
        set({
          slots: cleanedSlots,
          activeChatChannelId: pickActiveChatChannel(cleanedSlots),
          activePresetId: appSettings.multi_nook_active_preset_id ?? null,
        });
        // Restored avatars are whatever was persisted: they can be stale (Twitch
        // CDN URLs expire / the streamer changed their pic) or were never captured
        // (a network hiccup on the original add), so the offline overlay shows no
        // picture. Refresh them from Helix in the background (one batched call,
        // up to 100 logins) and persist the fresh values.
        void (async () => {
          const logins = Array.from(
            new Set(cleanedSlots.map((s) => s.channelLogin.toLowerCase())),
          ).filter(Boolean);
          if (logins.length === 0) return;
          try {
            const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
            const qs = logins.slice(0, 100).map((l) => `login=${encodeURIComponent(l)}`).join('&');
            const resp = await fetch(`https://api.twitch.tv/helix/users?${qs}`, {
              headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
            });
            if (!resp.ok) return;
            const data = await resp.json();
            const byLogin = new Map<string, { id: string; display_name: string; profile_image_url: string }>();
            for (const u of data.data || []) byLogin.set((u.login || '').toLowerCase(), u);
            let changed = false;
            const next = get().slots.map((s) => {
              const u = byLogin.get(s.channelLogin.toLowerCase());
              if (!u || !u.profile_image_url) return s;
              if (
                u.profile_image_url === s.profileImageUrl &&
                s.channelId &&
                s.channelName
              )
                return s;
              changed = true;
              return {
                ...s,
                profileImageUrl: u.profile_image_url,
                channelId: s.channelId || u.id,
                channelName: s.channelName || u.display_name,
              };
            });
            if (changed) {
              set({ slots: next });
              void get().saveSlots();
            }
          } catch (e) {
            Logger.warn('[multiNookStore] Failed to refresh restored slot avatars', e);
          }
        })();
      }
      if (appSettings.multi_nook_chat_hidden !== undefined) {
        set({ isChatHidden: appSettings.multi_nook_chat_hidden });
      }
    }
  },

  saveSlots: async () => {
    // Save to settings.json via AppStore
    const appStore = useAppStore.getState();
    const currentSettings = appStore.settings;
    
    // Strip ephemeral URLs
    const cleanSlots = get().slots.map(s => {
      const cleaned = { ...s };
      delete cleaned.streamUrl;
      delete cleaned.loadError;
      return cleaned as MultiNookSlot;
    });
    
    const newSettings = {
      ...currentSettings,
      multi_nook_slots: cleanSlots,
      multi_nook_active_preset_id: get().activePresetId ?? undefined,
    };

    try {
      await invoke('save_settings', { settings: newSettings });
      useAppStore.setState({ settings: newSettings }); // Update local app store reference
    } catch (e) {
      Logger.error('Failed to save multi-nook slots to settings', e);
    }
  }
}));

