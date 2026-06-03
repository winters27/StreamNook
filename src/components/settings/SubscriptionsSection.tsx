import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { DollarSign, Gift, Crown, Star, ChevronRight } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import {
  fetchMySubscriptions,
  fetchMyPastSubscriptions,
  type MySubscription,
  type PastSubscription,
} from '../../services/twitchService';
import { fetchIVRSubage } from '../../services/ivrService';

// USD list price per tier per month. The spend figure is an estimate only:
// regional pricing varies, active Prime / gifted subs cost nothing (and are
// excluded), and past subs don't expose Prime/gift status so they are counted
// at tier price.
const TIER_PRICE: Record<1 | 2 | 3, number> = { 1: 4.99, 2: 9.99, 3: 24.99 };

const containerV = { hidden: {}, show: { transition: { staggerChildren: 0.02 } } };
const itemV = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
};

const activeTierLabel = (s: MySubscription): string =>
  s.isGift ? 'Gift' : s.isPrime ? 'Prime' : `Tier ${s.tier}`;

interface Row {
  key: string;
  name: string;
  label: string;
  months: number | undefined; // undefined while the active streak is still loading
  status: 'active' | 'past';
  free: boolean; // active Prime/gift -> muted pill
}

const SubscriptionsSection = ({ login }: { login: string }) => {
  // null = still loading active list; [] = loaded but none (or fetch failed).
  const [subs, setSubs] = useState<MySubscription[] | null>(null);
  const [past, setPast] = useState<PastSubscription[]>([]);
  // Current-streak months per ACTIVE channel, from IVR. `null` value = the
  // lookup ran but returned nothing; absent key = still loading.
  const [streak, setStreak] = useState<Record<string, number>>({});
  const [streakLoaded, setStreakLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const self = login.toLowerCase();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [active, pastList] = await Promise.all([
          fetchMySubscriptions(),
          fetchMyPastSubscriptions(),
        ]);
        if (!alive) return;
        setSubs(active);
        setPast(pastList);

        // Current-streak months for the active subs (skip our own channel).
        // Past subs already carry their own months, so IVR is only hit for the
        // handful of active subs - no large fan-out / rate-limit risk.
        const entries = await Promise.all(
          active
            .filter((s) => s.channelLogin.toLowerCase() !== self)
            .map(async (s) => {
              const data = await fetchIVRSubage(login, s.channelLogin).catch(() => null);
              const m = data?.streak?.months ?? data?.meta?.subStreak ?? 0;
              return [s.channelLogin.toLowerCase(), m] as const;
            }),
        );
        if (alive) {
          setStreak(Object.fromEntries(entries));
          setStreakLoaded(true);
        }
      } catch (e) {
        Logger.error('[Subscriptions] Failed to load:', e);
        if (alive) {
          setSubs([]);
          setStreakLoaded(true);
        }
      }
    })();
    return () => { alive = false; };
  }, [login, self]);

  const loading = subs === null;

  // Exclude our own channel (broadcasters get a default Tier 3 to themselves).
  const active = (subs ?? []).filter((s) => s.channelLogin.toLowerCase() !== self);
  const pastAll = past.filter((p) => p.channelLogin.toLowerCase() !== self);

  const paid = active.filter((s) => !s.isPrime && !s.isGift);
  const primeCount = active.filter((s) => s.isPrime).length;
  const giftCount = active.filter((s) => s.isGift && !s.isPrime).length;

  // Sum past periods per channel (a channel can have several lapsed periods).
  const pastByChannel = new Map<string, { name: string; tier: 1 | 2 | 3; months: number }>();
  for (const p of pastAll) {
    const k = p.channelLogin.toLowerCase();
    const cur = pastByChannel.get(k);
    if (cur) {
      cur.months += p.months;
      cur.tier = Math.max(cur.tier, p.tier) as 1 | 2 | 3;
    } else {
      pastByChannel.set(k, { name: p.channelDisplayName, tier: p.tier, months: p.months });
    }
  }
  const activeByChannel = new Map(active.map((s) => [s.channelLogin.toLowerCase(), s]));

  // ── Spend ──────────────────────────────────────────────────────────────
  // Every past period (tier x months) + each active PAID sub's current period
  // (tier x streak). Past periods and the current period never overlap, so
  // nothing is double-counted and no past period is dropped.
  let spend = 0;
  let totalMonths = 0;
  // Price each past period at its OWN tier and months (a channel can have
  // separate periods at different tiers, so never blend them by channel).
  for (const p of pastAll) {
    spend += TIER_PRICE[p.tier] * p.months;
    totalMonths += p.months;
  }
  // Each active PAID sub's current period at its own tier.
  for (const s of active) {
    const m = streak[s.channelLogin.toLowerCase()] || 0;
    totalMonths += m;
    if (!s.isPrime && !s.isGift) spend += TIER_PRICE[s.tier] * Math.max(1, m);
  }

  // ── Display rows: union of active + past channels ──────────────────────
  const rowKeys = new Set<string>([...activeByChannel.keys(), ...pastByChannel.keys()]);
  const rows: Row[] = [...rowKeys]
    .map((k): Row => {
      const a = activeByChannel.get(k);
      const pst = pastByChannel.get(k);
      const streakKnown = !a || streakLoaded;
      const aStreak = a ? streak[k] || 0 : 0;
      const months = a ? aStreak + (pst?.months || 0) : pst!.months;
      return {
        key: k,
        name: a?.channelDisplayName ?? pst!.name,
        label: a ? activeTierLabel(a) : `Tier ${pst!.tier}`,
        months: streakKnown ? months : undefined,
        status: a ? 'active' : 'past',
        free: a ? a.isPrime || a.isGift : false,
      };
    })
    .sort((x, y) => (y.months || 0) - (x.months || 0));

  return (
    <div className="glass-panel rounded-xl p-5">
      <div className="mb-4 flex items-center gap-1.5">
        <Star size={14} className="text-textMuted" />
        <h4 className="text-sm font-semibold uppercase tracking-wide text-textPrimary">
          Subscriptions
        </h4>
        {!loading && (
          <span className="ml-auto text-[11px] tabular-nums text-textMuted">
            {rows.length} channels
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm italic text-textSecondary">Loading your subscriptions…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm italic text-textSecondary">No subscriptions found.</p>
      ) : (
        <>
          {/* Spend headline */}
          <div className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4">
            <div className="mb-1 flex items-center gap-2">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-md"
                style={{ background: 'rgba(140, 195, 170, 0.22)', border: '1px solid transparent' }}
              >
                <DollarSign size={14} strokeWidth={2.25} className="text-textPrimary" />
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-textMuted">
                Poured into Twitch
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-3xl font-bold tabular-nums text-textPrimary">
                ${Math.round(spend).toLocaleString()}
              </span>
              <span className="text-xs text-textMuted">
                estimated across {totalMonths.toLocaleString()} months
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-textSecondary">
              Every past subscription plus your current streaks, tier price times months. Active
              Prime and gifts are excluded; past subs are counted at tier price (their Prime/gift
              status isn't exposed). US pricing assumed, so treat it as a ballpark.
            </p>
          </div>

          {/* Breakdown */}
          <div className="mb-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-textSecondary">
              {paid.length} paid
            </span>
            {primeCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-textSecondary">
                <Crown size={11} /> {primeCount} Prime
              </span>
            )}
            {giftCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-textSecondary">
                <Gift size={11} /> {giftCount} gifted
              </span>
            )}
            {pastByChannel.size > 0 && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-textMuted">
                {pastByChannel.size} past
              </span>
            )}
          </div>

          {/* Channels - collapsed by default; expand to see the full list */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-textSecondary transition-colors hover:bg-white/[0.03] hover:text-textPrimary"
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
            />
            {expanded ? 'Hide channels' : `Show all ${rows.length} channels`}
          </button>
          {expanded && (
            <motion.div
              variants={containerV}
              initial="hidden"
              animate="show"
              className="mt-1 space-y-1"
            >
              {rows.map((r) => (
                <motion.div
                  key={r.key}
                  variants={itemV}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.03]"
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      r.status === 'past' ? 'text-textSecondary' : 'text-textPrimary'
                    }`}
                  >
                    {r.name}
                  </span>
                  <Tooltip content={r.status === 'past' ? `${r.label} (ended)` : r.label} side="left">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        r.status === 'active' && !r.free
                          ? 'bg-accent/20 text-accent'
                          : 'bg-white/[0.06] text-textSecondary'
                      }`}
                    >
                      {r.label}
                    </span>
                  </Tooltip>
                  <span className="w-16 text-right text-[11px] tabular-nums text-textMuted">
                    {r.months === undefined ? '…' : r.months > 0 ? `${r.months} mo` : ''}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          )}
        </>
      )}
    </div>
  );
};

export default SubscriptionsSection;
