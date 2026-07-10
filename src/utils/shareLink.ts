// Single source of truth for the shape of a shared stream link.
//
// Share buttons copy the web link (streamnook.app/w/<channel>) rather than the
// raw streamnook:// protocol so the link works for everyone: the landing page
// hands off to the app when it's installed and falls back to Twitch when it
// isn't. The app protocol below is what that page hands off to, and what the
// Rust deep-link handler parses back into a channel.

const SHARE_BASE = 'https://streamnook.app/w';

/** The web link to copy/share for a channel login. */
export function buildShareUrl(channelLogin: string): string {
  return `${SHARE_BASE}/${encodeURIComponent(normalizeLogin(channelLogin))}`;
}

/** The direct app-protocol link the landing page hands off to. */
export function buildDeepLink(channelLogin: string): string {
  return `streamnook://watch/${encodeURIComponent(normalizeLogin(channelLogin))}`;
}

// Defensive: callers pass a stream's user_login, which is normally present, but
// guard against null/undefined/whitespace so a Share click can never throw.
function normalizeLogin(channelLogin: string | null | undefined): string {
  return (channelLogin ?? '').trim().toLowerCase();
}
