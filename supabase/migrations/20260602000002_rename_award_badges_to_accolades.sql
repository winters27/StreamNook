-- Rename the profile "award badges" store to "accolades", freeing the word
-- "badge" (which means the wearable cosmetic / Twitch chat badge) from this
-- concept. Data-preserving: ALTER ... RENAME keeps every earned row, so an
-- already-collected accolade (e.g. the Spring season) survives the rename.
--
-- Idempotent: safe to re-run.

ALTER TABLE IF EXISTS user_award_badges RENAME TO user_accolades;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_accolades' AND column_name = 'badge_id'
  ) THEN
    ALTER TABLE user_accolades RENAME COLUMN badge_id TO accolade_id;
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_user_award_badges_user RENAME TO idx_user_accolades_user;

-- Recreate policies under the new names (RLS stays enabled across the rename).
DROP POLICY IF EXISTS user_award_badges_read ON user_accolades;
DROP POLICY IF EXISTS user_award_badges_insert ON user_accolades;
DROP POLICY IF EXISTS user_accolades_read ON user_accolades;
DROP POLICY IF EXISTS user_accolades_insert ON user_accolades;
CREATE POLICY user_accolades_read ON user_accolades FOR SELECT USING (true);
CREATE POLICY user_accolades_insert ON user_accolades FOR INSERT WITH CHECK (true);
