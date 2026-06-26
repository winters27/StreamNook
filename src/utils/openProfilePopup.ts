import { invoke } from '@tauri-apps/api/core';
import { Logger } from './logger';

/**
 * Open the same cursor-anchored user-profile popout window that clicking a
 * username in chat opens (the `/#/profile` WebviewWindow). Extracted so the mod
 * log (and anywhere else) can reuse it instead of the in-app modal.
 */
export async function openProfilePopup(opts: {
  userId: string;
  username: string; // login
  displayName?: string;
  color?: string;
  badges?: Array<{ key: string; info: unknown }>;
  channelId?: string;
  channelName?: string;
  /** Whether the viewer is a moderator/broadcaster in this channel. Drives the
   *  card's Moderator Actions zone (it also needs the resolved channel id as the
   *  broadcaster target, which the page derives from `channelId`). */
  isModerator?: boolean;
  clientX?: number;
  clientY?: number;
}): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const { getCurrentWindow, availableMonitors, currentMonitor } = await import(
      '@tauri-apps/api/window'
    );
    const mainWindow = getCurrentWindow();
    // innerPosition (the client-area top-left) plus the scale factor put the
    // cursor, whose clientX/Y are logical CSS pixels inside this window, into
    // physical desktop coordinates. That is the same space monitor bounds are
    // reported in, so the clamp math below stays consistent. outerPosition
    // would be off by the invisible DWM frame margin Windows reserves for the
    // drop shadow.
    const [winPos, scale] = await Promise.all([
      mainWindow.innerPosition(),
      mainWindow.scaleFactor(),
    ]);

    // Logical card size. These MUST match the width/height we request for the
    // window below, since the clamp converts them to physical via the scale.
    const cardWidth = 402;
    const cardHeight = 680;
    const gap = 10;

    // Cursor position in physical desktop pixels (falls back to this window's
    // origin if no click coords were supplied).
    const cursorX = winPos.x + (opts.clientX ?? 0) * scale;
    const cursorY = winPos.y + (opts.clientY ?? 0) * scale;

    // Card footprint and spacing in physical pixels, for clamping.
    const cardW = cardWidth * scale;
    const cardH = cardHeight * scale;
    const margin = 8 * scale;
    const gapPx = gap * scale;

    // Find the monitor the cursor sits on so the popup stays on-screen even on a
    // multi-monitor setup (a click on a secondary display should anchor there).
    // Fall back to the window's monitor, then to no clamp if neither resolves.
    let monitor: Awaited<ReturnType<typeof currentMonitor>> = null;
    try {
      const monitors = await availableMonitors();
      monitor =
        monitors.find(
          (m) =>
            cursorX >= m.position.x &&
            cursorX < m.position.x + m.size.width &&
            cursorY >= m.position.y &&
            cursorY < m.position.y + m.size.height,
        ) ?? null;
    } catch {
      /* availableMonitors unsupported on this platform, fall through */
    }
    if (!monitor) {
      try {
        monitor = await currentMonitor();
      } catch {
        /* ignore, clamp is skipped below */
      }
    }

    // Anchor to the LEFT of the cursor, vertically centered (the chat-click
    // behavior), then clamp the whole card inside the monitor so opening from a
    // log row near a screen edge can't push half the card off-screen.
    let x = cursorX - cardW - gapPx;
    let y = cursorY - cardH / 2;
    if (monitor) {
      const left = monitor.position.x;
      const top = monitor.position.y;
      const right = monitor.position.x + monitor.size.width;
      const bottom = monitor.position.y + monitor.size.height;
      // Not enough room on the left? Flip to the right of the cursor.
      if (x < left + margin) x = cursorX + gapPx;
      // Keep the full card within the monitor on both axes.
      x = Math.min(x, right - cardW - margin);
      x = Math.max(x, left + margin);
      y = Math.min(y, bottom - cardH - margin);
      y = Math.max(y, top + margin);
    } else {
      if (x < 0) x = cursorX + gapPx;
      if (y < 0) y = 0;
    }

    // The window options take LOGICAL pixels, so convert back from physical.
    const winX = Math.round(x / scale);
    const winY = Math.round(y / scale);

    let userId = opts.userId;
    let displayName = opts.displayName || opts.username;
    let channelId = opts.channelId || '';

    // The profile page fetches by user id; if we only have a login (e.g. an IRC
    // CLEARMSG delete carries no id), resolve it first so the popup still works.
    // Likewise resolve the CHANNEL id from its login when the caller supplied a
    // channel name but no id (the mod log only carries a channel login). Badges
    // are channel-scoped: with no channel the profile page falls back to the
    // viewed user's OWN channel, where everyone reads as the broadcaster. Run
    // both lookups together so we don't stack two round-trips.
    const needUser = !userId && !!opts.username;
    const needChannel = !channelId && !!opts.channelName;
    if (needUser || needChannel) {
      const [userInfo, channelInfo] = await Promise.all([
        needUser
          ? invoke<{ id?: string; display_name?: string }>('get_user_by_login', {
              login: opts.username.toLowerCase(),
            }).catch(() => null)
          : Promise.resolve(null),
        needChannel
          ? invoke<{ id?: string }>('get_user_by_login', {
              login: opts.channelName!.toLowerCase(),
            }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (userInfo?.id) userId = userInfo.id;
      if (needUser && !opts.displayName && userInfo?.display_name) {
        displayName = userInfo.display_name;
      }
      if (channelInfo?.id) channelId = channelInfo.id;
    }

    const windowLabel = `profile-${userId || opts.username}-${Date.now()}`;

    let messageHistory: unknown[] = [];
    if (userId) {
      try {
        messageHistory = await invoke<unknown[]>('get_user_message_history', { userId });
      } catch {
        /* no history is fine */
      }
    }

    const params = new URLSearchParams({
      userId: userId || '',
      username: opts.username || '',
      displayName,
      color: opts.color || '',
      badges: JSON.stringify(opts.badges || []),
      channelId: channelId || '',
      channelName: opts.channelName || '',
      isModerator: opts.isModerator ? '1' : '',
      messageHistory: JSON.stringify(messageHistory),
    });

    const profileWindow = new WebviewWindow(windowLabel, {
      url: `${window.location.origin}/#/profile?${params.toString()}`,
      title: `${displayName}'s Profile`,
      width: cardWidth,
      height: cardHeight,
      x: winX,
      y: winY,
      resizable: false,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      focus: true,
    });
    profileWindow.once('tauri://error', (e) => Logger.error('Error opening profile window:', e));
  } catch (err) {
    Logger.error('Failed to open profile popup:', err);
  }
}
