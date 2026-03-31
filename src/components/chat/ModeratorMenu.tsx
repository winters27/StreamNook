import React, { useState, useRef, useEffect } from 'react';
import { Shield, Users, MessageSquare, Clock, Slash, Hash } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Tooltip } from '../ui/Tooltip';
import { GlassSelect } from '../ui/GlassSelect';
import { invoke } from '@tauri-apps/api/core';
import { Logger } from '../../utils/logger';
import { useAppStore } from '../../stores/AppStore';

interface ModeratorMenuProps {
  broadcasterId: string;
  roomState: {
    followersOnly: number;
    slow: number;
    subsOnly: boolean;
    emoteOnly: boolean;
    r9k: boolean;
  };
}

const ModeratorMenu: React.FC<ModeratorMenuProps> = ({ broadcasterId, roomState }) => {
  const { settings, updateSettings } = useAppStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPending, setIsPending] = useState(false);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsConfirmingClear(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggleSetting = async (setting: string, currentValue: boolean | number) => {
    if (isPending || !broadcasterId) return;
    setIsPending(true);

    try {
      const payload: Record<string, boolean | number> = {};
      
      switch (setting) {
        case 'emote_mode':
          payload.emote_mode = !currentValue;
          break;
        case 'follower_mode':
          payload.follower_mode = (currentValue === -1);
          // Standardized default to 0 (all followers) if turning on
          if (currentValue === -1) payload.follower_mode_duration = 0; 
          break;
        case 'subscriber_mode':
          payload.subscriber_mode = !currentValue;
          break;
        case 'slow_mode':
          payload.slow_mode = (currentValue === 0);
          if (currentValue === 0) payload.slow_mode_wait_time = 10; // Default 10s slow mode
          break;
        case 'unique_chat_mode':
          payload.unique_chat_mode = !currentValue;
          break;
      }

      await invoke('update_chat_settings', {
        broadcasterId,
        settings: payload
      });
      Logger.debug(`[ModeratorMenu] Updated chat setting ${setting}:`, payload);
      
    } catch (err) {
      Logger.error(`[ModeratorMenu] Failed to update chat setting ${setting}:`, err);
    } finally {
      setIsPending(false);
    }
  };

  const handleClearChat = async () => {
    if (isPending || !broadcasterId) return;
    setIsPending(true);

    try {
      await invoke('clear_chat', { broadcasterId });
      Logger.debug('[ModeratorMenu] Cleared chat successfully.');
      setIsConfirmingClear(false);
      setIsOpen(false);
    } catch (err) {
      Logger.error('[ModeratorMenu] Failed to clear chat:', err);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="static inline-flex" ref={containerRef}>
      <Tooltip content="Moderator Tools">
        <button
          onClick={() => {
            setIsOpen(!isOpen);
            setIsConfirmingClear(false);
          }}
          className={`
            group p-1.5 rounded-lg flex items-center justify-center transition-all duration-200
            ${isOpen ? 'bg-green-500/10 text-green-400' : 'text-green-500/60 hover:text-green-400 hover:bg-green-500/10'}
          `}
        >
          <Shield size={18} strokeWidth={isOpen ? 2.5 : 2} className="transition-all duration-200 group-hover:drop-shadow-[0_0_6px_rgba(74,222,128,0.5)]" />
        </button>
      </Tooltip>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute z-[60] bottom-full left-0 right-0 mb-2 h-[520px] max-h-[calc(100vh-120px)] flex flex-col overflow-hidden rounded-xl border border-borderSubtle shadow-[0_16px_48px_rgba(0,0,0,0.8)] bg-background/[0.45] glass-panel origin-bottom"
            style={{ backdropFilter: 'blur(64px) saturate(300%)', WebkitBackdropFilter: 'blur(64px) saturate(300%)' }}
          >
            <div className="px-4 py-3 border-b border-white/5 flex items-center bg-background/[0.5] backdrop-blur-md shadow-sm z-10 relative">
              <span className="text-[11px] font-semibold text-white/50 tracking-wider uppercase">Stream Moderator Settings</span>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
              <div className="flex flex-col gap-1 p-1">
                <MenuToggleItem 
                  icon={<MessageSquare size={14} />} 
                label="Emote-Only Mode" 
                isActive={roomState.emoteOnly}
                onClick={() => handleToggleSetting('emote_mode', roomState.emoteOnly)}
                disabled={isPending}
              />
              <MenuToggleItem 
                icon={<Users size={14} />} 
                label="Follower-Only Mode" 
                isActive={roomState.followersOnly !== -1}
                onClick={() => handleToggleSetting('follower_mode', roomState.followersOnly)}
                disabled={isPending}
              />
              <MenuToggleItem 
                icon={<Shield size={14} />} 
                label="Subscriber-Only Mode" 
                isActive={roomState.subsOnly}
                onClick={() => handleToggleSetting('subscriber_mode', roomState.subsOnly)}
                disabled={isPending}
              />
              <div className="px-2.5 py-2 flex items-center justify-between hover:bg-white/5 rounded-md transition-colors">
                <div className="flex items-center gap-2.5">
                  <div className={`flex items-center justify-center ${roomState.slow > 0 ? 'text-green-400' : 'text-white/40'}`}>
                    <Clock size={14} />
                  </div>
                  <span className={`text-sm ${roomState.slow > 0 ? 'text-white' : 'text-white/70'}`}>
                    Slow Mode
                  </span>
                </div>
                <div className="w-[85px] z-[60]" onClick={e => e.stopPropagation()}>
                    <GlassSelect
                      value={roomState.slow > 0 ? roomState.slow.toString() : '0'}
                      onChange={(val) => {
                        const numericVal = parseInt(val, 10);
                        if (isPending || !broadcasterId) return;
                        setIsPending(true);
                        invoke('update_chat_settings', {
                          broadcasterId,
                          settings: { slow_mode: numericVal > 0, slow_mode_wait_time: numericVal > 0 ? numericVal : undefined }
                        }).then(() => {
                           Logger.debug(`[ModeratorMenu] Updated slow mode to ${numericVal}s`);
                        }).catch(err => {
                           Logger.error(`[ModeratorMenu] Failed to update slow mode:`, err);
                        }).finally(() => {
                           setIsPending(false);
                        });
                      }}
                      options={[
                        { value: '0', label: 'Off' },
                        { value: '3', label: '3s' },
                        { value: '5', label: '5s' },
                        { value: '10', label: '10s' },
                        { value: '20', label: '20s' },
                        { value: '30', label: '30s' },
                        { value: '60', label: '60s' },
                        { value: '120', label: '120s' },
                      ]}
                      placement="top"
                      className="!py-1.5 !px-2.5 !min-w-[85px] !text-[12px] !bg-white/5 hover:!bg-white/10"
                    />
                </div>
              </div>
              <MenuToggleItem 
                icon={<Hash size={14} />} 
                label="Unique Chat (r9k)" 
                isActive={roomState.r9k}
                onClick={() => handleToggleSetting('unique_chat_mode', roomState.r9k)}
                disabled={isPending}
              />
            </div>

            <div className="p-1.5 border-t border-white/10 flex flex-col gap-1">
              <div className="px-2 pt-1 pb-0.5">
                <span className="text-[10px] font-semibold text-white/40 tracking-wider uppercase">Local Settings</span>
              </div>
              <MenuToggleItem 
                icon={<Shield size={14} className="text-accent" />} 
                label="Show Mod Logs Pane" 
                isActive={settings.show_mod_logs ?? false}
                onClick={async () => {
                  try {
                    await updateSettings({ ...settings, show_mod_logs: !settings.show_mod_logs });
                  } catch (e) {
                    Logger.error('[ModeratorMenu] Failed to update settings:', e);
                  }
                }}
                disabled={false}
              />
            </div>
          </div>

          <div className="p-1.5 border-t border-white/10 shrink-0 bg-background/50">
            {!isConfirmingClear ? (
              <button
                onClick={() => setIsConfirmingClear(true)}
                disabled={isPending}
                className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2.5 text-red-400 hover:bg-red-500/10 transition-colors text-sm"
              >
                <Slash size={14} />
                <span>Clear Chat</span>
              </button>
            ) : (
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs text-red-400 font-medium tracking-wide">Are you sure?</span>
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={handleClearChat}
                    disabled={isPending}
                    className="px-2.5 py-1 text-xs font-semibold bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded transition-colors disabled:opacity-50"
                  >
                    Yes
                  </button>
                  <button 
                    onClick={() => setIsConfirmingClear(false)}
                    disabled={isPending}
                    className="px-2.5 py-1 text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/70 rounded transition-colors disabled:opacity-50"
                  >
                    No
                  </button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};


const MenuToggleItem = ({ 
  icon, 
  label, 
  isActive, 
  onClick, 
  disabled 
}: { 
  icon: React.ReactNode; 
  label: string; 
  isActive: boolean; 
  onClick: () => void;
  disabled: boolean;
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        w-full text-left px-2.5 py-2 rounded-md flex items-center justify-between transition-colors outline-none
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5 focus:bg-white/5'}
      `}
    >
      <div className="flex items-center gap-2.5">
        <div className={`
          flex items-center justify-center
          ${isActive ? 'text-green-400' : 'text-white/40'}
        `}>
          {icon}
        </div>
        <span className={`text-sm ${isActive ? 'text-white' : 'text-white/70'}`}>
          {label}
        </span>
      </div>
      
      {/* Toggle switch visual */}
      <div className={`
        w-7 h-4 rounded-full flex items-center p-0.5 transition-colors duration-200
        ${isActive ? 'bg-green-500' : 'bg-white/20'}
      `}>
        <div className={`
          w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-200
          ${isActive ? 'translate-x-3' : 'translate-x-0'}
        `} />
      </div>
    </button>
  );
};

export default ModeratorMenu;
