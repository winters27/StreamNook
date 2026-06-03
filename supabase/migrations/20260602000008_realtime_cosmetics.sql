-- Live cosmetic + badge updates without an app restart.
--
-- The desktop already subscribes to a `cosmetics-registry` realtime channel
-- (supabaseService.ts) that reloads entitlements/selections on any change to
-- user_cosmetics (INSERT) or user_cosmetic_active (*). For those broadcasts to
-- actually fire, the tables must be members of the `supabase_realtime`
-- publication. New tables are NOT added automatically, so without this a grant
-- or badge change only shows after a relaunch (which reloads from scratch).
--
-- Idempotent: each ADD TABLE is guarded so re-running is safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'user_cosmetics'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_cosmetics;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'user_cosmetic_active'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_cosmetic_active;
  END IF;
END $$;
