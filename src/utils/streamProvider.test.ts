// Run with: npm test
//
// The "bare = twitch" convention is load-bearing: a Twitch row must keep
// producing a BARE login key, because favorites, resume snapshots and chat
// slices persisted before multi-platform browsing all store bare logins.

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { streamProvider, streamKey, streamThumbnail, buildProviderUrl } from './streamProvider.ts';

test('an untagged row reads as twitch', () => {
  assert.equal(streamProvider({}), 'twitch');
  assert.equal(streamProvider(null), 'twitch');
  assert.equal(streamProvider({ provider: 'kick' }), 'kick');
});

test('twitch rows key bare, provider rows key composite', () => {
  assert.equal(streamKey({ user_login: 'XQC' }), 'xqc');
  assert.equal(streamKey({ user_login: 'XQC', provider: 'twitch' }), 'xqc');
  assert.equal(streamKey({ user_login: 'XQC', provider: 'kick' }), 'kick:xqc');
});

test('thumbnails fill twitch templates and pass provider URLs through', () => {
  assert.equal(
    streamThumbnail({ thumbnail_url: 'https://cdn/{width}x{height}.jpg' }, 1280, 720),
    'https://cdn/1280x720.jpg',
  );
  assert.equal(
    streamThumbnail({ thumbnail_url: 'https://cdn/%{width}x%{height}.jpg' }, 640, 360),
    'https://cdn/640x360.jpg',
  );
  const literal = 'https://images.kick.com/thumb.webp';
  assert.equal(streamThumbnail({ thumbnail_url: literal }, 1280, 720), literal);
  assert.equal(streamThumbnail({ thumbnail_url: '' }, 1280, 720), '');
});

test('watch URLs match what the backend classifier accepts', () => {
  assert.equal(buildProviderUrl('kick', 'xqc'), 'https://kick.com/xqc');
  assert.equal(buildProviderUrl('twitch', 'xqc'), 'https://twitch.tv/xqc');
  assert.equal(buildProviderUrl('tiktok', 'pokimane'), 'https://www.tiktok.com/@pokimane/live');
  assert.equal(buildProviderUrl('youtube', '@LinusTechTips'), 'https://www.youtube.com/@LinusTechTips/live');
  assert.equal(
    buildProviderUrl('youtube', 'UCXuqSBlHAE6Xw-yeJA0Tunw'),
    'https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw/live',
  );
  assert.equal(buildProviderUrl('youtube', 'jfKfPfyJRdk'), 'https://www.youtube.com/watch?v=jfKfPfyJRdk');
});
