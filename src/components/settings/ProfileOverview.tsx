import { useContext, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion } from 'framer-motion';
import {
  Clock,
  Cake,
  Users,
  MessageSquare,
  Tv,
  Gift,
  Coins,
  Palette,
  Award,
  Dices,
  Sparkles,
  Trophy,
  Lock,
  MessageCircle,
  Megaphone,
  Mic,
  Timer,
  Moon,
  Armchair,
  Waves,
  Ghost,
  Package,
  Flame,
  PiggyBank,
  Gem,
  Shapes,
  Droplets,
  Medal,
  Hourglass,
  Crown,
  Heart,
  PartyPopper,
  Clover,
  Sun,
  Skull,
  Snowflake,
  Star,
  Layers,
  Repeat,
  BellRing,
  Smile,
  Flower2,
  Leaf,
  Laugh,
  Sword,
  Drumstick,
  TreePine,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { Logger } from '../../utils/logger';
import {
  getUserStats,
  getTotalUsersCount,
  getAccolades,
  grantAccolade,
  getFavoriteChannel,
  type UserStats,
  type ChannelWatch,
} from '../../services/supabaseService';
import { fetchIVRUserData } from '../../services/ivrService';
import { getTier } from '../StreamNookBadge';
import type { InventoryResponse, ChannelPointsBalance } from '../../types';
import { pickHoursRoast, type PickedRoast } from '../../utils/hoursWatchedRoasts';
import { SEASONAL_ACCOLADES, getActiveSeasonalAccoladeIds, isCakeDay, CAKE_DAY_ID } from '../../utils/seasonalAccolades';
import { RESTLESS_ACCOLADE_ID } from '../../utils/notifAchievement';
import SubscriptionsSection from './SubscriptionsSection';
import TopEmotesSection from './TopEmotesSection';
import { ProfileAccentContext, ProfileCompactContext } from './profileAccentContext';

interface ProfileOverviewProps {
  userId: string;
  login: string;
  // 'partner' | 'affiliate' | '' (plain viewer). Fallback only; IVR roles win.
  broadcasterType: string;
  streamNookUserNumber: number | null;
  seventvPaintCount: number;
  seventvBadgeCount: number;
  ownedCosmeticsCount: number;
  // When false, render another member's PUBLIC profile: skip the self-only
  // live data (drops, channel-points balances, subscriptions) and never grant
  // accolades. Defaults to true (the current settings usage).
  isOwnProfile?: boolean;
  // Section keys the member hid from their public profile (honored only when
  // !isOwnProfile). Keys: roast, twitch, lifetime, emotes, accolades.
  hiddenSections?: string[];
}

// Soft, flat tints reused from the settings tile palette. No glow, just a
// faint wash behind each stat icon.
const TINT = {
  violet: 'rgba(140, 120, 200, 0.20)',
  sky: 'rgba(120, 175, 215, 0.22)',
  green: 'rgba(140, 195, 170, 0.22)',
  amber: 'rgba(220, 180, 120, 0.20)',
  rose: 'rgba(210, 140, 150, 0.20)',
  slate: 'rgba(150, 170, 185, 0.22)',
};


// Stagger so tiles slide in one after another instead of popping as a block.
const containerV = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } },
};
const itemV = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' as const } },
};

// rAF count-up so numbers tick from zero to their value on first paint (and
// re-animate when the real value arrives after the async fetch resolves).
const useCountUp = (target: number, durationMs = 900): number => {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!target || target <= 0) {
      setValue(target || 0);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
};

const StatTile = ({
  icon: Icon,
  label,
  count,
  value,
  caption,
  tint,
  tooltip,
}: {
  icon: LucideIcon;
  label: string;
  // Provide `count` for an animated number, or `value` for a fixed string.
  count?: number;
  value?: string;
  caption?: string;
  tint: string;
  tooltip?: string;
}) => {
  const animated = useCountUp(count ?? 0);
  const display = value !== undefined ? value : animated.toLocaleString();
  const accentRgb = useContext(ProfileAccentContext);
  const compact = useContext(ProfileCompactContext);
  const inner = (
    <div
      className={`h-full rounded-lg border border-white/[0.06] bg-white/[0.03] transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] ${compact ? 'p-3' : 'p-4'}`}
      style={accentRgb ? { borderColor: `rgba(${accentRgb}, 0.22)`, backgroundColor: `rgba(${accentRgb}, 0.05)` } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
          style={{ background: tint, border: '1px solid transparent' }}
        >
          <Icon size={14} strokeWidth={2.25} className="text-textPrimary" />
        </span>
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-textMuted">
          {label}
        </span>
      </div>
      <div className={`truncate font-bold tabular-nums text-textPrimary ${compact ? 'text-xl' : 'text-2xl'}`}>{display}</div>
      {caption && <div className="mt-1 text-[11px] leading-snug text-textSecondary">{caption}</div>}
    </div>
  );
  return (
    <motion.div variants={itemV} className="h-full min-w-0">
      {tooltip ? (
        <Tooltip content={tooltip} side="top">
          {inner}
        </Tooltip>
      ) : (
        inner
      )}
    </motion.div>
  );
};

interface Accolade {
  id: string;
  label: string;
  icon: LucideIcon;
  // Vivid two-stop gradient fill for the earned medallion. Each accolade
  // gets its own color so the wall reads as a varied collection.
  grad: string;
  earned: boolean;
  hint: string;
  // Secret accolades render as "???" until earned, then reveal.
  secret?: boolean;
}

// Bevel comes from inset shadows only, no outer glow, per the house style.
const MEDALLION_BEVEL =
  'inset 1.5px 1.5px 1px rgba(255,255,255,0.35), inset -1.5px -1.5px 3px rgba(0,0,0,0.30)';

// Icon + color for each seasonal accolade (keyed by the ids in
// seasonalAccolades.ts). Kept here so the util stays icon-free and testable.
const SEASONAL_PRES: Record<string, { icon: LucideIcon; grad: string }> = {
  new_year: { icon: PartyPopper, grad: 'linear-gradient(140deg, #fbbf24, #d97706)' },
  valentines: { icon: Heart, grad: 'linear-gradient(140deg, #fb7185, #be123c)' },
  st_patricks: { icon: Clover, grad: 'linear-gradient(140deg, #4ade80, #15803d)' },
  april_fools: { icon: Laugh, grad: 'linear-gradient(140deg, #c084fc, #7c3aed)' },
  may_fourth: { icon: Sword, grad: 'linear-gradient(140deg, #64748b, #1e293b)' },
  halloween: { icon: Skull, grad: 'linear-gradient(140deg, #fb923c, #c2410c)' },
  thanksgiving: { icon: Drumstick, grad: 'linear-gradient(140deg, #d8a657, #92400e)' },
  winter_holiday: { icon: TreePine, grad: 'linear-gradient(140deg, #4ade80, #b91c1c)' },
  spring: { icon: Flower2, grad: 'linear-gradient(140deg, #f9a8d4, #4ade80)' },
  summer: { icon: Sun, grad: 'linear-gradient(140deg, #fcd34d, #f59e0b)' },
  fall: { icon: Leaf, grad: 'linear-gradient(140deg, #fb923c, #b45309)' },
  winter: { icon: Snowflake, grad: 'linear-gradient(140deg, #93c5fd, #2563eb)' },
  [CAKE_DAY_ID]: { icon: Cake, grad: 'linear-gradient(140deg, #f9a8d4, #db2777)' },
};

const AccoladeMedallion = ({ a, isOwnProfile }: { a: Accolade; isOwnProfile: boolean }) => {
  const Icon = a.icon;
  const compact = useContext(ProfileCompactContext);
  const mystery = !!a.secret && !a.earned;
  const label = mystery ? '???' : a.label;
  // On YOUR OWN profile a secret accolade shows its cryptic, guiding hint so you
  // can discover and chase it. On someone else's profile it never reveals the
  // how-to (so it can't be cheated by reading it off their earned one) — just a
  // neutral descriptor. Non-secret accolades show their hint either way.
  const tip = a.secret && !isOwnProfile ? 'A hidden accolade.' : a.hint;
  return (
    <Tooltip content={tip} side="top">
      <motion.div
        variants={itemV}
        className={`flex flex-col items-center text-center ${compact ? 'gap-1.5' : 'gap-2'}`}
      >
        <div
          className={`relative flex ${compact ? 'h-12 w-12' : 'h-16 w-16'} items-center justify-center rounded-full ${
            a.earned ? '' : 'border border-white/[0.06] bg-white/[0.03] opacity-55'
          }`}
          style={a.earned ? { backgroundImage: a.grad, boxShadow: MEDALLION_BEVEL } : undefined}
        >
          {a.earned ? (
            <Icon
              size={compact ? 20 : 26}
              strokeWidth={2}
              className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
            />
          ) : mystery ? (
            <span className="text-lg font-bold text-textMuted">?</span>
          ) : (
            <Lock size={compact ? 18 : 20} strokeWidth={2.25} className="text-textMuted" />
          )}
        </div>
        <span
          className={`font-medium leading-tight ${compact ? 'max-w-[68px] text-[10px]' : 'max-w-[80px] text-[11px]'} ${
            a.earned ? 'text-textPrimary' : 'text-textMuted'
          }`}
        >
          {label}
        </span>
      </motion.div>
    </Tooltip>
  );
};

// "2 yrs, 4 mos" age, a numeric year count (for milestones), the exact join
// date, and a days-until-next-cake-day caption.
const describeAccountAge = (createdAt: string | null) => {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const now = new Date();

  let years = now.getFullYear() - created.getFullYear();
  let months = now.getMonth() - created.getMonth();
  if (now.getDate() < created.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  let next = new Date(now.getFullYear(), created.getMonth(), created.getDate());
  if (next.getTime() < now.getTime()) {
    next = new Date(now.getFullYear() + 1, created.getMonth(), created.getDate());
  }
  const daysToCakeDay = Math.ceil((next.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const ageLabel =
    years > 0
      ? `${years} yr${years === 1 ? '' : 's'}${months > 0 ? `, ${months} mo${months === 1 ? '' : 's'}` : ''}`
      : `${months} mo${months === 1 ? '' : 's'}`;

  const exact = created.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const caption =
    daysToCakeDay <= 0
      ? 'Cake day is today. Make a wish.'
      : daysToCakeDay === 1
        ? 'Cake day tomorrow'
        : `Cake day in ${daysToCakeDay} days`;

  return { ageLabel, years, caption, exact };
};

const ProfileOverview = ({
  userId,
  login,
  broadcasterType,
  streamNookUserNumber,
  seventvPaintCount,
  seventvBadgeCount,
  ownedCosmeticsCount,
  isOwnProfile = true,
  hiddenSections = [],
}: ProfileOverviewProps) => {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [followers, setFollowers] = useState<number | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [roles, setRoles] = useState<{ isAffiliate: boolean; isPartner: boolean; isStaff: boolean } | null>(null);
  const [dropsClaimed, setDropsClaimed] = useState<number | null>(null);
  const [totalMembers, setTotalMembers] = useState<number | null>(null);
  const [earnedAccolades, setEarnedAccolades] = useState<Set<string>>(new Set());
  // Real channel-points holdings: the summed current balance across every
  // channel StreamNook has tracked for you (not the auto-farmed counter).
  const [pointsHeld, setPointsHeld] = useState<number | null>(null);
  const [pointsChannels, setPointsChannels] = useState<number>(0);
  const [topPointsChannel, setTopPointsChannel] = useState<string | null>(null);
  const [favoriteChannel, setFavoriteChannel] = useState<ChannelWatch | null>(null);
  const [roast, setRoast] = useState<PickedRoast | null>(null);
  const [showAllAccolades, setShowAllAccolades] = useState(false);

  const hours = stats?.hours_watched ?? 0;
  const animatedHours = useCountUp(Math.round(hours));

  const rerollRoast = () => setRoast(pickHoursRoast(hours));
  useEffect(() => {
    if (stats) setRoast(pickHoursRoast(stats.hours_watched ?? 0));
  }, [stats]);

  useEffect(() => {
    let alive = true;

    getUserStats(userId)
      .then((s) => {
        if (alive) setStats(s ?? ({ user_id: userId, channel_points_farmed: 0, hours_watched: 0, messages_sent: 0, streams_watched: 0, updated_at: '' } as UserStats));
      })
      .catch((e) => Logger.error('[ProfileOverview] stats:', e));

    getTotalUsersCount()
      .then((c) => { if (alive) setTotalMembers(c || null); })
      .catch(() => {});

    getFavoriteChannel(userId)
      .then((c) => { if (alive) setFavoriteChannel(c); })
      .catch(() => {});

    getAccolades(userId)
      .then((ids) => {
        if (!alive) return;
        const set = new Set(ids);
        // Own profile only: inside a season/holiday window, collect it now
        // (idempotent) and reflect optimistically. Never grant on someone
        // else's profile.
        if (isOwnProfile) {
          getActiveSeasonalAccoladeIds(new Date()).forEach((id) => {
            set.add(id);
            grantAccolade(userId, id).catch(() => {});
          });
        }
        setEarnedAccolades(set);
      })
      .catch(() => {});

    fetchIVRUserData(login)
      .then((u) => {
        if (!alive || !u) return;
        setFollowers(typeof u.followers === 'number' ? u.followers : null);
        setCreatedAt(u.createdAt || null);
        if (u.roles) {
          setRoles({
            isAffiliate: !!u.roles.isAffiliate,
            isPartner: !!u.roles.isPartner,
            isStaff: !!u.roles.isStaff,
          });
        }
      })
      .catch((e) => Logger.error('[ProfileOverview] ivr:', e));

    // Live, self-only data tied to the viewer's own session (drops + channel
    // points balances). Skipped when viewing another member's public profile.
    if (isOwnProfile) {
      invoke<InventoryResponse>('get_drops_inventory')
        .then((inv) => { if (alive) setDropsClaimed(inv?.completed_drops?.length ?? 0); })
        .catch(() => { if (alive) setDropsClaimed(null); });

      invoke<ChannelPointsBalance[]>('get_all_channel_points_balances')
        .then((balances) => {
          if (!alive) return;
          const list = Array.isArray(balances) ? balances : [];
          setPointsHeld(list.reduce((sum, b) => sum + (b.balance || 0), 0));
          setPointsChannels(list.length);
          // Most-points channel ~ where you've banked the most channel points.
          const top = list.reduce<ChannelPointsBalance | null>(
            (best, b) => (b.balance > (best?.balance ?? -1) ? b : best),
            null,
          );
          setTopPointsChannel(top?.channel_name ?? null);
        })
        .catch(() => { if (alive) setPointsHeld(null); });
    }

    return () => { alive = false; };
  }, [userId, login]);

  // Cake Day: once the creation date resolves, collect the accolade if today
  // is the user's Twitch account anniversary.
  useEffect(() => {
    if (!isOwnProfile || !createdAt || !userId) return;
    if (isCakeDay(createdAt, new Date())) {
      grantAccolade(userId, CAKE_DAY_ID).catch(() => {});
      setEarnedAccolades((prev) => new Set(prev).add(CAKE_DAY_ID));
    }
  }, [createdAt, userId, isOwnProfile]);

  const age = useMemo(() => describeAccountAge(createdAt), [createdAt]);
  const tier = streamNookUserNumber !== null ? getTier(streamNookUserNumber) : null;

  // Account type: trust IVR roles (reliable) over the often-empty
  // broadcaster_type on the user object.
  const accountType = roles?.isStaff
    ? 'Twitch Staff'
    : roles?.isPartner || broadcasterType === 'partner'
      ? 'Partner'
      : roles?.isAffiliate || broadcasterType === 'affiliate'
        ? 'Affiliate'
        : 'Viewer';

  const cosmeticsTotal = seventvPaintCount + seventvBadgeCount + ownedCosmeticsCount;
  const messages = stats?.messages_sent ?? 0;
  const streams = stats?.streams_watched ?? 0;

  const pts = pointsHeld ?? 0;
  const drops = dropsClaimed ?? 0;
  const years = age?.years ?? 0;
  const memberNo = streamNookUserNumber;
  const isPalindrome = (n: number | null): boolean => {
    if (n === null || n < 10) return false;
    const s = String(n);
    return s === s.split('').reverse().join('');
  };

  const baseAccolades: Accolade[] = [
    { id: 'chatterbox', label: 'Chatterbox', icon: MessageCircle, grad: 'linear-gradient(140deg, #6aa9ff, #3b6fd4)', earned: messages >= 1000, hint: `Messages sent: ${messages.toLocaleString()} / 1,000` },
    { id: 'motormouth', label: 'Motormouth', icon: Megaphone, grad: 'linear-gradient(140deg, #5b8def, #2f5fc0)', earned: messages >= 10000, hint: `Messages sent: ${messages.toLocaleString()} / 10,000` },
    { id: 'yapper', label: 'Yapper Supreme', icon: Mic, grad: 'linear-gradient(140deg, #8b5cf6, #6d28d9)', earned: messages >= 50000, hint: `Messages sent: ${messages.toLocaleString()} / 50,000` },
    { id: 'marathoner', label: 'Marathoner', icon: Timer, grad: 'linear-gradient(140deg, #f59e0b, #b45309)', earned: hours >= 100, hint: `Hours watched: ${Math.round(hours).toLocaleString()} / 100` },
    { id: 'nosleep', label: 'No Sleep', icon: Moon, grad: 'linear-gradient(140deg, #6366f1, #4338ca)', earned: hours >= 1000, hint: `Hours watched: ${Math.round(hours).toLocaleString()} / 1,000` },
    { id: 'grassless', label: 'Grassless', icon: Armchair, grad: 'linear-gradient(140deg, #84cc16, #4d7c0f)', earned: hours >= 5000, hint: `Hours watched: ${Math.round(hours).toLocaleString()} / 5,000` },
    { id: 'surfer', label: 'Channel Surfer', icon: Waves, grad: 'linear-gradient(140deg, #06b6d4, #0e7490)', earned: streams >= 50, hint: `Streams watched: ${streams.toLocaleString()} / 50` },
    { id: 'lurker', label: 'Certified Lurker', icon: Ghost, grad: 'linear-gradient(140deg, #94a3b8, #475569)', earned: streams >= 250, hint: `Streams watched: ${streams.toLocaleString()} / 250` },
    { id: 'dropgoblin', label: 'Drop Goblin', icon: Package, grad: 'linear-gradient(140deg, #22c55e, #15803d)', earned: drops >= 25, hint: `Drops claimed: ${drops.toLocaleString()} / 25` },
    { id: 'dropdragon', label: 'Drop Dragon', icon: Flame, grad: 'linear-gradient(140deg, #ef4444, #b91c1c)', earned: drops >= 100, hint: `Drops claimed: ${drops.toLocaleString()} / 100` },
    { id: 'hoarder', label: 'Point Hoarder', icon: PiggyBank, grad: 'linear-gradient(140deg, #eab308, #a16207)', earned: pts >= 100000, hint: `Channel points held: ${pts.toLocaleString()} / 100,000` },
    { id: 'tycoon', label: 'Point Tycoon', icon: Gem, grad: 'linear-gradient(140deg, #2dd4bf, #0f766e)', earned: pts >= 1000000, hint: `Channel points held: ${pts.toLocaleString()} / 1,000,000` },
    { id: 'collector', label: 'Collector', icon: Shapes, grad: 'linear-gradient(140deg, #ec4899, #be185d)', earned: cosmeticsTotal >= 5, hint: `Cosmetics collected: ${cosmeticsTotal} / 5` },
    { id: 'driplord', label: 'Drip Lord', icon: Droplets, grad: 'linear-gradient(140deg, #38bdf8, #0284c7)', earned: cosmeticsTotal >= 15, hint: `Cosmetics collected: ${cosmeticsTotal} / 15` },
    { id: 'veteran', label: 'Veteran', icon: Medal, grad: 'linear-gradient(140deg, #fb923c, #c2410c)', earned: years >= 5, hint: `Years on Twitch: ${years} / 5` },
    { id: 'ancient', label: 'Ancient One', icon: Hourglass, grad: 'linear-gradient(140deg, #a855f7, #7e22ce)', earned: years >= 10, hint: `Years on Twitch: ${years} / 10` },
    { id: 'og', label: 'OG', icon: Crown, grad: 'linear-gradient(140deg, #fbbf24, #d97706)', earned: streamNookUserNumber !== null && streamNookUserNumber <= 100, hint: 'Be one of the first 100 StreamNook members' },
  ];
  const allBaseEarned = baseAccolades.every((a) => a.earned);
  const secretAccolades: Accolade[] = [
    { id: 'completionist', label: 'Completionist', icon: Star, grad: 'linear-gradient(140deg, #f472b6, #db2777)', secret: true, earned: allBaseEarned, hint: "When there's nothing else left to earn, this one shows up." },
    { id: 'triple', label: 'Triple Threat', icon: Layers, grad: 'linear-gradient(140deg, #34d399, #0f766e)', secret: true, earned: messages >= 1000 && hours >= 100 && drops >= 25, hint: 'Talk, watch, and collect until all three run deep.' },
    { id: 'palindrome', label: 'Palindrome', icon: Repeat, grad: 'linear-gradient(140deg, #c084fc, #7e22ce)', secret: true, earned: isPalindrome(memberNo), hint: 'A number that reads the same coming and going.' },
    { id: 'nice', label: 'Nice', icon: Smile, grad: 'linear-gradient(140deg, #facc15, #ca8a04)', secret: true, earned: memberNo !== null && [69, 420, 666, 777, 1337].includes(memberNo), hint: 'Land on a number the internet never lets you forget.' },
    { id: RESTLESS_ACCOLADE_ID, label: 'Restless', icon: BellRing, grad: 'linear-gradient(140deg, #818cf8, #4338ca)', secret: true, earned: earnedAccolades.has(RESTLESS_ACCOLADE_ID), hint: "The test notification really wishes you'd stop." },
  ];
  const seasonalAccolades: Accolade[] = [
    ...SEASONAL_ACCOLADES.map((b): Accolade => ({
      id: b.id,
      label: b.label,
      icon: SEASONAL_PRES[b.id].icon,
      grad: SEASONAL_PRES[b.id].grad,
      earned: earnedAccolades.has(b.id),
      hint: earnedAccolades.has(b.id) ? 'Collected' : b.hint,
    })),
    {
      id: CAKE_DAY_ID,
      label: 'Cake Day',
      icon: SEASONAL_PRES[CAKE_DAY_ID].icon,
      grad: SEASONAL_PRES[CAKE_DAY_ID].grad,
      earned: earnedAccolades.has(CAKE_DAY_ID),
      hint: earnedAccolades.has(CAKE_DAY_ID) ? 'Collected' : 'Open StreamNook on your Twitch cake day',
    },
  ];
  const allAccolades: Accolade[] = [...baseAccolades, ...secretAccolades, ...seasonalAccolades];
  // On someone else's PUBLIC profile, hide locked SECRET accolades entirely: a
  // viewer shouldn't see placeholders for hidden achievements the member hasn't
  // earned, and must never be able to read a how-to off them. Your own profile
  // shows all of them so you can chase them.
  const accolades: Accolade[] = isOwnProfile
    ? allAccolades
    : allAccolades.filter((a) => !(a.secret && !a.earned));
  const earnedCount = accolades.filter((a) => a.earned).length;
  const sortedAccolades = [...accolades].sort((a, b) => Number(b.earned) - Number(a.earned));
  const earnedMedallions = sortedAccolades.filter((a) => a.earned);
  const lockedCount = accolades.length - earnedCount;

  const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();

  const accentRgb = useContext(ProfileAccentContext);
  const compact = useContext(ProfileCompactContext);
  // A member can hide sections from their PUBLIC profile; honored only when
  // viewing someone else (the self settings view always shows everything).
  const sectionHidden = (key: string) => !isOwnProfile && hiddenSections.includes(key);
  const sectionStyle = accentRgb ? { borderColor: `rgba(${accentRgb}, 0.3)` } : undefined;
  const sectionPad = compact ? 'p-4' : 'p-5';
  const gridGap = compact ? 'gap-2.5' : 'gap-3';
  const headMb = compact ? 'mb-3' : 'mb-4';
  // In the compact overlay, show only earned accolades by default (it's a public
  // showcase) with an expander for the locked ones, so the wall doesn't dominate.
  const accoladesShown = compact && !showAllAccolades ? earnedMedallions : sortedAccolades;

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {/* Hours-watched roast hero. The whole card is a re-roll button. */}
      {!sectionHidden('roast') && (
      <motion.button
        type="button"
        onClick={compact ? undefined : rerollRoast}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={`w-full rounded-xl glass-panel text-left transition-colors ${
          compact ? 'cursor-default p-4' : 'group p-6 hover:bg-white/[0.02]'
        }`}
        style={sectionStyle}
      >
        <div className="mb-3 flex items-center gap-2">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md"
            style={{ background: TINT.amber, border: '1px solid transparent' }}
          >
            <Clock size={14} strokeWidth={2.25} className="text-textPrimary" />
          </span>
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-textMuted">
            Hours watched
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className={`font-bold tabular-nums text-textPrimary ${compact ? 'text-3xl' : 'text-5xl'}`}>
            {animatedHours.toLocaleString()}
          </span>
          <span className="text-sm text-textMuted">hrs</span>
        </div>
        {roast && (
          <div className="mt-3 flex items-start justify-between gap-3">
            <p className={`leading-relaxed text-textSecondary ${compact ? 'text-[13px]' : 'text-[15px]'}`}>
              {roast.text}
            </p>
            {!compact && (
              <span className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-textMuted opacity-0 transition-opacity group-hover:opacity-100">
                <Dices size={12} /> Tap for another
              </span>
            )}
          </div>
        )}
      </motion.button>
      )}

      {/* Your Twitch */}
      {!sectionHidden('twitch') && (
      <div className={`glass-panel rounded-xl ${sectionPad}`} style={sectionStyle}>
        <h4 className={`${headMb} flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-textPrimary`}>
          <Sparkles size={14} className="text-textMuted" /> Your Twitch
        </h4>
        <motion.div
          variants={containerV}
          initial="hidden"
          animate="show"
          className={`grid grid-cols-2 ${gridGap} sm:grid-cols-3`}
        >
          {age ? (
            <StatTile icon={Cake} label="Twitch age" value={age.ageLabel} caption={age.caption} tint={TINT.rose} tooltip={`Joined ${age.exact}`} />
          ) : (
            <StatTile icon={Cake} label="Twitch age" value="Unknown" tint={TINT.rose} />
          )}
          <StatTile
            icon={Users}
            label="Followers"
            count={followers ?? undefined}
            value={followers === null ? 'Unknown' : undefined}
            tint={TINT.sky}
          />
          <StatTile icon={Award} label="Account type" value={accountType} tint={TINT.violet} />
        </motion.div>
      </div>
      )}

      {/* Lifetime in StreamNook */}
      {!sectionHidden('lifetime') && (
      <div className={`glass-panel rounded-xl ${sectionPad}`} style={sectionStyle}>
        <h4 className={`${headMb} flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-textPrimary`}>
          <Tv size={14} className="text-textMuted" /> Lifetime in StreamNook
        </h4>
        <motion.div
          variants={containerV}
          initial="hidden"
          animate="show"
          className={`grid grid-cols-2 ${gridGap} sm:grid-cols-3`}
        >
          {isOwnProfile && (
            <StatTile
              icon={Coins}
              label="Channel points"
              count={pointsHeld ?? undefined}
              value={pointsHeld === null ? 'Unknown' : undefined}
              caption={pointsChannels > 0 ? `held across ${pointsChannels} channels` : 'watch a stream to start tracking'}
              tint={TINT.amber}
            />
          )}
          <StatTile
            icon={MessageSquare}
            label="Messages sent"
            count={messages}
            caption="into the void"
            tint={TINT.green}
          />
          <StatTile icon={Tv} label="Streams watched" count={streams} tint={TINT.sky} />
          {isOwnProfile && (
            <StatTile
              icon={Gift}
              label="Drops claimed"
              count={dropsClaimed ?? undefined}
              value={dropsClaimed === null ? 'Unknown' : undefined}
              tint={TINT.violet}
            />
          )}
          <StatTile
            icon={Palette}
            label="Cosmetics"
            count={cosmeticsTotal}
            caption={`${seventvPaintCount} paints, ${seventvBadgeCount} badges, ${ownedCosmeticsCount} StreamNook`}
            tint={TINT.rose}
          />
          {favoriteChannel && (
            <StatTile
              icon={Heart}
              label="Favorite channel"
              value={favoriteChannel.channel_name}
              caption={`${Math.round(favoriteChannel.minutes / 60).toLocaleString()}h watched`}
              tint={TINT.rose}
            />
          )}
          {topPointsChannel && (
            <StatTile
              icon={Coins}
              label="Most points"
              value={topPointsChannel}
              caption="channel points banked"
              tint={TINT.amber}
            />
          )}
          {streamNookUserNumber !== null && (
            <StatTile
              icon={Sparkles}
              label="Member rank"
              value={`#${streamNookUserNumber.toLocaleString()}`}
              caption={
                totalMembers
                  ? `of ${totalMembers.toLocaleString()}${tier?.label ? ` · ${tier.label}` : ''}`
                  : tier?.label || 'StreamNook member'
              }
              tint={TINT.slate}
            />
          )}
        </motion.div>
      </div>
      )}

      {isOwnProfile && <SubscriptionsSection login={login} />}

      {!sectionHidden('emotes') && <TopEmotesSection userId={userId} />}

      {/* Accolades - collectible medallions. Placed last on purpose: it's a
          big wall, so the stat cards lead and this anchors the bottom. */}
      {!sectionHidden('accolades') && (
      <div className={`glass-panel rounded-xl ${sectionPad}`} style={sectionStyle}>
        <div className={`flex items-center gap-1.5 ${compact ? 'mb-3' : 'mb-5'}`}>
          <Trophy size={14} className="text-textMuted" />
          <h4 className="text-sm font-semibold uppercase tracking-wide text-textPrimary">
            Accolades
          </h4>
          <span className="ml-auto text-[11px] tabular-nums text-textMuted">
            {earnedCount} / {accolades.length} unlocked
          </span>
        </div>
        <motion.div
          variants={containerV}
          initial="hidden"
          animate="show"
          className={`grid grid-cols-4 sm:grid-cols-6 ${compact ? 'gap-2.5' : 'gap-4'}`}
        >
          {accoladesShown.map((a) => (
            <AccoladeMedallion key={a.id} a={a} isOwnProfile={isOwnProfile} />
          ))}
        </motion.div>
        {compact && lockedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllAccolades((v) => !v)}
            className="mt-3 w-full text-[11px] font-medium text-textMuted transition-colors hover:text-textPrimary"
          >
            {showAllAccolades ? 'Show fewer' : `Show all ${accolades.length} (${lockedCount} locked)`}
          </button>
        )}
        <div className={`${compact ? 'mt-3' : 'mt-5'} h-1.5 overflow-hidden rounded-full bg-white/[0.06]`}>
          <div
            className="h-full rounded-full bg-accent/70 transition-[width] duration-700 ease-out"
            style={{ width: `${Math.round((earnedCount / accolades.length) * 100)}%` }}
          />
        </div>
      </div>
      )}
    </div>
  );
};

export default ProfileOverview;
