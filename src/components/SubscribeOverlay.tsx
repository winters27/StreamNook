import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Star } from 'lucide-react';

interface SubscribeOverlayProps {
  channel: string;
}

const SubscribeOverlay = ({ channel }: SubscribeOverlayProps) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const handleSubscribe = () => {
    invoke('shell_open', { url: `https://www.twitch.tv/subs/${channel}` });
  };

  return (
    <div className="absolute top-4 right-4 glass-panel backdrop-blur-lg p-3 rounded-lg shadow-lg flex items-center gap-3 animate-fade-in">
      <button 
        onClick={handleSubscribe} 
        className="flex items-center gap-2 glass-button text-white px-4 py-2 text-sm font-medium"
      >
        <Star size={16} className="fill-current" />
        <span>Subscribe</span>
      </button>
      <button 
        onClick={() => setVisible(false)} 
        className="p-1.5 text-textSecondary hover:text-red-400 hover:bg-glass rounded transition-all"
        title="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
};

export default SubscribeOverlay;
