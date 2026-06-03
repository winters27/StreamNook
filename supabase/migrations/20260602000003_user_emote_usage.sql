-- Per-account emote usage: counts of the emotes a member uses in their OWN
-- sent messages, so the profile Overview can show their most-used emotes.
-- There is no historical source for this (Twitch exposes no personal emote-use
-- history), so it accumulates from first use forward, persisted to the account.
--
-- Same soft-auth posture as user_stats: the anon key increments rows keyed by
-- Twitch user_id via an atomic RPC (with a manual-upsert fallback in the
-- client). Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS user_emote_usage (
    twitch_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emote_id       TEXT NOT NULL,
    emote_name     TEXT NOT NULL,
    provider       TEXT NOT NULL,
    image_url      TEXT,
    count          INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (twitch_user_id, emote_id)
);

CREATE INDEX IF NOT EXISTS idx_user_emote_usage_top
    ON user_emote_usage(twitch_user_id, count DESC);

-- Atomic increment (mirrors increment_user_stat). Upserts the emote row and
-- adds p_amount to its count, refreshing the display metadata.
CREATE OR REPLACE FUNCTION increment_emote_usage(
    p_user_id    TEXT,
    p_emote_id   TEXT,
    p_emote_name TEXT,
    p_provider   TEXT,
    p_image_url  TEXT,
    p_amount     INT DEFAULT 1
)
RETURNS void AS $$
BEGIN
    INSERT INTO user_emote_usage (
        twitch_user_id, emote_id, emote_name, provider, image_url, count, updated_at
    )
    VALUES (p_user_id, p_emote_id, p_emote_name, p_provider, p_image_url, p_amount, now())
    ON CONFLICT (twitch_user_id, emote_id) DO UPDATE
    SET count      = user_emote_usage.count + p_amount,
        emote_name = EXCLUDED.emote_name,
        provider   = EXCLUDED.provider,
        image_url  = COALESCE(EXCLUDED.image_url, user_emote_usage.image_url),
        updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE user_emote_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_emote_usage_read ON user_emote_usage;
CREATE POLICY user_emote_usage_read ON user_emote_usage FOR SELECT USING (true);

-- Permissive write so the client's manual-upsert fallback works when the RPC
-- is unavailable (same posture as user_cosmetic_active).
DROP POLICY IF EXISTS user_emote_usage_write ON user_emote_usage;
CREATE POLICY user_emote_usage_write ON user_emote_usage FOR ALL USING (true) WITH CHECK (true);
