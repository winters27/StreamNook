// Helper for spawning the standalone Lists window. Same model as
// multichatWindow: Tauri WebviewWindow over the app's own index.html, routed
// via the `#/lists` hash so main.tsx renders the ListsWindow shell instead of
// the regular App.
//
// Single-popout model: the window is a singleton keyed by WINDOW_LABEL; a
// second call focuses the existing one. List data needs no per-window state
// here because the list store lives in localStorage and syncs across windows
// via the `streamnook-lists-updated` event.

import { Logger } from './logger';

const WINDOW_LABEL = 'lists-default';
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 540;

export async function openListsWindow(): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');

    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      try {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.show();
        await existing.setFocus();
      } catch (err) {
        Logger.warn('[Lists] focus existing window failed:', err);
      }
      return;
    }

    // Try to land the new window next to the main one; fall back to the OS
    // default placement if the main-window query fails.
    let x: number | undefined;
    let y: number | undefined;
    try {
      const mainWindow = getCurrentWindow();
      const pos = await mainWindow.outerPosition();
      const mainSize = await mainWindow.outerSize();
      x = pos.x + mainSize.width + 10;
      y = pos.y;
    } catch (err) {
      Logger.debug('[Lists] Could not derive main window position:', err);
    }

    const win = new WebviewWindow(WINDOW_LABEL, {
      url: `${window.location.origin}/#/lists`,
      title: 'StreamNook Lists',
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      minWidth: 280,
      minHeight: 360,
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
      Logger.error('[Lists] Failed to open Lists window:', e);
    });
  } catch (err) {
    Logger.error('[Lists] openListsWindow failed:', err);
    throw err;
  }
}
