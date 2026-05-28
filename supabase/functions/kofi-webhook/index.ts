// Ko-fi webhook handler.
//
// Ko-fi POSTs application/x-www-form-urlencoded with a single `data` field
// that contains the JSON payload. We verify the token, dedup by message_id,
// match the donor to a Twitch user (primary: @twitchhandle in the donation
// message; fallback: kofi_email_links override), and award the matching
// cosmetic entitlement based on payment_type.
//
// Ported from Magne's server/src/routes/kofi.rs (axum + sqlx) to Deno +
// Supabase service_role. Always returns 200 so Ko-fi stops retrying.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface KofiPayload {
  verification_token?: string;
  message_id: string;
  timestamp?: string;
  type: string;
  is_public?: boolean;
  from_name?: string;
  email?: string;
  amount?: string;
  currency?: string;
  is_subscription_payment?: boolean;
  is_first_subscription_payment?: boolean;
  tier_name?: string;
  message?: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KOFI_VERIFICATION_TOKEN = Deno.env.get("KOFI_VERIFICATION_TOKEN") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const log = (msg: string, extra?: Record<string, unknown>) => {
  if (extra) console.log(`[kofi-webhook] ${msg}`, JSON.stringify(extra));
  else console.log(`[kofi-webhook] ${msg}`);
};

const parseAmount = (raw: string | undefined): number => {
  if (!raw) return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Pick the highest-tier cosmetic the payment amount qualifies for.
 *
 * The selection ignores Ko-fi's payment_type (Donation vs Subscription) by
 * design: a one-time $5 tip and a $5 monthly sub both clear the subscriber
 * threshold from the donor's perspective. Tiering is amount-driven only, so
 * adding a new $10 "patron" badge with min_amount = 10 is a pure catalog
 * insert with no webhook change required.
 *
 * Order: min_amount DESC, then sort_order DESC as a tiebreaker (sort_order
 * encodes catalog prominence — subscriber=20 > supporter=10 — and breaks
 * ties for tiers that happen to share a price). Returns null if the amount
 * doesn't clear any catalog row, or if Ko-fi sent a non-monetary event type
 * we don't recognize.
 */
const pickCosmeticByAmount = async (
  payload: KofiPayload,
  amount: number,
): Promise<{ slug: string; min_amount: number } | null> => {
  // Gate on Ko-fi event types that carry money. Commission / Shop Order
  // payloads still get logged for audit but won't award a badge.
  if (
    payload.type !== "Donation" &&
    payload.type !== "Subscription" &&
    !payload.is_subscription_payment
  ) {
    return null;
  }

  const { data, error } = await supabase
    .from("cosmetics")
    .select("slug, min_amount, sort_order")
    .not("min_amount", "is", null)
    .order("min_amount", { ascending: false })
    .order("sort_order", { ascending: false });
  if (error) {
    log("cosmetic catalog scan failed", { error: error.message });
    return null;
  }

  for (const row of data ?? []) {
    const minAmount = Number(row.min_amount ?? 0);
    if (amount >= minAmount) return { slug: row.slug, min_amount: minAmount };
  }
  return null;
};

const extractTwitchHandleCandidates = (msg: string | undefined): string[] => {
  if (!msg) return [];
  const tokens = msg.split(/\s+/);
  const out: string[] = [];
  for (const t of tokens) {
    const candidate = t.replace(/^[@]+/, "").trim().toLowerCase();
    if (candidate.length < 3) continue;
    // Twitch handles are [a-zA-Z0-9_] with length 4..25 in practice; we
    // accept 3+ here to keep this forgiving.
    if (!/^[a-z0-9_]+$/.test(candidate)) continue;
    out.push(candidate);
  }
  return out;
};

const matchUser = async (
  payload: KofiPayload,
  email: string | null,
): Promise<{ userId: string; via: string } | null> => {
  // 1. @twitchhandle in the donation message (primary).
  for (const candidate of extractTwitchHandleCandidates(payload.message)) {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .ilike("username", candidate)
      .maybeSingle();
    if (error) {
      log("user lookup by username failed", { candidate, error: error.message });
      continue;
    }
    if (data?.id) {
      // Auto-link this Ko-fi email so future donations from the same email
      // match directly without needing the @mention again.
      if (email) {
        const { error: linkErr } = await supabase
          .from("kofi_email_links")
          .upsert(
            { user_id: data.id, kofi_email: email, linked_by: "auto-message" },
            { onConflict: "kofi_email" },
          );
        if (linkErr) log("auto email-link insert failed", { error: linkErr.message });
      }
      return { userId: data.id, via: "message-mention" };
    }
  }

  // 2. kofi_email_links override (admin link page or prior auto-link).
  if (email) {
    const { data, error } = await supabase
      .from("kofi_email_links")
      .select("user_id")
      .eq("kofi_email", email)
      .maybeSingle();
    if (error) {
      log("email-link lookup failed", { error: error.message });
    } else if (data?.user_id) {
      return { userId: data.user_id, via: "email-link" };
    }
  }

  return null;
};

const awardCosmetic = async (
  userId: string,
  slug: string,
  paymentId: string,
): Promise<boolean> => {
  const { error } = await supabase
    .from("user_cosmetics")
    .insert({
      twitch_user_id: userId,
      slug,
      source: "kofi",
      payment_id: paymentId,
    });

  if (!error) return true;

  // 23505 = unique_violation; the user already has this cosmetic.
  if ((error as { code?: string }).code === "23505") {
    log("user already owns cosmetic", { userId, slug });
    return false;
  }

  log("cosmetic insert failed", { userId, slug, error: error.message });
  return false;
};

const logTransaction = async (
  payload: KofiPayload,
  email: string | null,
  matched: { userId: string; via: string } | null,
  cosmeticSlug: string | null,
  subscriberMonths: number | null,
): Promise<void> => {
  const rawData: Record<string, unknown> = {
    ...(payload as unknown as Record<string, unknown>),
  };
  if (subscriberMonths !== null) {
    rawData.subscriber_months_after = subscriberMonths;
  }
  const { error } = await supabase
    .from("kofi_transactions")
    .upsert(
      {
        message_id: payload.message_id,
        kofi_email: email,
        from_name: payload.from_name ?? null,
        amount: payload.amount ?? null,
        currency: payload.currency ?? null,
        payment_type: payload.type,
        is_subscription: payload.is_subscription_payment ?? false,
        is_first_sub: payload.is_first_subscription_payment ?? false,
        is_public: payload.is_public ?? true,
        tier_name: payload.tier_name ?? null,
        matched_user_id: matched?.userId ?? null,
        matched_via: matched?.via ?? null,
        cosmetic_slug: cosmeticSlug,
        raw_data: rawData,
      },
      { onConflict: "message_id" },
    );

  if (error) log("transaction log failed", { error: error.message });
};

/**
 * Atomically increment the user's subscriber-state row.
 *
 * Called on every Subscription payment after the cosmetic grant. The
 * Postgres-side function is responsible for the insert-or-bump-counter
 * semantics so concurrent webhooks can't lose increments. Returns the new
 * total_months for audit logging (and, in a later iteration, for tier-
 * threshold checks against catalog rows with `min_months_subscribed`).
 */
const recordSubscriberPayment = async (
  userId: string,
  paymentId: string,
  paidAt: string,
): Promise<number | null> => {
  const { data, error } = await supabase.rpc("record_subscriber_payment", {
    p_user_id: userId,
    p_payment_id: paymentId,
    p_paid_at: paidAt,
  });
  if (error) {
    log("record_subscriber_payment failed", { userId, error: error.message });
    return null;
  }
  return typeof data === "number" ? data : null;
};

const isDuplicate = async (messageId: string): Promise<boolean> => {
  const { data, error } = await supabase
    .from("kofi_transactions")
    .select("message_id")
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) {
    log("dedup check failed", { error: error.message });
    return false;
  }
  return !!data;
};

const parsePayload = async (req: Request): Promise<KofiPayload | null> => {
  const contentType = req.headers.get("content-type") ?? "";
  let raw: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    raw = form.get("data") as string | null;
  } else if (contentType.includes("application/json")) {
    // Defensive: some Ko-fi setups can be configured for JSON; accept both.
    const body = await req.json().catch(() => null);
    if (body && typeof body === "object" && "data" in body) {
      raw = (body as { data: string }).data;
    } else {
      return body as KofiPayload | null;
    }
  } else {
    // Fallback: try form parsing anyway.
    try {
      const form = await req.formData();
      raw = form.get("data") as string | null;
    } catch {
      return null;
    }
  }

  if (!raw) return null;
  try {
    return JSON.parse(raw) as KofiPayload;
  } catch (e) {
    log("payload JSON parse failed", { error: String(e) });
    return null;
  }
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = await parsePayload(req);
  if (!payload || !payload.message_id) {
    log("invalid payload, accepting to stop retries");
    return new Response("ok", { status: 200 });
  }

  if (KOFI_VERIFICATION_TOKEN) {
    const provided = payload.verification_token ?? "";
    if (provided !== KOFI_VERIFICATION_TOKEN) {
      log("invalid verification token", { message_id: payload.message_id });
      return new Response("ok", { status: 200 });
    }
  }

  if (await isDuplicate(payload.message_id)) {
    log("duplicate message_id, skipping", { message_id: payload.message_id });
    return new Response("ok", { status: 200 });
  }

  const email = payload.email?.trim().toLowerCase() || null;
  const matched = await matchUser(payload, email);

  // Amount-driven tier selection. The catalog's min_amount column gates
  // entry; pickCosmeticByAmount picks the highest-tier row the payment
  // clears. Currency assumption: numeric comparison against the raw amount
  // field, implicitly USD. Non-USD donations are treated by raw number; if
  // that bites later, swap to a currency-aware conversion.
  const actualAmount = parseAmount(payload.amount);
  const qualified = matched ? await pickCosmeticByAmount(payload, actualAmount) : null;
  const qualifyingSlug = qualified?.slug ?? null;
  const belowMinReason: { min: number; actual: number } | null =
    matched && !qualified && (payload.type === "Donation" || payload.type === "Subscription" || payload.is_subscription_payment)
      ? { min: 0, actual: actualAmount } // exact min unknowable when nothing matched; keep audit shape
      : null;

  let awarded = false;
  if (matched && qualifyingSlug) {
    awarded = await awardCosmetic(matched.userId, qualifyingSlug, payload.message_id);
  }

  // Subscription bookkeeping: every QUALIFYING Subscription payment bumps
  // total_months and refreshes last_paid_at. Under-min payments skip this
  // so future tiered-month badges (3mo, 6mo, etc.) only count payments
  // that met the threshold.
  let subscriberMonths: number | null = null;
  const isSubscriptionPayment =
    matched &&
    (payload.type === "Subscription" || payload.is_subscription_payment === true);
  if (isSubscriptionPayment && qualifyingSlug) {
    // Ko-fi's `timestamp` is an epoch string; fall back to now if missing
    // so the payment still records cleanly.
    const paidAtIso = (() => {
      const raw = payload.timestamp;
      if (!raw) return new Date().toISOString();
      const asNumber = Number(raw);
      const d = Number.isFinite(asNumber) ? new Date(asNumber) : new Date(raw);
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })();
    subscriberMonths = await recordSubscriberPayment(
      matched.userId,
      payload.message_id,
      paidAtIso,
    );
  }

  // Stash below-minimum details in raw_data so the audit row carries the
  // reason a matched user didn't get awarded. Brandon can SQL through these
  // later to manually grant if he wants to be generous to small donors.
  if (belowMinReason) {
    (payload as unknown as Record<string, unknown>).award_skipped_reason = "below_minimum";
    (payload as unknown as Record<string, unknown>).min_amount = belowMinReason.min;
    (payload as unknown as Record<string, unknown>).actual_amount = belowMinReason.actual;
  }

  await logTransaction(payload, email, matched, awarded ? qualifyingSlug : null, subscriberMonths);

  log("processed", {
    message_id: payload.message_id,
    type: payload.type,
    amount: actualAmount,
    matched: matched?.userId ?? null,
    via: matched?.via ?? null,
    qualifying_cosmetic: qualifyingSlug,
    awarded,
    subscriber_months: subscriberMonths,
    below_min: belowMinReason,
  });

  return new Response("ok", { status: 200 });
});
