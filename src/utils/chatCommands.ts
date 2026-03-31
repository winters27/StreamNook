export interface CommandDefinition {
  name: string;
  description: string;
  category: 'Everyone' | 'Moderator' | 'Chat Flow' | 'Engagement' | 'Broadcaster';
  usage: string;
}

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  // Everyone
  { name: 'mods', usage: '/mods', description: 'Display a list of all chat moderators', category: 'Everyone' },
  { name: 'vips', usage: '/vips', description: 'Display a list of VIPs for this channel', category: 'Everyone' },
  { name: 'color', usage: '/color <colorname|hex>', description: 'Change the color of your username', category: 'Everyone' },
  { name: 'block', usage: '/block <username>', description: 'Block all messages from a specific user', category: 'Everyone' },
  { name: 'unblock', usage: '/unblock <username>', description: 'Remove user from block list', category: 'Everyone' },
  { name: 'disconnect', usage: '/disconnect', description: 'Disconnect from the chat server', category: 'Everyone' },
  { name: 'w', usage: '/w <username> <message>', description: 'Send a private whisper', category: 'Everyone' },
  { name: 'gift', usage: '/gift <quantity>', description: 'Gift Subs to the community', category: 'Everyone' },
  { name: 'vote', usage: '/vote', description: 'Vote in the active poll', category: 'Everyone' },
  
  // Moderator / Utility
  { name: 'ban', usage: '/ban <username> [reason]', description: 'Permanently ban a user', category: 'Moderator' },
  { name: 'timeout', usage: '/timeout <username> [seconds] [reason]', description: 'Temporarily ban a user', category: 'Moderator' },
  { name: 'unban', usage: '/unban <username>', description: 'Lift a permanent ban or timeout', category: 'Moderator' },
  { name: 'monitor', usage: '/monitor <username>', description: 'Start monitoring a user\'s messages', category: 'Moderator' },
  { name: 'unmonitor', usage: '/unmonitor <username>', description: 'Stop monitoring a user\'s messages', category: 'Moderator' },
  { name: 'restrict', usage: '/restrict <username>', description: 'Start restricting a user\'s messages', category: 'Moderator' },
  { name: 'unrestrict', usage: '/unrestrict <username>', description: 'Stop restricting a user\'s messages', category: 'Moderator' },
  { name: 'user', usage: '/user <username>', description: 'Open a user\'s profile card', category: 'Moderator' },
  
  // Chat Flow
  { name: 'clear', usage: '/clear', description: 'Wipe the chat history', category: 'Chat Flow' },
  { name: 'slow', usage: '/slow <seconds>', description: 'Set limit on how often users can send messages', category: 'Chat Flow' },
  { name: 'slowoff', usage: '/slowoff', description: 'Disable slow mode', category: 'Chat Flow' },
  { name: 'followers', usage: '/followers [duration]', description: 'Restrict chat to followers', category: 'Chat Flow' },
  { name: 'followersoff', usage: '/followersoff', description: 'Disable followers only mode', category: 'Chat Flow' },
  { name: 'subscribers', usage: '/subscribers', description: 'Restrict chat to subscribers', category: 'Chat Flow' },
  { name: 'subscribersoff', usage: '/subscribersoff', description: 'Disable subscribers only mode', category: 'Chat Flow' },
  { name: 'uniquechat', usage: '/uniquechat', description: 'Disallow non-unique messages (r9k)', category: 'Chat Flow' },
  { name: 'uniquechatoff', usage: '/uniquechatoff', description: 'Disable uniquechat mode', category: 'Chat Flow' },
  { name: 'emoteonly', usage: '/emoteonly', description: 'Set chat to emotes only', category: 'Chat Flow' },
  { name: 'emoteonlyoff', usage: '/emoteonlyoff', description: 'Disable emote only mode', category: 'Chat Flow' },
  
  // Engagement
  { name: 'announce', usage: '/announce <message>', description: 'Highlight a message for chat\'s attention', category: 'Engagement' },
  { name: 'shoutout', usage: '/shoutout <username>', description: 'Share another streamer\'s channel', category: 'Engagement' },
  { name: 'poll', usage: '/poll', description: 'Create a new poll', category: 'Engagement' },
  { name: 'endpoll', usage: '/endpoll', description: 'End the active poll', category: 'Engagement' },
  { name: 'deletepoll', usage: '/deletepoll', description: 'Delete the active poll', category: 'Engagement' },
  
  // Broadcaster
  { name: 'commercial', usage: '/commercial [seconds]', description: 'Run a commercial for all viewers (30-180s)', category: 'Broadcaster' },
  { name: 'goal', usage: '/goal', description: 'Manage a sub or follower goal', category: 'Broadcaster' },
  { name: 'prediction', usage: '/prediction', description: 'Manage predictions', category: 'Broadcaster' },
  { name: 'raid', usage: '/raid <channel>', description: 'Send viewers to another live channel', category: 'Broadcaster' },
  { name: 'unraid', usage: '/unraid', description: 'Cancel the active raid', category: 'Broadcaster' },
  { name: 'marker', usage: '/marker [description]', description: 'Add a stream marker', category: 'Broadcaster' }
];
