import { Check } from 'lucide-react';

/** A green confirmation that a plugin is installed. Uses the bordered chip
 *  style (the tier/official chips' old look), now reserved for this status so
 *  it stands on its own: the official mark is an icon next to the name and the
 *  tier is a soft pill, leaving this chip style to read as "installed". */
const InstalledBadge = () => (
  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/20 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
    <Check size={11} strokeWidth={2.5} />
    Installed
  </span>
);

export default InstalledBadge;
