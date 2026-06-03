-- Profile preferences. First use: whether a member wants their 7TV paint used
-- as their public profile theme (off = the tier-color theme). World-readable so
-- a viewer's overlay honors the choice. Future profile visibility toggles can
-- live here too. Idempotent.

CREATE TABLE IF NOT EXISTS user_profile_prefs (
    twitch_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    paint_theme    BOOLEAN NOT NULL DEFAULT false,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_profile_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profile_prefs_read ON user_profile_prefs;
CREATE POLICY user_profile_prefs_read ON user_profile_prefs FOR SELECT USING (true);

DROP POLICY IF EXISTS user_profile_prefs_write ON user_profile_prefs;
CREATE POLICY user_profile_prefs_write ON user_profile_prefs FOR ALL USING (true) WITH CHECK (true);
