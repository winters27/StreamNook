import { PluginTier, TIER_LABEL } from '../../types/plugins';
import { Tooltip } from '../ui/Tooltip';

const TIER_CLASSES: Record<PluginTier, string> = {
  A: 'bg-emerald-500/20 text-emerald-200',
  B: 'bg-sky-500/20 text-sky-200',
  C: 'bg-violet-500/20 text-violet-200',
};

const TIER_HINT: Record<PluginTier, string> = {
  A: 'Official APIs and local features',
  B: 'Uses additional Twitch and third-party interfaces',
  C: 'A power-user add-on that runs in its own process and can use your login',
};

/** Small capability-scope pill (soft, ovular, sentence case) — visually
 *  distinct from the official verified mark and the installed chip. */
const TierBadge = ({ tier }: { tier: PluginTier }) => (
  <Tooltip content={TIER_HINT[tier]}>
    <span
      className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${TIER_CLASSES[tier]}`}
    >
      {TIER_LABEL[tier]}
    </span>
  </Tooltip>
);

export default TierBadge;
