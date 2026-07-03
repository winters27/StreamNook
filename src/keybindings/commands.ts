// The bindable-command registry: the single source of truth for every
// keyboard-driven action. Consumed by the dispatcher, the command palette
// (shortcut hints), and the Keybindings settings tab.

import { useAppStore } from '../stores/AppStore';
import { getPlayerControls, isPlayerControllable } from './playerControls';
import { getChatModController } from './chatModController';
import type { BindableCommand } from './types';

const app = () => useAppStore.getState();

/** A live stream or VOD is playing (clips use native controls, excluded). */
const watching = (): boolean => {
  const s = app();
  return !!s.currentStream && (s.currentMediaType === 'live' || s.currentMediaType === 'video');
};

const pc = () => getPlayerControls();
const mod = () => getChatModController();
/** Current user can moderate the watched channel. */
const canModerate = (): boolean => !!mod()?.isModerator();
/** A chat message is focused and the user can moderate (gates action keys). */
const modFocused = (): boolean => {
  const c = mod();
  return !!c && c.isModerator() && c.hasFocus();
};

/** Switch to the next/previous live followed channel relative to the one being
 *  watched (wraps around). Starts the first/last when nothing is playing. */
const startRelativeFollow = (dir: 1 | -1): void => {
  const s = app();
  const list = s.followedStreams;
  if (!list || list.length === 0) {
    s.addToast('No live followed channels right now', 'warning');
    return;
  }
  const cur = s.currentStream;
  const curIdx = cur
    ? list.findIndex(
        (f) =>
          (!!cur.user_id && f.user_id === cur.user_id) ||
          (!!cur.user_login && f.user_login?.toLowerCase() === cur.user_login.toLowerCase()),
      )
    : -1;
  const nextIdx =
    curIdx === -1 ? (dir === 1 ? 0 : list.length - 1) : (curIdx + dir + list.length) % list.length;
  const target = list[nextIdx];
  if (target) void s.startStream(target.user_login, target);
};

let cache: BindableCommand[] | null = null;

// ---------------- Plugin-registered commands ----------------
// UI plugins (src/plugins-ui/) contribute bindable commands at load and lose
// them at unload. They dispatch, list in the Keybindings settings, and accept
// user rebinds exactly like built-ins; overrides persist under the command id,
// so a plugin reusing a historical id keeps existing user rebinds working.

const pluginCommands: { pluginId: string; command: BindableCommand }[] = [];

export function registerPluginCommand(pluginId: string, command: BindableCommand): void {
  if (getBindableCommands().some((c) => c.id === command.id)) {
    unregisterPluginCommand(pluginId, command.id);
    if (getBindableCommands().some((c) => c.id === command.id)) return; // built-in owns the id
  }
  pluginCommands.push({ pluginId, command });
}

function unregisterPluginCommand(pluginId: string, commandId: string): void {
  for (let i = pluginCommands.length - 1; i >= 0; i--) {
    if (pluginCommands[i].pluginId === pluginId && pluginCommands[i].command.id === commandId) {
      pluginCommands.splice(i, 1);
    }
  }
}

export function unregisterPluginCommands(pluginId: string): void {
  for (let i = pluginCommands.length - 1; i >= 0; i--) {
    if (pluginCommands[i].pluginId === pluginId) pluginCommands.splice(i, 1);
  }
}

/** All bindable commands. Built-ins are cached (their definitions are static;
 *  handlers read live state at call time); plugin commands are appended live. */
export function getBindableCommands(): BindableCommand[] {
  if (!cache) cache = build();
  return pluginCommands.length === 0
    ? cache
    : [...cache, ...pluginCommands.map((p) => p.command)];
}

export function getBindableCommand(id: string): BindableCommand | undefined {
  return getBindableCommands().find((c) => c.id === id);
}

function build(): BindableCommand[] {
  return [
    // ---------------- Application ----------------
    {
      id: 'app.commandPalette',
      label: 'Open command palette',
      description: 'Search streamers, settings, snippets, and actions.',
      category: 'Application',
      context: 'global',
      defaultBindings: ['Ctrl+K'],
      keywords: 'command palette search quick switcher',
      reserved: true, // owned by useCommandPaletteHotkey
    },
    {
      id: 'qa.openSettings',
      label: 'Open settings',
      category: 'Application',
      context: 'global',
      defaultBindings: ['Ctrl+,'],
      keywords: 'settings preferences options',
      run: () => app().openSettings(),
    },
    {
      id: 'app.keybindings',
      label: 'Show keyboard shortcuts',
      description: 'Open this Keybindings settings page.',
      category: 'Application',
      context: 'global',
      defaultBindings: ['Shift+/'],
      keywords: 'help shortcuts hotkeys keybindings question mark cheat sheet',
      run: () => app().openSettings('Keybindings'),
    },

    // ---------------- Navigation ----------------
    {
      id: 'qa.goHome',
      label: 'Go to Home',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Alt+Home'],
      keywords: 'home following recommended browse',
      run: () => {
        const s = app();
        if (!s.isHomeActive) s.toggleHome();
      },
    },
    {
      id: 'qa.openDrops',
      label: 'Open Drops center',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Ctrl+Shift+D'],
      keywords: 'drops campaigns rewards automation',
      run: () => app().setShowDropsOverlay(true),
    },
    {
      id: 'qa.openBadges',
      label: 'Open Badges & Paints',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Ctrl+Shift+B'],
      keywords: 'badges paints cosmetics catalog',
      run: () => app().setShowBadgesOverlay(true),
    },
    {
      id: 'qa.openWhispers',
      label: 'Open Whispers',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Ctrl+Shift+W'],
      keywords: 'whispers dms direct messages inbox',
      run: () => app().setShowWhispersOverlay(true),
    },
    {
      id: 'qa.refreshFollows',
      label: 'Refresh followed streams',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Ctrl+Alt+R'],
      keywords: 'refresh reload follows following list',
      run: () => app().loadFollowedStreams(),
    },
    {
      id: 'nav.nextStream',
      label: 'Next followed stream',
      description: 'Switch to the next live channel you follow.',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Alt+N'],
      keywords: 'next followed channel switch surf cycle',
      isAvailable: () => (app().followedStreams?.length ?? 0) > 0,
      run: () => startRelativeFollow(1),
    },
    {
      id: 'nav.prevStream',
      label: 'Previous followed stream',
      description: 'Switch to the previous live channel you follow.',
      category: 'Navigation',
      context: 'global',
      defaultBindings: ['Alt+P'],
      keywords: 'previous prev followed channel switch surf cycle',
      isAvailable: () => (app().followedStreams?.length ?? 0) > 0,
      run: () => startRelativeFollow(-1),
    },

    // ---------------- Player ----------------
    {
      id: 'player.playPause',
      label: 'Play / pause',
      category: 'Player',
      context: 'player',
      defaultBindings: ['Space', 'K'],
      keywords: 'play pause resume',
      isAvailable: isPlayerControllable,
      run: () => pc()?.togglePlay(),
    },
    {
      id: 'player.mute',
      label: 'Mute / unmute',
      category: 'Player',
      context: 'player',
      defaultBindings: ['M'],
      keywords: 'mute unmute audio sound',
      isAvailable: isPlayerControllable,
      run: () => pc()?.toggleMute(),
    },
    {
      id: 'player.fullscreen',
      label: 'Toggle fullscreen',
      category: 'Player',
      context: 'player',
      defaultBindings: ['F'],
      keywords: 'fullscreen full screen',
      isAvailable: isPlayerControllable,
      run: () => pc()?.toggleFullscreen(),
    },
    {
      id: 'cs.toggleTheatre',
      label: 'Toggle theatre mode',
      description: 'Hide the sidebar and chat for a full-window video.',
      category: 'Player',
      context: 'player',
      defaultBindings: ['T'],
      keywords: 'theatre theater immersive hide chat sidebar',
      isAvailable: watching,
      run: () => app().toggleTheaterMode(),
    },
    {
      id: 'cs.createClip',
      label: 'Create clip',
      description: 'Clip ~30 seconds of what you are watching (live, or a VOD at the current spot).',
      category: 'Player',
      context: 'player',
      defaultBindings: ['Alt+X'],
      keywords: 'clip create capture moment highlight save vod',
      isAvailable: () => {
        const s = app();
        if (s.currentMediaType === 'live') return true;
        // A VOD loaded directly, or auto-loaded into the offline-chat space.
        return !!s.originalMediaUrl && /\/videos\/\d+/.test(s.originalMediaUrl);
      },
      run: () => app().createClip(),
    },
    {
      id: 'player.volumeUp',
      label: 'Volume up',
      category: 'Player',
      context: 'player',
      defaultBindings: ['↑'],
      keywords: 'volume up louder increase',
      isAvailable: isPlayerControllable,
      repeatable: true,
      run: () => pc()?.volumeUp(),
    },
    {
      id: 'player.volumeDown',
      label: 'Volume down',
      category: 'Player',
      context: 'player',
      defaultBindings: ['↓'],
      keywords: 'volume down quieter decrease',
      isAvailable: isPlayerControllable,
      repeatable: true,
      run: () => pc()?.volumeDown(),
    },
    {
      id: 'player.seekForward',
      label: 'Seek forward 10s',
      category: 'Player',
      context: 'player',
      defaultBindings: ['→'],
      keywords: 'seek forward skip ahead fast',
      isAvailable: isPlayerControllable,
      repeatable: true,
      run: () => pc()?.seekForward(),
    },
    {
      id: 'player.seekBackward',
      label: 'Seek backward 10s',
      category: 'Player',
      context: 'player',
      defaultBindings: ['←'],
      keywords: 'seek backward rewind back',
      isAvailable: isPlayerControllable,
      repeatable: true,
      run: () => pc()?.seekBackward(),
    },
    {
      id: 'player.pip',
      label: 'Picture-in-picture',
      category: 'Player',
      context: 'player',
      defaultBindings: ['P'],
      keywords: 'pip picture in picture mini player',
      isAvailable: isPlayerControllable,
      run: () => pc()?.togglePip(),
    },
    {
      id: 'player.speedUp',
      label: 'Increase playback speed',
      category: 'Player',
      context: 'player',
      defaultBindings: ['Shift+.'],
      keywords: 'speed faster playback rate',
      isAvailable: isPlayerControllable,
      run: () => pc()?.speedUp(),
    },
    {
      id: 'player.speedDown',
      label: 'Decrease playback speed',
      category: 'Player',
      context: 'player',
      defaultBindings: ['Shift+,'],
      keywords: 'speed slower playback rate',
      isAvailable: isPlayerControllable,
      run: () => pc()?.speedDown(),
    },
    {
      id: 'cs.restartStream',
      label: 'Restart current stream',
      category: 'Player',
      context: 'player',
      defaultBindings: ['R'],
      keywords: 'restart refresh reload stream',
      isAvailable: watching,
      run: () => app().restartStream(),
    },
    {
      id: 'cs.stopStream',
      label: 'Stop / close current stream',
      category: 'Player',
      context: 'player',
      defaultBindings: ['Shift+Q'],
      keywords: 'stop close exit stream leave',
      isAvailable: watching,
      run: () => app().exitStream(),
    },

    // ---------------- Moderation ----------------
    // Only active for moderators/broadcasters of the watched channel. Focus a
    // message with J/K, then act on it. Action keys require a focused message.
    {
      id: 'mod.focusNewer',
      label: 'Focus newer message',
      description: 'Start moderating (focuses the newest) or step toward newer messages.',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['J'],
      keywords: 'moderate focus next newer down message',
      isAvailable: canModerate,
      run: () => mod()?.focusNewer(),
    },
    {
      id: 'mod.focusOlder',
      label: 'Focus older message',
      description: 'Step the moderation focus toward older messages.',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['K'],
      keywords: 'moderate focus previous older up message',
      isAvailable: canModerate,
      run: () => mod()?.focusOlder(),
    },
    {
      id: 'mod.clearFocus',
      label: 'Clear message focus',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['Esc'],
      keywords: 'moderate clear stop focus escape',
      isAvailable: modFocused,
      run: () => mod()?.clearFocus(),
    },
    {
      id: 'mod.userCard',
      label: 'Open focused user card',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['U'],
      keywords: 'moderate user card profile open',
      isAvailable: modFocused,
      run: () => mod()?.openUserCard(),
    },
    {
      id: 'mod.delete',
      label: 'Delete focused message',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['Delete'],
      keywords: 'moderate delete remove message',
      isAvailable: modFocused,
      run: () => mod()?.deleteFocused(),
    },
    {
      id: 'mod.timeout1s',
      label: 'Timeout focused user (1s purge)',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['1'],
      keywords: 'moderate timeout purge 1 second',
      isAvailable: modFocused,
      run: () => mod()?.timeoutFocused(1),
    },
    {
      id: 'mod.timeout10m',
      label: 'Timeout focused user (10m)',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['2'],
      keywords: 'moderate timeout 10 minutes',
      isAvailable: modFocused,
      run: () => mod()?.timeoutFocused(600),
    },
    {
      id: 'mod.timeout1h',
      label: 'Timeout focused user (1h)',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['3'],
      keywords: 'moderate timeout 1 hour',
      isAvailable: modFocused,
      run: () => mod()?.timeoutFocused(3600),
    },
    {
      id: 'mod.ban',
      label: 'Ban focused user',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['B'],
      keywords: 'moderate ban permanent',
      isAvailable: modFocused,
      run: () => mod()?.banFocused(),
    },
    {
      id: 'mod.unban',
      label: 'Unban focused user',
      category: 'Moderation',
      context: 'chatPane',
      defaultBindings: ['A'],
      keywords: 'moderate unban allow approve',
      isAvailable: modFocused,
      run: () => mod()?.unbanFocused(),
    },

    // ---------------- Reserved documentation entries ----------------
    // Shown for discoverability; the key is owned by the listed component, so
    // the engine never dispatches it and it cannot be rebound here (yet).
    {
      id: 'chat.send',
      label: 'Send message',
      category: 'Chat',
      context: 'chatInput',
      defaultBindings: ['Enter'],
      keywords: 'send chat message',
      reserved: true,
    },
    {
      id: 'chat.sendKeep',
      label: 'Send and keep text (quick send)',
      category: 'Chat',
      context: 'chatInput',
      defaultBindings: ['Ctrl+Enter'],
      keywords: 'send keep quick send',
      reserved: true,
    },
    {
      id: 'chat.newline',
      label: 'Insert newline',
      category: 'Chat',
      context: 'chatInput',
      defaultBindings: ['Shift+Enter'],
      keywords: 'newline multiline line break',
      reserved: true,
    },
    {
      id: 'chat.autocomplete',
      label: 'Emote / name autocomplete',
      category: 'Chat',
      context: 'chatInput',
      defaultBindings: ['Tab'],
      keywords: 'tab complete emote autocomplete mention',
      reserved: true,
    },
    {
      id: 'mc.newTab',
      label: 'New chat tab',
      category: 'Multi-view',
      context: 'multiView',
      defaultBindings: ['Ctrl+T'],
      keywords: 'multichat new tab add channel',
      reserved: true,
    },
    {
      id: 'mc.closeTab',
      label: 'Close chat tab',
      category: 'Multi-view',
      context: 'multiView',
      defaultBindings: ['Ctrl+W'],
      keywords: 'multichat close tab',
      reserved: true,
    },
    {
      id: 'mc.nextTab',
      label: 'Next chat tab',
      category: 'Multi-view',
      context: 'multiView',
      defaultBindings: ['Ctrl+Tab'],
      keywords: 'multichat next tab cycle',
      reserved: true,
    },
    {
      id: 'mc.prevTab',
      label: 'Previous chat tab',
      category: 'Multi-view',
      context: 'multiView',
      defaultBindings: ['Ctrl+Shift+Tab'],
      keywords: 'multichat previous tab cycle',
      reserved: true,
    },
    {
      id: 'mc.jumpTab',
      label: 'Jump to chat tab 1-9',
      category: 'Multi-view',
      context: 'multiView',
      defaultBindings: ['Ctrl+1'],
      keywords: 'multichat jump tab number index',
      reserved: true,
    },
  ];
}
