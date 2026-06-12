import { Check } from 'lucide-react';

/** A green confirmation that a plugin is installed. Deliberately styled unlike
 *  the Official / tier chips (those are uppercase, bordered, rounded-rect
 *  category tags): this is a soft green pill, sentence case, with a check, so
 *  it reads as a positive status rather than another classification chip. */
const InstalledBadge = () => (
  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
    <Check size={12} strokeWidth={3} />
    Installed
  </span>
);

export default InstalledBadge;
