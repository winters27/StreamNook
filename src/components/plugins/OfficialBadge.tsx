import { BadgeCheck } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

/** Marks a first-party plugin built by StreamNook. Shown as an icon-only
 *  verified mark next to the plugin name (social-media style); the wording
 *  lives in the hover tooltip. Approved third-party plugins do not carry this;
 *  being in the index is their approval. */
const OfficialBadge = () => (
  <Tooltip content="Official plugin, built by StreamNook">
    <span className="inline-flex flex-shrink-0 items-center text-amber-300">
      <BadgeCheck size={15} strokeWidth={2.5} />
    </span>
  </Tooltip>
);

export default OfficialBadge;
