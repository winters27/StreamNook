import { useContext, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Smile } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { getEmoteUsageSummary, type EmoteUsageSummary } from '../../services/supabaseService';
import { ProfileAccentContext, ProfileCompactContext } from './profileAccentContext';

const containerV = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } };
const itemV = {
  hidden: { opacity: 0, scale: 0.9 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.22, ease: 'easeOut' as const } },
};

const TopEmotesSection = ({ userId }: { userId: string }) => {
  const [summary, setSummary] = useState<EmoteUsageSummary | null>(null);

  useEffect(() => {
    let alive = true;
    getEmoteUsageSummary(userId, 12)
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { if (alive) setSummary({ top: [], uniqueCount: 0, totalCount: 0 }); });
    return () => { alive = false; };
  }, [userId]);

  const accentRgb = useContext(ProfileAccentContext);
  const compact = useContext(ProfileCompactContext);

  return (
    <div
      className={`glass-panel rounded-xl ${compact ? 'p-4' : 'p-5'}`}
      style={accentRgb ? { borderColor: `rgba(${accentRgb}, 0.3)` } : undefined}
    >
      <div className={`flex items-center gap-1.5 ${compact ? 'mb-3' : 'mb-4'}`}>
        <Smile size={14} className="text-textMuted" />
        <h4 className="text-sm font-semibold uppercase tracking-wide text-textPrimary">
          Top Emotes
        </h4>
        {summary && summary.uniqueCount > 0 && (
          <span className="ml-auto text-[11px] tabular-nums text-textMuted">
            {summary.uniqueCount.toLocaleString()} emotes · {summary.totalCount.toLocaleString()} used
          </span>
        )}
      </div>

      {summary === null ? null : summary.top.length === 0 ? (
        <p className="text-sm italic text-textSecondary">
          Start chatting to track your most-used emotes.
        </p>
      ) : (
        <motion.div
          variants={containerV}
          initial="hidden"
          animate="show"
          className={`grid grid-cols-4 sm:grid-cols-6 ${compact ? 'gap-2' : 'gap-3'}`}
        >
          {summary.top.map((e, i) => (
            <Tooltip
              key={e.emote_id}
              content={`${e.emote_name} · ${e.count.toLocaleString()} · ${e.provider.toUpperCase()}`}
              side="top"
            >
              <motion.div
                variants={itemV}
                className={`flex flex-col items-center gap-1 rounded-lg border p-2 ${
                  i === 0
                    ? 'border-accent/30 bg-accent/[0.06]'
                    : 'border-white/[0.06] bg-white/[0.03]'
                }`}
              >
                <div className="flex h-10 items-center justify-center">
                  {e.image_url ? (
                    <img
                      src={e.image_url}
                      alt={e.emote_name}
                      className="max-h-10 max-w-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <span className="truncate text-[10px] text-textMuted">{e.emote_name}</span>
                  )}
                </div>
                <span className="text-[11px] font-semibold tabular-nums text-textPrimary">
                  {e.count.toLocaleString()}
                </span>
              </motion.div>
            </Tooltip>
          ))}
        </motion.div>
      )}
    </div>
  );
};

export default TopEmotesSection;
