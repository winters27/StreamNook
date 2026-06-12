import { Check } from 'lucide-react';

/** A green confirmation badge for an already-installed plugin. It is a status,
 *  not an action, so it reads as a badge (like Official / tier chips), not a
 *  button. The actionable states (Get / Update / Install) keep the button look. */
const InstalledBadge = () => (
  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/20 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
    <Check size={11} strokeWidth={2.5} />
    Installed
  </span>
);

export default InstalledBadge;
