-- Per-channel watch time (minutes) per account, so the profile Overview can
-- show a "favorite channel" based on time actually spent watching (distinct
-- from the points-based "most points" stat). No historical source, so it
-- accumulates one minute at a time from first watch forward.
--
-- Same soft-auth posture as user_stats / user_emote_usage. Idempotent.

CREATE TABLE IF NOT EXISTS user_channel_watch (
    twitch_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id     TEXT NOT NULL,
    channel_login  TEXT NOT NULL,
    channel_name   TEXT NOT NULL,
    minutes        INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (twitch_user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_user_channel_watch_top
    ON user_channel_watch(twitch_user_id, minutes DESC);

-- Atomic per-minute increment (mirrors increment_user_stat).
CREATE OR REPLACE FUNCTION increment_channel_watch(
    p_user_id       TEXT,
    p_channel_id    TEXT,
    p_channel_login TEXT,
    p_channel_name  TEXT,
    p_amount        INT DEFAULT 1
)
RETURNS void AS $$
BEGIN
    INSERT INTO user_channel_watch (
        twitch_user_id, channel_id, channel_login, channel_name, minutes, updated_at
    )
    VALUES (p_user_id, p_channel_id, p_channel_login, p_channel_name, p_amount, now())
    ON CONFLICT (twitch_user_id, channel_id) DO UPDATE
    SET minutes       = user_channel_watch.minutes + p_amount,
        channel_login = EXCLUDED.channel_login,
        channel_name  = EXCLUDED.channel_name,
        updated_at    = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE user_channel_watch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_channel_watch_read ON user_channel_watch;
CREATE POLICY user_channel_watch_read ON user_channel_watch FOR SELECT USING (true);

DROP POLICY IF EXISTS user_channel_watch_write ON user_channel_watch;
CREATE POLICY user_channel_watch_write ON user_channel_watch FOR ALL USING (true) WITH CHECK (true);
