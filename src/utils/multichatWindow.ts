// Helper for spawning a StreamNook MultiChat popout window. Uses Tauri's
// WebviewWindow with the same index.html as the main app, routed via the
// `#/multichat` hash so main.tsx renders the MultiChatWindow shell instead
// of the regular App.
//
// Single-popout model: the popout is a singleton keyed by `WINDOW_LABEL`. If
// one already exists, a second `openMultiChatWindow` call focuses it (and,
// when a channel is provided, emits `multichat-add-channel` so the existing
// window appends the new channel as a tab). Storage uses a stable id
// (`WINDOW_ID`) so closing and reopening restores the same tab set instead
// of leaving an orphan localStorage record per session.

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
  /** Multiple channels to seed/add at once — e.g. popping out every MultiNook
   *  tile's chat in one click. Takes precedence over the single-channel fields. */
  channels?: Array<{ channel: string; channelId?: string | null; channelName?: string | null }>;
  /** Replace the popout's entire tab set with exactly these channels (a fresh
   *  view) instead of merging/appending into whatever was already open. */
  replace?: boolean;
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
// Width of a single chat column. Split layouts (2–4 columns) size the window to
// a multiple of this so each chat keeps a comfortable single-chat width instead
// of being squeezed into a fraction of one. Exported so MultiChatWindow's
// column-aware resize uses the exact same base.
export const MULTICHAT_BASE_WIDTH = 402;
const DEFAULT_WIDTH = MULTICHAT_BASE_WIDTH;
const DEFAULT_HEIGHT = 620;

const WINDOW_ID = 'default';
const WINDOW_LABEL = `multichat-${WINDOW_ID}`;
const STORAGE_PREFIX = 'streamnook.multichat.';
const KEEP_STORAGE_KEY = `${STORAGE_PREFIX}${WINDOW_ID}`;
// Last window position + size (physical px), so a reopen lands on the same monitor in
// the same spot. Deliberately uses a hyphen (not the `streamnook.multichat.` dot
// prefix) so the orphan-storage sweep below doesn't wipe it. The popout writes it on
// move/resize; this spawner reads it at creation.
export const MULTICHAT_GEOMETRY_KEY = 'streamnook.multichat-geometry';

/** Sweep orphan `streamnook.multichat.<random>` keys left behind by the
 *  pre-stable-id era. Cheap to run on every spawn; only touches our own
 *  prefix. */
function cleanupOrphanStorage(): void {
  try {
    const orphans: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX) && key !== KEEP_STORAGE_KEY) {
        orphans.push(key);
      }
    }
    for (const key of orphans) localStorage.removeItem(key);
    if (orphans.length > 0) {
      Logger.debug(`[MultiChat] Cleaned ${orphans.length} orphan storage key(s)`);
    }
  } catch (err) {
    Logger.warn('[MultiChat] orphan storage sweep failed:', err);
  }
}

export async function openMultiChatWindow(options: OpenMultiChatOptions = {}): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { emit } = await import('@tauri-apps/api/event');

    cleanupOrphanStorage();

    // Normalize to a single channel list, lowercased. `channels` (multi) wins
    // over the single-channel fields; either way the rest of the flow is uniform.
    const channelList = (options.channels && options.channels.length > 0
      ? options.channels
      : options.channel
        ? [{ channel: options.channel, channelId: options.channelId, channelName: options.channelName }]
        : []
    ).map((c) => ({
      channel: c.channel.toLowerCase(),
      channelId: c.channelId ?? null,
      channelName: c.channelName ?? c.channel,
    }));

    // If a popout already exists, focus it and ask it to add each requested
    // channel as a tab. The popout listens for `multichat-add-channel` and
    // routes each through its add/dedup path, so channels already open are no-ops.
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      try {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.show();
        await existing.setFocus();
      } catch (err) {
        Logger.warn('[MultiChat] focus existing popout failed:', err);
      }
      if (options.replace) {
        // Replace the popout's whole tab set with exactly this list.
        try {
          await emit('multichat-set-channels', { channels: channelList });
        } catch (err) {
          Logger.warn('[MultiChat] emit multichat-set-channels failed:', err);
        }
      } else {
        for (const c of channelList) {
          try {
            await emit('multichat-add-channel', {
              channel: c.channel,
              channelId: c.channelId,
              channelName: c.channelName,
            });
          } catch (err) {
            Logger.warn('[MultiChat] emit multichat-add-channel failed:', err);
          }
        }
      }
      return;
    }

    const params = new URLSearchParams({ id: WINDOW_ID });
    if (options.replace) params.set('replace', '1');
    if (channelList.length === 1) {
      // Single channel: use the discrete params (keeps the URL readable).
      params.set('channel', channelList[0].channel);
      if (channelList[0].channelId) params.set('channelId', channelList[0].channelId);
      if (channelList[0].channelName) params.set('channelName', channelList[0].channelName);
    } else if (channelList.length > 1) {
      // Multiple channels: seed them all on first mount via a JSON param, so a
      // brand-new window doesn't race an event listener that isn't up yet.
      params.set('channels', JSON.stringify(channelList));
    }

    // Restore the last saved position + size if we have one and it still falls on a
    // connected monitor (so a since-disconnected second screen doesn't strand the
    // window off-screen). Otherwise land it next to the main window.
    let x: number | undefined;
    let y: number | undefined;
    let width = options.width ?? DEFAULT_WIDTH;
    let height = options.height ?? DEFAULT_HEIGHT;
    let placed = false;
    try {
      const geo = JSON.parse(localStorage.getItem(MULTICHAT_GEOMETRY_KEY) || 'null');
      if (geo && ['x', 'y', 'width', 'height'].every((k) => typeof geo[k] === 'number')) {
        const { availableMonitors } = await import('@tauri-apps/api/window');
        const monitors = await availableMonitors().catch(() => []);
        const onScreen =
          monitors.length === 0 ||
          monitors.some((m) => {
            const right = m.position.x + m.size.width;
            const bottom = m.position.y + m.size.height;
            // The window's top-left should land inside a monitor (with a margin so a
            // slightly-overhanging window still counts as on-screen).
            return (
              geo.x >= m.position.x - 64 &&
              geo.x < right - 64 &&
              geo.y >= m.position.y - 32 &&
              geo.y < bottom - 32
            );
          });
        if (onScreen) {
          x = geo.x;
          y = geo.y;
          width = geo.width;
          height = geo.height;
          placed = true;
        }
      }
    } catch (err) {
      Logger.debug('[MultiChat] geometry restore failed:', err);
    }
    if (!placed) {
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
    }

    const title =
      options.title ??
      (channelList.length > 1
        ? `StreamNook MultiChat — ${channelList.length} channels`
        : channelList.length === 1
          ? `StreamNook MultiChat — ${channelList[0].channelName}`
          : 'StreamNook MultiChat');

    const win = new WebviewWindow(WINDOW_LABEL, {
      url: `${window.location.origin}/#/multichat?${params.toString()}`,
      title,
      width,
      height,
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

    Logger.debug(`[MultiChat] Opened window ${WINDOW_LABEL} for channel ${options.channel ?? '(empty)'}`);
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
