-- StreamNook profile "award" badges: the persisted, account-tied collectibles
-- shown on the profile Overview (currently the seasonal / limited badges, e.g.
-- earned by opening StreamNook during a holiday window). Distinct from the
-- Twitch chat-badge concept ("earned_badges" via the Rust unified resolver) and
-- from the wearable `cosmetics` catalog.
--
-- Same soft-auth posture as user_stats / user_cosmetic_active: the anon key
-- writes rows keyed by Twitch user_id, the client asserting its own identity.
-- World-readable so a future profile-card surface can show others' badges.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS user_award_badges (
    twitch_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_id       TEXT NOT NULL,
    earned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (twitch_user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_award_badges_user ON user_award_badges(twitch_user_id);

ALTER TABLE user_award_badges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_award_badges_read ON user_award_badges;
CREATE POLICY user_award_badges_read ON user_award_badges FOR SELECT USING (true);

-- INSERT-only from the client (grant on earn). No UPDATE/DELETE needed: once a
-- badge is earned it stays earned, and the grant uses ON CONFLICT DO NOTHING.
DROP POLICY IF EXISTS user_award_badges_insert ON user_award_badges;
CREATE POLICY user_award_badges_insert ON user_award_badges FOR INSERT WITH CHECK (true);
