// Types for the plugin host UI. Mirrors the Rust types in
// src-tauri/src/plugin_host/ and the contract in docs/plugins/.

export type PluginTier = 'A' | 'B' | 'C';

export interface GrantedCaps {
  events: string[];
  host_methods: string[];
  credentials: string[];
  network: string;
  ui: string[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  tier: PluginTier;
  description: string;
  homepage: string | null;
  enabled: boolean;
  running: boolean;
  source: string;
  granted: GrantedCaps;
  credential_consent: Record<string, string>;
  has_panel: boolean;
}

export interface SourceInfo {
  url: string;
  name: string;
  operator: string;
  fingerprint: string;
  official: boolean;
}

export interface IndexEntry {
  id: string;
  name: string;
  version: string;
  tier: PluginTier;
  description: string;
  homepage: string | null;
  host_min: string;
  released_at: string | null;
  author: { name: string; pubkey: string; previous_pubkeys?: string[]; verified?: boolean };
  artifact: { url: string; sha256: string; size?: number; signature_url: string };
  // Marketplace metadata, all optional and presentation-only.
  icon_url?: string | null;
  banner_url?: string | null;
  readme_url?: string | null;
  downloads?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Positive when a is newer than b. Semver-ish, tolerant of short versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface PanelField {
  key: string;
  type: 'toggle' | 'number' | 'select' | 'text' | 'string_list';
  label: string;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export interface PanelSection {
  label?: string;
  description?: string;
  fields: PanelField[];
}

export interface PanelSchema {
  title: string;
  sections: PanelSection[];
}

export type PanelValues = Record<string, boolean | number | string | string[]>;

// The exact consent lines from docs/plugins/CAPABILITIES.md. The dialog
// renders these verbatim from the granted (or requested) capability set.
export function capabilityLines(caps: GrantedCaps): { text: string; warning: boolean }[] {
  const lines: { text: string; warning: boolean }[] = [];
  const watchEvents = ['on_stream_start', 'on_stream_stop', 'on_channel_change', 'on_watch_tick'];
  if (caps.events.some((e) => watchEvents.includes(e))) {
    lines.push({ text: 'Knows which channel you are watching', warning: false });
  }
  if (caps.events.includes('on_followed_live')) {
    lines.push({ text: 'Sees which channels you follow are live', warning: false });
  }
  if (caps.events.includes('on_ad_window')) {
    lines.push({ text: 'Knows when an ad break is detected', warning: false });
  }
  if (caps.events.includes('on_settings_change')) {
    lines.push({ text: 'Is told when certain app settings change', warning: false });
  }
  if (caps.host_methods.includes('get_followed_live')) {
    lines.push({ text: 'Can ask for your list of live followed channels', warning: false });
  }
  if (caps.host_methods.includes('set_upstream')) {
    lines.push({ text: 'Can supply the video source the player uses', warning: false });
  }
  if (caps.host_methods.includes('notify')) {
    lines.push({ text: 'Can show you notifications', warning: false });
  }
  if (caps.ui.includes('panel') || caps.host_methods.includes('register_panel')) {
    lines.push({ text: 'Adds a settings panel inside StreamNook', warning: false });
  }
  for (const kind of caps.credentials) {
    if (kind === 'twitch.android') {
      lines.push({
        text: 'Can request your Twitch login token. With it, this plugin can act as your Twitch account',
        warning: true,
      });
    }
  }
  if (caps.network === 'external') {
    lines.push({
      text: 'Makes its own network connections, to Twitch and elsewhere. StreamNook does not see or control this traffic',
      warning: false,
    });
  } else if (caps.network === 'none') {
    lines.push({ text: 'Declares that it makes no network connections of its own', warning: false });
  }
  return lines;
}

export const TIER_LABEL: Record<PluginTier, string> = {
  A: 'Safe',
  B: 'Unofficial interfaces',
  C: 'Account risk',
};
