import type { ProviderId } from '../types/providers';
import { DEFAULT_PROVIDER, isProviderId } from '../types/providers';

// Composite source key "<provider>:<channel>" used across the chat store, the
// activity store, and the add-source flow. Mirrors the Rust codec in
// services/providers/key.rs. A bare key (no recognised provider prefix) is
// treated as a legacy Twitch login so older persisted state keeps working.

export function makeKey(provider: ProviderId, channel: string): string {
  return `${provider}:${channel.toLowerCase()}`;
}

export interface ParsedKey {
  provider: ProviderId;
  channel: string;
}

export function parseKey(key: string): ParsedKey {
  const i = key.indexOf(':');
  if (i !== -1) {
    const maybe = key.slice(0, i);
    if (isProviderId(maybe)) {
      return { provider: maybe, channel: key.slice(i + 1) };
    }
  }
  // Bare login, or text that merely contains a colon: read as Twitch.
  return { provider: DEFAULT_PROVIDER, channel: key.toLowerCase() };
}

export function keyProvider(key: string): ProviderId {
  return parseKey(key).provider;
}

export function keyChannel(key: string): string {
  return parseKey(key).channel;
}
