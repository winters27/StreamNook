// Run with: npm test
//
// Every input below is copied from a real badge's earn text. The possessive
// case matters most: the previous pattern only accepted a straight apostrophe,
// while 126 badges in the catalogue use the curly one, so it never matched.

import { test } from 'vitest';
import assert from 'node:assert/strict';

import { extractChannelLogins } from './badgeChannels.ts';

test('finds a bare slash handle', () => {
  assert.deepEqual(
    extractChannelLogins('Subscribe or gift a sub to /studbudz during WNBA All-Star Weekend'),
    ['studbudz']
  );
});

test('finds a channel named in prose without a slash', () => {
  const text =
    'To earn this badge, subscribe to or gift a subscription to the participating channel StudBudz.';
  assert.deepEqual(extractChannelLogins(text), ['studbudz']);
});

test('finds possessives with either apostrophe', () => {
  assert.deepEqual(extractChannelLogins("watch Ibai's channel"), ['ibai']);
  assert.deepEqual(extractChannelLogins('watch Ibai’s channel'), ['ibai']);
  assert.deepEqual(
    extractChannelLogins('earned by watching 30 minutes of JasonTheWeen’s stream'),
    ['jasontheween']
  );
});

test('finds every channel in a twitch.tv list', () => {
  const text = 'on either of the following channels: twitch.tv/fps_shaka twitch.tv/legendus_shaka';
  const got = extractChannelLogins(text);
  assert.ok(got.includes('fps_shaka'));
  assert.ok(got.includes('legendus_shaka'));
});

test('splits a multi-channel phrase', () => {
  assert.deepEqual(
    extractChannelLogins('watch the channels Alpha_One and BetaTwo to qualify').sort(),
    ['alpha_one', 'betatwo']
  );
});

test('ignores site routes that are not channels', () => {
  assert.deepEqual(extractChannelLogins('see https://www.twitch.tv/directory/event/football-fest'), []);
  assert.deepEqual(extractChannelLogins('Twitch turbo page: https://www.twitch.tv/turbo'), []);
});

test('ignores generic words after "channel"', () => {
  assert.deepEqual(extractChannelLogins('any participating channel during the event'), []);
  assert.deepEqual(extractChannelLogins('subscribe to an eligible channel'), []);
  assert.deepEqual(extractChannelLogins('the streamer’s channel must be live'), []);
});

test('does not invent a channel from a date or a bare number', () => {
  assert.deepEqual(extractChannelLogins('Event duration: 2026-07-08 - 2026-08-24'), []);
});

test('dedupes a channel named more than one way', () => {
  const text = 'Subscribe to /studbudz. The participating channel StudBudz must be live.';
  assert.deepEqual(extractChannelLogins(text), ['studbudz']);
});
