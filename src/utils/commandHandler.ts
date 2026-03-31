import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/AppStore';
import { Logger } from './logger';

interface UserLookupResult {
  id: string;
  login: string;
  display_name: string;
}

/**
 * Look up a Twitch user by login name.
 * The Rust command `get_user_by_login` takes a single login string and returns a single UserInfo.
 */
async function lookupUser(username: string): Promise<UserLookupResult | null> {
  try {
    return await invoke<UserLookupResult>('get_user_by_login', { login: username });
  } catch {
    return null;
  }
}

export const handleSlashCommand = async (
  message: string, 
  broadcasterId: string, 
  broadcasterLogin: string,
  _sendMessageToChat: (msg: string) => void
): Promise<boolean> => {
  if (!message.startsWith('/')) return false;

  const args = message.slice(1).trim().split(/\s+/);
  const command = args[0].toLowerCase();
  const argsWithoutCommand = args.slice(1);

  const addToast = useAppStore.getState().addToast;

  try {
    switch (command) {
      // ────────────────────────────────────────────────────────
      // Moderator / Broadcaster commands (handled via Helix API)
      // ────────────────────────────────────────────────────────
      case 'ban': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0];
          const reason = argsWithoutCommand.slice(1).join(' ');
          const user = await lookupUser(username);
          if (user) {
            await invoke('ban_user', { broadcasterId, targetUserId: user.id, duration: null, reason: reason || null });
            addToast(`Banned ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'timeout': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0];
          const duration = argsWithoutCommand.length > 1 ? parseInt(argsWithoutCommand[1], 10) : 600;
          const reason = argsWithoutCommand.slice(2).join(' ');
          const user = await lookupUser(username);
          if (user) {
            const safeDuration = isNaN(duration) ? 600 : duration;
            await invoke('ban_user', { broadcasterId, targetUserId: user.id, duration: safeDuration, reason: reason || null });
            addToast(`Timed out ${username} for ${safeDuration}s`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'unban':
      case 'untimeout': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0];
          const user = await lookupUser(username);
          if (user) {
            await invoke('unban_user', { broadcasterId, targetUserId: user.id });
            addToast(`Unbanned ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'clear': {
        await invoke('clear_chat', { broadcasterId });
        addToast('Chat cleared', 'success');
        return true;
      }
      case 'slow': {
        const slowSeconds = argsWithoutCommand.length > 0 ? parseInt(argsWithoutCommand[0]) : 30;
        const safeSlowSeconds = isNaN(slowSeconds) ? 30 : slowSeconds;
        await invoke('update_chat_settings', { broadcasterId, settings: { slow_mode: true, slow_mode_wait_time: safeSlowSeconds } });
        addToast(`Slow mode enabled (${safeSlowSeconds}s)`, 'success');
        return true;
      }
      case 'slowoff': {
        await invoke('update_chat_settings', { broadcasterId, settings: { slow_mode: false } });
        addToast('Slow mode disabled', 'success');
        return true;
      }
      case 'followers': {
        const durationStr = argsWithoutCommand[0] || '0';
        let followersMinutes = 0;
        if (durationStr.endsWith('mo')) followersMinutes = parseInt(durationStr) * 60 * 24 * 30;
        else if (durationStr.endsWith('m')) followersMinutes = parseInt(durationStr);
        else if (durationStr.endsWith('h')) followersMinutes = parseInt(durationStr) * 60;
        else if (durationStr.endsWith('d')) followersMinutes = parseInt(durationStr) * 60 * 24;
        else if (durationStr.endsWith('w')) followersMinutes = parseInt(durationStr) * 60 * 24 * 7;
        else followersMinutes = parseInt(durationStr) || 0;
        
        await invoke('update_chat_settings', { broadcasterId, settings: { follower_mode: true, follower_mode_duration: followersMinutes } });
        addToast('Followers-only mode enabled', 'success');
        return true;
      }
      case 'followersoff': {
        await invoke('update_chat_settings', { broadcasterId, settings: { follower_mode: false } });
        addToast('Followers-only mode disabled', 'success');
        return true;
      }
      case 'subscribers': {
        await invoke('update_chat_settings', { broadcasterId, settings: { subscriber_mode: true } });
        addToast('Subscribers-only mode enabled', 'success');
        return true;
      }
      case 'subscribersoff': {
        await invoke('update_chat_settings', { broadcasterId, settings: { subscriber_mode: false } });
        addToast('Subscribers-only mode disabled', 'success');
        return true;
      }
      case 'uniquechat': {
        await invoke('update_chat_settings', { broadcasterId, settings: { unique_chat_mode: true } });
        addToast('Unique chat mode enabled', 'success');
        return true;
      }
      case 'uniquechatoff': {
        await invoke('update_chat_settings', { broadcasterId, settings: { unique_chat_mode: false } });
        addToast('Unique chat mode disabled', 'success');
        return true;
      }
      case 'emoteonly': {
        await invoke('update_chat_settings', { broadcasterId, settings: { emote_mode: true } });
        addToast('Emote-only mode enabled', 'success');
        return true;
      }
      case 'emoteonlyoff': {
        await invoke('update_chat_settings', { broadcasterId, settings: { emote_mode: false } });
        addToast('Emote-only mode disabled', 'success');
        return true;
      }
      case 'announce':
      case 'announceblue':
      case 'announcegreen':
      case 'announceorange':
      case 'announcepurple': {
        if (argsWithoutCommand.length > 0) {
          const colorMap: Record<string, string> = {
            announce: 'primary',
            announceblue: 'blue',
            announcegreen: 'green',
            announceorange: 'orange',
            announcepurple: 'purple',
          };
          await invoke('send_chat_announcement', { broadcasterId, message: argsWithoutCommand.join(' '), color: colorMap[command] });
          return true;
        }
        break;
      }
      case 'shoutout': {
        if (argsWithoutCommand.length > 0) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('send_shoutout', { broadcasterId, targetUserId: user.id });
            addToast(`Shoutout given to ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'commercial': {
        const length = argsWithoutCommand.length > 0 ? parseInt(argsWithoutCommand[0]) : 30;
        const safeLength = isNaN(length) ? 30 : length;
        await invoke('start_commercial', { broadcasterId, length: safeLength });
        addToast(`Started ${safeLength}s commercial`, 'success');
        return true;
      }
      case 'mod': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('add_channel_moderator', { broadcasterId, targetUserId: user.id });
            addToast(`${username} is now a moderator`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'unmod': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('remove_channel_moderator', { broadcasterId, targetUserId: user.id });
            addToast(`${username} is no longer a moderator`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'vip': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('add_channel_vip', { broadcasterId, targetUserId: user.id });
            addToast(`${username} is now a VIP`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'unvip': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('remove_channel_vip', { broadcasterId, targetUserId: user.id });
            addToast(`${username} is no longer a VIP`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'raid': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('start_raid', { broadcasterId, targetUserId: user.id });
            addToast(`Raiding ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'unraid': {
        await invoke('cancel_raid', { broadcasterId });
        addToast('Raid cancelled', 'success');
        return true;
      }
      case 'marker': {
        const description = argsWithoutCommand.length > 0 ? argsWithoutCommand.join(' ') : undefined;
        await invoke('create_stream_marker', { userId: broadcasterId, description: description || null });
        addToast('Stream marker created', 'success');
        return true;
      }

      // ────────────────────────────────────────────────────────
      // Everyone commands (handled via Helix API where we have endpoints)
      // ────────────────────────────────────────────────────────
      case 'color': {
        if (argsWithoutCommand.length >= 1) {
          const currentUser = useAppStore.getState().currentUser;
          if (!currentUser?.user_id) {
            addToast('You must be logged in to change your color', 'error');
            return true;
          }
          const colorValue = argsWithoutCommand[0];
          try {
            await invoke('update_user_chat_color', { targetUserId: currentUser.user_id, color: colorValue });
            addToast(`Chat color changed to ${colorValue}`, 'success');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            addToast(`Failed to change color: ${errMsg}`, 'error');
          }
          return true;
        }
        // No color provided — show usage instead of passthrough
        addToast('Usage: /color <color name or hex>', 'info');
        return true;
      }
      case 'block': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('block_user', { targetUserId: user.id });
            addToast(`Blocked ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'unblock': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('unblock_user', { targetUserId: user.id });
            addToast(`Unblocked ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        break;
      }
      case 'w': {
        // /w username message — send whisper
        if (argsWithoutCommand.length >= 2) {
          const username = argsWithoutCommand[0].replace('@', '');
          const whisperMessage = argsWithoutCommand.slice(1).join(' ');
          const user = await lookupUser(username);
          if (user) {
            await invoke('send_whisper', { toUserId: user.id, message: whisperMessage });
            addToast(`Whisper sent to ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        if (argsWithoutCommand.length === 1) {
          addToast('Usage: /w <username> <message>', 'info');
          return true;
        }
        break;
      }
      case 'disconnect': {
        // Disconnect from chat
        try {
          await invoke('stop_chat');
          addToast('Disconnected from chat', 'info');
        } catch (err: unknown) {
          Logger.error('[Command Handler] Disconnect failed:', err);
        }
        return true;
      }

      // ────────────────────────────────────────────────────────
      // IRC passthrough — commands handled natively by Twitch IRC
      // ────────────────────────────────────────────────────────
      case 'mods':
      case 'vips': {
        // Use GQL ChatViewers query — works for ANY authenticated user
        // (Helix Get Moderators requires broadcaster_id == access token user_id)
        const chatters = await invoke<{ moderators?: { login: string }[]; vips?: { login: string }[] }>(
          'get_chatters_by_role', { channelLogin: broadcasterLogin }
        );
        if (command === 'mods') {
          const mods = (chatters.moderators || []).map(m => m.login).filter(Boolean);
          const modMsg = mods.length > 0
            ? `The moderators of this channel are: ${mods.join(', ')}`
            : 'There are no moderators of this channel.';
          window.dispatchEvent(new CustomEvent('twitch-system-message', { detail: { message: modMsg } }));
        } else {
          const vips = (chatters.vips || []).map(v => v.login).filter(Boolean);
          const vipMsg = vips.length > 0
            ? `The VIPs of this channel are: ${vips.join(', ')}`
            : 'There are no VIPs of this channel.';
          window.dispatchEvent(new CustomEvent('twitch-system-message', { detail: { message: vipMsg } }));
        }
        return true;
      }
      // ────────────────────────────────────────────────────────
      // Suspicious User Management (Mod/Broadcaster)
      // ────────────────────────────────────────────────────────
      case 'monitor': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('update_suspicious_user_status', { broadcasterId, targetUserId: user.id, status: 'ACTIVE_MONITORING' });
            addToast(`Now monitoring ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /monitor <username>', 'info');
        return true;
      }
      case 'unmonitor': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('update_suspicious_user_status', { broadcasterId, targetUserId: user.id, status: 'NO_TREATMENT' });
            addToast(`Stopped monitoring ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /unmonitor <username>', 'info');
        return true;
      }
      case 'restrict': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('update_suspicious_user_status', { broadcasterId, targetUserId: user.id, status: 'RESTRICTED' });
            addToast(`Restricted ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /restrict <username>', 'info');
        return true;
      }
      case 'unrestrict': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            await invoke('update_suspicious_user_status', { broadcasterId, targetUserId: user.id, status: 'NO_TREATMENT' });
            addToast(`Unrestricted ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /unrestrict <username>', 'info');
        return true;
      }

      // ────────────────────────────────────────────────────────
      // Warn (Mod/Broadcaster) — uses Helix warn endpoint
      // ────────────────────────────────────────────────────────
      case 'warn': {
        if (argsWithoutCommand.length >= 2) {
          const username = argsWithoutCommand[0].replace('@', '');
          const reason = argsWithoutCommand.slice(1).join(' ');
          const user = await lookupUser(username);
          if (user) {
            await invoke('warn_chat_user', { broadcasterId, targetUserId: user.id, reason });
            addToast(`Warning sent to ${username}`, 'success');
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /warn <username> <reason>', 'info');
        return true;
      }

      // ────────────────────────────────────────────────────────
      // Shield Mode (Mod/Broadcaster)
      // ────────────────────────────────────────────────────────
      case 'shield': {
        await invoke('update_shield_mode', { broadcasterId, isActive: true });
        addToast('Shield mode activated', 'success');
        return true;
      }
      case 'shieldoff': {
        await invoke('update_shield_mode', { broadcasterId, isActive: false });
        addToast('Shield mode deactivated', 'success');
        return true;
      }

      // ────────────────────────────────────────────────────────
      // IRC passthrough — /me still works via IRC natively
      // ────────────────────────────────────────────────────────
      case 'me':
        return false; // Let IRC handle it

      // ────────────────────────────────────────────────────────
      // Commands that show usage info or are client-side only
      // ────────────────────────────────────────────────────────
      case 'help': {
        const helpCmd = argsWithoutCommand[0] || '';
        window.dispatchEvent(new CustomEvent('twitch-system-message', {
          detail: { message: helpCmd
            ? `For help with /${helpCmd}, visit: https://help.twitch.tv/s/article/chat-commands`
            : 'Available commands: /mods, /vips, /color, /block, /unblock, /me, /w, /announce, and more. Use /help <command> for details.'
          }
        }));
        return true;
      }
      case 'user': {
        if (argsWithoutCommand.length >= 1) {
          const username = argsWithoutCommand[0].replace('@', '');
          const user = await lookupUser(username);
          if (user) {
            window.dispatchEvent(new CustomEvent('twitch-system-message', {
              detail: { message: `User: ${user.display_name} (${user.login}) — ID: ${user.id}` }
            }));
          } else {
            addToast(`User ${username} not found`, 'error');
          }
          return true;
        }
        addToast('Usage: /user <username>', 'info');
        return true;
      }
      case 'vote':
      case 'gift':
      case 'poll':
      case 'endpoll':
      case 'deletepoll':
      case 'prediction':
      case 'goal':
      case 'raidbrowser':
      case 'requests':
      case 'pin':
      case 'sharedchat':
        // These are handled natively by the Twitch web client and cannot be replicated.
        // Let them fall through to IRC as a best-effort attempt.
        return false;
      default:
        return false;
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    Logger.error(`[Command Handler] Failed to execute /${command}:`, err);
    addToast(`Command failed: ${errMsg}`, 'error');
    return true; // We handled it (it failed, but we shouldn't send it to chat directly)
  }
  
  return false;
};
