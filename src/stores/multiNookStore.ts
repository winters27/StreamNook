import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './AppStore';
import { MultiNookSlot } from '../types';
import { Logger } from '../utils/logger';

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
    streamUrl: 'https://github.com/winters27/StreamNook/',
  };

  // Discord (gated by settings toggle)
  const settings = useAppStore.getState().settings;
  if (settings?.discord_rpc_enabled) {
    invoke('update_discord_presence', presenceArgs).catch(() => {});
  }

  // Magne (always-on, independent)
  invoke('update_magne_presence', presenceArgs).catch(() => {});
};


interface MultiNookState {
  isMultiNookActive: boolean;
  isChatHidden: boolean;
  activeChatChannelId: string | null;
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
  reorderSlots: (newSlots: MultiNookSlot[]) => void;
  toggleFocusSlot: (id: string) => void;
  dockSlot: (id: string) => void;
  undockSlot: (id: string) => void;
  swapDockedSlot: (id: string) => void;
  setActiveChatChannelId: (id: string | null) => void;
  toggleChatHidden: () => void;
  
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
  slots: [],
  flyingAnimation: null,
  suckUpLogin: null,
  recallAnimation: null,
  materializingLogin: null,

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
        streamUrl: undefined // Clearing streamUrl forces MultiNookCell to natively remount and concurrently invoke start_multi_nook
      }))
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

      set({ activeChatChannelId: null, slots: [] }); // Maintain chat hidden state

      // Restore Home view if no single stream is playing
      if (!useAppStore.getState().streamUrl) {
        useAppStore.setState({ isHomeActive: true });
      }
      
      // Revert to idle presence
      const settings = useAppStore.getState().settings;
      if (settings?.discord_rpc_enabled) {
        invoke('set_idle_discord_presence').catch(() => {});
      }
      invoke('set_idle_magne_presence').catch(() => {});
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
    
    // Auto focus chat on the first slot added
    if (newSlots.length === 1 && newSlot.channelId) {
       set({ activeChatChannelId: newSlot.channelId });
    }
    
    if (newSlot.channelId) {
       invoke('register_active_channel', { channelId: newSlot.channelId }).catch(() => {});
    }
    
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
    
    set({ slots: newSlots });
    
    // If the active chat channel was removed, fallback to the first focused one or the first visible one
    if (slotToRemove?.channelId === get().activeChatChannelId) {
      const activeSlot = newSlots.find(s => s.isFocused) || newSlots.find(s => !s.isMinimized);
      set({ activeChatChannelId: activeSlot?.channelId || null });
    }
    
    if (newSlots.length > 0) {
      broadcastMultiNookPresence(newSlots);
    } else {
      // Revert to idle presence since there are no streams
      const settings = useAppStore.getState().settings;
      if (settings?.discord_rpc_enabled) {
        invoke('set_idle_discord_presence').catch(() => {});
      }
      invoke('set_idle_magne_presence').catch(() => {});
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

    set({ slots: newSlots });
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
        // Dock the old one
        return { ...s, isMinimized: true, isFocused: false, muted: true };
      }
      // If we are swapping, we assume 1-stream viewing mode, so mute all others
      return { ...s, isFocused: false, muted: true };
    });
    
    set({ slots: newSlots });
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
          return cleaned as MultiNookSlot;
        });
        set({ slots: cleanedSlots });
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
      return cleaned as MultiNookSlot;
    });
    
    const newSettings = {
      ...currentSettings,
      multi_nook_slots: cleanSlots,
    };
    
    try {
      await invoke('save_settings', { settings: newSettings });
      useAppStore.setState({ settings: newSettings }); // Update local app store reference
    } catch (e) {
      Logger.error('Failed to save multi-nook slots to settings', e);
    }
  }
}));

