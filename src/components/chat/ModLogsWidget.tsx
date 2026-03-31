import React, { useRef, useEffect } from 'react';
import { useAppStore } from '../../stores/AppStore';
import { motion, AnimatePresence } from 'framer-motion';

export const ModLogsWidget: React.FC = () => {
  const { modLogs, clearModLogs, settings } = useAppStore();
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [modLogs]);

  if (!settings.show_mod_logs) return null;

  return (
    <div className="flex flex-col h-full bg-background border-borderSubtle overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-secondary border-b border-borderSubtle">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <span className="text-sm font-medium text-text">Moderator Logs</span>
          <span className="text-xs text-textSecondary ml-2 bg-background px-2 overflow-hidden rounded-full">
            {modLogs.length} events
          </span>
        </div>
        <button
          onClick={clearModLogs}
          className="text-xs text-textSecondary hover:text-text transition-colors p-1 rounded hover:bg-background"
          title="Clear Logs"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {/* Logs Container */}
      <div 
        ref={logsContainerRef}
        className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-accent scrollbar-track-transparent p-2 space-y-2"
      >
        <AnimatePresence initial={false}>
          {modLogs.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center justify-center h-full text-textSecondary text-sm"
            >
              No moderation events yet
            </motion.div>
          ) : (
            modLogs.map((log) => (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-secondary rounded p-2 text-sm border border-borderSubtle space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-textSecondary text-xs">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="uppercase text-xs font-bold text-accent">
                    {log.action}
                  </span>
                </div>
                
                <div className="flex flex-wrap items-baseline gap-1">
                  <span className="font-semibold text-[color:var(--tw-prose-links)]">{log.moderator_name}</span>
                  <span className="text-textSecondary">acted on</span>
                  <span className="font-semibold text-text">{log.target_user_name || 'Stream/Settings'}</span>
                </div>

                {log.duration !== undefined && log.duration !== null && (
                  <div className="text-xs text-textSecondary">
                    Duration: <span className="text-text font-medium">{log.duration}s</span>
                  </div>
                )}
                
                {log.reason && (
                  <div className="text-xs italic text-textSecondary bg-background p-1.5 rounded mt-1 border border-borderSubtle/50">
                    "{log.reason}"
                  </div>
                )}
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
