-- Per-section public-profile visibility. An array of section keys the member has
-- HIDDEN from their public profile (what other StreamNook users see in the
-- overlay). Empty = everything visible (the default). World-readable (the prefs
-- table already is) so a viewer's overlay honors it. Keys: roast, twitch,
-- lifetime, emotes, accolades. (Subscriptions/spend are never persisted, always
-- private, so they aren't in this list.) Idempotent.

ALTER TABLE user_profile_prefs ADD COLUMN IF NOT EXISTS hidden_sections TEXT[] NOT NULL DEFAULT '{}';
