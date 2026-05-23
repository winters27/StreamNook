import { useEffect, useState, useRef, memo } from 'react';
import type { ReactNode, MouseEvent } from 'react';
import { Tooltip } from './ui/Tooltip';
import streamNookLogo from '../assets/streamnook-logo.png';

interface StreamNookBadgeProps {
  userNumber: number | null;
}

// Rank tiers based on signup order. The cutoffs and labels are intentionally
// kept here in one place; if these names ever change, everyone who already saw
// their old tier label will notice, so treat them as durable.
//
// CARD layout (not a tooltip pill). Each tier renders as a composed card:
//   ┌────────────────────────────┐
//   │     STREAMNOOK             │  <- wordmark, tiny tracked caps
//   │                            │
//   │   Nº   01                  │  <- number, prominent, tier-styled
//   │                            │
//   │   ─────                    │  <- thin tier-colored hairline
//   │   ETHEREAL                 │  <- tier label, tier-styled
//   └────────────────────────────┘
//
// For Ethereal (#1) only: a soft internal violet aura sits behind the content
// (radial gradient on the card bg, NOT on the label text, so it doesn't
// violate the "no glow on label" rule from past iterations). The number's
// hue-melt and the aura are the two visual signatures of tier #1 and do not
// propagate to any other tier or anywhere else in the app.
//
// All Tailwind class strings are kept as literals so JIT can scan them.
interface TierInfo {
  label: string | null;
  numberClassName: string;
  hairlineClassName: string;
  labelClassName: string;
  /** Optional internal aura overlay (Ethereal only). */
  auraClassName?: string;
}

// Shared card chassis. Liquid-glass material, the most premium surface in
// the app, with a stronger bevel than glass-button. Generous padding and
// rounded-2xl give it physical presence vs. the prior tooltip pill.
const CARD_CLASS =
  'relative inline-flex flex-col items-center px-7 py-5 rounded-2xl pointer-events-none min-w-[220px] ' +
  'bg-[rgba(14,14,18,0.92)] backdrop-blur-2xl border border-white/[0.04] ' +
  'shadow-[inset_1px_1px_0_0_rgba(255,255,255,0.14),inset_-1px_-1px_0_0_rgba(0,0,0,0.50),0_20px_50px_-15px_rgba(0,0,0,0.7),0_0_30px_-5px_rgba(0,0,0,0.4)]';

// Number typography. Fraunces Variable (italic) at a light weight gives a
// silky calligraphic display-serif feel that Satoshi can't produce. Font is
// imported in main.tsx (@fontsource-variable/fraunces/wght-italic.css).
// `font-style: italic` is implied by the import variant; we also set it
// explicitly via Tailwind so it's visible in the JSX.
const NUMBER_BASE_CLASS =
  "font-['Fraunces_Variable'] italic font-light text-[52px] tabular-nums leading-none tracking-tight";

// Label typography. Small, tracked-out caps. Reads as classic museum-style
// nameplate subtitle.
const LABEL_BASE_CLASS =
  'text-[10px] uppercase tracking-[0.28em] font-semibold leading-none';

// Easter-egg ranks. Numbers with cultural / meme / gaming significance get a
// custom label overriding the standard tier name (Ascendant / Founder / Member /
// etc.). The number color, hairline, aura, and label STYLING all stay tied to
// the underlying tier band — only the label TEXT changes. That keeps the visual
// hierarchy intact and makes the surprise purely about the reveal moment:
// you expected "FOUNDER" and got "BLAZE IT".
//
// Keep this list deliberately small. The magic is in recognizing the number;
// enumerating every meme would dilute the discovery. If a candidate doesn't
// trigger immediate "oh!" recognition for a broad audience, leave it out.
const EASTER_EGGS: Record<number, string> = {
  42: 'The Answer',     // Hitchhiker's Guide to the Galaxy
  67: 'Six Seven',      // TikTok meme (LaMelo Ball)
  69: 'Nice',           // universal
  141: 'Going Dark',    // Task Force 141 / Call of Duty
  404: 'Not Found',     // web HTTP status
  420: 'Blaze It',      // cannabis culture
  1337: 'Leet',         // leetspeak / hacker culture
  9000: 'Over 9000',    // Dragon Ball Z
};

const getTier = (n: number): TierInfo => {
  const base = getTierBase(n);
  const easterEgg = EASTER_EGGS[n];
  return easterEgg ? { ...base, label: easterEgg } : base;
};

const getTierBase = (n: number): TierInfo => {
  if (n === 1) {
    return {
      label: 'Ethereal',
      numberClassName: `${NUMBER_BASE_CLASS} sn-ethereal-text`,
      hairlineClassName: 'bg-gradient-to-r from-transparent via-violet-400/50 to-transparent',
      // Italic violet, slightly lighter weight than the chip tiers. The
      // number's hue-melt and the card's internal aura carry the Ethereal
      // identity; the label stays restrained. No chip, no glow on the text.
      labelClassName: 'text-[11px] italic tracking-[0.22em] font-light text-violet-200',
      // Soft internal aura via radial violet gradient on the card bg, sitting
      // BEHIND the content. Not a glow on any text element.
      auraClassName: 'absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_50%_70%,rgba(139,92,246,0.18),transparent_60%)] pointer-events-none',
    };
  }
  if (n <= 10) {
    // Mythic: the second tier, only 9 people. Visually shares lineage with
    // Ethereal (italic light label, soft tier-tinted aura) to read as the
    // "inner circle," distinct from the bulk brand-color tiers below.
    return {
      label: 'Mythic',
      numberClassName: `${NUMBER_BASE_CLASS} text-amber-200`,
      hairlineClassName: 'bg-gradient-to-r from-transparent via-amber-400/45 to-transparent',
      // Italic light, same shape as Ethereal's label. The founding-tier band
      // shares this treatment so they cluster visually.
      labelClassName: 'text-[11px] italic tracking-[0.22em] font-light text-amber-200',
      // Soft warm amber aura. Lower alpha + tighter falloff than Ethereal's
      // violet so the hierarchy is clear (Ethereal still reads as MORE).
      auraClassName: 'absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_50%_75%,rgba(251,191,36,0.10),transparent_55%)] pointer-events-none',
    };
  }
  if (n <= 100) {
    return {
      label: 'Ascendant',
      numberClassName: `${NUMBER_BASE_CLASS} text-accent`,
      hairlineClassName: 'bg-gradient-to-r from-transparent via-cyan-400/35 to-transparent',
      labelClassName: `${LABEL_BASE_CLASS} text-accent`,
    };
  }
  if (n <= 1000) {
    return {
      label: 'Founder',
      numberClassName: `${NUMBER_BASE_CLASS} text-textPrimary`,
      hairlineClassName: 'bg-gradient-to-r from-transparent via-white/20 to-transparent',
      labelClassName: `${LABEL_BASE_CLASS} text-textPrimary`,
    };
  }
  // Member: bulk community tier. Now renders a label (previously was the
  // unlabeled fallback). Muted color so it sits visually quieter than Founder.
  return {
    label: 'Member',
    numberClassName: `${NUMBER_BASE_CLASS} text-textPrimary`,
    hairlineClassName: 'bg-gradient-to-r from-transparent via-white/15 to-transparent',
    labelClassName: `${LABEL_BASE_CLASS} text-textSecondary`,
  };
};

// Mixed pool: digits (the target glyphs), half-width katakana for the matrix flavor,
// plus a few punctuation marks for visual variety while scrambling.
const SCRAMBLE_POOL =
  '0123456789' +
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
  '!#$%&*+';

const pickRandomGlyph = () =>
  SCRAMBLE_POOL.charAt(Math.floor(Math.random() * SCRAMBLE_POOL.length));

const SCRAMBLE_MS = 700;     // duration of the pure-cypher scramble phase
const SWAP_INTERVAL_MS = 60; // throttle for glyph swaps during scramble (~16/sec)
const MIN_SCRAMBLE_WIDTH = 3; // minimum cypher width so single-digit numbers feel substantial

interface MatrixDecodeProps {
  numberText: string;
  tier: TierInfo;
  /** When true, mount straight in the resolved state (no cypher, no fade-in).
      Used for surfaces where the user is looking at their *own* rank (e.g.
      ProfileModal), since the cypher reveal is a "discover someone else's
      tier" moment, not a self-check moment. */
  skipCypher?: boolean;
}

const MatrixDecode = ({ numberText, tier, skipCypher = false }: MatrixDecodeProps) => {
  const padWidth = Math.max(numberText.length, MIN_SCRAMBLE_WIDTH);

  // Build the initial scramble synchronously so the first paint has glyphs in it
  // rather than an empty string flicker before the RAF loop kicks in.
  const [scramble, setScramble] = useState(() => {
    let s = '';
    for (let i = 0; i < padWidth; i++) s += pickRandomGlyph();
    return s;
  });
  // When skipCypher is set, start fully resolved (no scramble, no fade-in).
  const [revealed, setRevealed] = useState(skipCypher);
  const [animateIn, setAnimateIn] = useState(skipCypher);

  const rafRef = useRef<number | null>(null);
  const revealTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (skipCypher) return; // no animation work needed
    const startTime = performance.now();
    let lastSwapTime = startTime;
    let current: string[] = [];
    for (let i = 0; i < padWidth; i++) current.push(pickRandomGlyph());

    const tick = () => {
      const now = performance.now();
      const elapsed = now - startTime;

      if (now - lastSwapTime >= SWAP_INTERVAL_MS) {
        current = current.map(() => pickRandomGlyph());
        lastSwapTime = now;
        setScramble(current.join(''));
      }

      if (elapsed < SCRAMBLE_MS) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    revealTimerRef.current = setTimeout(() => {
      setRevealed(true);
      // Defer flipping animateIn by two frames so the resolved layout mounts
      // at its initial state (opacity-0, translate-y-1) before transitioning
      // to its final state. Single rAF is sometimes not enough; paint can
      // batch the two state updates and skip the from-state.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimateIn(true));
      });
    }, SCRAMBLE_MS);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    };
  }, [padWidth, skipCypher]);

  // Card composition. The number element is always rendered (mono cypher
  // glyphs during phase 1, tier-styled resolved number during phase 2) so the
  // card geometry stays stable through the reveal. The decorative chrome
  // (wordmark, "Nº" prefix, hairline, tier label) is rendered alongside but
  // held at opacity-0 during the cypher; on reveal they fade and slide in
  // together. Pre-rendering at opacity-0 reserves their layout space so the
  // card doesn't jump from compact-cypher to taller-card on resolve.
  const chromeTransition = `transition-all duration-300 ease-out ${
    animateIn ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
  }`;

  return (
    <>
      {tier.auraClassName && <div className={tier.auraClassName} />}
      <div className="relative flex flex-col items-center w-full">
        {/* Wordmark */}
        <div
          className={`text-[9px] uppercase tracking-[0.36em] font-medium text-white/35 mb-4 ${chromeTransition}`}
        >
          StreamNook
        </div>

        {/* Number row: leading Nº prefix + number, with a phantom Nº mirror on
            the right (visibility: hidden) so the flex row is symmetric in both
            phases. The visible Nº and phantom Nº have identical font metrics
            ⇒ identical widths ⇒ the scramble / resolved number always sits at
            the geometric center of the row, regardless of whether the leading
            Nº is at opacity-0 (cypher) or opacity-1 (reveal). */}
        <div className="flex items-baseline justify-center gap-2 mb-3.5">
          <span className={`text-[11px] text-white/30 font-light leading-none ${chromeTransition}`}>
            Nº
          </span>
          {!revealed ? (
            <span className="font-mono text-[52px] font-extralight text-textPrimary tabular-nums leading-none tracking-tight">
              {scramble}
            </span>
          ) : (
            <span className={tier.numberClassName}>{numberText}</span>
          )}
          <span className="text-[11px] font-light leading-none invisible" aria-hidden="true">
            Nº
          </span>
        </div>

        {/* Tier-colored hairline */}
        <div className={`w-16 h-px ${tier.hairlineClassName} mb-2.5 ${chromeTransition}`} />

        {/* Tier label */}
        {tier.label && (
          <div className={`${tier.labelClassName} ${chromeTransition}`}>{tier.label}</div>
        )}
      </div>
    </>
  );
};

// Standalone tier card with chassis + aura + composed content. Used both as the
// Tooltip content for the chat-badge hover (via StreamNookBadge) and as an
// inline element in any "your identity" surface (e.g. ProfileModal). When
// inline, place it directly; when in a tooltip, pass CARD_CLASS as the
// tooltip's containerClassName so the tooltip bubble itself becomes the card
// chassis (avoids double-wrapping).
export const StreamNookTierCard = memo(function StreamNookTierCard({
  userNumber,
  skipCypher = false,
}: { userNumber: number; skipCypher?: boolean }) {
  const tier = getTier(userNumber);
  return (
    <div className={CARD_CLASS}>
      {tier.auraClassName && <div className={tier.auraClassName} />}
      <MatrixDecode numberText={String(userNumber)} tier={tier} skipCypher={skipCypher} />
    </div>
  );
});

export const StreamNookBadge = memo(function StreamNookBadge({
  userNumber,
}: StreamNookBadgeProps) {
  // Default click opens BadgesOverlay on the StreamNook tab. Same destination
  // from every surface (chat row, UserProfileCard badge list, etc.). Wrapped
  // with stopPropagation so the surrounding chat row's own click handler
  // (which opens UserProfileCard) doesn't also fire. Matches the 7TV chat
  // badge pattern (`openBadgesWithBadge`).
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    // Routed through openBadgesInMain so popout clicks open the overlay in
    // the main window. Imported lazily to avoid a static cycle if
    // StreamNookBadge ever lands in a deeper import chain than the helper.
    import('../utils/openBadgesInMain').then(({ openBadgesOnStreamNookInMain }) => {
      openBadgesOnStreamNookInMain();
    });
  };
  // If the registry lookup somehow missed (shouldn't happen given isSN was true),
  // fall back to the plain label so we never render a broken animation.
  let tooltipContent: ReactNode;
  let containerClassName: string | undefined;
  if (userNumber != null) {
    const tier = getTier(userNumber);
    tooltipContent = (
      <>
        {tier.auraClassName && <div className={tier.auraClassName} />}
        <MatrixDecode numberText={String(userNumber)} tier={tier} />
      </>
    );
    containerClassName = CARD_CLASS;
  } else {
    tooltipContent = 'StreamNook user';
  }

  return (
    <Tooltip
      content={tooltipContent}
      side="top"
      delay={120}
      containerClassName={containerClassName}
    >
      <img
        src={streamNookLogo}
        alt="StreamNook"
        loading="lazy"
        className="w-5 h-5 inline-block object-contain cursor-pointer hover:scale-110 transition-transform"
        draggable={false}
        onClick={handleClick}
      />
    </Tooltip>
  );
});
