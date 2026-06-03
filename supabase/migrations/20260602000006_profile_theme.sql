-- Profile theme source: what themes a member's profile background (and, later,
-- their chat messages). One of:
--   'tier'  - the free default (their rank tier aura)
--   'paint' - their equipped 7TV paint (premium)
--   '<id>'  - a StreamNook Atmosphere, e.g. 'void' (premium, StreamNook-designed)
-- Supersedes the paint_theme boolean (kept in sync for back-compat; profile_theme
-- is the source of truth). Idempotent.

ALTER TABLE user_profile_prefs ADD COLUMN IF NOT EXISTS profile_theme TEXT NOT NULL DEFAULT 'tier';

-- Carry forward anyone who already opted into the 7TV paint theme.
UPDATE user_profile_prefs SET profile_theme = 'paint' WHERE paint_theme = true AND profile_theme = 'tier';
