// Stripe webhook handler for streamnook.app payments. We listen for:
//   - checkout.session.completed       → one-time Supporter donations
//   - invoice.payment_succeeded        → recurring Subscriber renewals
//   - customer.subscription.updated    → status + cancel_at_period_end + period_end changes
//   - customer.subscription.deleted    → subscription ended (graceful or otherwise)
//
// Authentication: HMAC-SHA256 signature in `Stripe-Signature` header against
// STRIPE_WEBHOOK_SECRET (the endpoint signing secret from the Stripe
// dashboard). We verify the timestamp tolerance + the v1 signature ourselves
// since the Deno-friendly Stripe SDK doesn't exist as a drop-in.
//
// Idempotency: stripe_transactions PK is stripe_event_id. We check existence
// before mutating downstream tables.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

// Webhook timestamp tolerance: Stripe's docs recommend 5 minutes.
const SIG_TOLERANCE_SECONDS = 300;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const log = (msg: string, extra?: Record<string, unknown>) => {
  if (extra) console.log(`[stripe-webhook] ${msg}`, JSON.stringify(extra));
  else console.log(`[stripe-webhook] ${msg}`);
};

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
}

async function verifySignature(payload: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !secret) return false;
  // Format: t=<unix>,v1=<hex>,v0=<hex>...
  const parts = header.split(",").reduce<Record<string, string>>((acc, p) => {
    const eq = p.indexOf("=");
    if (eq === -1) return acc;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k === "t" || k === "v1") acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > SIG_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedPayload = `${parts.t}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function isDuplicate(eventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("stripe_transactions")
    .select("stripe_event_id")
    .eq("stripe_event_id", eventId)
    .maybeSingle();
  if (error) {
    log("dedup check failed", { error: error.message });
    return false;
  }
  return !!data;
}

async function pickQualifyingCosmetic(
  tier: "supporter" | "subscriber",
  amountCents: number,
): Promise<{ slug: string; min_amount: number } | null> {
  const { data, error } = await supabase
    .from("cosmetics")
    .select("slug, min_amount, sort_order")
    .not("min_amount", "is", null)
    .order("min_amount", { ascending: false })
    .order("sort_order", { ascending: false });
  if (error) {
    log("catalog scan failed", { error: error.message });
    return null;
  }
  // Subscription tier ALWAYS gets the subscriber slug if amount qualifies.
  // For supporter donations, pick the highest-tier slug the amount clears.
  // Tiers are catalog-driven: adding a $10 patron tier later is a pure
  // catalog insert with no webhook change required.
  const dollars = amountCents / 100;
  if (tier === "subscriber") {
    const row = (data ?? []).find(r => r.slug === "streamnook-subscriber");
    if (row && dollars >= Number(row.min_amount ?? 0)) {
      return { slug: row.slug, min_amount: Number(row.min_amount) };
    }
    return null;
  }
  for (const row of data ?? []) {
    if (row.slug === "streamnook-subscriber") continue; // exclude subscriber tier from one-time picks
    const min = Number(row.min_amount ?? 0);
    if (dollars >= min) return { slug: row.slug, min_amount: min };
  }
  return null;
}

// Subscription-tier monetary value is always >= the supporter threshold
// ($5/mo subscriber min vs. $3 supporter min), so any subscription payment
// that clears even the supporter threshold should grant the supporter
// cosmetic alongside the subscriber one. Picks the same "highest tier the
// amount clears among one-time tiers" the supporter check does — keeps the
// logic open for future tiered one-time badges.
async function pickQualifyingOneTimeCosmetic(
  amountCents: number,
): Promise<{ slug: string; min_amount: number } | null> {
  return pickQualifyingCosmetic("supporter", amountCents);
}

async function awardCosmetic(
  twitchUserId: string,
  slug: string,
  paymentId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("user_cosmetics")
    .insert({
      twitch_user_id: twitchUserId,
      slug,
      source: "stripe",
      payment_id: paymentId,
    });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") {
    log("user already owns cosmetic", { twitchUserId, slug });
    return false;
  }
  log("cosmetic insert failed", { twitchUserId, slug, error: error.message });
  return false;
}

async function recordSubscriberPayment(
  twitchUserId: string,
  paymentId: string,
  paidAt: string,
): Promise<number | null> {
  // Idempotency guard: invoice.paid AND invoice.payment_succeeded BOTH fire for
  // the same paid invoice (and both route here), with distinct event ids, so
  // the outer event-id dedup doesn't catch them. The RPC does an unconditional
  // +1, so guard here on the payment id (the invoice id) to count each invoice
  // exactly once even when both events are registered or Stripe retries.
  const { data: existing } = await supabase
    .from("user_subscriber_state")
    .select("last_payment_id")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();
  if ((existing?.last_payment_id as string | undefined) === paymentId) {
    log("subscriber payment already counted, skipping", { twitchUserId, paymentId });
    return null;
  }

  const { data, error } = await supabase.rpc("record_subscriber_payment", {
    p_user_id: twitchUserId,
    p_payment_id: paymentId,
    p_paid_at: paidAt,
  });
  if (error) {
    log("record_subscriber_payment failed", { twitchUserId, error: error.message });
    return null;
  }
  return typeof data === "number" ? data : null;
}

async function upsertCustomerLookup(twitchUserId: string, customerId: string): Promise<void> {
  const { error } = await supabase
    .from("stripe_customers")
    .upsert(
      { twitch_user_id: twitchUserId, stripe_customer_id: customerId },
      { onConflict: "twitch_user_id" },
    );
  if (error) log("stripe_customers upsert failed", { error: error.message });
}

async function upsertSubscription(
  subscriptionId: string,
  twitchUserId: string,
  customerId: string,
  status: string,
  currentPeriodEnd: number | null,
  cancelAtPeriodEnd: boolean,
  priceId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("stripe_subscriptions")
    .upsert(
      {
        stripe_subscription_id: subscriptionId,
        twitch_user_id: twitchUserId,
        stripe_customer_id: customerId,
        status,
        current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
        cancel_at_period_end: cancelAtPeriodEnd,
        price_id: priceId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" },
    );
  if (error) log("stripe_subscriptions upsert failed", { error: error.message });
}

async function logTransaction(
  event: StripeEvent,
  twitchUserId: string | null,
  amountCents: number | null,
  currency: string | null,
  tier: string | null,
  cosmeticSlug: string | null,
): Promise<void> {
  const obj = event.data.object as Record<string, unknown>;
  const { error } = await supabase
    .from("stripe_transactions")
    .upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        stripe_customer_id: (obj.customer as string | null) ?? null,
        twitch_user_id: twitchUserId,
        amount_cents: amountCents,
        currency,
        payment_intent_id: (obj.payment_intent as string | null) ?? null,
        invoice_id: (obj.invoice as string | null) ?? (event.type.startsWith("invoice.") ? (obj.id as string) : null),
        subscription_id: (obj.subscription as string | null) ?? (event.type.startsWith("customer.subscription.") ? (obj.id as string) : null),
        checkout_session_id: event.type === "checkout.session.completed" ? (obj.id as string) : null,
        tier,
        cosmetic_slug: cosmeticSlug,
        raw_data: event,
      },
      { onConflict: "stripe_event_id" },
    );
  if (error) log("audit log failed", { error: error.message });
}

function readMetadata(obj: Record<string, unknown>, key: string): string | null {
  const meta = obj.metadata as Record<string, string> | undefined;
  return meta?.[key] ?? null;
}

async function handleCheckoutCompleted(event: StripeEvent): Promise<void> {
  const session = event.data.object as Record<string, unknown>;
  const customerId = (session.customer as string | null) ?? null;
  const twitchUserId =
    readMetadata(session, "twitch_user_id") ?? (session.client_reference_id as string | null) ?? null;
  const tier = (readMetadata(session, "tier") as "supporter" | "subscriber" | null) ?? null;
  const amountTotal = (session.amount_total as number | null) ?? null;
  const currency = (session.currency as string | null) ?? null;

  if (!twitchUserId || !tier) {
    log("checkout missing twitch_user_id or tier; skipping award", { event_id: event.id });
    await logTransaction(event, twitchUserId, amountTotal, currency, tier, null);
    return;
  }

  if (customerId) await upsertCustomerLookup(twitchUserId, customerId);

  let cosmeticSlug: string | null = null;

  // Only auto-award the supporter cosmetic on checkout.session.completed for
  // one-time payments. Subscriptions get their cosmetic + month increment
  // on the FIRST invoice.payment_succeeded instead, so we know the recurring
  // billing is actually live (a Checkout completion without a paid invoice
  // could be e.g. a trial signup with $0 first month).
  if (tier === "supporter" && amountTotal !== null) {
    const qualified = await pickQualifyingCosmetic("supporter", amountTotal);
    if (qualified) {
      await awardCosmetic(twitchUserId, qualified.slug, event.id);
      cosmeticSlug = qualified.slug;
    }
  }

  await logTransaction(event, twitchUserId, amountTotal, currency, tier, cosmeticSlug);
  log("checkout.session.completed processed", {
    event_id: event.id,
    twitch_user_id: twitchUserId,
    tier,
    amount: amountTotal,
    cosmetic: cosmeticSlug,
  });
}

// Stripe API 2025-03-31.basil+ removed invoice.subscription and
// invoice.subscription_details; the subscription ref + its metadata now live
// under invoice.parent.subscription_details (and the line items' parent).
// Read every known location so the handler works across API versions.
function resolveInvoiceSubscription(invoice: Record<string, unknown>): {
  subscriptionId: string | null;
  metadata: Record<string, string> | null;
} {
  const legacySub = (invoice.subscription as string | null) ?? null;
  const legacyDetails = invoice.subscription_details as Record<string, unknown> | undefined;

  const parent = invoice.parent as Record<string, unknown> | undefined;
  const parentDetails = parent?.subscription_details as Record<string, unknown> | undefined;

  const lines = (invoice.lines as Record<string, unknown> | undefined)?.data as
    | Array<Record<string, unknown>>
    | undefined;
  const lineParent = lines?.[0]?.parent as Record<string, unknown> | undefined;
  const lineSubDetails = lineParent?.subscription_item_details as Record<string, unknown> | undefined;

  const subscriptionId =
    legacySub ??
    (parentDetails?.subscription as string | undefined) ??
    (lineSubDetails?.subscription as string | undefined) ??
    null;

  const metadata =
    (legacyDetails?.metadata as Record<string, string> | undefined) ??
    (parentDetails?.metadata as Record<string, string> | undefined) ??
    null;

  return { subscriptionId, metadata };
}

async function handleInvoicePaid(event: StripeEvent): Promise<void> {
  const invoice = event.data.object as Record<string, unknown>;
  const { subscriptionId, metadata: subMetadata } = resolveInvoiceSubscription(invoice);
  const customerId = (invoice.customer as string | null) ?? null;
  const amountPaid = (invoice.amount_paid as number | null) ?? null;
  const currency = (invoice.currency as string | null) ?? null;

  // Only process invoices that paid for a subscription. One-time invoices
  // (subscription === null) belong to checkout.session.completed.
  if (!subscriptionId) {
    await logTransaction(event, null, amountPaid, currency, null, null);
    return;
  }

  // Pull twitch_user_id off the subscription metadata via the existing
  // stripe_subscriptions row. If we don't have one yet (first invoice on a
  // brand-new sub), pull from invoice.subscription_details.metadata or
  // invoice.metadata. checkout.session.completed runs first for new
  // subscriptions, so customer.subscription.updated should have already
  // populated stripe_subscriptions — but we're defensive here either way.
  let twitchUserId =
    readMetadata(invoice, "twitch_user_id") ?? subMetadata?.["twitch_user_id"] ?? null;
  if (!twitchUserId) {
    const { data } = await supabase
      .from("stripe_subscriptions")
      .select("twitch_user_id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    twitchUserId = (data?.twitch_user_id as string | undefined) ?? null;
  }
  if (!twitchUserId) {
    log("invoice.payment_succeeded without twitch_user_id; skipping award", { event_id: event.id });
    await logTransaction(event, null, amountPaid, currency, "subscriber", null);
    return;
  }

  // A subscription payment is worth at least the subscriber min ($5), which
  // is also >= the supporter min ($3). Policy: a qualifying subscription
  // payment grants subscriber AND supporter. A subscription payment that
  // clears only the supporter threshold (below subscriber min — possible if
  // someone sets a custom amount lower than expected) still grants supporter.
  // awardCosmetic is idempotent (catches 23505 unique_violation) so re-runs
  // and double-grants are safe.
  let cosmeticSlug: string | null = null;
  if (amountPaid !== null) {
    const subQualified = await pickQualifyingCosmetic("subscriber", amountPaid);
    if (subQualified) {
      await awardCosmetic(twitchUserId, subQualified.slug, event.id);
      cosmeticSlug = subQualified.slug;
    }
    const oneTimeQualified = await pickQualifyingOneTimeCosmetic(amountPaid);
    if (oneTimeQualified && oneTimeQualified.slug !== subQualified?.slug) {
      await awardCosmetic(twitchUserId, oneTimeQualified.slug, `${event.id}:bonus`);
      // Record only the primary slug in the audit row; the bonus supporter
      // grant is still observable in user_cosmetics.
      if (!cosmeticSlug) cosmeticSlug = oneTimeQualified.slug;
    }
  }

  // Always bump months when an invoice paid for a subscription, even if the
  // amount falls below the cosmetic threshold (the donor still paid).
  const paidAtRaw = (invoice.status_transitions as Record<string, unknown> | undefined)?.paid_at;
  const paidAt = typeof paidAtRaw === "number"
    ? new Date(paidAtRaw * 1000).toISOString()
    : new Date().toISOString();
  // Key the months bump on the INVOICE id (not the event id) so invoice.paid
  // and invoice.payment_succeeded for the same invoice count once, not twice.
  const monthsPaymentId = (invoice.id as string | null) ?? event.id;
  await recordSubscriberPayment(twitchUserId, monthsPaymentId, paidAt);

  if (customerId) await upsertCustomerLookup(twitchUserId, customerId);

  await logTransaction(event, twitchUserId, amountPaid, currency, "subscriber", cosmeticSlug);
  log("invoice.payment_succeeded processed", {
    event_id: event.id,
    twitch_user_id: twitchUserId,
    subscription_id: subscriptionId,
    amount: amountPaid,
    cosmetic: cosmeticSlug,
  });
}

async function handleSubscriptionStateChange(event: StripeEvent): Promise<void> {
  const sub = event.data.object as Record<string, unknown>;
  const subscriptionId = sub.id as string;
  const customerId = (sub.customer as string | null) ?? null;
  const status = (sub.status as string | null) ?? "unknown";
  const currentPeriodEnd = (sub.current_period_end as number | null) ?? null;
  const cancelAtPeriodEnd = Boolean(sub.cancel_at_period_end);
  const items = sub.items as Record<string, unknown> | undefined;
  const itemsData = (items?.data as Array<Record<string, unknown>> | undefined) ?? [];
  const priceId = (itemsData[0]?.price as Record<string, unknown> | undefined)?.id as string | undefined;

  const twitchUserId =
    readMetadata(sub, "twitch_user_id") ??
    (await (async () => {
      const { data } = await supabase
        .from("stripe_subscriptions")
        .select("twitch_user_id")
        .eq("stripe_subscription_id", subscriptionId)
        .maybeSingle();
      return (data?.twitch_user_id as string | undefined) ?? null;
    })());

  if (!twitchUserId || !customerId) {
    log("subscription event missing twitch_user_id or customer; logging only", { event_id: event.id });
    await logTransaction(event, twitchUserId, null, null, "subscriber", null);
    return;
  }

  await upsertSubscription(
    subscriptionId,
    twitchUserId,
    customerId,
    event.type === "customer.subscription.deleted" ? "canceled" : status,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    priceId ?? null,
  );

  await logTransaction(event, twitchUserId, null, null, "subscriber", null);
  log("subscription state change processed", {
    event_id: event.id,
    twitch_user_id: twitchUserId,
    subscription_id: subscriptionId,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const payload = await req.text();
  const signature = req.headers.get("stripe-signature");
  const verified = await verifySignature(payload, signature, STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    log("signature verification failed");
    return new Response("Invalid signature", { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch (err) {
    log("payload parse failed", { error: String(err) });
    return new Response("ok", { status: 200 });
  }

  if (await isDuplicate(event.id)) {
    log("duplicate event, skipping", { event_id: event.id });
    return new Response("ok", { status: 200 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event);
        break;
      case "invoice.payment_succeeded":
      case "invoice.paid":
        await handleInvoicePaid(event);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionStateChange(event);
        break;
      default:
        log("unhandled event type, logging only", { event_id: event.id, type: event.type });
        await logTransaction(event, null, null, null, null, null);
    }
  } catch (err) {
    log("handler threw, audit-log only", { event_id: event.id, error: String(err) });
    // Best-effort audit row so we have a trail of failures
    try {
      await logTransaction(event, null, null, null, null, null);
    } catch {
      // give up
    }
  }

  return new Response("ok", { status: 200 });
});
