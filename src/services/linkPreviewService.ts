// Inline link previews for chat.
//
// The Rust `fetch_link_preview` command does the actual network fetch + metadata
// parse (so it sidesteps CORS and the webview never touches arbitrary pasted
// URLs). This module decides WHICH urls are allowed to auto-expand (a trusted-
// domain allowlist) and caches results per webview so repeated links and
// scroll-back re-renders don't refetch.

import { Logger } from '../utils/logger';

export type LinkPreviewKind = 'youtube' | 'image' | 'generic' | 'tweet' | 'media';

// Mirrors the Rust `LinkPreview` struct (serde keeps snake_case field names).
export interface LinkPreview {
  url: string;
  kind: LinkPreviewKind;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  author: string | null;
  author_avatar: string | null;
  video_id: string | null;
}

// Registrable domains we auto-expand. A host matches if it equals one of these
// or is a subdomain of it (so www.youtube.com, m.twitch.tv, i.imgur.com all
// resolve). Everything else stays a plain clickable link — no passive fetch,
// which keeps IP-grabber / shock-image links from auto-loading.
const TRUSTED_BASE_DOMAINS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'twitter.com',
  'x.com',
  'imgur.com',
  'giphy.com',
  'gph.is',
  'reddit.com',
  'redd.it',
  'github.com',
  'streamable.com',
  'kick.com',
  'spotify.com',
  'soundcloud.com',
  'tiktok.com',
];

export function isTrustedHost(host: string): boolean {
  const h = host.toLowerCase();
  return TRUSTED_BASE_DOMAINS.some((base) => h === base || h.endsWith(`.${base}`));
}

// Extract the trusted, previewable URLs from a message body. Capped (default 2)
// so a message that's a wall of links can't spawn a wall of cards. Dedupes and
// strips trailing sentence punctuation that the greedy match would otherwise
// swallow into the URL.
export function extractPreviewableUrls(text: string, max = 2): string[] {
  if (!text) return [];
  // Fast path: almost every chat line has no link. Skip the regex + URL parsing
  // (and the array work) entirely unless the text could plausibly contain one.
  if (!text.includes('http') && !text.includes('www.')) return [];
  const re = /(?:https?:\/\/|www\.)[^\s]+/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null && out.length < max) {
    const raw = match[0].replace(/[.,!?:;'")\]}>]+$/, '');
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!isTrustedHost(host)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Compact, single-line display label for a URL: drop the scheme and `www.`,
 * keep the host fully visible (so it's never misleading about where the link
 * goes), and truncate a long path/query/hash with an ellipsis.
 */
export function prettyUrlLabel(raw: string, maxLen = 40): string {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, '');
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    const full = host + rest;
    if (rest && full.length > maxLen) {
      const room = Math.max(0, maxLen - host.length - 1);
      return `${host}${rest.slice(0, room)}…`;
    }
    return full.replace(/\/$/, '') || host;
  } catch {
    return raw.length > maxLen ? `${raw.slice(0, maxLen - 1)}…` : raw;
  }
}

// --- In-flight dedupe (no cache) -------------------------------------------
//
// Chat links are ephemeral, so nothing is stored. The only coordination kept is
// an in-flight map that coalesces truly-concurrent requests for the same URL
// (e.g. the same link visible in two rows at once) into a single fetch. It self-
// empties the instant a request settles — it holds no resolved data.
const inflight = new Map<string, Promise<LinkPreview | null>>();

/**
 * Resolve a preview, coalescing concurrent requests for the same URL. Returns
 * null when there's no usable preview (the UI then just leaves the link as-is).
 * Never throws, never caches.
 */
export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async (): Promise<LinkPreview | null> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<LinkPreview>('fetch_link_preview', { url });
    } catch (err) {
      Logger.debug('[LinkPreview] no preview for', url, err);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, promise);
  return promise;
}
