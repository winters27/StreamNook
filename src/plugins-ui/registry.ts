// Registry of live ui-plugin contributions for this window. Host surfaces
// (title bar, overlay outlet, slot owners, palette, keybindings) read from
// here; the per-plugin api object writes here; unloading a plugin clears
// everything it registered.

import { create } from 'zustand';
import type { ComponentType } from 'react';
import type {
  OverlayContribution,
  PluginPaletteItem,
  SlotContribution,
  TitleBarButtonContribution,
} from './types';

type Keyed<T> = T & { pluginId: string };

interface PluginUiRegistryState {
  titleBarButtons: Keyed<TitleBarButtonContribution>[];
  overlays: Keyed<OverlayContribution>[];
  slots: Record<string, Keyed<SlotContribution>[]>;
  paletteProviders: { pluginId: string; provider: () => PluginPaletteItem[] }[];
  /** A plugin's own settings component, rendered on its card in the plugins
   *  page. The in-process equivalent of a process plugin's host-rendered panel. */
  settingsPanels: Record<string, ComponentType>;
}

export const usePluginUiRegistry = create<PluginUiRegistryState>(() => ({
  titleBarButtons: [],
  overlays: [],
  slots: {},
  paletteProviders: [],
  settingsPanels: {},
}));

export function addTitleBarButton(
  pluginId: string,
  contribution: TitleBarButtonContribution,
): void {
  usePluginUiRegistry.setState((s) => ({
    titleBarButtons: [
      ...s.titleBarButtons.filter((b) => !(b.pluginId === pluginId && b.id === contribution.id)),
      { ...contribution, pluginId },
    ],
  }));
}

export function addOverlay(pluginId: string, contribution: OverlayContribution): void {
  usePluginUiRegistry.setState((s) => ({
    overlays: [
      ...s.overlays.filter((o) => !(o.pluginId === pluginId && o.id === contribution.id)),
      { ...contribution, pluginId },
    ],
  }));
}

export function addSlotContribution(
  pluginId: string,
  slotId: string,
  contribution: SlotContribution,
): void {
  usePluginUiRegistry.setState((s) => ({
    slots: {
      ...s.slots,
      [slotId]: [
        ...(s.slots[slotId] ?? []).filter(
          (c) => !(c.pluginId === pluginId && c.id === contribution.id),
        ),
        { ...contribution, pluginId },
      ],
    },
  }));
}

export function addPaletteProvider(
  pluginId: string,
  provider: () => PluginPaletteItem[],
): void {
  usePluginUiRegistry.setState((s) => ({
    paletteProviders: [...s.paletteProviders, { pluginId, provider }],
  }));
}

export function addSettingsPanel(pluginId: string, Component: ComponentType): void {
  usePluginUiRegistry.setState((s) => ({
    settingsPanels: { ...s.settingsPanels, [pluginId]: Component },
  }));
}

/** Removes every contribution a plugin registered (called at unload). */
export function clearPluginContributions(pluginId: string): void {
  usePluginUiRegistry.setState((s) => {
    const settingsPanels = { ...s.settingsPanels };
    delete settingsPanels[pluginId];
    return {
      titleBarButtons: s.titleBarButtons.filter((b) => b.pluginId !== pluginId),
      overlays: s.overlays.filter((o) => o.pluginId !== pluginId),
      slots: Object.fromEntries(
        Object.entries(s.slots).map(([slot, list]) => [
          slot,
          list.filter((c) => c.pluginId !== pluginId),
        ]),
      ),
      paletteProviders: s.paletteProviders.filter((p) => p.pluginId !== pluginId),
      settingsPanels,
    };
  });
}

const EMPTY_SLOT: Keyed<SlotContribution>[] = [];

/** Stable-reference selector helper for a slot's contributions. */
export function selectSlot(slotId: string) {
  return (s: PluginUiRegistryState) => s.slots[slotId] ?? EMPTY_SLOT;
}
