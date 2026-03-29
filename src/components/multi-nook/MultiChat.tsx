import React, { useEffect, useState, useRef } from 'react';
import { usemultiNookStore } from '../../stores/multiNookStore';
import { useMultiChat } from '../../hooks/useMultiChat';
import ChatMessage from '../ChatMessage';
import { Logger } from '../../utils/logger';

export const MultiChat: React.FC = () => {
  const { slots } = usemultiNookStore();
  const { messages, connectMultiChat, sendMessage, isConnected, cleanupWebSocket } = useMultiChat();
  const [inputText, setInputText] = useState('');
  const [selectedChannel, setSelectedChannel] = useState<string>('');
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Connect on slots change
  useEffect(() => {
    const channels = slots.map(s => s.channelLogin);
    if (channels.length > 0) {
      connectMultiChat(channels).catch(e => Logger.error('Failed to connect multi chat', e));
      
      // Auto-select focused channel or first
      const focused = slots.find(s => s.isFocused);
      if (focused) setSelectedChannel(focused.channelLogin);
      else if (!selectedChannel && channels[0]) setSelectedChannel(channels[0]);
      else if (selectedChannel && !channels.includes(selectedChannel)) setSelectedChannel(channels[0]);
    } else {
      cleanupWebSocket();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, connectMultiChat, cleanupWebSocket]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedChannel) return;
    
    sendMessage(inputText, selectedChannel).then(success => {
      if (success) setInputText('');
    });
  };

  if (slots.length === 0) {
    return (
      <div className="w-full h-full bg-slate-950 border-l border-slate-900 flex flex-col items-center justify-center text-slate-500">
        <i className="ri-chat-off-line text-4xl mb-4 opacity-50"></i>
        <p>No chat channels added yet</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-slate-950 border-l border-slate-900 flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-white/10 flex items-center justify-between px-4 bg-black/40">
        <h3 className="text-white/80 font-medium">Multi Chat</h3>
        <span className="text-xs px-2 py-1 rounded bg-white/10 text-white/70 border border-white/5">
          {slots.length} channel{slots.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="flex items-center justify-center p-8 text-white/30 text-sm">
            {isConnected ? 'Welcome to unified chat...' : 'Connecting...'}
          </div>
        )}
        
        {messages.map((msg, idx) => {
          const channel = msg.channel || '';
          const msgId = msg.id || typeof msg === 'string' ? msg.match(/(?:^|;)id=([^;]+)/)?.[1] : undefined;
          
          // Generate a safe unique key
          const safeKey = msgId || `multichat-${idx}`;

          return (
            <div key={safeKey} className="group relative">
              {/* Channel Indicator */}
              <div className="text-[10px] font-bold uppercase tracking-wider text-white/30 mb-0.5 ml-8 pl-1 select-none">
                # {channel}
              </div>
              <ChatMessage 
                message={msg}
                messageIndex={idx}
                onUsernameClick={() => {}}
                onReplyClick={() => {}}
                onEmoteRightClick={() => {}}
                onUsernameRightClick={() => {}}
                onBadgeClick={() => {}}
                isHighlighted={false}
              />
            </div>
          );
        })}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-white/10 bg-black/40">
        <div className="flex gap-2 mb-2 p-1 overflow-x-auto scrollbar-none">
          {slots.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSelectedChannel(s.channelLogin)}
              className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all border ${
                selectedChannel === s.channelLogin 
                  ? 'bg-white/15 text-white shadow-[0_0_15px_rgba(255,255,255,0.25)] border-white/20' 
                  : 'bg-white/5 text-white/50 border-white/5 hover:bg-white/10 hover:text-white/80'
              }`}
            >
              # {s.channelLogin}
            </button>
          ))}
        </div>
        
        <div className="flex bg-white/5 rounded-lg border border-white/10 pb-0.5 overflow-hidden focus-within:border-white/30 focus-within:shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={`Send to #${selectedChannel}...`}
            className="flex-1 bg-transparent border-none text-white text-sm px-3 py-2 outline-none"
          />
          <button 
            type="submit"
            disabled={!inputText.trim()}
            className="px-4 text-white/60 hover:text-white disabled:opacity-30 disabled:hover:text-white/60 transition-colors"
          >
            <i className="ri-send-plane-fill"></i>
          </button>
        </div>
      </form>
    </div>
  );
};

