import { describe, expect, it } from 'vitest';
import { makeKey, normalizeChannel, parseKey } from './providerKey';

describe('providerKey', () => {
  it('lowercases case-insensitive platforms', () => {
    expect(makeKey('twitch', 'NickMercs')).toBe('twitch:nickmercs');
    expect(makeKey('kick', 'Trainwreck')).toBe('kick:trainwreck');
  });

  it('never normalises YouTube ids (a video id is case-sensitive)', () => {
    expect(makeKey('youtube', 'AGr94tpNVkw')).toBe('youtube:AGr94tpNVkw');
    expect(normalizeChannel('youtube', 'AGr94tpNVkw')).toBe('AGr94tpNVkw');
  });

  it('round-trips through parseKey', () => {
    const parsed = parseKey(makeKey('kick', 'SomeSlug'));
    expect(parsed).toEqual({ provider: 'kick', channel: 'someslug' });
  });

  it('treats a bare key as a legacy Twitch login', () => {
    expect(parseKey('nickmercs')).toEqual({ provider: 'twitch', channel: 'nickmercs' });
  });

  it('a Kick and a Twitch channel sharing a login stay distinct keys', () => {
    expect(makeKey('kick', 'shared')).not.toBe(makeKey('twitch', 'shared'));
  });
});
