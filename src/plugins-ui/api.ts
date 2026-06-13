// Builds the frozen api object handed to a ui plugin's module, plus the
// disposer that tears down everything the plugin registered through it.
// The surface is documented in docs/plugins/UI_PLUGINS.md.

import { emit, listen } from '@tauri-apps/api/event';
import { Tooltip } from '../components/ui/Tooltip';
import { Logger } from '../utils/logger';
import {
  registerPluginCommand,
  unregisterPluginCommands,
} from '../keybindings/commands';
import type { KeybindCategory } from '../keybindings/types';
import {
  addOverlay,
  addPaletteProvider,
  addSettingsPanel,
  addSlotContribution,
  addTitleBarButton,
  clearPluginContributions,
} from './registry';
import { HOST_LIBS } from './hostLibs';
import { UI_KIT } from '../components/plugins/uiKit';
import { insertIntoChatInput, useHasChatTarget } from './chatBridge';
import { openPluginWindow } from './windows';
import type { PluginApi, PluginKeybinding } from './types';

const KEYBIND_CATEGORIES: KeybindCategory[] = [
  'Application',
  'Navigation',
  'Player',
  'Chat',
  'Moderation',
  'Multi-view',
];

function toKeybindCategory(category: string | undefined): KeybindCategory {
  return KEYBIND_CATEGORIES.includes(category as KeybindCategory)
    ? (category as KeybindCategory)
    : 'Application';
}

export function buildPluginApi(pluginId: string): { api: PluginApi; dispose: () => void } {
  const disposers: (() => void)[] = [];

  const api: PluginApi = Object.freeze({
    pluginId,
    libs: HOST_LIBS,
    components: Object.freeze({ Tooltip, ...UI_KIT }),
    ui: Object.freeze({
      registerTitleBarButton: (contribution: Parameters<PluginApi['ui']['registerTitleBarButton']>[0]) =>
        addTitleBarButton(pluginId, contribution),
      registerOverlay: (contribution: Parameters<PluginApi['ui']['registerOverlay']>[0]) =>
        addOverlay(pluginId, contribution),
      registerSlot: (
        slotId: string,
        contribution: Parameters<PluginApi['ui']['registerSlot']>[1],
      ) => addSlotContribution(pluginId, slotId, contribution),
    }),
    commands: Object.freeze({
      registerKeybinding: (command: PluginKeybinding) =>
        registerPluginCommand(pluginId, {
          id: command.id,
          label: command.label,
          description: command.description,
          category: toKeybindCategory(command.category),
          context: 'global',
          defaultBindings: command.defaultBindings,
          keywords: command.keywords,
          run: command.run,
        }),
      registerPaletteItems: (provider: Parameters<PluginApi['commands']['registerPaletteItems']>[0]) =>
        addPaletteProvider(pluginId, provider),
    }),
    settings: Object.freeze({
      registerPanel: (Component: Parameters<PluginApi['settings']['registerPanel']>[0]) =>
        addSettingsPanel(pluginId, Component),
    }),
    windows: Object.freeze({
      open: (options: Parameters<PluginApi['windows']['open']>[0]) =>
        openPluginWindow(pluginId, options),
    }),
    events: Object.freeze({
      emit: (name: string, payload?: unknown) => emit(name, payload),
      listen: async (name: string, handler: (payload: unknown) => void) => {
        const unlisten = await listen<unknown>(name, (event) => handler(event.payload));
        disposers.push(unlisten);
        return unlisten;
      },
    }),
    chat: Object.freeze({
      useHasTarget: useHasChatTarget,
      insertText: insertIntoChatInput,
    }),
    log: Object.freeze({
      debug: (...args: unknown[]) => Logger.debug(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) => Logger.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) => Logger.error(`[plugin:${pluginId}]`, ...args),
    }),
  });

  const dispose = () => {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer();
      } catch {
        // listener already gone
      }
    }
    unregisterPluginCommands(pluginId);
    clearPluginContributions(pluginId);
  };

  return { api, dispose };
}
