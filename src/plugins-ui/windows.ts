// Popout OS windows for ui plugins. The host owns the window: it spawns a
// frameless WebviewWindow routed to the generic `#/plugin/<id>/<surface>`
// hash, where PluginWindowHost renders the standard titlebar and theme and
// mounts the component the plugin's module returns from windowSurface().
//
// One window per (plugin, surface): reopening focuses the existing one.

import { Logger } from '../utils/logger';
import type { PluginWindowOptions } from './types';

/** Window labels only allow [a-zA-Z0-9-/:_]; plugin ids contain dots. */
function sanitizeLabelPart(part: string): string {
  return part.replace(/[^a-zA-Z0-9-_]/g, '-');
}

export function pluginWindowLabel(pluginId: string, surface: string): string {
  return `plugin-${sanitizeLabelPart(pluginId)}-${sanitizeLabelPart(surface)}`;
}

export async function openPluginWindow(
  pluginId: string,
  options: PluginWindowOptions,
): Promise<void> {
  const label = pluginWindowLabel(pluginId, options.surface);
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');

    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      try {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.show();
        await existing.setFocus();
      } catch (err) {
        Logger.warn(`[PluginWindow] focus existing '${label}' failed:`, err);
      }
      return;
    }

    // Land the new window next to the current one; fall back to the OS
    // default placement if the query fails.
    let x: number | undefined;
    let y: number | undefined;
    try {
      const current = getCurrentWindow();
      const pos = await current.outerPosition();
      const size = await current.outerSize();
      x = pos.x + size.width + 10;
      y = pos.y;
    } catch (err) {
      Logger.debug('[PluginWindow] could not derive window position:', err);
    }

    const hash = `#/plugin/${encodeURIComponent(pluginId)}/${encodeURIComponent(
      options.surface,
    )}?title=${encodeURIComponent(options.title)}`;
    const win = new WebviewWindow(label, {
      url: `${window.location.origin}/${hash}`,
      title: options.title,
      width: options.width ?? 420,
      height: options.height ?? 560,
      minWidth: options.minWidth ?? 280,
      minHeight: options.minHeight ?? 360,
      x,
      y,
      resizable: true,
      decorations: false,
      transparent: false,
      minimizable: true,
      maximizable: false,
      focus: true,
    });
    win.once('tauri://error', (e) => {
      Logger.error(`[PluginWindow] failed to open '${label}':`, e);
    });
  } catch (err) {
    Logger.error('[PluginWindow] openPluginWindow failed:', err);
    throw err;
  }
}
