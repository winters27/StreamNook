// Helper for spawning a StreamNook MultiChat popout window. Uses Tauri's
// WebviewWindow with the same index.html as the main app, routed via the
// `#/multichat` hash so main.tsx renders the MultiChatWindow shell instead
// of the regular App.
//
// Window label format: `multichat-{shortId}`. Multiple MultiChat windows are
// allowed (one per monitor is reasonable), so the label includes a random
// suffix to avoid collisions.

import { Logger } from './logger';

export interface OpenMultiChatOptions {
  /** Optional channel to pre-load (used when popping out from a watched stream).
   *  If omitted, the window opens empty for the user to add channels manually. */
  channel?: string;
  /** Twitch channel/room id, paired with `channel`. Without this the optimistic
   *  IRC send path can't supply a real `room-id` tag, and channel-scoped badges
   *  fall through to global until USERSTATE lands. */
  channelId?: string;
  /** Display name (proper capitalization) for the channel — used for the tab
   *  label and window title until the popout's own metadata poll lands. */
  channelName?: string;
  /** Display title (defaults to `StreamNook MultiChat` or includes the channel
   *  name when one is pre-loaded). */
  title?: string;
  width?: number;
  height?: number;
}

// Defaults tuned to feel comparable to Twitch's stock popout chat window.
// Twitch's web popout is roughly 340×500 of chat-only content; we add ~70px
// for our own chrome (custom title bar + tab strip + send input row), which
// lands us around 402×620 — compact, comfortable on a second monitor, and
// resizable from any edge if the user wants more room.
const DEFAULT_WIDTH = 402;
const DEFAULT_HEIGHT = 620;

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function openMultiChatWindow(options: OpenMultiChatOptions = {}): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');

    const id = randomId();
    const label = `multichat-${id}`;

    const params = new URLSearchParams({ id });
    if (options.channel) params.set('channel', options.channel.toLowerCase());
    if (options.channelId) params.set('channelId', options.channelId);
    if (options.channelName) params.set('channelName', options.channelName);

    // Try to land the new window next to the main one. Falls back to centered
    // placement if the main-window query fails.
    let x: number | undefined;
    let y: number | undefined;
    try {
      const mainWindow = getCurrentWindow();
      const pos = await mainWindow.outerPosition();
      const size = await mainWindow.outerSize();
      // Prefer right side of main; if that would render off-screen we'll just
      // let Tauri decide (omit x/y → uses OS defaults).
      x = pos.x + size.width + 10;
      y = pos.y;
    } catch (err) {
      Logger.debug('[MultiChat] Could not derive main window position:', err);
    }

    const titleChannel = options.channelName || options.channel;
    const title =
      options.title ??
      (titleChannel ? `StreamNook MultiChat — ${titleChannel}` : 'StreamNook MultiChat');

    const win = new WebviewWindow(label, {
      url: `${window.location.origin}/#/multichat?${params.toString()}`,
      title,
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
      x,
      y,
      resizable: true,
      decorations: false,
      transparent: false,
      minimizable: true,
      maximizable: true,
      focus: true,
      // Disable Tauri's native drag-and-drop interception. With it enabled
      // (the default), the OS captures drag gestures before HTML5 `dragstart`
      // can fire — which silently breaks the tab-strip drag-to-reorder. The
      // popout has no need for OS-level file-drop targeting, so turning this
      // off is safe and re-enables web-level DnD throughout the window.
      dragDropEnabled: false,
    });

    win.once('tauri://error', (e) => {
      Logger.error('[MultiChat] Failed to open MultiChat window:', e);
    });

    Logger.debug(`[MultiChat] Opened window ${label} for channel ${options.channel ?? '(empty)'}`);
  } catch (err) {
    Logger.error('[MultiChat] openMultiChatWindow failed:', err);
    throw err;
  }
}

// Expose on window during development so the popout can be triggered from
// devtools while the UI button is still being designed. Safe in production
// since the function only spawns a known-label window with our own origin.
if (typeof window !== 'undefined') {
  (window as unknown as { openMultiChatWindow: typeof openMultiChatWindow }).openMultiChatWindow =
    openMultiChatWindow;
}
