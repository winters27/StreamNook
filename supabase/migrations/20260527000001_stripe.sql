-- Stripe-side bookkeeping for streamnook.app.
--
-- Three new tables that live alongside the Ko-fi schema. Ko-fi tables stay
-- in place for historical audit, but no new Ko-fi rows are expected after
-- the streamnook.app cutover. Cosmetics + user_cosmetics + user_subscriber_state
-- are SHARED — the Stripe webhook writes to the same downstream tables the
-- Ko-fi webhook does, so the desktop app's realtime entitlement bridging is
-- already wired for free.
--
-- Idempotent: re-running this migration is safe.

-- ─── Stripe customer lookup ──────────────────────────────────────────────
-- One row per Twitch user, populated lazily by the checkout endpoint the
-- first time they pay. Cached so we don't have to round-trip Stripe's
-- /customers/search (which has eventual-consistency latency) on every
-- checkout attempt.
CREATE TABLE IF NOT EXISTS stripe_customers (
    twitch_user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id TEXT NOT NULL UNIQUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Stripe subscription state ───────────────────────────────────────────
-- One row per active or recently-active subscription. Distinct from
-- user_subscriber_state, which is the LIFETIME bookkeeping (months ever
-- paid). This table holds the CURRENT subscription's status (active /
-- past_due / canceled / inactive) so the account page can render a real
-- "renews on X" or "ends on X" string instead of inferring from
-- last_paid_at.
CREATE TABLE IF NOT EXISTS stripe_subscriptions (
    stripe_subscription_id TEXT PRIMARY KEY,
    twitch_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id     TEXT NOT NULL,
    status                 TEXT NOT NULL, -- active | past_due | canceled | unpaid | incomplete | trialing
    current_period_end     TIMESTAMPTZ,
    cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
    price_id               TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_user
    ON stripe_subscriptions(twitch_user_id);

CREATE INDEX IF NOT EXISTS idx_stripe_subscriptions_status
    ON stripe_subscriptions(status) WHERE status IN ('active', 'past_due');

-- ─── Stripe transaction audit (idempotency + reporting) ──────────────────
-- One row per Stripe event we've processed. PK on stripe_event_id makes
-- replays a no-op. Mirrors the shape of kofi_transactions so future
-- reporting can UNION across sources if we ever want a unified view.
CREATE TABLE IF NOT EXISTS stripe_transactions (
    stripe_event_id        TEXT PRIMARY KEY,
    event_type             TEXT NOT NULL,
    stripe_customer_id     TEXT,
    twitch_user_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
    amount_cents           INT,
    currency               TEXT,
    payment_intent_id      TEXT,
    invoice_id             TEXT,
    subscription_id        TEXT,
    checkout_session_id    TEXT,
    tier                   TEXT, -- 'supporter' | 'subscriber'
    cosmetic_slug          TEXT REFERENCES cosmetics(slug) ON DELETE SET NULL,
    raw_data               JSONB,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_txn_user
    ON stripe_transactions(twitch_user_id) WHERE twitch_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stripe_txn_event_type
    ON stripe_transactions(event_type);

-- ─── Cosmetics catalog: add stripe_url alongside ko_fi_url ───────────────
-- ko_fi_url stays populated for historical reference. New surfaces should
-- read stripe_url first and fall back. The streamnook.app domain is fixed,
-- so this column is mostly informational — the actual checkout URL is
-- generated dynamically by /api/checkout.
ALTER TABLE cosmetics ADD COLUMN IF NOT EXISTS stripe_url TEXT;

UPDATE cosmetics SET stripe_url = 'https://streamnook.app/support?tier=supporter'
  WHERE slug = 'streamnook-supporter';

UPDATE cosmetics SET stripe_url = 'https://streamnook.app/support?tier=subscriber'
  WHERE slug = 'streamnook-subscriber';

-- ─── RLS: world-readable for the account dashboard's anon reads ──────────
-- Writes are service-role only (the stripe-webhook Edge Function).
ALTER TABLE stripe_customers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_transactions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_subscriptions_read ON stripe_subscriptions;
CREATE POLICY stripe_subscriptions_read ON stripe_subscriptions FOR SELECT USING (true);

-- stripe_customers + stripe_transactions are deliberately NOT exposed via
-- read policies. They contain Stripe customer ids and event payloads that
-- should only be reachable via the server (service_role bypasses RLS).
