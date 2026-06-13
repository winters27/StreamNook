// Tracks which installed plugins have a newer version available in a source
// index, so the title bar can badge the marketplace entry point. Populated by
// PluginUpdatesChecker; read by the title bar's Marketplace button.

import { create } from 'zustand';

interface PluginUpdatesState {
  /** Ids of installed plugins with a newer version available. */
  ids: string[];
  setIds: (ids: string[]) => void;
}

export const usePluginUpdates = create<PluginUpdatesState>((set) => ({
  ids: [],
  setIds: (ids) => set({ ids }),
}));
