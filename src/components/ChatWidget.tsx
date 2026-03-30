import React, { useEffect, useRef, useState, useMemo, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import ChatMessageList from './ChatMessageList';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Pickaxe, Gift } from 'lucide-react';

// Channel Points Icon (Twitch style)
const ChannelPointsIcon = ({ className = "", size = 14 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
    <path fillRule="evenodd" d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" clipRule="evenodd"></path>
  </svg>
);
import { MiningStatus } from '../types';
import { useTwitchChat } from '../hooks/useTwitchChat';
import { useAppStore } from '../stores/AppStore';
import { incrementStat } from '../services/supabaseService';
import ChatMessage from './ChatMessage';
import UserProfileCard from './UserProfileCard';
import ErrorBoundary from './ErrorBoundary';
import PredictionOverlay from './PredictionOverlay';
import StreamerAboutPanel from './StreamerAboutPanel';
import ChannelPointsMenu from './ChannelPointsMenu';
import ResubNotificationBanner, { ResubNotification } from './ResubNotificationBanner';
import WatchStreakBanner, { WatchStreakMilestone } from './WatchStreakBanner';
import { fetchAllEmotes, Emote, EmoteSet, preloadChannelEmotes, queueEmoteForCaching } from '../services/emoteService';
import { preloadThirdPartyBadgeDatabases } from '../services/thirdPartyBadges';
import { initializeBadges, getBadgeInfo } from '../services/twitchBadges';
import { parseBadges } from '../services/twitchBadges';
import { initializeBadgeImageCache } from '../services/badgeImageCacheService';
import { parseMessage } from '../services/twitchChat';
import { fetchStreamViewerCount } from '../services/twitchService';
import {
  loadFavoriteEmotes,
  addFavoriteEmote,
  removeFavoriteEmote,
  isFavoriteEmote,
  getAvailableFavorites,
  getFavoriteEmotes
} from '../services/favoriteEmoteService';
import { getAppleEmojiUrl } from '../services/emojiService';
import { fetchRecentMessagesAsIRC } from '../services/ivrService';
import { useChatUserStore } from '../stores/chatUserStore';
import MentionAutocomplete from './MentionAutocomplete';

import { BackendChatMessage } from '../services/twitchChat';
import { Tooltip } from './ui/Tooltip';

interface ParsedMessage {
  username: string;
  content: string;
  color: string;
  badges: Array<{ key: string; info: any }>;
  tags: Map<string, string>;
  emotes: string;
}

import { EMOJI_CATEGORIES, EMOJI_KEYWORDS } from '../services/emojiCategories';
import { usemultiNookStore } from '../stores/multiNookStore';
import type { TwitchStream } from '../types';

import { Logger } from '../utils/logger';
// Helper function to format time remaining for Hype Train
const formatHypeTrainTimeRemaining = (expiresAt: string): string => {
  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  const diffMs = Math.max(0, expiry - now);
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${seconds}s`;
};

// Channel Points hover tooltip — portalled to document.body to escape overflow-hidden
const ChannelPointsTooltip = ({ anchorRef, customPointsIconUrl, customPointsName, isLoadingChannelPoints, channelPoints }: {
  anchorRef: React.RefObject<HTMLDivElement>;
  customPointsIconUrl: string | null;
  customPointsName: string | null;
  isLoadingChannelPoints: boolean;
  channelPoints: number | null;
}) => {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setPos({ left: rect.left + rect.width / 2, top: rect.top - 8 });
    };
    // Measure immediately
    update();
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <div
      className="fixed px-3 py-1.5 bg-black/95 border border-border rounded-lg shadow-lg z-[9999] min-w-max pointer-events-none"
      style={{
        left: pos.left,
        top: pos.top,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <div className="flex items-center gap-1.5">
        {customPointsIconUrl ? (
          <img 
            src={customPointsIconUrl} 
            alt={customPointsName || "Channel Points"} 
            className="w-[14px] h-[14px] flex-shrink-0"
          />
        ) : (
          <ChannelPointsIcon size={14} className="text-accent-neon flex-shrink-0" />
        )}
        {isLoadingChannelPoints ? (
          <span className="text-sm text-textSecondary">Loading...</span>
        ) : channelPoints !== null ? (
          <span className="text-sm font-bold text-accent-neon">{channelPoints.toLocaleString()}</span>
        ) : (
          <span className="text-sm text-textSecondary">--</span>
        )}
        {customPointsName && channelPoints !== null && (
          <span className="text-xs text-textSecondary">{customPointsName}</span>
        )}
      </div>
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-black/95" />
    </div>,
    document.body
  );
};

// Emote Grid Item - TRUE lazy loading with IntersectionObserver
// Image src only set when element enters viewport
const EmoteGridItem = memo(({ emote, isFavorited, onInsert, onToggleFavorite }: {
  emote: Emote;
  isFavorited: boolean;
  onInsert: () => void;
  onToggleFavorite: () => void;
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // IntersectionObserver to detect when emote scrolls into view
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect(); // Once visible, stop observing
          }
        });
      },
      { rootMargin: '100px' } // Start loading 100px before entering viewport
    );
    
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  
  return (
    <Tooltip 
      side="top" 
      delay={200}
      content={
        <div className="flex flex-col items-center gap-1.5 py-0.5">
          <img
            src={emote.provider === '7tv' ? `https://cdn.7tv.app/emote/${emote.id}/4x.avif` : (emote.localUrl || emote.url)}
            alt={emote.name}
            className="h-16 w-auto max-w-[96px] object-contain mx-auto drop-shadow-md"
            onError={(e) => {
              if (emote.provider === '7tv') {
                const target = e.currentTarget;
                const src = target.src;
                if (src.includes('/4x.avif')) target.src = `https://cdn.7tv.app/emote/${emote.id}/2x.avif`;
                else if (src.includes('/2x.avif')) target.src = `https://cdn.7tv.app/emote/${emote.id}/1x.avif`;
              }
            }}
          />
          <div className="text-center flex flex-col items-center gap-0.5">
            <span className="font-bold text-[13px] leading-tight">{emote.name}</span>
            <span className="text-[10px] text-white/60 leading-tight">
              {emote.owner_name ? `by ${emote.owner_name}` : emote.provider}
            </span>
            {emote.isZeroWidth && (
              <span className="text-[9px] font-bold tracking-wider uppercase text-yellow-400 mt-0.5 mix-blend-screen drop-shadow-sm">
                Zero-Width
              </span>
            )}
          </div>
        </div>
      }
    >
      <div 
        ref={containerRef}
        className="relative group flex items-center justify-center focus:outline-none w-full h-full min-h-8"
      >
        <button onClick={onInsert} className={`flex items-center justify-center p-1 w-full h-full min-w-8 min-h-8 hover:bg-glass rounded transition-colors ${emote.isZeroWidth ? 'ring-1 ring-yellow-400/50 bg-yellow-400/10' : ''}`}>
          {isVisible ? (
            <img
              src={emote.localUrl || emote.url}
              srcSet={emote.provider === '7tv' ? `https://cdn.7tv.app/emote/${emote.id}/1x.avif 1x, https://cdn.7tv.app/emote/${emote.id}/2x.avif 2x, https://cdn.7tv.app/emote/${emote.id}/3x.avif 3x, https://cdn.7tv.app/emote/${emote.id}/4x.avif 4x` : undefined}
              alt={emote.name}
              referrerPolicy="no-referrer"
              className={`max-h-8 w-auto max-w-full object-contain ${emote.isZeroWidth ? 'drop-shadow-[0_0_3px_rgba(234,179,8,0.6)]' : ''}`}

              onError={(e) => {
                const target = e.currentTarget;
                if (emote.localUrl && target.src !== emote.url) {
                  target.src = emote.url;
                } else {
                  target.style.opacity = '0.3';
                }
              }}
            />
          ) : (
            // Placeholder while not visible - same size to prevent layout shift
            <div className="h-8 w-8 max-w-full bg-glass/30 rounded animate-pulse opacity-50" />
          )}
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }} 
          className={`absolute top-0 right-0 p-1 rounded-bl transition-all ${isFavorited ? 'text-yellow-400 opacity-100' : 'text-textSecondary opacity-0 group-hover:opacity-100'} hover:text-yellow-400 hover:bg-glass`} 
          title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
        >
          <svg className="w-3 h-3" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        </button>
      </div>
    </Tooltip>
  );
});
const HYPE_MESSAGES = [
  // Classic hype
  'HYYYYPE! 🚂',
  'CHOO CHOO MOTHERFUCKERS! 🚂💨',
  'ALL ABOARD THE HYPE TRAIN LET\'S FUCKING GOOO 🎉',
  'WE EATING GOOD TONIGHT BOYS 🍽️🔥',
  'POGGERS IN CHAT 🐸',
  'TRAIN HAS LEFT THE STATION AND IT\'S ON FIRE 🚂🔥',
  'LET\'S FUCKING GOOOOOOOOOOOOO 🔥',
  'CHAT POPPIN OFF RN 📈',
  'THIS IS THE ENERGY WE CAME FOR 🙌',
  // Edgy / unfiltered
  'INJECT THE HYPE STRAIGHT INTO MY FUCKING VEINS 💉',
  'I\'M HARD AS FUCK RIGHT NOW 🍆🚂',
  'CHAT\'S ON THAT COCAINUM ENERGY TONIGHT 🤍💊',
  'MY BLOOD PRESSURE IS IN THE STRATOSPHERE 😤',
  'MOMMY? SORRY. MOMMY? 🚂',
  'I\'M GONNA NUT IF THIS KEEPS UP 🤤💦',
  'CHAT IS 100% GOONING RIGHT NOW 👁️👄👁️',
  'THIS IS ILLEGALLY HYPE 🚨🔥',
  // Unhinged / nuclear
  'I\'M FOAMING AT THE MOUTH RN 🤪💀',
  'CRYING SCREAMING PISSING SHITTING THROWING UP 🤮💩😭',
  'MY EYEBALLS ARE CUMMING FROM THIS PEAK 👀💦',
  'I JUST SHATTERED MY PELVIS FROM HYPE 🚑🦴💥',
  'I\'M LEGALLY BRAINDEAD FROM THIS ENERGY 🧠💨',
  'CHAT IS ONE BAD MOMENT AWAY FROM A MELTDOWN 💀🔥',
  'I\'M GONNA FUCK THE HYPE TRAIN ITSELF 🚂🍑',
  'MY THERAPIST IS GONNA QUIT AFTER THIS STREAM 😭💀',
  'SOMEONE SEDATE ME BEFORE I BECOME A WAR CRIME 💉🔥',
  'MY SPINE IS LIQUID AND MY SOUL IS GONE ✨💀',
  'I AM BECOME HYPE, DESTROYER OF CHILL ☢️🚂',
  // StreamNook-branded hype
  'CHOO CHOO MOTHERFUCKERS! 🚂💨',
  'ALL ABOARD THE STREAMNOOK HYPE TRAIN! 🎉',
  'STREAMNOOK FAM LET\'S FUCKING GOOO 🔥',
  'POGGERS IN THE NOOK 🐸🏠',
  'TRAIN HAS LEFT THE STATION AND STREAMNOOK IS DRIVING 🚂🌪️',
  'CHAT POPPIN OFF IN STREAMNOOK RN 📈',
  'STREAMNOOK ENERGY IS UNMATCHED 🙌',
  'WE\'RE COZY AS FUCK IN THE NOOK TONIGHT 🛋️🚂',
  // Edgy StreamNook
  'INJECT THE STREAMNOOK HYPE STRAIGHT INTO MY VEINS 💉',
  'I\'M HARD AS FUCK FOR THIS STREAMNOOK CLUTCH 🍆🚂',
  'CHAT\'S ON THAT STREAMNOOK COCAINUM ENERGY 🤍🐍',
  'MY BLOOD PRESSURE JUST SPIKED IN THE NOOK 😤',
  'MOMMY? SORRY. STREAMNOOK MOMMY? 😏🚂',
  'I\'M GONNA NUT IF STREAMNOOK KEEPS THIS UP 🤤💦',
  'STREAMNOOK CHAT IS 100% GOONING RIGHT NOW 👁️👄👁️',
  'THIS STREAMNOOK MOMENT IS ILLEGALLY HYPE 🫡🚨',
  // Unhinged StreamNook
  'I\'M FOAMING AT THE MOUTH AND MY DICK IS OUT 🍆🤪',
  'MY EYEBALLS ARE CUMMING FROM THIS PEAK 👀💦',
  'I JUST SHATTERED MY PELVIS FROM HYPE 🚑🦴💥',
  'I\'M LEGALLY RETARDED FROM THIS ENERGY 🧠💨',
  'CHAT IS ONE BAD MOMENT AWAY FROM A MASS SUICIDE PACT 💀🔗',
  'I\'M GONNA FUCK THE HYPE TRAIN ITSELF 🚂🍑',
  'MY THERAPIST IS GONNA QUIT AFTER THIS STREAM 😭🛋️',
  'SOMEONE SEDATE ME BEFORE I BECOME A WAR CRIME 🩸💉',
  'MY SPINE IS LIQUID AND MY SOUL IS GONE ✨🪦',
  'I AM BECOME HYPE, DESTROYER OF CHILL ☢️🚂',
];

const ChatWidget = () => {
  const { messages, connectChat, sendMessage, isConnected, error, setPaused: setBufferPaused, deletedMessageIds, clearedUserContexts } = useTwitchChat();
  const { currentStream: rawCurrentStream, currentUser, currentHypeTrain } = useAppStore();
  const { isMultiNookActive, activeChatChannelId, slots } = usemultiNookStore();
  
  const currentStream = useMemo(() => {
    if (isMultiNookActive && activeChatChannelId) {
      const activeSlot = slots.find(s => s.channelId === activeChatChannelId || s.channelLogin === activeChatChannelId);
      if (activeSlot) {
        return {
          id: activeSlot.channelId || activeSlot.id,
          user_id: activeSlot.channelId || '',
          user_login: activeSlot.channelLogin,
          user_name: activeSlot.channelName || activeSlot.channelLogin,
          game_id: '',
          game_name: 'multi-nook',
          type: 'live',
          title: `multi-nook: ${activeSlot.channelName || activeSlot.channelLogin}`,
          viewer_count: 0,
          started_at: new Date().toISOString(),
          language: 'en',
          thumbnail_url: '',
          tag_ids: [],
          is_mature: false
        } as TwitchStream;
      }
    }
    return rawCurrentStream;
  }, [rawCurrentStream, isMultiNookActive, activeChatChannelId, slots]);
  
  // UI state
  const [messageInput, setMessageInput] = useState('');
  const [activeView, setActiveView] = useState<'chat' | 'about'>('chat');
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const [emotes, setEmotes] = useState<EmoteSet | null>(null);

  // Dynamic smiley icon — cycles on unhover with crossfade animation
  const smileyPool = useMemo(() => ['😀', '😄', '😁', '😆', '🤣', '😂', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😋', '🤗', '🫠', '🫡', '😺'], []);
  const [currentSmiley, setCurrentSmiley] = useState(() => '😀');
  const [isSmileyTransitioning, setIsSmileyTransitioning] = useState(false);
  const cycleEmoteSmiley = useCallback(() => {
    // Phase 1: fade out (100ms)
    setIsSmileyTransitioning(true);
    setTimeout(() => {
      // Phase 2: swap src while invisible
      setCurrentSmiley(prev => {
        const filtered = smileyPool.filter(s => s !== prev);
        return filtered[Math.floor(Math.random() * filtered.length)];
      });
      // Phase 3: fade back in
      setIsSmileyTransitioning(false);
    }, 110);
  }, [smileyPool]);
  const [selectedProvider, setSelectedProvider] = useState<'twitch' | 'bttv' | '7tv' | 'ffz' | 'favorites' | 'emoji'>('twitch');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingEmotes, setIsLoadingEmotes] = useState(false);
  const [favoriteEmotes, setFavoriteEmotes] = useState<Emote[]>([]);
  const emoteScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const channelPointsRef = useRef<HTMLDivElement>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedMessageCount, setPausedMessageCount] = useState(0);
  const isHoveringChatRef = useRef<boolean>(false);
  const lastResumeTimeRef = useRef<number>(0);
  const lastNavigationTimeRef = useRef<number>(0); // Track scrollToMessage navigation
  const mountTimeRef = useRef<number>(Date.now());
  const [viewerCount, setViewerCount] = useState<number | null>(null);
  const streamUptimeRef = useRef<string>('');
  const [hypeTrainTimeRemaining, setHypeTrainTimeRemaining] = useState<string>('');
  const hypeTrainExpiresAtRef = useRef<string | null>(null);
  const [isLevelUpCelebration, setIsLevelUpCelebration] = useState(false);
  const previousHypeTrainLevelRef = useRef<number>(0);
  const [displayedLevel, setDisplayedLevel] = useState<number>(0);
  const [celebrationMessage, setCelebrationMessage] = useState<string>('');
  

  const { settings } = useAppStore();
  const [selectedUser, setSelectedUser] = useState<{
    userId: string;
    username: string;
    displayName: string;
    color: string;
    badges: Array<{ key: string; info: any }>;
    position: { x: number; y: number };
  } | null>(null);
  const userMessageHistory = useRef<Map<string, ParsedMessage[]>>(new Map());
  const connectedChannelRef = useRef<string | null>(null);

  // Warm up badge cache on mount (non-blocking, runs before messages render)
  useEffect(() => {
    initializeBadgeImageCache();
  }, []);
  const lastProcessedCountRef = useRef<number>(0);
  const messageIdToIndexRef = useRef<Map<string, number>>(new Map());
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [isSharedChat, setIsSharedChat] = useState<boolean>(false);
  const [replyingTo, setReplyingTo] = useState<{ messageId: string; username: string } | null>(null);

  // @ mention autocomplete state
  const [showMentionAutocomplete, setShowMentionAutocomplete] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [mentionStartPosition, setMentionStartPosition] = useState<number | null>(null);
  const { addUser, getMatchingUsers, clearUsers } = useChatUserStore();

  // Resub notification state
  const [resubNotification, setResubNotification] = useState<ResubNotification | null>(null);
  const [isResubMode, setIsResubMode] = useState(false);
  const [includeStreak, setIncludeStreak] = useState(false);
  const [resubDismissed, setResubDismissed] = useState(false);

  // Watch streak state
  const [watchStreak, setWatchStreak] = useState<WatchStreakMilestone | null>(null);
  const [isWatchStreakMode, setIsWatchStreakMode] = useState(false);
  const [watchStreakDismissed, setWatchStreakDismissed] = useState(false);

  // Drops mining state
  const [dropsCampaign, setDropsCampaign] = useState<{ id: string; name: string; game_name: string } | null>(null);
  const [isMining, setIsMining] = useState(false);
  const [isLoadingDrops, setIsLoadingDrops] = useState(false);

  // Channel points state
  const [channelPoints, setChannelPoints] = useState<number | null>(null);
  const [channelPointsHovered, setChannelPointsHovered] = useState(false);
  const [showChannelPointsMenu, setShowChannelPointsMenu] = useState(false);
  const [isLoadingChannelPoints, setIsLoadingChannelPoints] = useState(false);
  const [customPointsName, setCustomPointsName] = useState<string | null>(null);
  const [customPointsIconUrl, setCustomPointsIconUrl] = useState<string | null>(null);

  // Pinned chat state
  interface PinnedMessage {
    id: string;
    type: string;
    message_text: string;
    sender_id: string;
    sender_name: string;
    sender_color: string;
    sender_avatar: string;
    sender_badges: Array<{ set_id: string; version: string }>;
    pinned_by: string;
    pinned_by_id: string;
    pinned_by_avatar: string;
    started_at: string;
  }
  const [pinnedMessages, setPinnedMessages] = useState<PinnedMessage[]>([]);
  const [isPinnedExpanded, setIsPinnedExpanded] = useState(true);
  const seenPinIdRef = useRef<string | null>(null);
  const pinnedContentRef = useRef<HTMLDivElement>(null);

  // Cache for channel names (broadcaster ID -> display name) used in emote picker grouping
  const [channelNameCache, setChannelNameCache] = useState<Map<string, string>>(new Map());

  // Messages to render
  const visibleMessages = messages;


  // Process new messages for user history tracking
  useEffect(() => {
    const newMessages = messages.slice(lastProcessedCountRef.current);
    newMessages.forEach((message, idx) => {
      try {
        let parsed: ParsedMessage;
        let msgId: string | undefined;
        let userId: string | undefined;
        let username: string | undefined;
        let displayName: string | undefined;
        let userColor: string | undefined;

        if (typeof message === 'string') {
          const channelIdMatch = message.match(/room-id=([^;]+)/);
          const channelId = channelIdMatch ? channelIdMatch[1] : undefined;
          parsed = parseMessage(message, channelId);
          msgId = parsed.tags.get('id');
          userId = parsed.tags.get('user-id');
          username = parsed.username;
          displayName = parsed.tags.get('display-name') || parsed.username;
          userColor = parsed.color;
        } else {
          // Backend message object
          parsed = parseMessage(message);
          msgId = message.id;
          userId = message.tags['user-id'] || message.user_id;
          username = message.username;
          displayName = message.display_name || message.username;
          userColor = message.color || parsed.color;
        }

        if (msgId) {
          const actualIndex = lastProcessedCountRef.current + idx;
          messageIdToIndexRef.current.set(msgId, actualIndex);
        }
        if (userId) {
          const history = userMessageHistory.current.get(userId) || [];
          history.push(parsed);
          if (history.length > 50) history.shift();
          userMessageHistory.current.set(userId, history);
          
          // Add user to mention autocomplete store
          if (username && displayName) {
            addUser({
              userId,
              username,
              displayName,
              color: userColor || '#9147FF',
            });
          }
        }
      } catch (err) {
        Logger.error('[ChatWidget] Failed to parse message:', err, message);
      }
    });
    lastProcessedCountRef.current = messages.length;
  }, [messages, addUser]);

  useEffect(() => {
    const getViewerCount = async () => {
      if (currentStream?.user_login) {
        try {
          const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
          const count = await fetchStreamViewerCount(currentStream.user_login, clientId, token);
          setViewerCount(count);
        } catch (err) {
          Logger.error('[ChatWidget] Failed to fetch viewer count:', err);
          setViewerCount(null);
        }
      } else {
        setViewerCount(null);
      }
    };
    getViewerCount();
    const intervalId = setInterval(getViewerCount, 180000);
    return () => clearInterval(intervalId);
  }, [currentStream?.user_login]);

  useEffect(() => {
    let headerElement: HTMLElement | null = null;
    const updateUptime = () => {
      if (currentStream?.started_at) {
        const startTime = new Date(currentStream.started_at).getTime();
        const now = Date.now();
        const diffMs = now - startTime;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
        let uptimeString = '';
        if (hours > 0) {
          uptimeString = `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
          uptimeString = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
        streamUptimeRef.current = uptimeString;
        if (!headerElement) headerElement = document.getElementById('stream-uptime-display');
        if (headerElement) headerElement.textContent = uptimeString;
      } else {
        streamUptimeRef.current = '';
        if (!headerElement) headerElement = document.getElementById('stream-uptime-display');
        if (headerElement) headerElement.textContent = '';
      }
    };
    updateUptime();
    const intervalId = setInterval(updateUptime, 1000);
    return () => clearInterval(intervalId);
  }, [currentStream?.started_at]);

  // Smooth Hype Train countdown - updates every second locally
  useEffect(() => {
    if (!currentHypeTrain?.expires_at) {
      setHypeTrainTimeRemaining('');
      hypeTrainExpiresAtRef.current = null;
      return;
    }

    // Update the ref when expires_at changes (new level or new hype train)
    hypeTrainExpiresAtRef.current = currentHypeTrain.expires_at;

    const updateCountdown = () => {
      if (!hypeTrainExpiresAtRef.current) return;
      const now = Date.now();
      const expiry = new Date(hypeTrainExpiresAtRef.current).getTime();
      const diffMs = Math.max(0, expiry - now);
      
      // Timer expired - clear hype train immediately (don't wait for poll)
      if (diffMs === 0) {
        Logger.debug('[HypeTrain] Timer expired - clearing immediately');
        useAppStore.getState().setCurrentHypeTrain(null);
        return;
      }
      
      const minutes = Math.floor(diffMs / 60000);
      const seconds = Math.floor((diffMs % 60000) / 1000);
      if (minutes > 0) {
        setHypeTrainTimeRemaining(`${minutes}:${seconds.toString().padStart(2, '0')}`);
      } else {
        setHypeTrainTimeRemaining(`${seconds}s`);
      }
    };

    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 1000);
    return () => clearInterval(countdownInterval);
  }, [currentHypeTrain?.expires_at]);

  // Level-up celebration detection - SYNCHRONOUS during render
  // Detect level changes during render phase (before paint) for immediate response
  const pendingLevelUpRef = useRef<{ from: number; to: number } | null>(null);
  
  // Synchronous check during render - happens BEFORE paint
  if (currentHypeTrain && !isLevelUpCelebration) {
    const currentLevel = currentHypeTrain.level;
    const previousLevel = previousHypeTrainLevelRef.current;
    
    // Detect level-up (previous must be > 0 to avoid initial load trigger)
    if (currentLevel > previousLevel && previousLevel > 0) {
      pendingLevelUpRef.current = { from: previousLevel, to: currentLevel };
    }
  }

  // Effect to handle the detected level-up (sets state, starts timer)
  useEffect(() => {
    if (!currentHypeTrain) {
      previousHypeTrainLevelRef.current = 0;
      setDisplayedLevel(0);
      pendingLevelUpRef.current = null;
      return;
    }

    if (pendingLevelUpRef.current) {
      const { from, to } = pendingLevelUpRef.current;
      Logger.debug(`[HypeTrain] 🎉 LEVEL UP! ${from} → ${to}`);
      
      const randomMessage = HYPE_MESSAGES[Math.floor(Math.random() * HYPE_MESSAGES.length)];
      setCelebrationMessage(randomMessage);
      setIsLevelUpCelebration(true);
      pendingLevelUpRef.current = null;
      
      // Clear celebration after 8s (matches slower 7s scroll + buffer)
      const celebrationTimeout = setTimeout(() => {
        setIsLevelUpCelebration(false);
        setDisplayedLevel(to);
        previousHypeTrainLevelRef.current = to;
      }, 8000);
      
      return () => clearTimeout(celebrationTimeout);
    } else {
      // Normal update (no level-up in progress) - only update if not celebrating
      if (!isLevelUpCelebration) {
        setDisplayedLevel(currentHypeTrain.level);
        previousHypeTrainLevelRef.current = currentHypeTrain.level;
      }
    }
  }, [currentHypeTrain?.level]); // Removed isLevelUpCelebration from deps to avoid re-trigger

  // Memoized confetti configuration to avoid regenerating random positions on re-render
  const confettiParticles = useMemo(() => {
    return [...Array(20)].map((_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      color: ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#9b59b6', '#e74c3c'][i % 6],
      delay: `${Math.random() * 0.5}s`,
      duration: `${1 + Math.random() * 0.5}s`
    }));
  }, [isLevelUpCelebration]); // Regenerate only when celebration starts


  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    if (currentStream?.user_login && connectedChannelRef.current !== currentStream.user_login) {
      connectedChannelRef.current = currentStream.user_login;
      // Reset pause state when switching channels - ensures chat starts anchored to bottom
      setIsPaused(false);
      setPausedMessageCount(0);
      setBufferPaused(false);
      mountTimeRef.current = Date.now(); // Reset grace period on channel switch
      // Pass roomId (user_id) to enable fetching recent messages from IVR API
      connectChat(currentStream.user_login, currentStream.user_id);
      loadEmotes(currentStream.user_login, currentStream.user_id);
      userMessageHistory.current.clear();
      clearUsers(); // Clear mention autocomplete user list
      // PHASE 3: Clear Rust user message history when switching channels
      invoke('clear_user_message_history').catch(err => 
        Logger.warn('[ChatWidget] Failed to clear Rust user history:', err)
      );
      // Reset channel points when switching channels
      setChannelPoints(null);
      setCustomPointsName(null);
      setCustomPointsIconUrl(null);
      setShowChannelPointsMenu(false);
      // Reset resub notification state when switching channels
      setResubNotification(null);
      setIsResubMode(false);
      setIncludeStreak(false);
      setResubDismissed(false);
      // Reset watch streak state when switching channels
      setWatchStreak(null);
      setIsWatchStreakMode(false);
      setWatchStreakDismissed(false);
      // Reset pinned chat state when switching channels
      setPinnedMessages([]);
      setIsPinnedExpanded(true);
      // Reset to chat view when switching channels
      setActiveView('chat');
      
      // NEW: Hot-swap backend tracking context if inside MultiNook
      if (isMultiNookActive) {
        Logger.info(`[MultiNook] Hot-swapping backend tracking for ${currentStream.user_login}...`);
        
        // Immediate clean up front-end state
        useAppStore.getState().setCurrentHypeTrain(null);
        
        const channelId = currentStream.user_id;
        const channelName = currentStream.user_login;
        
        if (channelId) {
          // Debounce the backend network shifting (250ms) to prevent UI spamming
          timeoutId = setTimeout(() => {
            invoke('start_drops_monitoring', { channelId, channelName }).catch(e => Logger.warn('[Drops] Failed to hot-swap', e));
            invoke('register_active_channel', { channelId }).catch(() => {});
            
            invoke('disconnect_eventsub')
              .then(() => {
                // Delay reconnection by 150ms to ensure the OS socket closes safely
                setTimeout(() => {
                  invoke('connect_eventsub', { broadcasterId: channelId }).catch(e => Logger.warn('[EventSub] Failed to hot-swap', e));
                }, 150);
              })
              .catch(() => {});
          }, 250);
        }
      }
    }
    
    return () => {
      if (currentStream?.user_login !== connectedChannelRef.current) connectedChannelRef.current = null;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [currentStream?.user_login, currentStream?.user_id, isMultiNookActive]);

  // Chat refresh signal — triggered by VideoPlayer's refresh button
  const chatRefreshKey = useAppStore((s) => s.chatRefreshKey);
  const chatRefreshMountRef = useRef(chatRefreshKey);
  useEffect(() => {
    // Skip initial mount
    if (chatRefreshMountRef.current === chatRefreshKey) return;
    chatRefreshMountRef.current = chatRefreshKey;

    if (currentStream?.user_login) {
      Logger.info('[ChatWidget] Chat refresh triggered — reconnecting...');
      connectChat(currentStream.user_login, currentStream.user_id);
    }
  }, [chatRefreshKey, currentStream?.user_login, currentStream?.user_id, connectChat]);

  // Force unpause chat when returning from About view
  useEffect(() => {
    if (activeView === 'chat') {
      // Re-trigger the scroll stabilization grace period so the sudden remount
      // doesn't falsely trigger a user scroll-up event
      mountTimeRef.current = Date.now();
      
      // Small delay to let the chat container remount before interacting with it
      const timer = setTimeout(() => {
        setIsPaused(false);
        setBufferPaused(false);
        if ((window as any).__chatScrollToBottom) {
          (window as any).__chatScrollToBottom();
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [activeView, setBufferPaused]);

  // Fetch channel points for current channel using direct GQL query with retry logic
  const fetchChannelPoints = useCallback(async () => {
    if (!currentStream?.user_login) return;
    
    const maxRetries = 3;
    const retryDelayMs = 1000;
    
    Logger.debug('[ChatWidget] fetchChannelPoints - fetching for channel:', currentStream.user_login);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use the direct GQL query command which fetches fresh data
        const result = await invoke<any>('get_channel_points_for_channel', {
          channelLogin: currentStream.user_login
        });
        
        Logger.debug('[ChatWidget] Raw GQL response:', JSON.stringify(result).substring(0, 500));
        
        // Try multiple possible paths since the backend GQL query uses "community.channel" structure
        // Path 1: data.community.channel.self.communityPoints.balance
        let balance = result?.data?.community?.channel?.self?.communityPoints?.balance;
        const channel = result?.data?.community?.channel || result?.data?.user?.channel;
        
        // Path 2: data.user.channel.self.communityPoints.balance (alternative structure)
        if (balance === undefined) {
          balance = result?.data?.user?.channel?.self?.communityPoints?.balance;
        }
        
        // Path 3: Direct balance if returned differently
        if (balance === undefined && result?.balance !== undefined) {
          balance = result.balance;
        }
        
        // Extract custom points settings (name and icon)
        const communityPointsSettings = channel?.communityPointsSettings;
        if (communityPointsSettings) {
          const customName = communityPointsSettings.name;
          const customIconUrl = communityPointsSettings.image?.url;
          Logger.debug('[ChatWidget] Custom points settings:', { customName, customIconUrl });
          setCustomPointsName(customName || null);
          setCustomPointsIconUrl(customIconUrl || null);
        } else {
          setCustomPointsName(null);
          setCustomPointsIconUrl(null);
        }
        
        if (typeof balance === 'number') {
          Logger.debug('[ChatWidget] ✅ Got channel points balance:', balance);
          setChannelPoints(balance);
          return;
        }
        
        // Check if communityPoints is explicitly null (channel points not enabled)
        const communityPoints = result?.data?.community?.channel?.self?.communityPoints 
          ?? result?.data?.user?.channel?.self?.communityPoints;
        if (communityPoints === null) {
          Logger.debug('[ChatWidget] Channel points not enabled or user not eligible for this channel');
          setChannelPoints(null);
          return;
        }
        
        Logger.warn(`[ChatWidget] Attempt ${attempt}/${maxRetries}: Could not parse balance from response`);
      } catch (err) {
        Logger.warn(`[ChatWidget] Attempt ${attempt}/${maxRetries} failed:`, err);
      }
      
      // Wait before retrying (except on last attempt)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
    
    Logger.debug('[ChatWidget] All retries exhausted - will update via events');
  }, [currentStream?.user_login]);

  // Automatically fetch channel points when entering a new channel
  useEffect(() => {
    if (currentStream?.user_login) {
      setIsLoadingChannelPoints(true);
      fetchChannelPoints().finally(() => setIsLoadingChannelPoints(false));
    }
  }, [currentStream?.user_login, fetchChannelPoints]);

  // Fetch resub notification when entering a new channel
  useEffect(() => {
    const fetchResubNotification = async () => {
      if (!currentStream?.user_login || resubDismissed) return;
      
      try {
        const notification = await invoke<ResubNotification | null>('get_resub_notification', {
          channelLogin: currentStream.user_login,
        });
        setResubNotification(notification);
        if (notification) {
          Logger.debug('[ChatWidget] Resub notification available:', notification.cumulative_tenure_months, 'months');
        }
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to fetch resub notification:', err);
        setResubNotification(null);
      }
    };
    
    fetchResubNotification();
  }, [currentStream?.user_login, resubDismissed]);

  // Fetch watch streak milestone when entering a new channel
  useEffect(() => {
    const fetchWatchStreak = async () => {
      if (!currentStream?.user_id || watchStreakDismissed) return;

      try {
        const milestone = await invoke<WatchStreakMilestone | null>('get_watch_streak', {
          channelId: currentStream.user_id,
        });
        setWatchStreak(milestone);
        if (milestone) {
          Logger.debug('[ChatWidget] Watch streak available:', milestone.streak_count, 'streams, bonus:', milestone.copo_bonus);
        }
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to fetch watch streak:', err);
        setWatchStreak(null);
      }
    };

    fetchWatchStreak();
  }, [currentStream?.user_id, watchStreakDismissed]);

  // Fetch pinned chat messages for current channel
  useEffect(() => {
    const fetchPinnedMessages = async () => {
      if (!currentStream?.user_id) {
        setPinnedMessages([]);
        return;
      }
      try {
        const messages = await invoke<PinnedMessage[]>('get_pinned_chat_messages', {
          channelId: currentStream.user_id,
        });
        setPinnedMessages(messages || []);
        if (messages && messages.length > 0) {
          Logger.debug('[ChatWidget] Pinned messages:', messages.length);
        }
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to fetch pinned messages:', err);
        setPinnedMessages([]);
      }
    };

    fetchPinnedMessages();
    // Poll every 5s for near-realtime pin updates
    const pollInterval = setInterval(fetchPinnedMessages, 5000);
    return () => clearInterval(pollInterval);
  }, [currentStream?.user_id]);

  // Listen for channel points updates from backend events
  useEffect(() => {
    if (!currentStream?.user_id) return;
    
    const unlistenSpent = listen<{ channel_id?: string | null; points: number; balance: number }>('channel-points-spent', (event) => {
      Logger.debug('[ChatWidget] 💸 Points spent event:', event.payload, 'currentChannel:', currentStream.user_id);
      // Update if channel matches OR if no channel_id in event (prediction bets sometimes don't include it)
      if (!event.payload.channel_id || event.payload.channel_id === currentStream.user_id) {
        Logger.debug('[ChatWidget] ✅ Updating channel points to:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    const unlistenEarned = listen<{ channel_id?: string | null; points: number; balance: number }>('channel-points-earned', (event) => {
      Logger.debug('[ChatWidget] 💰 Points earned event:', event.payload, 'currentChannel:', currentStream.user_id);
      // Update if channel matches OR if no channel_id in event
      if (!event.payload.channel_id || event.payload.channel_id === currentStream.user_id) {
        Logger.debug('[ChatWidget] ✅ Updating channel points to:', event.payload.balance);
        setChannelPoints(event.payload.balance);
      }
    });

    return () => {
      unlistenSpent.then(fn => fn());
      unlistenEarned.then(fn => fn());
    };
  }, [currentStream?.user_id]);

  // Load drops data when stream changes to check if game has active drops
  useEffect(() => {
    const loadDropsForStream = async () => {
      if (!currentStream?.game_name) {
        setDropsCampaign(null);
        setIsMining(false);
        return;
      }
      setIsLoadingDrops(true);
      try {
        // Get active drop campaigns (not inventory - we want all active campaigns)
        const campaigns = await invoke<Array<{ id: string; name: string; game_name: string; game_id: string }>>('get_active_drop_campaigns');
        if (campaigns && campaigns.length > 0) {
          // Find active campaign matching current game
          const gameName = currentStream.game_name.toLowerCase();
          const matchingCampaign = campaigns.find(
            campaign => campaign.game_name?.toLowerCase() === gameName
          );
          if (matchingCampaign) {
            setDropsCampaign(matchingCampaign);
            // Check if already mining this game (check by game_name, not campaign name)
            const miningStatus = await invoke<MiningStatus>('get_mining_status');
            const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
              miningStatus.current_channel?.game_name?.toLowerCase();
            setIsMining(miningStatus.is_mining && miningGameName === gameName);
          } else {
            setDropsCampaign(null);
            setIsMining(false);
          }
        } else {
          setDropsCampaign(null);
          setIsMining(false);
        }
      } catch (err) {
        Logger.warn('[ChatWidget] Could not load drops data:', err);
        setDropsCampaign(null);
      } finally {
        setIsLoadingDrops(false);
      }
    };
    loadDropsForStream();
  }, [currentStream?.game_name]);

  // Listen for mining status changes from anywhere in the app
  useEffect(() => {
    const handleMiningStatusChange = async () => {
      if (!dropsCampaign || !currentStream?.game_name) return;
      try {
        const miningStatus = await invoke<MiningStatus>('get_mining_status');
        const gameName = currentStream.game_name.toLowerCase();
        const miningGameName = miningStatus.current_drop?.game_name?.toLowerCase() ||
          miningStatus.current_channel?.game_name?.toLowerCase();
        setIsMining(miningStatus.is_mining && miningGameName === gameName);
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to check mining status:', err);
      }
    };

    // Listen for mining events using dynamic import
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen('mining-status-changed', handleMiningStatusChange);
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to set up mining event listener:', err);
      }
    };
    setupListener();

    // Also poll every 5 seconds as backup for state sync
    const pollInterval = setInterval(handleMiningStatusChange, 5000);

    return () => {
      if (unlisten) unlisten();
      clearInterval(pollInterval);
    };
  }, [dropsCampaign]);

  // Handler to toggle mining drops for current channel
  const handleToggleMining = async () => {
    if (!dropsCampaign) return;

    if (isMining) {
      // Stop mining
      try {
        await invoke('stop_auto_mining');
        setIsMining(false);
        useAppStore.getState().addToast(`Stopped mining drops for ${dropsCampaign.game_name}`, 'info');
      } catch (err) {
        Logger.error('[ChatWidget] Failed to stop mining:', err);
        useAppStore.getState().addToast('Failed to stop mining drops', 'error');
      }
    } else {
      // Start mining
      try {
        // Try to start mining with channel preference (use current channel's user_id)
        // If the channel is eligible for this campaign, it will use it
        // Otherwise, the backend will fall back to recommended channel
        if (currentStream?.user_id) {
          await invoke('start_campaign_mining_with_channel', {
            campaignId: dropsCampaign.id,
            channelId: currentStream.user_id
          });
        } else {
          // Fall back to automatic channel selection
          await invoke('start_campaign_mining', {
            campaignId: dropsCampaign.id
          });
        }
        setIsMining(true);
        useAppStore.getState().addToast(`Started mining drops for ${dropsCampaign.game_name}`, 'success');
      } catch (err) {
        Logger.error('[ChatWidget] Failed to start mining:', err);
        useAppStore.getState().addToast('Failed to start mining drops', 'error');
      }
    }
  };

  const getMessageId = useCallback((message: string | BackendChatMessage): string | null => {
    if (typeof message !== 'string') {
      return message.id;
    }
    const idMatch = message.match(/(?:^|;)id=([^;]+)/);
    return idMatch ? idMatch[1] : null;
  }, []);

  // Track paused message count for resume button
  useEffect(() => {
    if (isPaused && pausedMessageCount === 0) {
      setPausedMessageCount(messages.length);
    } else if (!isPaused) {
      setPausedMessageCount(0);
    }
  }, [isPaused, messages.length, pausedMessageCount]);


  const handleResume = () => {
    lastResumeTimeRef.current = Date.now();
    setIsPaused(false);
    setBufferPaused(false);
    // Trigger scroll to bottom via ChatMessageList's exposed function
    if ((window as any).__chatScrollToBottom) {
      (window as any).__chatScrollToBottom();
    }
  };

  const handleBadgeClick = useCallback(async (badgeKey: string, badgeInfo: any) => {
    useAppStore.getState().setShowBadgesOverlay(true);
    const [setId] = badgeKey.split('/');
    window.dispatchEvent(new CustomEvent('show-badge-detail', { detail: { badge: badgeInfo, setId } }));
  }, []);

  // Helper function to scroll to a specific message by ID
  // Uses container-aware scrolling to avoid scrolling the entire document
  // which can cause the title bar to disappear in Tauri apps with custom decorations
  const scrollToMessage = useCallback((messageId: string, options?: { highlight?: boolean; align?: 'start' | 'center' | 'end' | 'auto' }) => {
    const { highlight = true, align = 'center' } = options || {};

    Logger.debug('[ChatWidget] scrollToMessage called:', { messageId, highlight, align });

    // Find the message index
    const messageIndex = messages.findIndex(msg => getMessageId(msg) === messageId);

    if (messageIndex === -1) {
      Logger.warn('[ChatWidget] Message not found in buffer. ID:', messageId);
      return false;
    }

    // Pause chat to prevent auto-scrolling interference
    setIsPaused(true);
    setBufferPaused(true);
    
    // Mark navigation start time to prevent auto-resume from snapping back to bottom
    lastNavigationTimeRef.current = Date.now();

    // Set highlight immediately if requested
    if (highlight) {
      setHighlightedMessageId(messageId);
    }

    // Use container-aware scrolling instead of scrollIntoView
    // scrollIntoView can cause the entire document to scroll in WebViews,
    // which makes the title bar disappear in Tauri apps with custom decorations
    requestAnimationFrame(() => {
      const element = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
      if (element) {
        // Find the scrollable chat container (ChatMessageList's container)
        const container = element.closest('.overflow-y-auto') as HTMLElement | null;
        if (container) {
          // Calculate the element's position relative to the container
          const elementTopRelative = element.offsetTop;
          const containerScrollTop = container.scrollTop;
          const containerHeight = container.clientHeight;
          const elementHeight = element.offsetHeight;
          
          let targetScrollTop: number;
          
          if (align === 'center') {
            // Center the element in the container
            targetScrollTop = elementTopRelative - (containerHeight / 2) + (elementHeight / 2);
          } else if (align === 'start') {
            // Align element to the top of the container
            targetScrollTop = elementTopRelative;
          } else if (align === 'end') {
            // Align element to the bottom of the container
            targetScrollTop = elementTopRelative - containerHeight + elementHeight;
          } else {
            // 'auto' - scroll minimum distance to make element visible
            const elementTopInView = elementTopRelative - containerScrollTop;
            const elementBottomInView = elementTopInView + elementHeight;
            
            if (elementTopInView < 0) {
              // Element is above viewport, scroll up
              targetScrollTop = elementTopRelative;
            } else if (elementBottomInView > containerHeight) {
              // Element is below viewport, scroll down
              targetScrollTop = elementTopRelative - containerHeight + elementHeight;
            } else {
              // Element is already in view, no scroll needed
              targetScrollTop = containerScrollTop;
            }
          }
          
          // Clamp scroll position to valid range
          targetScrollTop = Math.max(0, Math.min(targetScrollTop, container.scrollHeight - containerHeight));
          
          // Smooth scroll to the target position
          container.scrollTo({
            top: targetScrollTop,
            behavior: 'smooth'
          });
          
          Logger.debug('[ChatWidget] Scrolled to message via container-aware scroll');
        } else {
          Logger.warn('[ChatWidget] Could not find scrollable container for message');
        }
      } else {
        Logger.warn('[ChatWidget] Could not find DOM element for message:', messageId);
      }
    });

    // Clear highlight after animation completes
    if (highlight) {
      setTimeout(() => setHighlightedMessageId(null), 2000);
    }

    return true;
  }, [messages, getMessageId, setBufferPaused]);

  const handleReplyClick = useCallback((parentMsgId: string) => {
    Logger.debug('[ChatWidget] handleReplyClick called for parentMsgId:', parentMsgId);

    const success = scrollToMessage(parentMsgId, { highlight: true, align: 'center' });

    if (!success) {
      useAppStore.getState().addToast('Original message is no longer in chat history', 'info');
    }
  }, [scrollToMessage]);

  const loadEmotes = async (channelName: string, channelId?: string) => {
    setIsLoadingEmotes(true);
    try {
      // Start badge and third-party database loading in parallel (non-blocking)
      // These will populate caches in the background for future lookups
      preloadThirdPartyBadgeDatabases().catch(err =>
        Logger.warn('[ChatWidget] Failed to preload third-party badge databases:', err)
      );

      // Start badge initialization in the background (non-blocking)
      invoke<[string, string]>('get_twitch_credentials')
        .then(([clientId, token]) => initializeBadges(clientId, token, channelId))
        .catch(err => Logger.warn('[ChatWidget] Badge init error (non-blocking):', err));

      // PRIORITY: Fetch emotes first and display immediately
      // This is the critical path - emotes should appear ASAP
      const emoteSet = await fetchAllEmotes(channelName, channelId);
      setEmotes(emoteSet);
      setIsLoadingEmotes(false); // Clear loading state immediately after emotes arrive

      // Note: We use loading="lazy" on emote picker images instead of preloading
      // This prevents WebView connection throttling issues with 900+ images

      // BACKGROUND: Fetch channel names for Twitch emote owners (for grouped display)
      // This can happen after emotes are already displayed
      if (emoteSet?.twitch) {
        const ownerIds = new Set<string>();
        for (const emote of emoteSet.twitch) {
          if (emote.owner_id && emote.emote_type === 'subscriptions') {
            ownerIds.add(emote.owner_id);
          }
        }
        
        // Fetch display names for all unique owner IDs (in parallel, non-blocking)
        if (ownerIds.size > 0) {
          const newCache = new Map(channelNameCache);
          const idsToFetch = Array.from(ownerIds).filter(id => !newCache.has(id));
          
          if (idsToFetch.length > 0) {
            Logger.debug(`[ChatWidget] Fetching ${idsToFetch.length} channel names for emote groups`);
            Promise.allSettled(
              idsToFetch.map(async (id) => {
                const user = await invoke<{ display_name: string }>('get_user_by_id', { userId: id });
                return { id, name: user.display_name };
              })
            ).then(results => {
              for (const result of results) {
                if (result.status === 'fulfilled') {
                  newCache.set(result.value.id, result.value.name);
                }
              }
              setChannelNameCache(new Map(newCache));
            });
          }
        }
      }

      // BACKGROUND: Load favorite emotes (non-blocking)
      loadFavoriteEmotes().then(() => {
        if (emoteSet) {
          const allEmotes = [...emoteSet.twitch, ...emoteSet.bttv, ...emoteSet['7tv'], ...emoteSet.ffz];
          const availableFavorites = getAvailableFavorites(allEmotes);
          setFavoriteEmotes(availableFavorites);
        }
      }).catch(err => Logger.warn('[ChatWidget] Failed to load favorites:', err));

    } catch (err) {
      Logger.error('Failed to load emotes:', err);
      setIsLoadingEmotes(false);
    }
  };

  useEffect(() => {
    const initializeSharedChannelBadges = async () => {
      const sourceRoomIds = new Set<string>();
      let hasSharedMessages = false;
      messages.forEach(message => {
        let sourceRoomId: string | null = null;
        let roomId: string | null = null;

        if (typeof message === 'string') {
          const sourceRoomIdMatch = message.match(/source-room-id=([^;]+)/);
          const roomIdMatch = message.match(/room-id=([^;]+)/);
          if (sourceRoomIdMatch) sourceRoomId = sourceRoomIdMatch[1];
          if (roomIdMatch) roomId = roomIdMatch[1];
        } else {
          sourceRoomId = message.tags['source-room-id'] || null;
          roomId = message.tags['room-id'] || null;
        }

        if (sourceRoomId && roomId && sourceRoomId !== roomId) {
          sourceRoomIds.add(sourceRoomId);
          hasSharedMessages = true;
        }
      });
      setIsSharedChat(hasSharedMessages);
      if (sourceRoomIds.size > 0) {
        try {
          const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');
          for (const sourceRoomId of sourceRoomIds) {
            try {
              await initializeBadges(clientId, token, sourceRoomId);
            } catch (err) {
              Logger.warn('[ChatWidget] Failed to initialize badges for shared channel:', sourceRoomId, err);
            }
          }
        } catch (err) {
          Logger.error('[ChatWidget] Failed to get credentials for shared channel badges:', err);
        }
      }
    };
    initializeSharedChannelBadges();
  }, [messages]);

  const handleSendMessage = async () => {
    if ((messageInput.trim() || isWatchStreakMode || isResubMode) && isConnected && currentUser) {
      const messageToSend = messageInput;
      const replyParentMsgId = replyingTo?.messageId;
      setMessageInput('');
      setReplyingTo(null);
      // Reset textarea height after sending
      if (inputRef.current) {
        inputRef.current.style.height = '36px';
      }
      inputRef.current?.focus({ preventScroll: true });

      // Handle resub mode - send resub notification
      if (isResubMode && resubNotification && currentStream?.user_login) {
        setIsResubMode(false);
        try {
          const success = await invoke<boolean>('use_resub_token', {
            channelLogin: currentStream.user_login,
            message: messageToSend || null,
            includeStreak: includeStreak,
            tokenId: resubNotification.id,
          });
          if (success) {
            setResubNotification(null); // Token consumed
            setResubDismissed(true);
          } else {
            useAppStore.getState().addToast('Failed to share resub notification', 'error');
            setMessageInput(messageToSend);
          }
        } catch (err) {
          Logger.error('[ChatWidget] Failed to use resub token:', err);
          useAppStore.getState().addToast('Failed to share resub notification', 'error');
          setMessageInput(messageToSend);
        }
        return;
      }

      // Handle watch streak mode - send watch streak share
      if (isWatchStreakMode && watchStreak && currentStream?.user_id) {
        setIsWatchStreakMode(false);
        try {
          const success = await invoke<boolean>('share_watch_streak', {
            channelId: currentStream.user_id,
            milestoneId: watchStreak.milestone_id,
            message: messageToSend || null,
          });
          if (success) {
            setWatchStreak(null); // Milestone consumed
            setWatchStreakDismissed(true);
            useAppStore.getState().addToast('Watch streak shared!', 'success');
          } else {
            useAppStore.getState().addToast('Failed to share watch streak', 'error');
            setMessageInput(messageToSend);
          }
        } catch (err) {
          Logger.error('[ChatWidget] Failed to share watch streak:', err);
          useAppStore.getState().addToast('Failed to share watch streak', 'error');
          setMessageInput(messageToSend);
        }
        return;
      }

      try {
        let badgeString = '';
        try {
          const userBadges = await invoke<string>('get_user_badges', { userId: currentUser.user_id, channelId: currentStream?.user_id });
          badgeString = userBadges;
        } catch (badgeErr) {
          Logger.warn('[ChatWidget] Could not fetch user badges:', badgeErr);
        }
        await sendMessage(messageToSend, {
          username: currentUser.login || currentUser.username,
          displayName: currentUser.display_name || currentUser.username,
          userId: currentUser.user_id,
          color: undefined,
          badges: badgeString
        }, replyParentMsgId);

        // Track message sent stat for analytics
        incrementStat(currentUser.user_id, 'messages_sent', 1).catch(err => {
          Logger.warn('[ChatWidget] Failed to track message sent stat:', err);
        });
      } catch (err) {
        Logger.error('Failed to send message:', err);
        setMessageInput(messageToSend);
        useAppStore.getState().addToast('Failed to send message. Please try again.', 'error');
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    // Handle autocomplete navigation when visible
    if (showMentionAutocomplete) {
      const matchingUsers = getMatchingUsers(mentionQuery);
      
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionSelectedIndex(prev => 
          prev > 0 ? prev - 1 : matchingUsers.length - 1
        );
        return;
      }
      
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionSelectedIndex(prev => 
          prev < matchingUsers.length - 1 ? prev + 1 : 0
        );
        return;
      }
      
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selectedUser = matchingUsers[mentionSelectedIndex];
        if (selectedUser) {
          insertMention(selectedUser);
        }
        return;
      }
      
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionAutocomplete(false);
        return;
      }
      
      if (e.key === 'Tab') {
        e.preventDefault();
        const selectedUser = matchingUsers[mentionSelectedIndex];
        if (selectedUser) {
          insertMention(selectedUser);
        }
        return;
      }
    }
    
    // Normal Enter to send message
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Handle input changes and detect @ mentions
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || value.length;
    
    setMessageInput(value);
    
    // Auto-resize textarea (expand upward as content grows)
    const textarea = e.target;
    // Temporarily set overflow hidden to get accurate scrollHeight
    textarea.style.overflow = 'hidden';
    textarea.style.height = 'auto'; // Reset to calculate new height
    const maxHeight = 120; // ~5 lines max
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
    // Enable scrolling only if we hit max height
    textarea.style.overflow = newHeight >= maxHeight ? 'auto' : 'hidden';
    
    // Find the @ trigger before cursor
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    
    if (lastAtIndex !== -1) {
      // Check if there's a space between @ and cursor (if so, not a mention)
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
      const hasSpace = textAfterAt.includes(' ');
      
      // Also check if @ is at start or preceded by whitespace
      const charBeforeAt = lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
      const isValidStart = /\s/.test(charBeforeAt) || lastAtIndex === 0;
      
      if (!hasSpace && isValidStart) {
        const query = textAfterAt;
        setMentionQuery(query);
        setMentionStartPosition(lastAtIndex);
        setMentionSelectedIndex(0);
        
        // Only show autocomplete if we have matches
        const matches = getMatchingUsers(query);
        setShowMentionAutocomplete(matches.length > 0);
        return;
      }
    }
    
    // No valid @ trigger found
    setShowMentionAutocomplete(false);
    setMentionQuery('');
    setMentionStartPosition(null);
  }, [getMatchingUsers]);

  // Insert a mention at the current @ position
  const insertMention = useCallback((user: { username: string; displayName: string }) => {
    if (mentionStartPosition === null) return;
    
    const beforeMention = messageInput.slice(0, mentionStartPosition);
    const afterMention = messageInput.slice(mentionStartPosition + 1 + mentionQuery.length);
    
    // Insert @username with a trailing space
    const newValue = `${beforeMention}@${user.username} ${afterMention}`;
    setMessageInput(newValue);
    
    // Hide autocomplete
    setShowMentionAutocomplete(false);
    setMentionQuery('');
    setMentionStartPosition(null);
    
    // Focus and set cursor position after the inserted mention
    inputRef.current?.focus({ preventScroll: true });
    const newCursorPos = beforeMention.length + user.username.length + 2; // +2 for @ and space
    setTimeout(() => {
      inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [messageInput, mentionStartPosition, mentionQuery]);

  const insertEmote = (emoteName: string) => {
    setMessageInput(prev => prev + (prev ? ' ' : '') + emoteName + ' ');
    inputRef.current?.focus({ preventScroll: true });
  };

  const handleEmoteRightClick = (emoteName: string) => {
    setMessageInput(prev => {
      if (prev.trim()) return prev + (prev.endsWith(' ') ? '' : ' ') + emoteName + ' ';
      return emoteName + ' ';
    });
    inputRef.current?.focus({ preventScroll: true });
  };

  const handleUsernameRightClick = (messageId: string, username: string) => {
    setReplyingTo({ messageId, username });
    inputRef.current?.focus({ preventScroll: true });
  };

  const emojiCategories = EMOJI_CATEGORIES;

  // Memoize allEmojis to prevent recreation on every render
  const allEmojis = useMemo(() => 
    Object.entries(emojiCategories).flatMap(([category, emojis]) =>
      emojis.map(emoji => ({ emoji, category }))
    ),
    [emojiCategories]
  );

  // Memoize filtered emotes to prevent recalculation on every render
  const filteredEmotes = useMemo((): Emote[] => {
    if (selectedProvider === 'emoji') return [];
    if (selectedProvider === 'favorites') {
      const favs = favoriteEmotes;
      if (!searchQuery) return favs;
      const query = searchQuery.toLowerCase();
      return favs.filter((emote: Emote) => emote.name.toLowerCase().includes(query));
    }
    if (!emotes) return [];
    const providerEmotes = emotes[selectedProvider] || [];
    if (!searchQuery) return providerEmotes;
    const query = searchQuery.toLowerCase();
    return providerEmotes.filter((emote: Emote) => emote.name.toLowerCase().includes(query));
  }, [selectedProvider, favoriteEmotes, searchQuery, emotes]);

  // With IntersectionObserver-based lazy loading, we can show all emotes
  // Only visible ones will actually load their images
  useEffect(() => {
    // Scroll to top when switching providers
    if (emoteScrollRef.current) {
      emoteScrollRef.current.scrollTop = 0;
    }
  }, [selectedProvider, searchQuery]);

  // Group emotes by width categories for better grid layout
  const groupedWidthEmotes = useMemo(() => {
    const groups = new Map<string, { label: string, emotes: Emote[], gridCols: string }>();
    groups.set('standard', { label: 'Standard', emotes: [], gridCols: 'grid-cols-7' });
    groups.set('wide', { label: 'Wide', emotes: [], gridCols: 'grid-cols-4' });
    groups.set('ultrawide', { label: 'Ultra Wide', emotes: [], gridCols: 'grid-cols-3' });

    for (const emote of filteredEmotes) {
      const width = emote.width || 32;
      if (width <= 48) {
        groups.get('standard')!.emotes.push(emote);
      } else if (width <= 80) {
        groups.get('wide')!.emotes.push(emote);
      } else {
        groups.get('ultrawide')!.emotes.push(emote);
      }
    }
    
    // Sort emotes internally by exact width and then name
    for (const group of groups.values()) {
       group.emotes.sort((a, b) => {
         // Zero-width emotes float to the start of their respective category
         if (a.isZeroWidth && !b.isZeroWidth) return -1;
         if (!a.isZeroWidth && b.isZeroWidth) return 1;

         const wA = a.width || 32;
         const wB = b.width || 32;
         if (wA !== wB) return wA - wB; // Narrowest first
         return a.name.localeCompare(b.name);
       });
    }

    return groups;
  }, [filteredEmotes]);

  // Memoize grouped Twitch emotes to prevent recalculation on every render
  const groupedTwitchEmotes = useMemo((): Map<string, { name: string; emotes: Emote[] }> => {
    const groups = new Map<string, { name: string; emotes: Emote[] }>();
    
    for (const emote of filteredEmotes) {
      const type = emote.emote_type || 'globals';
      const ownerId = emote.owner_id || 'twitch';
      
      // Create a unique key for each group
      let groupKey: string;
      let groupName: string;
      
      if (type === 'globals' || !emote.owner_id) {
        groupKey = 'globals';
        groupName = 'Global Emotes';
      } else if (type === 'subscriptions') {
        groupKey = `sub-${ownerId}`;
        // Use cached channel name if available, otherwise show ID
        const cachedName = channelNameCache.get(ownerId);
        groupName = cachedName || `Channel ${ownerId}`;
      } else if (type === 'bitstier') {
        groupKey = 'bits';
        groupName = 'Bits Emotes';
      } else if (type === 'follower') {
        groupKey = `follower-${ownerId}`;
        groupName = 'Follower Emotes';
      } else if (type === 'channelpoints') {
        groupKey = `points-${ownerId}`;
        groupName = 'Channel Points Emotes';
      } else {
        groupKey = type;
        groupName = type.charAt(0).toUpperCase() + type.slice(1);
      }
      
      if (!groups.has(groupKey)) {
        groups.set(groupKey, { name: groupName, emotes: [] });
      }
      groups.get(groupKey)!.emotes.push(emote);
    }
    
    // Sort: current channel subs first, then globals, then channel points, then other subs, then others
    const currentChannelId = currentStream?.user_id;
    const sortedGroups = new Map<string, { name: string; emotes: Emote[] }>();
    const keys = Array.from(groups.keys()).sort((a, b) => {
      // Current channel's subscription emotes first (if watching a channel)
      if (currentChannelId) {
        const aIsCurrentChannel = a === `sub-${currentChannelId}`;
        const bIsCurrentChannel = b === `sub-${currentChannelId}`;
        if (aIsCurrentChannel && !bIsCurrentChannel) return -1;
        if (!aIsCurrentChannel && bIsCurrentChannel) return 1;
      }
      // Globals second
      if (a === 'globals') return -1;
      if (b === 'globals') return 1;
      // Channel points emotes third
      if (a.startsWith('points-') && !b.startsWith('points-')) return -1;
      if (!a.startsWith('points-') && b.startsWith('points-')) return 1;
      // Other subscription emotes fourth
      if (a.startsWith('sub-') && !b.startsWith('sub-')) return -1;
      if (!a.startsWith('sub-') && b.startsWith('sub-')) return 1;
      // Sort remaining by display name
      const nameA = groups.get(a)?.name || a;
      const nameB = groups.get(b)?.name || b;
      return nameA.localeCompare(nameB);
    });
    
    for (const key of keys) {
      sortedGroups.set(key, groups.get(key)!);
    }
    
    return sortedGroups;
  }, [filteredEmotes, channelNameCache, currentStream?.user_id]);

  // Memoize filtered emojis
  const filteredEmojis = useMemo(() => {
    if (!searchQuery) return allEmojis;
    const query = searchQuery.toLowerCase();
    return allEmojis.filter(({ emoji, category }) => {
      // Check category match
      if (category.toLowerCase().includes(query)) return true;
      // Check keywords match
      const keywords = EMOJI_KEYWORDS[emoji];
      if (keywords) {
        return keywords.some(k => k.includes(query));
      }
      return false;
    });
  }, [searchQuery, allEmojis]);

  if (!currentStream) {
    return (
      <div className="h-full bg-secondary backdrop-blur-md flex items-center justify-center p-4">
        <p className="text-textSecondary">No stream selected</p>
      </div>
    );
  }

  const showLoadingScreen = !isConnected && messages.length === 0;
  if (showLoadingScreen) {
    return (
      <div className="h-full bg-secondary backdrop-blur-md flex items-center justify-center p-4">
        <p className="text-textSecondary">Connecting to chat...</p>
      </div>
    );
  }

  const handleUsernameClick = async (userId: string, username: string, displayName: string, color: string, badges: Array<{ key: string; info: any }>, event: React.MouseEvent) => {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const mainWindow = getCurrentWindow();
      const mainPosition = await mainWindow.outerPosition();
      const mainSize = await mainWindow.outerSize();
      const cardWidth = 320;
      const cardHeight = 600;
      const gap = 10;
      let x = mainPosition.x - cardWidth - gap;
      const y = mainPosition.y;
      if (x < 0) x = mainPosition.x + mainSize.width + gap;
      const windowLabel = `profile-${userId}-${Date.now()}`;
      
      // PHASE 3: Fetch message history from Rust LRU cache instead of frontend Map
      // This eliminates frontend memory overhead and provides more reliable history
      let messageHistory: any[] = [];
      try {
        messageHistory = await invoke<any[]>('get_user_message_history', { userId });
      } catch (err) {
        Logger.warn('[ChatWidget] Failed to fetch user history from Rust, using frontend cache:', err);
        messageHistory = userMessageHistory.current.get(userId) || [];
      }
      
      const params = new URLSearchParams({
        userId, username, displayName, color,
        badges: JSON.stringify(badges),
        channelId: currentStream?.user_id || '',
        channelName: currentStream?.user_login || '',
        messageHistory: JSON.stringify(messageHistory)
      });
      const profileWindow = new WebviewWindow(windowLabel, {
        url: `${window.location.origin}/#/profile?${params.toString()}`,
        title: `${displayName}'s Profile`,
        width: cardWidth, height: cardHeight, x, y,
        resizable: false, decorations: false, alwaysOnTop: true, skipTaskbar: true, transparent: true, focus: true
      });
      profileWindow.once('tauri://error', (e) => Logger.error('Error opening profile window:', e));
    } catch (err) {
      Logger.error('Failed to open profile window:', err);
      setSelectedUser({ userId, username, displayName, color, badges, position: { x: event.clientX, y: event.clientY } });
    }
  };

  return (
    <>
      <div className="h-full bg-secondary backdrop-blur-md overflow-hidden flex flex-col relative">
        {/* Prediction Overlay - floating at top of chat */}
        <PredictionOverlay
          channelId={currentStream?.user_id}
          channelLogin={currentStream?.user_login}
          isHypeTrainActive={!!currentHypeTrain}
        />

        {/* Chat header - transforms when Hype Train active */}
        <div className={`absolute top-0 left-0 right-0 px-3 ${currentHypeTrain ? 'py-4' : 'py-2'} ${currentHypeTrain ? '' : 'border-b'} backdrop-blur-ultra z-10 pointer-events-none shadow-lg overflow-hidden ${
          currentHypeTrain ? '' : (isSharedChat ? 'iridescent-border' : 'border-borderSubtle')
        }`} style={{ 
          backgroundColor: currentHypeTrain ? 'var(--color-background)' : 'rgba(12, 12, 13, 0.9)',
          boxShadow: currentHypeTrain ? '0 4px 20px color-mix(in srgb, var(--color-highlight-purple) 30%, transparent), 0 2px 8px color-mix(in srgb, var(--color-highlight-purple) 20%, transparent)' : undefined
        }}>
          {currentHypeTrain && (
            // Hype Train Mode - entire header is the progress bar
            (() => {
              // Guard against NaN when goal is 0 or undefined
              const percentage = currentHypeTrain.goal > 0
                ? Math.min(Math.round((currentHypeTrain.progress / currentHypeTrain.goal) * 100), 100)
                : 0;
              // Remaining = goal - progress (in Hype points)
              const remaining = Math.max(0, currentHypeTrain.goal - currentHypeTrain.progress);
              // 1 bit = 1 point, 1 Tier1 sub = 500 points
              const bitsNeeded = remaining;
              const subsNeeded = Math.ceil(remaining / 500);
              const isGolden = currentHypeTrain.is_golden_kappa;
              
              return (
                <>
                  {/* Progress fill background */}
                  <div 
                    className={`absolute inset-0 ${
                      isGolden ? 'hype-train-progress-golden' : 'hype-train-progress-rainbow'
                    }`}
                    style={{ 
                      width: `${percentage}%`,
                      transition: 'width 0.5s ease-out'
                    }}
                  />
                  {/* Unfilled portion with animated wavy left edge */}
                  <div 
                    className="absolute inset-0 hype-train-wave-edge"
                    style={{ 
                      backgroundColor: 'var(--color-background)',
                      left: `calc(${percentage}% - 19px)`,
                      width: `calc(${100 - percentage}% + 19px)`,
                      transition: 'left 0.5s ease-out, width 0.5s ease-out'
                    }}
                  />
                  {/* Percentage/celebration content - pinned to top so it doesn't clip behind pinned message */}
                  <div className="absolute inset-x-0 top-0 h-10 flex items-center justify-center z-20 pointer-events-none">
                    {isLevelUpCelebration ? (
                      <>
                        {/* White flash effect */}
                        <div className="absolute inset-0 bg-white/40 animate-hype-flash" />
                        
                        {/* Confetti particles - uses memoized config */}
                        <div className="absolute inset-0 overflow-hidden">
                          {confettiParticles.map((particle) => (
                            <div
                              key={particle.id}
                              className="absolute w-2 h-2 rounded-full animate-confetti"
                              style={{
                                left: particle.left,
                                backgroundColor: particle.color,
                                animationDelay: particle.delay,
                                animationDuration: particle.duration
                              }}
                            />
                          ))}
                        </div>
                        
                        {/* Scrolling HYPE text */}
                        <div className="animate-hype-marquee whitespace-nowrap">
                          <span className="text-xl font-black text-white drop-shadow-glow mx-4">
                            🎉 LEVEL UP! {celebrationMessage} 🎉 LEVEL UP! {celebrationMessage} 🎉
                          </span>
                        </div>
                      </>
                    ) : (
                      <span className="text-xl font-black text-white drop-shadow-lg tabular-nums">
                        {percentage}%
                      </span>
                    )}
                  </div>
                  
                  {/* Content overlay - left and right aligned */}
                  <div className="relative flex items-center justify-between z-10">
                    {/* Left side - train icon and level */}
                    <div className="flex items-center gap-1.5">
                      {isGolden ? (
                        <span className="text-lg">✨</span>
                      ) : (
                        <svg className="w-5 h-5 text-white" viewBox="0 0 15 13" fill="none">
                          <path fillRule="evenodd" clipRule="evenodd" d="M4.10001 0.549988H2.40001V4.79999H0.700012V10.75H1.55001C1.55001 11.6889 2.31113 12.45 3.25001 12.45C4.1889 12.45 4.95001 11.6889 4.95001 10.75H5.80001C5.80001 11.6889 6.56113 12.45 7.50001 12.45C8.4389 12.45 9.20001 11.6889 9.20001 10.75H10.05C10.05 11.6889 10.8111 12.45 11.75 12.45C12.6889 12.45 13.45 11.6889 13.45 10.75H14.3V0.549988H6.65001V2.24999H7.50001V4.79999H4.10001V0.549988ZM12.6 9.04999V6.49999H2.40001V9.04999H12.6ZM9.20001 4.79999H12.6V2.24999H9.20001V4.79999Z" fill="currentColor" />
                        </svg>
                      )}
                      <span className="text-sm font-bold text-white drop-shadow-sm">
                        LVL {displayedLevel || currentHypeTrain.level}
                      </span>
                    </div>
                    
                    {/* Right side - bits/subs remaining and time */}
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-white/80 drop-shadow-sm">
                        {remaining > 0 ? (
                          <>
                            {bitsNeeded >= 1000 
                              ? `${(bitsNeeded / 1000).toFixed(1)}K` 
                              : bitsNeeded} bits / {subsNeeded} subs left
                          </>
                        ) : '🎉'}
                      </span>
                      <span className="text-[10px] text-white/50">|</span>
                      <span className="text-[10px] text-white/70 drop-shadow-sm tabular-nums">
                        {hypeTrainTimeRemaining}
                      </span>
                    </div>
                  </div>
                </>
              );
            })()
          )}
          {/* Normal header — always visible */}
          <div
            className={`relative z-10 ${currentHypeTrain ? 'mt-2 rounded-lg px-2.5 py-1.5' : ''}`}
            style={currentHypeTrain ? {
              background: 'rgba(12, 12, 13, 0.75)',
              backdropFilter: 'blur(24px)',
            } : undefined}
          >
              <div
                className={`flex items-center gap-2 ${pinnedMessages.length > 0 ? 'pointer-events-auto cursor-pointer' : ''}`}
                onClick={pinnedMessages.length > 0 ? () => {
                  const currentPinId = pinnedMessages[0]?.id || '';
                  const next = !isPinnedExpanded;
                  setIsPinnedExpanded(next);
                  if (next) {
                    seenPinIdRef.current = currentPinId;
                  }
                } : undefined}
              >
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-400'}`}></div>
                {/* Carousel toggle — cycles between STREAM CHAT and ABOUT */}
                <Tooltip content={activeView === 'about' ? 'Back to chat' : 'About this streamer'} side="top">
                <button
                  className="pointer-events-auto flex items-center gap-1.5 group/toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveView(activeView === 'about' ? 'chat' : 'about');
                  }}
                >
                  <div className="relative h-4 overflow-hidden" style={{ width: activeView === 'about' ? '44px' : (isSharedChat ? '135px' : '88px') }}>
                    <div
                      className="absolute w-full transition-transform duration-300 ease-in-out"
                      style={{ transform: activeView === 'about' ? 'translateY(-100%)' : 'translateY(0)' }}
                    >
                      <p className={`text-xs font-semibold leading-4 whitespace-nowrap ${isSharedChat ? 'iridescent-title' : 'text-textPrimary'}`}>
                        {isConnected ? (isSharedChat ? 'SHARED STREAM CHAT' : 'STREAM CHAT') : 'DISCONNECTED'}
                      </p>
                    </div>
                    <div
                      className="absolute w-full transition-transform duration-300 ease-in-out"
                      style={{ transform: activeView === 'about' ? 'translateY(0)' : 'translateY(100%)' }}
                    >
                      <p className="text-xs font-semibold leading-4 whitespace-nowrap text-accent">
                        ABOUT
                      </p>
                    </div>
                  </div>
                  {/* Up/Down chevron arrows */}
                  <div className="flex flex-col -space-y-1 text-textSecondary/50 group-hover/toggle:text-textSecondary transition-colors">
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    </svg>
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </button>
                </Tooltip>
                <div className="flex items-center gap-3 ml-auto">
                  {viewerCount !== null && (
                    <div className="flex items-center gap-1">
                      <svg className="w-3 h-3 text-textSecondary" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z" /><path fillRule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" /></svg>
                      <span className="text-xs text-textSecondary">{viewerCount.toLocaleString()}</span>
                    </div>
                  )}
                  {currentStream?.started_at && (
                    <div className="flex items-center gap-1">
                      <svg className="w-3 h-3 text-textSecondary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      <span id="stream-uptime-display" className="text-xs text-textSecondary">{streamUptimeRef.current}</span>
                    </div>
                  )}
                  {/* Pin icon + chevron indicator */}
                  {pinnedMessages.length > 0 && (() => {
                    const currentPinId = pinnedMessages[0]?.id || '';
                    const isUnseen = currentPinId !== seenPinIdRef.current;
                    return (
                      <div className="flex items-center gap-1">
                        <svg className={`w-3.5 h-3.5 text-accent ${isUnseen ? 'animate-pulse drop-shadow-[0_0_4px_var(--color-accent)]' : ''}`} fill="currentColor" viewBox="0 0 16 16">
                          <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
                        </svg>
                        <svg className={`w-2.5 h-2.5 text-textSecondary transition-transform duration-200 ${isPinnedExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    );
                  })()}

                </div>
              </div>
              {/* Expandable pinned message section */}
              {pinnedMessages.length > 0 && (
                <div
                  ref={pinnedContentRef}
                  className="overflow-hidden transition-all duration-300 ease-in-out"
                  style={{
                    maxHeight: isPinnedExpanded ? `${pinnedContentRef.current?.scrollHeight || 300}px` : '0px',
                    opacity: isPinnedExpanded ? 1 : 0,
                  }}
                >
                  {pinnedMessages.map((pin) => (
                    <div
                      key={pin.id}
                      className="mt-3 rounded-lg p-3 border border-white/[0.06]"
                      style={{
                        background: 'rgba(12, 12, 13, 0.75)',
                        backdropFilter: 'blur(24px)',
                      }}
                    >
                      {/* Sender row: avatar + badges + name + message */}
                      <div className="flex items-start gap-2.5">
                        {/* Sender avatar */}
                        {pin.sender_avatar ? (
                          <img
                            src={pin.sender_avatar}
                            alt={pin.sender_name}
                            className="w-8 h-8 rounded-full flex-shrink-0 object-cover"
                          />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
                            style={{ backgroundColor: pin.sender_color }}
                          >
                            {pin.sender_name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          {/* Name + badges row */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {/* Badges — resolved from in-memory badge cache */}
                            {(() => {
                              const badgeStr = pin.sender_badges?.map(b => `${b.set_id}/${b.version}`).join(',') || '';
                              if (!badgeStr) return null;
                              const resolved = parseBadges(badgeStr, currentStream?.user_id);
                              return resolved.map((badge: { key: string; info: { image_url_1x?: string; image_url_2x?: string; title?: string } | null }, i: number) => (
                                badge.info?.image_url_1x ? (
                                  <img
                                    key={`${badge.key}-${i}`}
                                    src={badge.info.image_url_2x || badge.info.image_url_1x}
                                    alt={badge.info.title || badge.key}
                                    title={badge.info.title || badge.key}
                                    className="w-[18px] h-[18px] flex-shrink-0"
                                  />
                                ) : null
                              ));
                            })()}
                            <span
                              className="text-sm font-semibold"
                              style={{ color: pin.sender_color }}
                            >
                              {pin.sender_name}
                            </span>
                          </div>
                          {/* Message text with clickable links */}
                          <p className="text-[13px] text-textPrimary/90 mt-1.5 break-words" style={{ lineHeight: '1.6' }}>
                            {pin.message_text.split(/(https?:\/\/\S+)/g).map((part, i) =>
                              /^https?:\/\//.test(part) ? (
                                <a
                                  key={i}
                                  className="text-accent hover:underline pointer-events-auto cursor-pointer"
                                  onClick={() => {
                                    import('@tauri-apps/plugin-shell').then(({ open }) => open(part));
                                  }}
                                >
                                  {part.length > 50 ? part.slice(0, 50) + '…' : part}
                                </a>
                              ) : (
                                <span key={i}>{part}</span>
                              )
                            )}
                          </p>
                        </div>
                      </div>
                      {/* Pinned by footer — visually separated */}
                      {pin.pinned_by && (
                        <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-white/[0.05] ml-[42px]">
                          <svg className="w-2.5 h-2.5 text-accent" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5a.5.5 0 0 1-1 0V10h-4A.5.5 0 0 1 3 9.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.708V2.277a2.77 2.77 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
                          </svg>
                          {pin.pinned_by_avatar && (
                            <img
                              src={pin.pinned_by_avatar}
                              alt={pin.pinned_by}
                              className="w-3.5 h-3.5 rounded-full object-cover"
                            />
                          )}
                          <span className="text-[10px] text-textSecondary">
                            Pinned by <span className="font-medium text-textPrimary/70">{pin.pinned_by}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>

        {/* Staging area removed - using direct rendering with ResizeObserver */}

        {/* About panel - replaces chat when active */}
        {activeView === 'about' && currentStream && (
          <div className={`flex-1 overflow-hidden animate-panel-slide-up ${currentHypeTrain ? 'pt-24' : 'pt-10'}`}>
            <StreamerAboutPanel
              channelLogin={currentStream.user_login}
            />
          </div>
        )}

        {/* Chat messages area - flex-1 to take remaining space */}
        {activeView === 'chat' && <div className="flex-1 overflow-hidden animate-panel-slide-down"
          onMouseEnter={() => { isHoveringChatRef.current = true; }}
          onMouseLeave={() => { isHoveringChatRef.current = false; }}>
          {visibleMessages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-textSecondary text-sm">Waiting for messages...</p>
            </div>
          ) : (
            <ErrorBoundary componentName="ChatWidgetList" reportToLogService={true}>
              <ChatMessageList
                messages={visibleMessages}
                isPaused={isPaused}
                onScroll={(distanceToBottom, isUserScroll) => {
                  // Debug logging - to be removed after verification
                  if (isUserScroll && distanceToBottom > 150) {
                     Logger.debug('[ChatWidget] Potential Pause Trigger:', { distanceToBottom, isUserScroll, isPaused });
                  }
                  
                  // Grace Periods:
                  // 1. Initial Load: Ignore first 2s to allow layout stabilization
                  // 2. Resume: Ignore first 1s after clicking resume
                  const now = Date.now();
                  if (now - mountTimeRef.current < 2000) return;
                  if (now - lastResumeTimeRef.current < 1000) return;
                  if (now - lastNavigationTimeRef.current < 1000) return; // Skip during scrollToMessage animation
                  
                  // User scrolled up (away from bottom) - pause chat
                  // STRICT: Only pause if Child component confirms it was a USER interaction (isUserScroll)
                  if (isUserScroll && distanceToBottom > 150 && !isPaused) {
                    Logger.debug('[ChatWidget] PAUSING CHAT due to user scroll');
                    setIsPaused(true);
                    setBufferPaused(true);
                  }
                  // User scrolled back to bottom while paused - auto-resume
                  else if (isPaused && distanceToBottom < 30) {
                    handleResume();
                  }
                }}
                onUsernameClick={handleUsernameClick}
                onReplyClick={handleReplyClick}
                onEmoteRightClick={handleEmoteRightClick}
                onUsernameRightClick={handleUsernameRightClick}
                onBadgeClick={handleBadgeClick}
                highlightedMessageId={highlightedMessageId}
                deletedMessageIds={deletedMessageIds}
                clearedUserContexts={clearedUserContexts}
                emotes={emotes}
                getMessageId={getMessageId}
              />
            </ErrorBoundary>
          )}
        </div>}

        {/* Chat Paused indicator - positioned above input */}
        {activeView === 'chat' && isPaused && (
          <div className="absolute bottom-[60px] left-1/2 transform -translate-x-1/2 z-50 pointer-events-auto">
            <button onClick={handleResume} className="flex items-center gap-2 px-4 py-2 glass-button text-white text-sm font-medium rounded-full shadow-lg bg-black/95">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              <span>Chat Paused ({messages.length - pausedMessageCount} new)</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </button>
          </div>
        )}

        {/* Input container - static flex item at bottom (hidden when About view active) */}
        {activeView === 'chat' &&
        <div className="flex-shrink-0 border-t border-borderSubtle backdrop-blur-ultra" style={{ backgroundColor: 'rgba(12, 12, 13, 0.9)' }}>
          <div className="p-2">
            <div className="relative">
              {showEmotePicker && (
                <div className="absolute bottom-full left-0 right-0 mb-2 h-[520px] max-h-[calc(100vh-120px)] border border-borderSubtle rounded-lg shadow-lg flex flex-col overflow-hidden" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>
                  <div className="p-2 border-b border-borderSubtle">
                    <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search emotes..."
                      className="w-full glass-input text-xs px-3 py-1.5 placeholder-textSecondary" />
                    <div className="flex gap-1 mt-2">
                      <button onClick={() => setSelectedProvider('favorites')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center gap-1 ${selectedProvider === 'favorites' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }} title={`Favorites (${favoriteEmotes.length})`}>
                        <span className="text-yellow-400">★</span><span className="text-[10px] opacity-70">{favoriteEmotes.length}</span>
                      </button>
                      <Tooltip content="Emoji" side="top">
                      <button onClick={() => setSelectedProvider('emoji')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center ${selectedProvider === 'emoji' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }}><img src={getAppleEmojiUrl('😀')} alt="😀" className="w-4 h-4" /></button>
                      </Tooltip>
                      <Tooltip content={`Twitch (${emotes?.twitch.length || 0})`} side="top">
                      <button onClick={() => setSelectedProvider('twitch')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center gap-1 ${selectedProvider === 'twitch' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }}>
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.twitch.length || 0}</span>
                      </button>
                      </Tooltip>
                      <Tooltip content={`BetterTTV (${emotes?.bttv.length || 0})`} side="top">
                      <button onClick={() => setSelectedProvider('bttv')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center gap-1 ${selectedProvider === 'bttv' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }}>
                        <svg className="w-4 h-4" viewBox="0 0 300 300" fill="currentColor"><path fill="transparent" d="M249.771 150A99.771 99.922 0 0 1 150 249.922 99.771 99.922 0 0 1 50.229 150 99.771 99.922 0 0 1 150 50.078 99.771 99.922 0 0 1 249.771 150Z" /><path d="M150 1.74C68.409 1.74 1.74 68.41 1.74 150S68.41 298.26 150 298.26h148.26V150.17h-.004c0-.057.004-.113.004-.17C298.26 68.409 231.59 1.74 150 1.74zm0 49c55.11 0 99.26 44.15 99.26 99.26 0 55.11-44.15 99.26-99.26 99.26-55.11 0-99.26-44.15-99.26-99.26 0-55.11 44.15-99.26 99.26-99.26z" /><path d="M161.388 70.076c-10.662 0-19.42 7.866-19.42 17.67 0 9.803 8.758 17.67 19.42 17.67 10.662 0 19.42-7.867 19.42-17.67 0-9.804-8.758-17.67-19.42-17.67zm45.346 24.554-.02.022-.004.002c-5.402 2.771-11.53 6.895-18.224 11.978l-.002.002-.004.002c-25.943 19.766-60.027 54.218-80.344 80.33h-.072l-1.352 1.768c-5.114 6.69-9.267 12.762-12.098 18.006l-.082.082.022.021v.002l.004.002.174.176.052-.053.102.053-.07.072c30.826 30.537 81.213 30.431 111.918-.273 30.783-30.784 30.8-81.352.04-112.152l-.005-.004zM87.837 142.216c-9.803 0-17.67 8.758-17.67 19.42 0 10.662 7.867 19.42 17.67 19.42 9.804 0 17.67-8.758 17.67-19.42 0-10.662-7.866-19.42-17.67-19.42z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.bttv.length || 0}</span>
                      </button>
                      </Tooltip>
                      <Tooltip content={`7TV (${emotes?.['7tv'].length || 0})`} side="top">
                      <button onClick={() => setSelectedProvider('7tv')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center gap-1 ${selectedProvider === '7tv' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }}>
                        <svg className="w-4 h-4" viewBox="0 0 28 21" fill="currentColor"><path d="M20.7465 5.48825L21.9799 3.33745L22.646 2.20024L21.4125 0.0494437V0H14.8259L17.2928 4.3016L17.9836 5.48825H20.7465Z" /><path d="M7.15395 19.9258L14.5546 7.02104L15.4673 5.43884L13.0004 1.13724L12.3097 0.0247596H1.8995L0.666057 2.17556L0 3.31276L1.23344 5.46356V5.51301H9.12745L2.96025 16.267L2.09685 17.7998L3.33029 19.9506V20H7.15395" /><path d="M17.4655 19.9257H21.2398L26.1736 11.3225L27.037 9.83924L25.8036 7.68844V7.63899H22.0046L19.5377 11.9406L19.365 12.262L16.8981 7.96038L16.7255 7.63899L14.2586 11.9406L13.5679 13.1272L17.2682 19.5796L17.4655 19.9257Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.['7tv'].length || 0}</span>
                      </button>
                      </Tooltip>
                      <Tooltip content={`FrankerFaceZ (${emotes?.ffz.length || 0})`} side="top">
                      <button onClick={() => setSelectedProvider('ffz')} className={`flex-1 py-1.5 text-xs transition-all flex items-center justify-center gap-1 ${selectedProvider === 'ffz' ? 'glass-input text-emerald-400 font-extrabold' : 'glass-button text-textSecondary hover:text-white'}`} style={{ borderRadius: '8px' }}>
                        <svg className="w-4 h-4" viewBox="-0.5 -0.5 40 30" fill="currentColor"><path d="M 15.5,-0.5 C 17.8333,-0.5 20.1667,-0.5 22.5,-0.5C 24.6552,3.13905 26.8218,6.80572 29,10.5C 29.691,7.40943 31.5243,6.24276 34.5,7C 36.585,9.68221 38.2517,12.5155 39.5,15.5C 39.5,17.5 39.5,19.5 39.5,21.5C 34.66,25.2533 29.3267,27.92 23.5,29.5C 20.5,29.5 17.5,29.5 14.5,29.5C 9.11466,27.3005 4.11466,24.3005 -0.5,20.5C -0.5,17.5 -0.5,14.5 -0.5,11.5C 4.17691,4.45967 7.34358,5.12633 9,13.5C 10.6047,10.3522 11.6047,7.01889 12,3.5C 12.6897,1.64977 13.8564,0.316435 15.5,-0.5 Z" /></svg>
                        <span className="text-[10px] opacity-70">{emotes?.ffz.length || 0}</span>
                      </button>
                      </Tooltip>
                    </div>
                  </div>
                  <div ref={emoteScrollRef} className="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
                    {selectedProvider === 'emoji' ? (
                      filteredEmojis.length === 0 ? (
                        <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">No emojis found</p></div>
                      ) : (
                        <div className="flex flex-col gap-4 pt-2">
                          {Object.entries(emojiCategories).map(([category, emojis]) => {
                            const filteredCategoryEmojis = searchQuery ? emojis.filter(emoji => emoji.includes(searchQuery) || category.toLowerCase().includes(searchQuery.toLowerCase())) : emojis;
                            if (filteredCategoryEmojis.length === 0) return null;
                            return (
                              <div key={category} className="flex flex-col">
                                <h3 className="text-[10px] text-textSecondary uppercase tracking-wider font-bold mb-2 -mx-2 px-4 sticky top-0 py-1.5 border-b border-white/[0.03] z-10 backdrop-blur-ultra" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>{category}</h3>
                                <div className="grid grid-cols-8 gap-1 px-1">
                                  {filteredCategoryEmojis.map((emoji, idx) => (
                                    <button key={`${category}-${idx}`} onClick={() => insertEmote(emoji)} className="flex items-center justify-center p-1.5 hover:bg-glass rounded transition-colors" title={emoji}>
                                      <img src={getAppleEmojiUrl(emoji)} alt={emoji} className="w-6 h-6 object-contain" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.insertAdjacentText('afterend', emoji); }} />
                                    </button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )
                    ) : isLoadingEmotes ? (
                      <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">Loading emotes...</p></div>
                    ) : filteredEmotes.length === 0 ? (
                      <div className="flex items-center justify-center h-32"><p className="text-xs text-textSecondary">No emotes found</p></div>
                    ) : selectedProvider === 'twitch' ? (
                      // Grouped Twitch emotes by channel
                      <div className="flex flex-col gap-4 pt-2">
                        {Array.from(groupedTwitchEmotes.entries()).map(([groupKey, group]) => (
                          <div key={groupKey} className="flex flex-col">
                            <h3 className="text-[10px] text-textSecondary uppercase tracking-wider font-bold mb-2 -mx-2 px-4 sticky top-0 py-1.5 border-b border-borderSubtle z-10 backdrop-blur-ultra" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>
                              <span className="text-textPrimary">{group.name}</span> <span className="opacity-50">({group.emotes.length})</span>
                            </h3>
                            <div className="grid grid-cols-7 gap-2 px-1">
                              {group.emotes.map((emote, idx) => {
                                const isFavorited = isFavoriteEmote(emote.id);
                                return (
                                  <div key={`${groupKey}-${emote.provider}-${emote.id}-${idx}`} className="relative group">
                                    <button onClick={() => insertEmote(emote.name)} className="flex flex-col items-center gap-1 p-1.5 hover:bg-glass rounded transition-colors w-full" title={emote.name}>
                                      <img
                                        src={emote.localUrl || emote.url}
                                        alt={emote.name}
                                        loading="lazy"
                                        referrerPolicy="no-referrer"
                                        crossOrigin="anonymous"
                                        className="w-8 h-8 object-contain"
                                        // Don't cache emotes from picker - only from chat messages
                                        onError={(e) => {
                                          // If cached file failed, try CDN URL
                                          const target = e.currentTarget;
                                          if (emote.localUrl && target.src !== emote.url) {
                                            target.src = emote.url;
                                          } else {
                                            target.style.display = 'none';
                                          }
                                        }}
                                      />
                                      <span className="text-xs text-textSecondary truncate w-full text-center">{emote.name}</span>
                                    </button>
                                    <button onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        if (isFavorited) {
                                          await removeFavoriteEmote(emote.id);
                                          useAppStore.getState().addToast(`Removed ${emote.name} from favorites`, 'success');
                                        } else {
                                          await addFavoriteEmote(emote);
                                          if (emotes) {
                                            const allEmotes = [...emotes.twitch, ...emotes.bttv, ...emotes['7tv'], ...emotes.ffz];
                                            const availableFavorites = getAvailableFavorites(allEmotes);
                                            setFavoriteEmotes(availableFavorites);
                                          }
                                          useAppStore.getState().addToast(`Added ${emote.name} to favorites`, 'success');
                                        }
                                      } catch (err) {
                                        Logger.error('Failed to toggle favorite:', err);
                                        useAppStore.getState().addToast('Failed to update favorites', 'error');
                                      }
                                    }} className={`absolute top-0 right-0 p-1 rounded-bl transition-all ${isFavorited ? 'text-yellow-400 opacity-100' : 'text-textSecondary opacity-0 group-hover:opacity-100'} hover:text-yellow-400 hover:bg-glass`} title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}>
                                      <svg className="w-3 h-3" fill={isFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-4 pt-2">
                        {Array.from(groupedWidthEmotes.values()).filter(g => g.emotes.length > 0).map((group) => (
                          <div key={group.label} className="flex flex-col">
                            <h3 className="text-[10px] text-textSecondary uppercase tracking-wider font-bold mb-2 -mx-2 px-4 sticky top-0 py-1.5 border-b border-borderSubtle z-10 backdrop-blur-ultra" style={{ backgroundColor: 'rgba(12, 12, 13, 0.95)' }}>
                              <span className="text-textPrimary">{group.label}</span> <span className="opacity-50">({group.emotes.length})</span>
                            </h3>
                            <div className={`grid ${group.gridCols} gap-2 px-1`}>
                              {group.emotes.map((emote: Emote, idx: number) => {
                                const isFavorited = isFavoriteEmote(emote.id);
                                return (
                                  <EmoteGridItem
                                    key={`${emote.provider}-${emote.id}-${idx}`}
                                    emote={emote}
                                    isFavorited={isFavorited}
                                    onInsert={() => insertEmote(emote.name)}
                                    onToggleFavorite={async () => {
                                      try {
                                        if (isFavorited) {
                                          await removeFavoriteEmote(emote.id);
                                          if (selectedProvider === 'favorites') setFavoriteEmotes(prev => prev.filter(e => e.id !== emote.id));
                                          useAppStore.getState().addToast(`Removed ${emote.name} from favorites`, 'info');
                                        } else {
                                          await addFavoriteEmote(emote);
                                          if (emotes) {
                                            const allEmotes = [...emotes.twitch, ...emotes.bttv, ...emotes['7tv'], ...emotes.ffz];
                                            const availableFavorites = getAvailableFavorites(allEmotes);
                                            setFavoriteEmotes(availableFavorites);
                                          }
                                          useAppStore.getState().addToast(`Added ${emote.name} to favorites`, 'success');
                                        }
                                      } catch (err) {
                                        Logger.error('Failed to toggle favorite:', err);
                                        useAppStore.getState().addToast('Failed to update favorites', 'error');
                                      }
                                    }}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Channel Points Menu - renders at full width like emote picker */}
              {showChannelPointsMenu && currentStream && (
                <ChannelPointsMenu
                  channelLogin={currentStream.user_login}
                  channelId={currentStream.user_id}
                  currentBalance={channelPoints}
                  customPointsName={customPointsName}
                  customPointsIconUrl={customPointsIconUrl}
                  onClose={() => setShowChannelPointsMenu(false)}
                  onBalanceUpdate={fetchChannelPoints}
                  onEmotesChange={() => loadEmotes(currentStream.user_login, currentStream.user_id)}
                />
              )}
              {/* Resub Notification Banner - shows when user has a shareable resub */}
              {resubNotification && !resubDismissed && currentStream && (
                <ResubNotificationBanner
                  resubNotification={resubNotification}
                  channelLogin={currentStream.user_login}
                  isResubMode={isResubMode}
                  includeStreak={includeStreak}
                  onActivateShare={() => {
                    setIsResubMode(true);
                    setReplyingTo(null); // Clear reply mode if active
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                  onDismiss={() => {
                    setResubDismissed(true);
                    setIsResubMode(false);
                  }}
                  onToggleStreak={() => setIncludeStreak(!includeStreak)}
                  onCancelShare={() => {
                    setIsResubMode(false);
                    setMessageInput('');
                  }}
                />
              )}
              {/* Watch Streak Banner - shows when user has a shareable watch streak */}
              {watchStreak && !watchStreakDismissed && currentStream && (
                <WatchStreakBanner
                  milestone={watchStreak}
                  isStreakMode={isWatchStreakMode}
                  onActivateShare={() => {
                    setIsWatchStreakMode(true);
                    setIsResubMode(false); // Can't be in both modes
                    setReplyingTo(null);
                    inputRef.current?.focus({ preventScroll: true });
                  }}
                  onDismiss={() => {
                    setWatchStreakDismissed(true);
                    setIsWatchStreakMode(false);
                  }}
                  onCancelShare={() => {
                    setIsWatchStreakMode(false);
                    setMessageInput('');
                  }}
                />
              )}
              {replyingTo && !isResubMode && !isWatchStreakMode && (
                <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-glass rounded-lg border border-borderSubtle">
                  <svg className="w-4 h-4 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                  <span className="text-xs text-textSecondary flex-1">Replying to <span className="text-accent font-semibold">{replyingTo.username}</span></span>
                  <Tooltip content="Cancel reply" side="top">
                  <button onClick={() => setReplyingTo(null)} className="text-textSecondary hover:text-textPrimary transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  </Tooltip>
                </div>
              )}

              <div className="flex items-center gap-2 min-w-0">
                {/* Channel Points button - click to open rewards menu, hover for balance */}
                <div 
                  ref={channelPointsRef}
                  className="relative flex-shrink-0 self-center flex items-center"
                  onMouseEnter={() => setChannelPointsHovered(true)}
                  onMouseLeave={() => setChannelPointsHovered(false)}
                >
                  <button
                    onClick={() => setShowChannelPointsMenu(!showChannelPointsMenu)}
                    className={`group flex items-center justify-center w-9 h-9 transition-all duration-200 ${showChannelPointsMenu ? 'text-accent-neon' : channelPoints !== null ? 'text-accent-neon' : 'text-textSecondary hover:text-accent-neon'}`}
                  >
                    {customPointsIconUrl ? (
                      <img 
                        src={customPointsIconUrl} 
                        alt={customPointsName || "Channel Points"} 
                        className="w-[18px] h-[18px] transition-all duration-200 group-hover:drop-shadow-[0_0_6px_rgba(200,224,232,0.85)]"
                      />
                    ) : (
                      <ChannelPointsIcon size={18} className="transition-all duration-200 group-hover:drop-shadow-[0_0_6px_rgba(200,224,232,0.85)]" />
                    )}
                  </button>
                  {/* Points tooltip - fixed position to escape overflow-hidden parents */}
                  {channelPointsHovered && !showChannelPointsMenu && (
                    <ChannelPointsTooltip
                      anchorRef={channelPointsRef}
                      customPointsIconUrl={customPointsIconUrl}
                      customPointsName={customPointsName}
                      isLoadingChannelPoints={isLoadingChannelPoints}
                      channelPoints={channelPoints}
                    />
                  )}
                </div>
                {/* Drops mining button - only shows if current game has active drops */}
                {dropsCampaign && (
                  <Tooltip content={isMining ? `Stop mining drops for ${dropsCampaign.game_name}` : `Start mining drops for ${dropsCampaign.game_name}`} side="top">
                  <button
                    onClick={handleToggleMining}
                    disabled={isLoadingDrops}
                    className={`group flex-shrink-0 flex items-center justify-center self-center w-9 h-9 transition-all duration-200 ${isMining
                      ? 'text-green-400 hover:text-red-400'
                      : 'text-textSecondary hover:text-accent'
                      }`}
                  >
                    <Pickaxe size={18} className={`transition-all duration-200 group-hover:drop-shadow-[0_0_6px_rgba(200,224,232,0.85)] ${isMining ? 'animate-pulse' : ''}`} />
                  </button>
                  </Tooltip>
                )}
                {/* Input container with emoji button inset on the left */}
                <div className="relative flex-1 min-w-0 flex items-center">
                  {/* Emoji button — inset left inside the input */}
                  <Tooltip content={showEmotePicker ? "Close Emotes" : "Emotes"} side="top">
                  <button
                    onClick={() => setShowEmotePicker(!showEmotePicker)}
                    onMouseLeave={cycleEmoteSmiley}
                    className="group absolute left-1 top-1/2 -translate-y-1/2 z-10 flex items-center justify-center w-7 h-7 text-textSecondary hover:text-textPrimary transition-colors duration-200"
                  >
                    {showEmotePicker ? (
                      <svg className="w-4 h-4 transition-all duration-200 text-accent group-hover:drop-shadow-[0_0_5px_rgba(200,224,232,0.8)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                    ) : (
                      <img
                        src={getAppleEmojiUrl(currentSmiley)}
                        alt={currentSmiley}
                        draggable={false}
                        className={`w-4 h-4 object-contain transition-all ease-in-out group-hover:drop-shadow-[0_0_5px_rgba(200,224,232,0.8)] ${
                          isSmileyTransitioning
                            ? 'opacity-0 scale-50 duration-100'
                            : 'opacity-100 scale-100 duration-150'
                        }`}
                      />
                    )}
                  </button>
                  </Tooltip>
                  {/* @ Mention Autocomplete */}
                  {showMentionAutocomplete && (
                    <MentionAutocomplete
                      users={getMatchingUsers(mentionQuery)}
                      selectedIndex={mentionSelectedIndex}
                      onSelect={(user) => insertMention(user)}
                      onSelectedIndexChange={setMentionSelectedIndex}
                    />
                  )}
                  <textarea 
                    ref={inputRef} 
                    value={messageInput} 
                    onChange={handleInputChange} 
                    onKeyDown={handleKeyPress}
                    placeholder={isWatchStreakMode ? "Add a message (optional)..." : "Send a message"} 
                    className={`w-full glass-input text-textPrimary text-sm placeholder-textSecondary resize-none overflow-hidden scrollbar-thin leading-[1.4] self-center transition-all duration-300 ${
                      isWatchStreakMode 
                        ? 'ring-2 ring-amber-500/50 bg-amber-500/5 shadow-[0_0_15px_rgba(245,158,11,0.15)] placeholder-amber-500/60' 
                        : ''
                    }`}
                    style={{ 
                      minHeight: '36px',
                      maxHeight: '120px',
                      paddingTop: '8px',
                      paddingBottom: '8px',
                      paddingLeft: '36px',
                      paddingRight: '12px',
                    }}
                    rows={1}
                    disabled={!isConnected}
                    onBlur={() => {
                      // Delay hiding to allow click on autocomplete
                      setTimeout(() => setShowMentionAutocomplete(false), 150);
                    }}
                  />
                </div>
                <Tooltip content={isWatchStreakMode ? "Share Watch Streak" : "Send message"} side="top">
                <button 
                  onClick={handleSendMessage} 
                  disabled={(!messageInput.trim() && !isWatchStreakMode && !isResubMode) || !isConnected} 
                  className={`flex-shrink-0 flex items-center justify-center self-center w-9 h-9 text-white rounded transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isWatchStreakMode 
                      ? 'bg-amber-500 hover:bg-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.3)]' 
                      : 'glass-button'
                  }`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                </button>
                </Tooltip>
              </div>
            </div>
            {!isConnected && <p className="text-xs text-yellow-400 mt-2">Chat is not connected. Messages cannot be sent.</p>}
          </div>
        </div>}
      </div>
      {
        selectedUser && (
          <UserProfileCard userId={selectedUser.userId} username={selectedUser.username} displayName={selectedUser.displayName}
            color={selectedUser.color} badges={selectedUser.badges} messageHistory={userMessageHistory.current.get(selectedUser.userId) || []}
            onClose={() => setSelectedUser(null)} position={selectedUser.position} />
        )
      }
    </>
  );
};

export default ChatWidget;

