import { useMemo, useState, useEffect } from 'react';
import { parseMessage } from '../services/twitchChat';
import { parseEmotesWithThirdParty, EmoteSegment } from '../services/emoteParser';
import { EmoteSet } from '../services/emoteService';
import { getUserCosmetics, computePaintStyle, getBadgeImageUrl } from '../services/seventvService';
import { SevenTVBadge, SevenTVPaint } from '../types';
import { useAppStore } from '../stores/AppStore';

// Global cache for channel names and profile images to prevent re-fetching and flashing
const channelNameCache = new Map<string, string>();
const channelProfileImageCache = new Map<string, string>();

interface ChatMessageProps {
  message: string; // Raw IRC message
  emoteSet?: EmoteSet | null;
  messageIndex?: number; // For alternating backgrounds
  onUsernameClick?: (
    userId: string,
    username: string,
    displayName: string,
    color: string,
    badges: Array<{ key: string; info: any }>,
    event: React.MouseEvent
  ) => void;
  onReplyClick?: (parentMsgId: string) => void;
  isHighlighted?: boolean;
  onEmoteRightClick?: (emoteName: string) => void;
  onUsernameRightClick?: (messageId: string, username: string) => void;
  onBadgeClick?: (badgeKey: string, badgeInfo: any) => void;
}

const ChatMessage = ({ message, emoteSet, messageIndex = 0, onUsernameClick, onReplyClick, isHighlighted = false, onEmoteRightClick, onUsernameRightClick, onBadgeClick }: ChatMessageProps) => {
  const { settings, currentUser } = useAppStore();
  const chatDesign = settings.chat_design;
  const parsed = useMemo(() => {
    // Extract channel ID from the message tags if available
    // For shared chat messages, use source-room-id instead of room-id for badge lookup
    const sourceRoomIdMatch = message.match(/source-room-id=([^;]+)/);
    const roomIdMatch = message.match(/room-id=([^;]+)/);
    
    // Prefer source-room-id for shared chat messages, fall back to room-id
    const channelId = sourceRoomIdMatch ? sourceRoomIdMatch[1] : (roomIdMatch ? roomIdMatch[1] : undefined);
    
    return parseMessage(message, channelId);
  }, [message]);
  const contentWithEmotes = useMemo(
    () => parseEmotesWithThirdParty(parsed.content, parsed.emotes, emoteSet || undefined),
    [parsed, emoteSet]
  );
  
  const [seventvBadge, setSeventvBadge] = useState<any>(null);
  const [seventvPaint, setSeventvPaint] = useState<any>(null);
  const [broadcasterType, setBroadcasterType] = useState<string | null>(null);
  const [isMentioned, setIsMentioned] = useState(false);
  const [isReplyToMe, setIsReplyToMe] = useState(false);
  
  // Extract userId once to prevent re-renders
  const userId = useMemo(() => parsed.tags.get('user-id'), [message]);
  
  // Check if this message mentions the current user or is a reply to them
  useEffect(() => {
    if (!currentUser) return;
    
    // Check for @ mentions in the message content
    const mentionPattern = new RegExp(`@${currentUser.username}\\b`, 'i');
    const mentioned = mentionPattern.test(parsed.content);
    setIsMentioned(mentioned);
    
    // Check if this is a reply to the current user
    const replyUserId = parsed.replyInfo?.parentUserId;
    const isReply = replyUserId === currentUser.user_id;
    setIsReplyToMe(isReply);
  }, [parsed.content, parsed.replyInfo, currentUser]);
  
  // Fetch 7TV user cosmetics using v4 API
  useEffect(() => {
    if (!userId) {
      return;
    }

    let cancelled = false;

    getUserCosmetics(userId).then((cosmetics) => {
      if (cancelled || !cosmetics) return;

      // Find selected paint
      const selectedPaint = cosmetics.paints.find((p) => p.selected);
      if (selectedPaint) {
        setSeventvPaint(selectedPaint);
      }

      // Find selected badge
      const selectedBadge = cosmetics.badges.find((b) => b.selected);
      if (selectedBadge) {
        setSeventvBadge(selectedBadge);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);
  
  // Create username style with paint
  const usernameStyle = useMemo(() => {
    if (!seventvPaint) {
      return { color: parsed.color };
    }
    
    // Use the new computePaintStyle function
    return computePaintStyle(seventvPaint, parsed.color);
  }, [seventvPaint, parsed.color]);


  const renderContent = (segments: EmoteSegment[]) => {
    return segments.map((segment, index) => {
      if (segment.type === 'emote') {
        const emoteUrl = segment.emoteUrl || 
          (segment.emoteId ? `https://static-cdn.jtvnw.net/emoticons/v2/${segment.emoteId}/default/dark/1.0` : '');
        
        return (
          <img
            key={`${segment.emoteId || segment.content}-${index}`}
            src={emoteUrl}
            alt={segment.content}
            className="inline h-6 align-middle mx-0.5 cursor-pointer hover:scale-110 transition-transform"
            title={`Right-click to copy: ${segment.content}`}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onEmoteRightClick) {
                onEmoteRightClick(segment.content);
              }
            }}
            onError={(e) => {
              // Fallback to text if image fails to load
              e.currentTarget.style.display = 'none';
              e.currentTarget.insertAdjacentText('afterend', segment.content);
            }}
          />
        );
      }
      
      // Parse text for URLs and make them clickable
      return <span key={index}>{parseTextWithLinks(segment.content)}</span>;
    });
  };

  // Helper function to detect URLs and make them clickable
  const parseTextWithLinks = (text: string) => {
    // URL regex pattern that matches http://, https://, and www. URLs
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    const parts = text.split(urlRegex);
    
    return parts.map((part, index) => {
      // Check if this part is a URL
      if (part.match(urlRegex)) {
        // Ensure the URL has a protocol
        const url = part.startsWith('http') ? part : `https://${part}`;
        
        return (
          <a
            key={index}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 underline cursor-pointer"
            onClick={async (e) => {
              e.preventDefault();
              try {
                // Use Tauri's shell plugin to open URL in default browser
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(url);
              } catch (err) {
                console.error('[ChatMessage] Failed to open URL:', err);
              }
            }}
          >
            {part}
          </a>
        );
      }
      return part;
    });
  };

  // Check if this is a subscription message
  // Note: 'sharedchatnotice' is used for shared subscription events across channels
  const msgId = parsed.tags.get('msg-id');
  const sourceMsgId = parsed.tags.get('source-msg-id');
  const isSubscription = msgId === 'sub' || 
                         msgId === 'resub' ||
                         msgId === 'subgift' ||
                         msgId === 'submysterygift' ||
                         msgId === 'sharedchatnotice' ||
                         sourceMsgId === 'sub' ||
                         sourceMsgId === 'resub' ||
                         sourceMsgId === 'subgift' ||
                         sourceMsgId === 'submysterygift';

  // Check if this is a charity donation message
  const isDonation = msgId === 'charitydonation' || sourceMsgId === 'charitydonation';

  // Get system message for subscriptions and donations
  const systemMessage = parsed.tags.get('system-msg')?.replace(/\\s/g, ' ');
  
  // Check if this is a first-time message
  const isFirstMessage = parsed.tags.get('first-msg') === '1';

  // Handle charity donations
  if (isDonation) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `donation-${parsed.username}-${Date.now()}`;
    
    // Get donation details
    const charityName = parsed.tags.get('msg-param-charity-name')?.replace(/\\s/g, ' ');
    const donationAmount = parsed.tags.get('msg-param-donation-amount');
    const donationCurrency = parsed.tags.get('msg-param-donation-currency') || 'USD';
    const exponent = parseInt(parsed.tags.get('msg-param-exponent') || '2', 10);
    
    // Calculate the actual donation amount (amount is in smallest currency unit)
    const actualAmount = donationAmount ? (parseInt(donationAmount, 10) / Math.pow(10, exponent)) : 0;
    
    // Format the amount with currency symbol
    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: donationCurrency,
    }).format(actualAmount);
    
    // Check if this is a shared chat notice (from another channel)
    const isSharedChat = msgId === 'sharedchatnotice';
    const sourceRoomId = parsed.tags.get('source-room-id');
    const currentRoomId = parsed.tags.get('room-id');
    const isFromDifferentChannel = isSharedChat && sourceRoomId && currentRoomId && sourceRoomId !== currentRoomId;
    
    // Initialize from cache if available
    const [sharedChannelName, setSharedChannelName] = useState<string | null>(() => {
      if (sourceRoomId && channelNameCache.has(sourceRoomId)) {
        return channelNameCache.get(sourceRoomId) || null;
      }
      return null;
    });
    
    useEffect(() => {
      if (isFromDifferentChannel && systemMessage && sourceRoomId) {
        // Check if we already have it in cache
        if (channelNameCache.has(sourceRoomId)) {
          const cachedName = channelNameCache.get(sourceRoomId);
          if (cachedName && cachedName !== sharedChannelName) {
            setSharedChannelName(cachedName);
          }
          return;
        }
        
        // Try to extract channel name from system message
        const channelMatch = systemMessage.match(/to\s+support\s+(\w+)/i);
        if (channelMatch && channelMatch[1]) {
          // Store in cache
          channelNameCache.set(sourceRoomId, channelMatch[1]);
          setSharedChannelName(channelMatch[1]);
        } else {
          // Fallback: fetch channel info from Twitch API using sourceRoomId
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke<any>('get_user_by_id', { userId: sourceRoomId })
              .then((user) => {
                if (user && user.login) {
                  // Store in cache
                  channelNameCache.set(sourceRoomId, user.login);
                  setSharedChannelName(user.login);
                }
              })
              .catch((err) => {
                console.warn('[ChatMessage] Failed to fetch source channel info:', err);
              });
          });
        }
      }
    }, [isFromDifferentChannel, systemMessage, sourceRoomId, sharedChannelName]);
    
    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId;
      return (
        <span
          className="font-bold cursor-pointer hover:underline"
          style={usernameStyle}
          onClick={(e) => {
            if (userIdForClick && onUsernameClick) {
              onUsernameClick(
                userIdForClick,
                username,
                displayName || username,
                parsed.color,
                parsed.badges,
                e
              );
            }
          }}
          title="Click to view profile"
        >
          {displayName || username}
        </span>
      );
    };
    
    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge) return null;
      
      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => (
            <img 
              key={`donation-badge-${badge.key}-${idx}`} 
              src={badge.info.image_url_1x}
              srcSet={`${badge.info.image_url_1x} 1x, ${badge.info.image_url_2x} 2x, ${badge.info.image_url_4x} 4x`}
              alt={badge.info.title}
              title={badge.info.title}
              className="w-4 h-4 inline-block cursor-pointer hover:scale-110 transition-transform"
              onClick={() => onBadgeClick?.(badge.key, badge.info)}
              onError={(e) => {
                console.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
          {seventvBadge && (
            <img 
              src={getBadgeImageUrl(seventvBadge)}
              alt={seventvBadge.description || seventvBadge.name}
              title={seventvBadge.description || seventvBadge.name}
              className="w-4 h-4 inline-block"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
        </span>
      );
    };
    
    return (
      <div key={messageId} className="px-3 py-2 border-b border-borderSubtle donation-gradient">
        {/* Shared chat indicator */}
        {isFromDifferentChannel && (
          <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-borderSubtle">
            <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-xs text-accent font-semibold">From Shared Chat</span>
            {sharedChannelName && (
              <>
                <span className="text-xs text-textSecondary">-</span>
                <button
                  onClick={async () => {
                    try {
                      const { useAppStore } = await import('../stores/AppStore');
                      await useAppStore.getState().startStream(sharedChannelName);
                    } catch (err) {
                      console.error('[ChatMessage] Failed to switch to shared channel:', err);
                      const { useAppStore } = await import('../stores/AppStore');
                      useAppStore.getState().addToast(`Failed to switch to ${sharedChannelName}'s stream`, 'error');
                    }
                  }}
                  className="text-xs text-blue-400 font-semibold hover:underline cursor-pointer"
                  title={`Switch to ${sharedChannelName}'s stream`}
                >
                  {sharedChannelName}
                </button>
              </>
            )}
          </div>
        )}
        
        <div className="flex items-start gap-2.5">
          <div className="flex-shrink-0 mt-0.5">
            {/* Heart/Charity icon */}
            <svg className="w-5 h-5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm leading-relaxed">
              {renderBadges()}
              {renderClickableUsername(parsed.username, parsed.tags.get('display-name') || parsed.username)}
              <span className="text-green-400 font-bold"> donated {formattedAmount}</span>
              {charityName && <span className="text-textSecondary"> to support {charityName}</span>}
            </p>
            {parsed.content && (
              <p className="text-textSecondary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (isSubscription) {
    // Generate a unique key based on message ID to prevent animation restarts
    const messageId = parsed.tags.get('id') || `sub-${parsed.username}-${Date.now()}`;
    
    // Get subscription details
    const msgId = parsed.tags.get('msg-id');
    const msgParamRecipientDisplayName = parsed.tags.get('msg-param-recipient-display-name');
    const msgParamSubPlan = parsed.tags.get('msg-param-sub-plan');
    const msgParamSubPlanName = parsed.tags.get('msg-param-sub-plan-name')?.replace(/\\s/g, ' ');
    const msgParamMonths = parsed.tags.get('msg-param-cumulative-months') || parsed.tags.get('msg-param-months');
    const msgParamMassGiftCount = parsed.tags.get('msg-param-mass-gift-count');
    const msgParamSenderCount = parsed.tags.get('msg-param-sender-count');
    
    // Check if this is a shared chat notice (from another channel)
    const isSharedChat = msgId === 'sharedchatnotice';
    const sourceRoomId = parsed.tags.get('source-room-id');
    const currentRoomId = parsed.tags.get('room-id');
    const isFromDifferentChannel = isSharedChat && sourceRoomId && currentRoomId && sourceRoomId !== currentRoomId;
    
    // Extract channel name from system message (e.g., "Maasaw19 is gifting 5 Tier 1 Subs to Nadeshot's community!")
    // Initialize from cache if available
    const [sharedChannelName, setSharedChannelName] = useState<string | null>(() => {
      if (sourceRoomId && channelNameCache.has(sourceRoomId)) {
        return channelNameCache.get(sourceRoomId) || null;
      }
      return null;
    });
    
    useEffect(() => {
      if (isFromDifferentChannel && systemMessage && sourceRoomId) {
        // Check if we already have it in cache
        if (channelNameCache.has(sourceRoomId)) {
          const cachedName = channelNameCache.get(sourceRoomId);
          if (cachedName && cachedName !== sharedChannelName) {
            setSharedChannelName(cachedName);
          }
          return;
        }
        
        // Try to extract channel name from system message
        // Pattern: "to [ChannelName]'s community" or similar
        const channelMatch = systemMessage.match(/to\s+(\w+)'s\s+community/i);
        if (channelMatch && channelMatch[1]) {
          // Store in cache
          channelNameCache.set(sourceRoomId, channelMatch[1]);
          setSharedChannelName(channelMatch[1]);
        } else {
          // Fallback: fetch channel info from Twitch API using sourceRoomId
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke<any>('get_user_by_id', { userId: sourceRoomId })
              .then((user) => {
                if (user && user.login) {
                  // Store in cache
                  channelNameCache.set(sourceRoomId, user.login);
                  setSharedChannelName(user.login);
                }
              })
              .catch((err) => {
                console.warn('[ChatMessage] Failed to fetch source channel info:', err);
              });
          });
        }
      }
    }, [isFromDifferentChannel, systemMessage, sourceRoomId, sharedChannelName]);
    
    // Helper function to render username as clickable
    const renderClickableUsername = (username: string, displayName?: string) => {
      const userIdForClick = userId; // Use the userId from the message
      return (
        <span
          className="font-bold cursor-pointer hover:underline"
          style={usernameStyle}
          onClick={(e) => {
            if (userIdForClick && onUsernameClick) {
              onUsernameClick(
                userIdForClick,
                username,
                displayName || username,
                parsed.color,
                parsed.badges,
                e
              );
            }
          }}
          title="Click to view profile"
        >
          {displayName || username}
        </span>
      );
    };
    
    // Helper function to render badges
    const renderBadges = () => {
      if (parsed.badges.length === 0 && !seventvBadge) return null;
      
      return (
        <span className="inline-flex items-center gap-1 mr-1">
          {parsed.badges.map((badge, idx) => (
            <img 
              key={`sub-badge-${badge.key}-${idx}`} 
              src={badge.info.image_url_1x}
              srcSet={`${badge.info.image_url_1x} 1x, ${badge.info.image_url_2x} 2x, ${badge.info.image_url_4x} 4x`}
              alt={badge.info.title}
              title={badge.info.title}
              className="w-4 h-4 inline-block cursor-pointer hover:scale-110 transition-transform"
              onClick={() => onBadgeClick?.(badge.key, badge.info)}
              onError={(e) => {
                console.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                e.currentTarget.style.display = 'none';
              }}
            />
          ))}
          {seventvBadge && (
            <img 
              src={getBadgeImageUrl(seventvBadge)}
              alt={seventvBadge.description || seventvBadge.name}
              title={seventvBadge.description || seventvBadge.name}
              className="w-4 h-4 inline-block"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
        </span>
      );
    };
    
    // Helper function to parse system message and make usernames clickable
    const parseSystemMessageWithClickableNames = (message: string) => {
      if (!message) return null;
      
      // Pattern to match usernames in the system message
      // This will match the subscriber's name and recipient names
      const usernamePattern = /\b([A-Za-z0-9_]{3,25})\b/g;
      const parts: (string | JSX.Element)[] = [];
      let lastIndex = 0;
      let match;
      let keyIndex = 0;
      
      while ((match = usernamePattern.exec(message)) !== null) {
        const matchedName = match[1];
        
        // Add text before the match
        if (match.index > lastIndex) {
          parts.push(message.substring(lastIndex, match.index));
        }
        
        // Check if this is the subscriber's username or recipient's username
        const isSubscriber = matchedName.toLowerCase() === parsed.username.toLowerCase();
        const isRecipient = msgParamRecipientDisplayName && 
                           matchedName.toLowerCase() === msgParamRecipientDisplayName.toLowerCase();
        
        if (isSubscriber || isRecipient) {
          // Make it clickable with badges
          parts.push(
            <span
              key={`username-${keyIndex++}`}
              className="inline-flex items-center"
            >
              {renderBadges()}
              <span
                className="font-bold cursor-pointer hover:underline"
                style={usernameStyle}
                onClick={(e) => {
                  if (userId && onUsernameClick) {
                    onUsernameClick(
                      userId,
                      parsed.username,
                      parsed.tags.get('display-name') || parsed.username,
                      parsed.color,
                      parsed.badges,
                      e
                    );
                  }
                }}
                title="Click to view profile"
              >
                {matchedName}
              </span>
            </span>
          );
        } else {
          // Keep as plain text
          parts.push(matchedName);
        }
        
        lastIndex = match.index + matchedName.length;
      }
      
      // Add remaining text
      if (lastIndex < message.length) {
        parts.push(message.substring(lastIndex));
      }
      
      return parts.length > 0 ? parts : message;
    };
    
    // Build a more detailed message for different subscription types
    let displayMessage = systemMessage;
    
    if (!displayMessage) {
      // Fallback messages if system-msg is not available
      if (msgId === 'sub') {
        displayMessage = `${parsed.username} subscribed!`;
      } else if (msgId === 'resub') {
        displayMessage = `${parsed.username} subscribed for ${msgParamMonths} months!`;
      } else if (msgId === 'subgift') {
        displayMessage = `${parsed.username} gifted a subscription to ${msgParamRecipientDisplayName}!`;
      } else if (msgId === 'submysterygift') {
        displayMessage = `${parsed.username} is gifting ${msgParamMassGiftCount} subscriptions to the community!`;
      } else {
        displayMessage = `${parsed.username} subscribed!`;
      }
    }
    
    return (
      <div key={messageId} className="px-3 py-2 border-b border-borderSubtle subscription-gradient">
        {/* Shared chat indicator */}
        {isFromDifferentChannel && (
          <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-borderSubtle">
            <svg className="w-3.5 h-3.5 text-accent flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <span className="text-xs text-accent font-semibold">From Shared Chat</span>
            {sharedChannelName && (
              <>
                <span className="text-xs text-textSecondary">-</span>
                <button
                  onClick={async () => {
                    try {
                      const { useAppStore } = await import('../stores/AppStore');
                      
                      // Use the startStream method to switch to the shared channel
                      await useAppStore.getState().startStream(sharedChannelName);
                    } catch (err) {
                      console.error('[ChatMessage] Failed to switch to shared channel:', err);
                      const { useAppStore } = await import('../stores/AppStore');
                      useAppStore.getState().addToast(`Failed to switch to ${sharedChannelName}'s stream`, 'error');
                    }
                  }}
                  className="text-xs text-blue-400 font-semibold hover:underline cursor-pointer"
                  title={`Switch to ${sharedChannelName}'s stream`}
                >
                  {sharedChannelName}
                </button>
              </>
            )}
          </div>
        )}
        
        <div className="flex items-start gap-2.5">
          <div className="flex-shrink-0 mt-0.5">
            {/* Gift box icon */}
            <svg className="w-5 h-5 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M4 3a2 2 0 100 4h12a2 2 0 100-4H4z" />
              <path fillRule="evenodd" d="M3 8h14v7a2 2 0 01-2 2H5a2 2 0 01-2-2V8zm5 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-semibold text-sm leading-relaxed">
              {parseSystemMessageWithClickableNames(displayMessage)}
            </p>
            {parsed.content && (
              <p className="text-textSecondary text-sm mt-1 leading-relaxed">
                {renderContent(contentWithEmotes)}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Check if this is a shared chat message (from a different channel)
  const sourceRoomId = parsed.tags.get('source-room-id');
  const currentRoomId = parsed.tags.get('room-id');
  const isFromSharedChat = sourceRoomId && currentRoomId && sourceRoomId !== currentRoomId;
  
  // State to store the fetched channel name - initialize from cache if available
  const [fetchedChannelName, setFetchedChannelName] = useState<string | null>(() => {
    if (sourceRoomId && channelNameCache.has(sourceRoomId)) {
      return channelNameCache.get(sourceRoomId) || null;
    }
    return null;
  });
  
  // State to store the channel profile image
  const [channelProfileImage, setChannelProfileImage] = useState<string | null>(() => {
    if (sourceRoomId && channelProfileImageCache.has(sourceRoomId)) {
      return channelProfileImageCache.get(sourceRoomId) || null;
    }
    return null;
  });
  
  // Fetch source channel name and profile image if this is a shared chat message (only once per sourceRoomId)
  useEffect(() => {
    if (!isFromSharedChat || !sourceRoomId) return;
    
    // Check if we already have it in cache
    if (channelNameCache.has(sourceRoomId)) {
      const cachedName = channelNameCache.get(sourceRoomId);
      if (cachedName && cachedName !== fetchedChannelName) {
        setFetchedChannelName(cachedName);
      }
    }
    
    if (channelProfileImageCache.has(sourceRoomId)) {
      const cachedImage = channelProfileImageCache.get(sourceRoomId);
      if (cachedImage && cachedImage !== channelProfileImage) {
        setChannelProfileImage(cachedImage);
      }
      return;
    }
    
    // Fetch the channel name and profile image
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<any>('get_user_by_id', { userId: sourceRoomId })
        .then((user) => {
          if (user && user.login) {
            // Store name in cache
            channelNameCache.set(sourceRoomId, user.login);
            setFetchedChannelName(user.login);
            
            // Store profile image in cache
            if (user.profile_image_url) {
              channelProfileImageCache.set(sourceRoomId, user.profile_image_url);
              setChannelProfileImage(user.profile_image_url);
            }
          }
        })
        .catch((err) => {
          console.warn('[ChatMessage] Failed to fetch source channel info:', err);
        });
    });
  }, [isFromSharedChat, sourceRoomId, fetchedChannelName, channelProfileImage]);

  // Build dynamic styles based on chat design settings
  const messageStyle: React.CSSProperties = {
    paddingTop: `${(chatDesign?.message_spacing ?? 2) / 2}px`,
    paddingBottom: `${(chatDesign?.message_spacing ?? 2) / 2}px`,
  };

  // Determine animation class and border color
  let animationClass = '';
  let borderLeftColor = '';
  
  if (isMentioned && chatDesign?.mention_animation !== false) {
    animationClass = 'animate-mention-flash';
    borderLeftColor = chatDesign?.mention_color ?? '#ff4444';
  } else if (isReplyToMe && chatDesign?.mention_animation !== false) {
    animationClass = 'animate-reply-flash';
    borderLeftColor = chatDesign?.reply_color ?? '#ff6b6b';
  } else if (isHighlighted) {
    animationClass = 'animate-highlight-flash';
  }
  
  // Build background class based on dark mode and alternating backgrounds
  let backgroundClass = '';
  const isDarkMode = chatDesign?.dark_mode ?? false;
  
  if (chatDesign?.alternating_backgrounds) {
    // When alternating is enabled
    if (isDarkMode) {
      // Dark mode with alternating: black base, no background on alternating (shows default gray)
      backgroundClass = messageIndex % 2 === 1 ? '' : 'bg-black/80';
    } else {
      // Light mode: gray base, black alternating
      backgroundClass = messageIndex % 2 === 1 ? 'bg-black/80' : '';
    }
  } else {
    // When alternating is disabled, apply base color
    if (isDarkMode) {
      backgroundClass = 'bg-black/80';
    }
  }
  
  // Build border class based on settings
  const borderClass = chatDesign?.show_dividers !== false ? 'border-b border-borderSubtle' : '';

  return (
    <div 
      className={`px-3 hover:bg-glass transition-colors ${borderClass} ${
        animationClass
      } ${isFirstMessage ? 'bg-gradient-to-r from-purple-500/20 via-purple-400/10 to-transparent' : ''} ${
        isFromSharedChat ? 'border-l-2 border-l-accent/50 bg-accent/5' : ''
      } ${backgroundClass}`}
      style={{
        ...messageStyle,
        borderLeftColor: (isMentioned || isReplyToMe) && borderLeftColor ? borderLeftColor : undefined,
        borderLeftWidth: (isMentioned || isReplyToMe) ? '4px' : undefined,
      }}
    >
      
      {/* First message indicator */}
      {isFirstMessage && (
        <div className="mb-1.5 flex items-center justify-end gap-1.5">
          <span className="text-xs text-purple-400 font-normal">First message in chat</span>
        </div>
      )}
      {/* Reply indicator */}
      {parsed.replyInfo && (
        <div 
          className="mb-1.5 pl-2 border-l-2 border-textSecondary/40 cursor-pointer hover:border-textSecondary/60 transition-colors"
          onClick={() => onReplyClick?.(parsed.replyInfo!.parentMsgId)}
          title="Click to view parent message"
        >
          <div className="flex items-center gap-1.5 text-xs text-textSecondary">
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="font-semibold">{parsed.replyInfo.parentDisplayName}</span>
            <span className="truncate flex-1">{parsed.replyInfo.parentMsgBody}</span>
          </div>
        </div>
      )}
      
      <div className="flex items-start">
        {/* Badges and Message content in a single flex container */}
        <div className="flex flex-wrap items-start gap-2 flex-1 min-w-0">
          {/* Badges */}
          {(isFromSharedChat && channelProfileImage) || parsed.badges.length > 0 || seventvBadge ? (
            <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
              {/* Shared chat channel profile image badge */}
              {isFromSharedChat && channelProfileImage && (
                <img 
                  src={channelProfileImage}
                  alt={`${fetchedChannelName || 'Channel'} profile`}
                  title={`Chatting from ${fetchedChannelName || 'shared channel'}`}
                  className="w-4 h-4 cursor-pointer hover:scale-110 transition-transform object-cover"
                  onClick={async () => {
                    if (fetchedChannelName) {
                      try {
                        const { useAppStore } = await import('../stores/AppStore');
                        await useAppStore.getState().startStream(fetchedChannelName);
                      } catch (err) {
                        console.error('[ChatMessage] Failed to switch to shared channel:', err);
                      }
                    }
                  }}
                  onError={(e) => {
                    console.warn('[Badge] Failed to load channel profile image');
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
              {parsed.badges.map((badge, idx) => (
                <img 
                  key={`${badge.key}-${idx}`} 
                  src={badge.info.image_url_1x}
                  srcSet={`${badge.info.image_url_1x} 1x, ${badge.info.image_url_2x} 2x, ${badge.info.image_url_4x} 4x`}
                  alt={badge.info.title}
                  title={badge.info.title}
                  className="w-4 h-4 cursor-pointer hover:scale-110 transition-transform"
                  onClick={() => onBadgeClick?.(badge.key, badge.info)}
                  onError={(e) => {
                    // Hide broken badge images
                    console.warn('[Badge] Failed to load badge:', badge.key, badge.info.image_url_1x);
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ))}
              {seventvBadge && (
                <img 
                  src={getBadgeImageUrl(seventvBadge)}
                  alt={seventvBadge.description || seventvBadge.name}
                  title={seventvBadge.description || seventvBadge.name}
                  className="w-4 h-4"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              )}
            </div>
          ) : null}
          
          {/* Message content */}
          <div 
            className="flex-1 min-w-0 leading-tight"
            style={{
              fontSize: `${chatDesign?.font_size ?? 14}px`,
              fontWeight: chatDesign?.font_weight ?? 400,
            }}
          >
            <span 
              style={usernameStyle} 
              className="font-bold cursor-pointer hover:underline inline-flex items-center gap-1"
              onClick={(e) => {
                const userId = parsed.tags.get('user-id');
                const displayName = parsed.tags.get('display-name') || parsed.username;
                if (userId && onUsernameClick) {
                  onUsernameClick(
                    userId,
                    parsed.username,
                    displayName,
                    parsed.color,
                    parsed.badges,
                    e
                  );
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const messageId = parsed.tags.get('id');
                if (messageId && onUsernameRightClick) {
                  onUsernameRightClick(messageId, parsed.username);
                }
              }}
              title="Right-click to reply"
            >
              {parsed.username}
              {broadcasterType === 'partner' && (
                <svg 
                  className="w-3.5 h-3.5 inline-block flex-shrink-0" 
                  viewBox="0 0 16 16" 
                  fill="#9146FF"
                  style={{ verticalAlign: 'middle' }}
                >
                  <path fillRule="evenodd" d="M12.5 3.5 8 2 3.5 3.5 2 8l1.5 4.5L8 14l4.5-1.5L14 8l-1.5-4.5ZM7 11l4.5-4.5L10 5 7 8 5.5 6.5 4 8l3 3Z" clipRule="evenodd"></path>
                </svg>
              )}
            </span>
            <span className="text-textPrimary break-words">
              {' '}{renderContent(contentWithEmotes)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatMessage;
