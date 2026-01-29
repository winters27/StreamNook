import { parseBadges } from './twitchBadges';

// Message segment types - matches Rust MessageSegment enum
export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'emote'; content: string; emote_id?: string; emote_url: string; is_zero_width?: boolean }
  | { type: 'emoji'; content: string; emoji_url: string }
  | { type: 'link'; content: string; url: string }
  // Cheermote segment for animated bits (e.g., Cheer500)
  | { type: 'cheermote'; content: string; prefix: string; bits: number; tier: string; color: string; cheermote_url: string };

// Reply information parsed from IRC tags - matches Rust ReplyInfo
export interface BackendReplyInfo {
  parent_msg_id: string;
  parent_display_name: string;
  parent_msg_body: string;
  parent_user_id: string;
  parent_user_login: string;
}

// Pre-computed message metadata - THE ENDGAME
// All these fields are computed in Rust to eliminate frontend processing
export interface MessageMetadata {
  /** Whether this is an ACTION message (/me command) */
  is_action: boolean;
  /** Whether this message mentions the current user (set by frontend context) */
  is_mentioned: boolean;
  /** Whether this is the user's first message in the channel */
  is_first_message: boolean;
  /** Pre-formatted timestamp string (e.g., "3:45 PM") */
  formatted_timestamp?: string;
  /** Pre-formatted timestamp with seconds (e.g., "3:45:30 PM") */
  formatted_timestamp_with_seconds?: string;
  /** Reply information if this is a reply message */
  reply_info?: BackendReplyInfo;
  /** Source room ID for shared chat messages */
  source_room_id?: string;
  /** Whether this message is from shared chat (different from current room) */
  is_from_shared_chat: boolean;
  /** Message type for special messages (sub, resub, subgift, etc.) */
  msg_type?: string;
  /** Bits amount if this is a cheer message */
  bits_amount?: number;
  /** System message for subscriptions/donations */
  system_message?: string;
}

export interface BackendChatMessage {
  id: string;
  username: string;
  display_name: string;
  color?: string;
  user_id: string;
  timestamp: string;
  content: string;
  badges: Array<{
    name: string;
    version: string;
    image_url_1x?: string;
    image_url_2x?: string;
    image_url_4x?: string;
    title?: string;
    description?: string;
  }>;
  emotes: Array<{ id: string; start: number; end: number; url: string }>;
  layout: { height: number; width: number; has_reply?: boolean; is_first_message?: boolean };
  tags: { [key: string]: string };
  // Pre-parsed segments from Rust (Phase 3.1 - The Endgame)
  segments?: MessageSegment[];
  // Pre-computed metadata - THE ENDGAME
  // All message analysis done in Rust, frontend just renders
  metadata?: MessageMetadata;
}

// Frontend-facing reply info (camelCase for consistency)
export interface ReplyInfo {
  parentMsgId: string;
  parentDisplayName: string;
  parentMsgBody: string;
  parentUserId: string;
  parentUserLogin: string;
}

export const parseMessage = (raw: string | BackendChatMessage, channelId?: string) => {
  // Check if it's a backend message object
  if (typeof raw !== 'string') {
    const tags = new Map<string, string>(Object.entries(raw.tags));

    // Reconstruct badge string from the array
    const badgeStr = raw.badges.map(b => `${b.name}/${b.version}`).join(',');
    
    // Use parseBadges to enrich with metadata from cache
    const sourceRoomId = raw.metadata?.source_room_id || tags.get('source-room-id');
    const effectiveChannelId = sourceRoomId || channelId;
    const badgeData = parseBadges(badgeStr, effectiveChannelId);

    // PHASE 3.1 - THE ENDGAME: Use pre-computed reply info from Rust
    let replyInfo: ReplyInfo | undefined;
    if (raw.metadata?.reply_info) {
      // Convert from Rust snake_case to frontend camelCase
      const ri = raw.metadata.reply_info;
      replyInfo = {
        parentMsgId: ri.parent_msg_id,
        parentDisplayName: ri.parent_display_name,
        parentMsgBody: ri.parent_msg_body,
        parentUserId: ri.parent_user_id,
        parentUserLogin: ri.parent_user_login,
      };
    } else {
      // Fallback: parse from tags (legacy support)
      const replyParentMsgId = tags.get('reply-parent-msg-id');
      if (replyParentMsgId) {
        replyInfo = {
          parentMsgId: replyParentMsgId,
          parentDisplayName: tags.get('reply-parent-display-name') || '',
          parentMsgBody: tags.get('reply-parent-msg-body')?.replace(/\\s/g, ' ') || '',
          parentUserId: tags.get('reply-parent-user-id') || '',
          parentUserLogin: tags.get('reply-parent-user-login') || '',
        };
      }
    }

    // PHASE 3.1 - Use pre-computed is_action from Rust metadata
    let isAction = raw.metadata?.is_action ?? false;
    let content = raw.content;
    
    // Fallback check if metadata not available
    if (!raw.metadata && content.startsWith('\u0001ACTION ') && content.endsWith('\u0001')) {
      isAction = true;
      content = content.slice(8, -1);
    }

    // Remove redundant @mention from reply messages
    // The UI already shows reply context, so the leading @username is redundant
    if (replyInfo && replyInfo.parentUserLogin) {
      const mentionPattern = new RegExp(`^@${replyInfo.parentUserLogin}\\s*`, 'i');
      content = content.replace(mentionPattern, '').trim();
    }

    return {
      tags,
      username: raw.username,
      content,
      color: raw.color || tags.get('color') || '#9147FF',
      badges: badgeData,
      emotes: tags.get('emotes') || '',
      replyInfo,
      isAction,
      layout: raw.layout, // Pass layout through
      segments: raw.segments, // Pass pre-parsed segments through (Phase 3.1)
      // Pass pre-computed metadata through (Phase 3.1 - THE ENDGAME)
      metadata: raw.metadata,
    };
  }

  // Legacy string parsing logic
  // Parse IRC tags, username, content, etc.
  const tags = new Map<string, string>();
  let message = raw;

  // Parse tags if present
  if (raw.startsWith('@')) {
    const tagEnd = raw.indexOf(' ');
    const tagStr = raw.slice(1, tagEnd);
    tagStr.split(';').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) {
        tags.set(key, value);
      }
    });
    message = raw.slice(tagEnd + 1).trim();
  }

  // Check if this is a USERNOTICE (subscription, etc.)
  const isUserNotice = message.includes('USERNOTICE');

  // Parse IRC message format: :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
  // Extract username from prefix or tags
  let username = tags.get('display-name') || tags.get('login') || 'unknown';
  if (message.startsWith(':')) {
    const prefixEnd = message.indexOf(' ');
    const prefix = message.slice(1, prefixEnd);
    const userMatch = prefix.match(/^([^!]+)!/);
    if (userMatch && username === 'unknown') {
      username = userMatch[1];
    }
    message = message.slice(prefixEnd + 1);
  }

  // Extract the actual message content
  let content = '';
  let isAction = false;
  if (isUserNotice) {
    // For USERNOTICE, content comes after USERNOTICE #channel :
    const contentMatch = message.match(/USERNOTICE\s+#\S+\s+:(.+)$/);
    content = contentMatch ? contentMatch[1] : '';
  } else {
    // For PRIVMSG, content comes after PRIVMSG #channel :
    const contentMatch = message.match(/PRIVMSG\s+#\S+\s+:(.+)$/);
    content = contentMatch ? contentMatch[1] : '';

    // Check if this is an ACTION message (like /me command)
    if (content.startsWith('\u0001ACTION ') && content.endsWith('\u0001')) {
      isAction = true;
      // Strip the ACTION wrapper
      content = content.slice(8, -1);
    }
  }

  // Parse badges using the badge service
  // For shared chat messages, prefer source-badges over badges
  const sourceBadgeStr = tags.get('source-badges');
  const badgeStr = sourceBadgeStr || tags.get('badges') || '';

  // For shared chat, use source-room-id for badge lookup
  const sourceRoomId = tags.get('source-room-id');
  const effectiveChannelId = sourceRoomId || channelId;

  const badgeData = parseBadges(badgeStr, effectiveChannelId);

  // Parse reply information if present
  let replyInfo: ReplyInfo | undefined;
  const replyParentMsgId = tags.get('reply-parent-msg-id');
  if (replyParentMsgId) {
    const parentDisplayName = tags.get('reply-parent-display-name') || '';
    const parentMsgBody = tags.get('reply-parent-msg-body')?.replace(/\\s/g, ' ') || '';
    const parentUserId = tags.get('reply-parent-user-id') || '';
    const parentUserLogin = tags.get('reply-parent-user-login') || '';

    replyInfo = {
      parentMsgId: replyParentMsgId,
      parentDisplayName,
      parentMsgBody,
      parentUserId,
      parentUserLogin,
    };

    // Remove redundant @mention from reply messages
    // The UI already shows reply context, so the leading @username is redundant
    if (parentUserLogin) {
      const mentionPattern = new RegExp(`^@${parentUserLogin}\\s*`, 'i');
      content = content.replace(mentionPattern, '').trim();
    }
  }

  return {
    tags,
    username,
    content,
    color: tags.get('color') || '#9147FF', // Twitch purple as default
    badges: badgeData,
    emotes: tags.get('emotes') || '',
    replyInfo,
    isAction,
  };
};
