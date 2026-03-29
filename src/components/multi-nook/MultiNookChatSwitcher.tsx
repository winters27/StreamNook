import React from 'react';
import { usemultiNookStore } from '../../stores/multiNookStore';
import { MessageCircle } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

const MultiNookChatSwitcher: React.FC = () => {
  const { slots, activeChatChannelId, setActiveChatChannelId } = usemultiNookStore();

  if (slots.length <= 1) return null; // Only show if multiple streams exist

  return (
    <div className="flex-shrink-0 flex items-center gap-2 p-2 px-3 overflow-x-auto scrollbar-thin border-b border-borderSubtle bg-glass/30 backdrop-blur-sm shadow-sm" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <MessageCircle size={14} className="text-textMuted flex-shrink-0" />
      <div className="flex items-center gap-1.5 min-w-max">
        {slots.map((slot) => {
          // If the slot hasn't fully loaded its ID yet, fallback to login logic temporarily
          const isActive = slot.channelId 
            ? activeChatChannelId === slot.channelId 
            : activeChatChannelId === slot.channelLogin; // Safety fallback

          return (
            <Tooltip key={slot.id} content={`Switch chat to ${slot.channelName || slot.channelLogin}`} side="bottom">
              <button
                onClick={() => setActiveChatChannelId(slot.channelId || slot.channelLogin)}
                className={`
                  px-3 py-1.5 text-xs font-bold tracking-wide rounded-full transition-all duration-200 flex items-center gap-1.5
                  ${isActive 
                    ? 'glass-input text-accent font-extrabold' 
                    : 'glass-button text-textSecondary hover:text-white'}
                `}
              >
                {slot.channelName || slot.channelLogin}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};

export default MultiNookChatSwitcher;

