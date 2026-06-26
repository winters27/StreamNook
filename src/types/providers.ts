// Provider identity for multi-platform chat + events.
//
// Twitch is the established native path; the other platforms light up per
// release phase via the `enabled` flag below. A "source" the user watches is
// identified by a composite `<provider>:<channel>` key (see utils/providerKey).

export type ProviderId = 'twitch' | 'kick' | 'youtube' | 'rumble' | 'tiktok' | 'x';

export const PROVIDER_IDS: ProviderId[] = ['twitch', 'kick', 'youtube', 'rumble', 'tiktok', 'x'];

export const DEFAULT_PROVIDER: ProviderId = 'twitch';

// How sending a message is achieved on a platform. Drives the chat input's
// read-only vs sendable state and which connection a send routes through.
//   native  - existing first-party path (Twitch IRC/Helix)
//   oauth   - official write API behind an account connection (Kick)
//   webview - typed into the platform's own logged-in page (YouTube/Rumble/TikTok/X)
//   none    - sending not supported
export type SendSupport = 'native' | 'oauth' | 'webview' | 'none';

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  // Whether the adapter is wired up and offered in the add-source picker.
  // Flips to true as each platform phase ships; Twitch only at first.
  enabled: boolean;
  send: SendSupport;
  // True when even READING chat requires a hosted webview (X). Most read natively.
  readNeedsWebview: boolean;
  // Brand color for the provider chip in the activity feed and source rows.
  color: string;
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  twitch: { id: 'twitch', label: 'Twitch', enabled: true, send: 'native', readNeedsWebview: false, color: '#9147ff' },
  kick: { id: 'kick', label: 'Kick', enabled: false, send: 'oauth', readNeedsWebview: false, color: '#53fc18' },
  youtube: { id: 'youtube', label: 'YouTube', enabled: true, send: 'webview', readNeedsWebview: false, color: '#ff0000' },
  rumble: { id: 'rumble', label: 'Rumble', enabled: false, send: 'webview', readNeedsWebview: false, color: '#85c742' },
  tiktok: { id: 'tiktok', label: 'TikTok', enabled: false, send: 'webview', readNeedsWebview: false, color: '#00f2ea' },
  x: { id: 'x', label: 'X', enabled: false, send: 'webview', readNeedsWebview: true, color: '#1d9bf0' },
};

export function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_IDS as string[]).includes(v);
}

export function providerLabel(id: string): string {
  return isProviderId(id) ? PROVIDERS[id].label : id;
}
