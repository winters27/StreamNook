// Loads and unloads ui-plugin modules in this window. The bundle is read
// through the host (which enforces kind and enabled state), imported as a
// blob module, and activated with a per-plugin api object. Unloading runs
// the module's deactivate, the activate cleanup, and the api disposer, which
// clears every registered contribution.

import { invoke } from '@tauri-apps/api/core';
import type * as React from 'react';
import { Logger } from '../utils/logger';
import { buildPluginApi } from './api';
import { installHostLibs } from './hostLibs';
import type { PluginApi, PluginUiModule } from './types';

interface PluginInfoLite {
  id: string;
  name: string;
  kind?: string;
  enabled: boolean;
}

interface LoadedUiPlugin {
  dispose: () => void;
}

const loaded = new Map<string, LoadedUiPlugin>();
let syncing = false;
let pendingResync = false;

async function importBundle(pluginId: string): Promise<PluginUiModule> {
  installHostLibs();
  const code = await invoke<string>('plugins_ui_bundle', { pluginId });
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ url)) as PluginUiModule;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function load(pluginId: string): Promise<LoadedUiPlugin> {
  const module = await importBundle(pluginId);
  const { api, dispose: disposeApi } = buildPluginApi(pluginId);
  let cleanup: void | (() => void);
  try {
    cleanup = module.activate?.(api);
  } catch (err) {
    disposeApi();
    throw err;
  }
  Logger.debug(`[PluginUi] loaded ${pluginId}`);
  return {
    dispose: () => {
      try {
        module.deactivate?.();
      } catch (err) {
        Logger.warn(`[PluginUi] ${pluginId} deactivate failed:`, err);
      }
      if (typeof cleanup === 'function') {
        try {
          cleanup();
        } catch (err) {
          Logger.warn(`[PluginUi] ${pluginId} activate cleanup failed:`, err);
        }
      }
      disposeApi();
      Logger.debug(`[PluginUi] unloaded ${pluginId}`);
    },
  };
}

/** Brings this window's loaded set in line with the registry: loads enabled
 *  ui plugins that are not loaded, unloads ones no longer enabled. Serialized;
 *  a call during a sync schedules one follow-up pass. */
export async function syncUiPlugins(onError?: (message: string) => void): Promise<void> {
  if (syncing) {
    pendingResync = true;
    return;
  }
  syncing = true;
  try {
    const all = await invoke<PluginInfoLite[]>('plugins_list');
    const want = new Set(
      all.filter((p) => p.kind === 'ui' && p.enabled).map((p) => p.id),
    );
    for (const [id, handle] of [...loaded]) {
      if (!want.has(id)) {
        handle.dispose();
        loaded.delete(id);
      }
    }
    for (const id of want) {
      if (!loaded.has(id)) {
        try {
          loaded.set(id, await load(id));
        } catch (err) {
          Logger.error(`[PluginUi] failed to load ${id}:`, err);
          onError?.(`Plugin "${all.find((p) => p.id === id)?.name ?? id}" failed to load`);
        }
      }
    }
  } catch (err) {
    Logger.error('[PluginUi] sync failed:', err);
  } finally {
    syncing = false;
    if (pendingResync) {
      pendingResync = false;
      void syncUiPlugins(onError);
    }
  }
}

/** Popout-window path: imports the module and asks it for the component that
 *  renders the given surface. Returns the component plus a disposer for the
 *  api (listeners the surface registered through it). */
export async function loadWindowSurface(
  pluginId: string,
  surface: string,
): Promise<{ Component: React.ComponentType | null; api: PluginApi; dispose: () => void }> {
  const module = await importBundle(pluginId);
  const { api, dispose } = buildPluginApi(pluginId);
  const Component = module.windowSurface?.(surface, api) ?? null;
  return { Component, api, dispose };
}
