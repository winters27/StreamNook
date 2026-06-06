export interface SettingsIndexEntry {
  tab: string;
  section: string;
  sectionId?: string;
  title: string;
  description?: string;
}

const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/\s+/).filter(Boolean);

export const searchSettings = (
  query: string,
  limit = 50,
): SettingsIndexEntry[] => {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const scored: { entry: SettingsIndexEntry; score: number }[] = [];

  for (const entry of SETTINGS_INDEX) {
    const title = entry.title.toLowerCase();
    const description = entry.description?.toLowerCase() ?? '';
    const section = entry.section.toLowerCase();
    const tab = entry.tab.toLowerCase();
    const haystack = `${title} ${description} ${section} ${tab}`;

    let allMatch = true;
    let score = 0;
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        allMatch = false;
        break;
      }
      if (title.startsWith(token)) score += 100;
      else if (title.includes(token)) score += 50;
      else if (section.includes(token)) score += 20;
      else if (description.includes(token)) score += 10;
      else if (tab.includes(token)) score += 5;
    }

    if (allMatch) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
};

export const SETTINGS_INDEX: SettingsIndexEntry[] = [
  // === Player ===
  {
    tab: 'Player',
    section: 'Player Overlay Buttons',
    title: 'Player Overlay Buttons',
    description: 'Choose which action buttons (follow, subscribe, clip, clips & vods, multinook, refresh, close) appear in the top-right of the video player.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Auto-Switch',
    description: 'When a stream goes offline, automatically switch to another stream.'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Enable Auto-Switch',
    description: 'Automatically switch when current stream goes offline'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Switch To',
    description: 'Switch to the highest viewer stream in the same game/category or one of your live followed streamers'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Show Notification',
    description: 'Display a toast when auto-switching streams'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Auto-Redirect on Raid',
    description: 'Automatically follow raids to the target channel (requires login)'
  },
  {
    tab: 'Player',
    section: 'Auto-Switch',
    sectionId: 'settings-section-auto-switch',
    title: 'Stay in Offline Chat',
    description: "Don't auto-switch when stream ends, stay in the chat room instead"
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Allow h265 + AV1 codecs',
    description: 'Request AV1 and HEVC stream variants in addition to h264. Turn off if you see decode errors on older hardware.'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Use Proxy Routing',
    description: 'Route playlists through CDN proxies (recommended for ad-blocking)'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Connection Timeout',
    description: 'How long to keep retrying to resolve a stream before giving up'
  },
  {
    tab: 'Player',
    section: 'Streaming',
    sectionId: 'settings-section-streaming',
    title: 'Auto-Retry Delay',
    description: 'Seconds to wait between resolve attempts while a stream is not available yet'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Video Player',
    description: 'Control playback behavior'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Autoplay',
    description: 'Automatically play stream when loaded'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Low Latency Mode',
    description: 'Reduce stream delay for live content (may affect stability)'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Max Buffer Length',
    description: 'Maximum amount of video to buffer ahead (higher = more stable, but more delay)'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Default Stream Quality',
    description: 'Quality to use when starting streams (you can change quality anytime using the player controls)'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Lock Aspect Ratio (16:9)',
    description: 'Prevent letterboxing by constraining window resize to maintain video aspect ratio'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Start Muted',
    description: 'Begin playback with audio muted'
  },
  {
    tab: 'Player',
    section: 'Video Player',
    sectionId: 'settings-section-video-player',
    title: 'Default Volume',
    description: 'Initial volume level when starting playback'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Audio Boost',
    description: 'Compressor and makeup gain to even out loud and quiet moments and make the stream louder without clipping.'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Enable Audio Boost',
    description: 'Run the stream audio through a compressor and a makeup-gain stage.'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Boost',
    description: 'How much louder to make the stream after compression (volume boost / gain).'
  },
  {
    tab: 'Player',
    section: 'Audio Boost',
    sectionId: 'settings-section-audio-boost',
    title: 'Advanced Compressor Controls',
    description: 'Threshold, ratio, knee, attack and release controls for the audio compressor.'
  },

  // === Theme ===
  {
    tab: 'Theme',
    section: 'Theme',
    title: 'Theme',
    description: 'Pick a color theme or build your own. Themes set the palette only; font and glassiness are chosen separately, so you can use any font with any theme.'
  },
  {
    tab: 'Theme',
    section: 'Glassiness',
    title: 'Glassiness',
    description: 'How see-through and frosted every surface is, for every theme. 100% is the signature glass; 0% removes all transparency and blur for a completely flat, solid, opaque look.'
  },
  {
    tab: 'Theme',
    section: 'Font',
    title: 'Font',
    description: 'Interface font, independent of the theme. Choose any font with any theme. Satoshi, Twitch (Inter), Geist, Manrope, Outfit, Space Grotesk, Serif, and System.'
  },

  // === Chat ===
  {
    tab: 'Chat',
    section: 'Chat Placement',
    title: 'Chat Placement',
    description: 'Choose where to display the chat window or hide it completely'
  },
  {
    tab: 'Chat',
    section: 'Chat Placement',
    title: 'Placement',
    description: 'Choose where to display the chat window or hide it completely'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Chat Design',
    description: 'Customize the appearance of chat messages'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Show Message Dividers',
    description: 'Display subtle lines between chat messages'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Alternating Backgrounds',
    description: 'Alternate message background colors using your theme palette'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Message Spacing',
    description: 'Space between chat messages'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Font Size',
    description: 'Chat message text size'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Font Weight',
    description: 'Boldness of chat message text'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Mention Animation',
    description: 'Flash animation when you\'re mentioned or replied to'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Show Timestamps',
    description: 'Display the time each message was sent next to the username'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Include Seconds',
    description: 'Show seconds in timestamps (e.g., 7:42:30 PM instead of 7:42 PM)'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Collapsed Pinned Message',
    description: 'When a pinned message is collapsed, shrink it to a thin one-line bar (sender + truncated text) instead of hiding it entirely.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Name Separator',
    description: 'Glyph between the username and the message: colon, dot, arrow, pipe, or dash. Makes the name read as a prefix (name: message).'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Name Style',
    description: 'Make the username stand out as a prefix: accent bar, frosted chip or tag, brackets [name], or a small color dot.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Prefix Color',
    description: "Color for the username separator and name style: the chatter's own color, or your theme accent."
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Moderation Actions',
    description: 'Choose how to moderate: classic click buttons, drag a chat message into an action bucket (ban/timeout/delete/whisper/profile), or both. Also called Action Style.'
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Drag Style',
    description: 'Where the action buckets appear: a vertical bucket column beside chat (bigger tiles, kept above the player controls) or a compact bucket cluster above the message.'
  },
  {
    tab: 'Moderation',
    section: 'Moderation Actions',
    title: 'Pin Action',
    description: 'The inline Pin button next to Copy is always available to mods; this toggles whether a Pin tile also appears in the drag-to-moderate gesture.'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: '@ Mention Color',
    description: 'Color used for messages that mention you'
  },
  {
    tab: 'Chat',
    section: 'Chat Design',
    title: 'Reply Thread Color',
    description: 'Color used for replies in threads'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emotes',
    description: 'Customize emote display'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Size',
    description: 'Multiplier for inline emote size. 1.00x matches the default.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Hover Size',
    description: 'How large an emote grows in its hover preview. Hover the sample to try the chosen size.'
  },
  {
    tab: 'Chat',
    section: 'Emotes',
    title: 'Emote Spacing',
    description: 'Horizontal space around emotes. Negative values let them overlap for an inline feel.'
  },
  {
    tab: 'Chat',
    section: 'Highlight Phrases',
    title: 'Highlight Phrases',
    description: 'Flash chat messages that match specific words, names, or patterns. Mentions of your own name and replies to you are always highlighted; these are extra.'
  },
  {
    tab: 'Chat',
    section: 'Custom Commands',
    title: 'Custom Commands',
    description: 'Define your own chat commands with expansions and auto-fill'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Emote Tab Completion',
    description: 'Tab cycles forward through matching emotes in the chat input, Shift+Tab cycles back.'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Enable Tab Completion',
    description: 'Press Tab while typing a partial emote name to insert the best-matching emote.'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Match Mode',
    description: 'Whether the tab carousel ranks matches by prefix (starts with) or by substring (contains).'
  },
  {
    tab: 'Chat',
    section: 'Emote Tab Completion',
    sectionId: 'settings-section-emote-tab-completion',
    title: 'Include Chat Users',
    description: 'Also cycle through display names of users currently in chat.'
  },
  {
    tab: 'Chat',
    section: 'User Overrides',
    title: 'User Overrides',
    description: 'Nicknames you\'ve set for individual chatters. Only visible to you. Set or clear a nickname from the user\'s profile card in chat.'
  },

  // === Link Previews (Chat) ===
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Link Previews',
    description: 'Show rich preview cards when links are posted in chat.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Preview Mode',
    description: 'Off keeps links as plain text. Card + Link shows the preview and keeps the link in chat. Clean shows only the preview card and hides the link.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Load Preview Button',
    description: 'Untrusted links show a Load preview button before the preview card is fetched. Trusted sites expand automatically.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Shorten Links',
    description: 'Display links as a clean compact label (site plus a short path) instead of the full raw URL.'
  },
  {
    tab: 'Chat',
    section: 'Link Previews',
    title: 'Trusted Sources',
    description: 'Sites that expand into a preview automatically. Add or remove your own trusted sites.'
  },

  // === Moderation ===
  {
    tab: 'Moderation',
    section: 'Mod Logs',
    title: 'Mod Logs',
    description: 'Control moderation action visibility'
  },
  {
    tab: 'Moderation',
    section: 'Mod Logs',
    title: 'Show Mod Logs panel',
    description: 'Display the recent moderation actions sidebar inside chat (timeouts, bans, deletions)'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Message Visibility',
    description: 'Control how removed messages are shown in chat'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Announce mod actions inline',
    description: 'Add an extra system row to chat when a mod times someone out, bans, or deletes a message (on top of the strikethrough you already see)'
  },
  {
    tab: 'Moderation',
    section: 'Message Visibility',
    title: 'Hide strikethrough on removed messages',
    description: 'Suppress the strikethrough overlay on banned, timed-out, or deleted messages so your backlog stays pristine'
  },
  {
    tab: 'Moderation',
    section: 'Mass Actions',
    title: 'Mass Actions',
    description: 'Mods can sweep a phrase or pattern across the current channel using these commands in the chat input.'
  },

  // === Interface ===
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Sidebar',
    description: 'Control the appearance of the stream list sidebar'
  },
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Sidebar Display Mode',
    description: 'Choose how the sidebar appears (expanded, compact, hidden, or disabled)'
  },
  {
    tab: 'Interface',
    section: 'Sidebar',
    sectionId: 'settings-section-sidebar',
    title: 'Expand on Hover',
    description: 'Sidebar expands when you hover over it'
  },
  {
    tab: 'Interface',
    section: 'Motion',
    sectionId: 'settings-section-motion',
    title: 'Animations',
    description: 'Choose how much the interface animates: Full, Reduced (fades only), or Off (instant and snappy, best for low-end PCs).'
  },
  {
    tab: 'Interface',
    section: 'Motion',
    sectionId: 'settings-section-motion',
    title: 'Reduce motion',
    description: 'Reduce or turn off animations and transitions for accessibility or performance.'
  },
  {
    tab: 'Interface',
    section: 'Settings Window',
    sectionId: 'settings-section-settings-window',
    title: 'Compact settings window',
    description: 'Show settings in a centered window, or turn off for a full-page settings layout that fills the entire app.'
  },
  {
    tab: 'Interface',
    section: 'Compact View',
    title: 'Compact View',
    description: 'Choose the window size when entering Compact View mode. Perfect for fitting the app on a second monitor.'
  },

  // === Integrations ===
  {
    tab: 'Integrations',
    section: 'Discord',
    title: 'Discord',
    description: 'Discord integration settings'
  },
  {
    tab: 'Integrations',
    section: 'Discord',
    title: 'Discord Rich Presence',
    description: 'Show what you\'re watching on Discord'
  },

  // === Notifications ===
  {
    tab: 'Notifications',
    section: 'Notifications',
    title: 'Notifications',
    description: 'Control notification system settings'
  },
  {
    tab: 'Notifications',
    section: 'Notifications',
    title: 'Enable Notifications',
    description: 'Master toggle for all notification types'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Notification Methods',
    description: 'Choose how to display notifications'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Dynamic Island',
    description: 'Show notifications in the notification center at the top'
  },
  {
    tab: 'Notifications',
    section: 'Notification Methods',
    title: 'Toast Notifications',
    description: 'Show popup toasts at the bottom of the screen'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Notification Types',
    description: 'Enable or disable specific types of notifications'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Live Stream Notifications',
    description: 'Get notified when followed streamers go live'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Whisper Notifications',
    description: 'Get notified when you receive whispers'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Update Notifications',
    description: 'Get notified when a new app update is available'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Quick Update on Toast Click',
    description: 'Clicking the update toast immediately starts the update'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Drops Notifications',
    description: 'Get notified when a drop is claimed'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Favorite Category Drops',
    description: 'Notify when favorited categories have new drops on startup'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Channel Points Notifications',
    description: 'Get notified when channel points are claimed'
  },
  {
    tab: 'Notifications',
    section: 'Notification Types',
    title: 'Badge Notifications',
    description: 'Get notified when new badges become available'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Sound',
    description: 'Configure notification sounds'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Notification Sound',
    description: 'Play a subtle sound for notifications'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Sound Style',
    description: 'All sounds are designed to be pleasant and non-intrusive'
  },
  {
    tab: 'Notifications',
    section: 'Sound',
    title: 'Test Notification',
    description: 'Send a test notification to preview your settings'
  },
  {
    tab: 'Notifications',
    section: 'About',
    title: 'About',
    description: 'About notifications and how to use them'
  },

  // === Cache ===
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache',
    description: 'Manage cached emotes and badges'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Enable Cache',
    description: 'Cache emotes and badges to speed up loading'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache Expiry',
    description: 'How long to keep cached data before refreshing'
  },
  {
    tab: 'Cache',
    section: 'Cache',
    title: 'Cache Maintenance',
    description: 'View cache statistics or delete all cached emotes and badges'
  },

  // === Command Palette ===
  {
    tab: 'Command Palette',
    section: 'Keyboard Shortcuts',
    sectionId: 'settings-section-keyboard',
    title: 'Keyboard Shortcuts',
    description: 'Keyboard controls for the command palette'
  },
  {
    tab: 'Command Palette',
    section: 'What lives in the palette',
    title: 'What lives in the palette',
    description: 'Overview of palette sections and available actions'
  },
  {
    tab: 'Command Palette',
    section: 'Snippet Manager',
    title: 'Snippet Manager',
    description: 'Star the snippets you use most, bind aliases for instant matching, and add your own.'
  },

  // === Support ===
  {
    tab: 'Support',
    section: 'Community Discord',
    title: 'Community Discord',
    description: 'Join the StreamNook community for help, feature requests, updates, and chat with other users.'
  },
  {
    tab: 'Support',
    section: 'Community Discord',
    title: 'Join the Discord',
    description: 'Open the StreamNook community Discord invite'
  },

  // === Backup ===
  {
    tab: 'Backup',
    section: 'Backup and Restore',
    title: 'Backup and Restore',
    description: 'Export your settings to a file, or import a saved backup to restore them.'
  },
  {
    tab: 'Backup',
    section: 'Backup and Restore',
    title: 'Export Settings',
    description: 'Save a backup of all your preferences to a file you choose.'
  },
  {
    tab: 'Backup',
    section: 'Backup and Restore',
    title: 'Import Settings',
    description: 'Restore your preferences from a previously exported backup file.'
  },
  {
    tab: 'Backup',
    section: 'Settings File',
    title: 'Open Settings Folder',
    description: 'Open the folder on this PC where StreamNook stores settings.json.'
  },
];
