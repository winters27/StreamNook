import { parseBadges } from './twitchBadges';

export interface BackendChatMessage {
  id: string;
  username: string;
  display_name: string;
  color?: string;
  user_id: string;
  timestamp: string;
  content: string;
  badges: Array<{ name: string; version: string }>;
  emotes: Array<{ id: string; start: number; end: number; url: string }>;
  layout: { height: number; width: number };
  tags: { [key: string]: string };
}

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

    // Parse badges using the badge service (using existing logic)
    const sourceBadgeStr = tags.get('source-badges');
    const badgeStr = sourceBadgeStr || tags.get('badges') || '';
    const sourceRoomId = tags.get('source-room-id');
    const effectiveChannelId = sourceRoomId || channelId;
    const badgeData = parseBadges(badgeStr, effectiveChannelId);

    // Parse reply info
    let replyInfo: ReplyInfo | undefined;
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

    let isAction = false;
    let content = raw.content;
    if (content.startsWith('\u0001ACTION ') && content.endsWith('\u0001')) {
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
