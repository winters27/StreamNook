import { useAppStore } from '../../stores/AppStore';
import ColorWheelPicker from '../ColorWheelPicker';
import HighlightPhrasesSettings from './HighlightPhrasesSettings';
import BuiltInHighlightsSettings from './BuiltInHighlightsSettings';
import UserHighlightsSettings from './UserHighlightsSettings';
import BadgeHighlightsSettings from './BadgeHighlightsSettings';
import HighlightAppearanceSettings from './HighlightAppearanceSettings';
import UserOverridesSettings from './UserOverridesSettings';
import UserCommandsSettings from './UserCommandsSettings';
import { SettingsSection, SettingsRow, SegmentedSelect } from './_primitives';

const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
  <button
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${enabled ? 'bg-accent' : 'bg-gray-600'
      }`}
  >
    <span
      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
    />
  </button>
);

const ChatSettings = () => {
  const { settings, updateSettings } = useAppStore();

  const stored = settings.chat_design;
  const cd = {
    show_dividers: stored?.show_dividers ?? true,
    alternating_backgrounds: stored?.alternating_backgrounds ?? false,
    message_spacing: stored?.message_spacing ?? 2,
    font_size: stored?.font_size ?? 14,
    font_weight: stored?.font_weight ?? 400,
    mention_color: stored?.mention_color ?? '#ff4444',
    reply_color: stored?.reply_color ?? '#ff6b6b',
    mention_animation: stored?.mention_animation ?? true,
    show_timestamps: stored?.show_timestamps ?? false,
    show_timestamp_seconds: stored?.show_timestamp_seconds ?? false,
    emote_scale: stored?.emote_scale ?? 1,
    emote_margin: stored?.emote_margin ?? 0.125,
    deleted_message_style: stored?.deleted_message_style ?? 'strikethrough',
    hide_shared_chat: stored?.hide_shared_chat ?? false,
    paint_mentions_in_body: stored?.paint_mentions_in_body ?? true,
    compact_emote_tooltips: stored?.compact_emote_tooltips ?? false,
    seventv_emote_notices: stored?.seventv_emote_notices ?? true,
  };

  const setDesign = (patch: Partial<typeof cd>) => {
    updateSettings({
      ...settings,
      chat_design: { ...cd, ...patch },
    });
  };

  const setInput = (patch: Partial<NonNullable<typeof settings.chat_input>>) =>
    updateSettings({
      ...settings,
      chat_input: { ...settings.chat_input, ...patch },
    });

  const setRender = (patch: Partial<NonNullable<typeof settings.chat_render>>) =>
    updateSettings({
      ...settings,
      chat_render: { ...settings.chat_render, ...patch },
    });

  const setCosmetics = (patch: Partial<NonNullable<typeof settings.cosmetics>>) =>
    updateSettings({
      ...settings,
      cosmetics: { ...settings.cosmetics, ...patch },
    });

  return (
    <div className="space-y-8">
      <SettingsSection label="Chat Placement">
        <SettingsRow
          title="Placement"
          description="Choose where to display the chat window or hide it completely"
        >
          <SegmentedSelect<'right' | 'bottom' | 'hidden'>
            value={settings.chat_placement as 'right' | 'bottom' | 'hidden'}
            onChange={(placement) => updateSettings({ ...settings, chat_placement: placement })}
            options={[
              { value: 'hidden', label: 'Hidden' },
              { value: 'bottom', label: 'Bottom' },
              { value: 'right', label: 'Right' },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Chat Design">
        <SettingsRow
          title="Show Message Dividers"
          description="Display subtle lines between chat messages"
          control={
            <Toggle
              enabled={cd.show_dividers ?? true}
              onChange={() => setDesign({ show_dividers: !(cd.show_dividers ?? true) })}
            />
          }
        />

        <SettingsRow
          title="Alternating Backgrounds"
          description="Alternate message background colors using your theme palette"
          control={
            <Toggle
              enabled={cd.alternating_backgrounds ?? false}
              onChange={() => setDesign({ alternating_backgrounds: !(cd.alternating_backgrounds ?? false) })}
            />
          }
        />

        <SettingsRow
          title={`Message Spacing: ${cd.message_spacing ?? 2}px`}
          description="Space between chat messages"
        >
          <input
            type="range"
            min="0"
            max="20"
            step="1"
            value={cd.message_spacing ?? 2}
            onChange={(e) => setDesign({ message_spacing: parseInt(e.target.value) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title={`Font Size: ${cd.font_size ?? 14}px`}
          description="Chat message text size"
        >
          <input
            type="range"
            min="10"
            max="20"
            step="1"
            value={cd.font_size ?? 14}
            onChange={(e) => setDesign({ font_size: parseInt(e.target.value) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title="Font Weight"
          description="Boldness of chat message text"
        >
          <select
            value={cd.font_weight ?? 400}
            onChange={(e) => setDesign({ font_weight: parseInt(e.target.value) })}
            className="w-full glass-input text-textPrimary text-sm px-3 py-2"
          >
            <option value="300">Light (300)</option>
            <option value="400">Normal (400)</option>
            <option value="500">Medium (500)</option>
            <option value="600">Semi-Bold (600)</option>
            <option value="700">Bold (700)</option>
          </select>
        </SettingsRow>

        <SettingsRow
          title="Mention Animation"
          description="Flash animation when you're mentioned or replied to"
          control={
            <Toggle
              enabled={cd.mention_animation ?? true}
              onChange={() => setDesign({ mention_animation: !(cd.mention_animation ?? true) })}
            />
          }
        />

        <SettingsRow
          title="Show Timestamps"
          description="Display the time each message was sent next to the username"
          control={
            <Toggle
              enabled={cd.show_timestamps ?? false}
              onChange={() => setDesign({ show_timestamps: !(cd.show_timestamps ?? false) })}
            />
          }
        >
          {cd.show_timestamps && (
            <SettingsRow
              title="Include Seconds"
              description="Show seconds in timestamps (e.g., 7:42:30 PM instead of 7:42 PM)"
              control={
                <Toggle
                  enabled={cd.show_timestamp_seconds ?? false}
                  onChange={() => setDesign({ show_timestamp_seconds: !(cd.show_timestamp_seconds ?? false) })}
                />
              }
            />
          )}
        </SettingsRow>

        <SettingsRow
          title="@ Mention Color"
          description="Color used for messages that mention you"
        >
          <ColorWheelPicker
            label=""
            color={cd.mention_color ?? '#ff4444'}
            onChange={(color) => setDesign({ mention_color: color })}
          />
        </SettingsRow>

        <SettingsRow
          title="Reply Thread Color"
          description="Color used for replies in threads"
        >
          <ColorWheelPicker
            label=""
            color={cd.reply_color ?? '#ff6b6b'}
            onChange={(color) => setDesign({ reply_color: color })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Emotes">
        <SettingsRow
          title={`Emote Size: ${(cd.emote_scale ?? 1).toFixed(2)}x`}
          description="Multiplier for inline emote size. 1.00x matches the default."
        >
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.05"
            value={cd.emote_scale ?? 1}
            onChange={(e) => setDesign({ emote_scale: parseFloat(e.target.value) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>

        <SettingsRow
          title={`Emote Spacing: ${(cd.emote_margin ?? 0.125).toFixed(3)}rem`}
          description="Horizontal space around emotes. Negative values let them overlap for an inline feel."
        >
          <input
            type="range"
            min="-0.5"
            max="0.5"
            step="0.025"
            value={cd.emote_margin ?? 0.125}
            onChange={(e) => setDesign({ emote_margin: parseFloat(e.target.value) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        label="Chat Input"
        description="Quality-of-life behavior for the message composer."
      >
        <SettingsRow
          title="Bypass duplicate-message check"
          description="When you send the same message twice in a row, append an invisible character so Twitch doesn't reject the second send. Useful for repeating an emote."
          control={
            <Toggle
              enabled={settings.chat_input?.bypass_duplicate ?? false}
              onChange={() => setInput({ bypass_duplicate: !(settings.chat_input?.bypass_duplicate ?? false) })}
            />
          }
        />
        <SettingsRow
          title="Quick Send (Ctrl+Enter keeps message)"
          description="Holding Ctrl while pressing Enter sends the message AND leaves it in the input box so you can re-send fast. Plain Enter still sends and clears like normal."
          control={
            <Toggle
              enabled={settings.chat_input?.quick_send ?? false}
              onChange={() => setInput({ quick_send: !(settings.chat_input?.quick_send ?? false) })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        label="Emote Tab Completion"
        description="Type part of an emote name in chat and press Tab to cycle through matching emotes. Shift+Tab cycles backwards."
        id="settings-section-emote-tab-completion"
      >
        <SettingsRow
          title="Enable Tab Completion"
          description="Press Tab while typing to insert the best-matching emote. Press Tab again to cycle to the next match."
          control={
            <Toggle
              enabled={settings.chat_input?.emote_tab_complete_enabled ?? true}
              onChange={() =>
                setInput({
                  emote_tab_complete_enabled: !(settings.chat_input?.emote_tab_complete_enabled ?? true),
                })
              }
            />
          }
        />
        <SettingsRow
          title="Match Mode"
          description='"Starts With" only matches emotes that begin with what you typed. "Contains" matches anywhere in the name.'
        >
          <SegmentedSelect<'starts_with' | 'includes'>
            value={settings.chat_input?.emote_tab_complete_match_mode ?? 'starts_with'}
            options={[
              { value: 'starts_with', label: 'Starts With' },
              { value: 'includes', label: 'Contains' },
            ]}
            onChange={(v) => setInput({ emote_tab_complete_match_mode: v })}
          />
        </SettingsRow>
        <SettingsRow
          title="Include Chat Users"
          description="Also cycle through display names of users currently in chat."
          control={
            <Toggle
              enabled={settings.chat_input?.emote_tab_complete_include_chatters ?? true}
              onChange={() =>
                setInput({
                  emote_tab_complete_include_chatters: !(settings.chat_input?.emote_tab_complete_include_chatters ?? true),
                })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        label="Render Style"
        description="How specific message classes look in chat."
      >
        <SettingsRow
          title="Deleted messages"
          description="How banned, timed-out, and deleted messages render."
        >
          <SegmentedSelect<'strikethrough' | 'dimmed' | 'keep' | 'hidden'>
            value={cd.deleted_message_style as 'strikethrough' | 'dimmed' | 'keep' | 'hidden'}
            onChange={(value) => setDesign({ deleted_message_style: value })}
            options={[
              { value: 'strikethrough', label: 'Strikethrough' },
              { value: 'dimmed', label: 'Dimmed' },
              { value: 'keep', label: 'Keep' },
              { value: 'hidden', label: 'Hidden' },
            ]}
          />
        </SettingsRow>

        <SettingsRow
          title="Hide shared chat messages"
          description="Suppress messages flagged as coming from another room in a Twitch shared-chat session."
          control={
            <Toggle
              enabled={cd.hide_shared_chat}
              onChange={() => setDesign({ hide_shared_chat: !cd.hide_shared_chat })}
            />
          }
        />

        <SettingsRow
          title="Paint @mentions inline"
          description="When someone @ mentions a user, render the mentioned name with their 7TV paint. Off renders mentions in their flat color only."
          control={
            <Toggle
              enabled={cd.paint_mentions_in_body}
              onChange={() => setDesign({ paint_mentions_in_body: !cd.paint_mentions_in_body })}
            />
          }
        />

        <SettingsRow
          title="Compact emote tooltips"
          description='Show just the emote name on hover instead of the full "Right-click to copy" hint.'
          control={
            <Toggle
              enabled={cd.compact_emote_tooltips}
              onChange={() => setDesign({ compact_emote_tooltips: !cd.compact_emote_tooltips })}
            />
          }
        />

        <SettingsRow
          title="7TV emote update notices"
          description="Show a chat notice when a channel's 7TV emote set changes live (a mod adds, removes, or renames an emote). The new emote is usable right away either way."
          control={
            <Toggle
              enabled={cd.seventv_emote_notices ?? true}
              onChange={() => setDesign({ seventv_emote_notices: !(cd.seventv_emote_notices ?? true) })}
            />
          }
        />

        <SettingsRow
          title="Smooth scroll on Resume"
          description='Animate the scroll when you click the "Resume" button. New-message auto-scroll stays instant.'
          control={
            <Toggle
              enabled={settings.chat_render?.smooth_scroll_on_resume ?? false}
              onChange={() =>
                setRender({ smooth_scroll_on_resume: !(settings.chat_render?.smooth_scroll_on_resume ?? false) })
              }
            />
          }
        />

        <SettingsRow
          title={`Message buffer: ${settings.chat_render?.message_buffer_cap ?? 100} messages`}
          description="How many messages to keep in the local scrollback per channel. Higher = more history, more memory."
        >
          <input
            type="range"
            min="50"
            max="1000"
            step="10"
            value={settings.chat_render?.message_buffer_cap ?? 100}
            onChange={(e) => setRender({ message_buffer_cap: parseInt(e.target.value, 10) })}
            className="w-full accent-accent cursor-pointer"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        label="7TV Cosmetics"
        description="Visual controls for 7TV-rendered usernames (paints)."
      >
        <SettingsRow
          title="Paint drop shadows"
          description='Some 7TV paints stack heavy drop shadows for readability. Drop to "One" or "None" if they feel too noisy.'
        >
          <SegmentedSelect<'all' | 'one' | 'none'>
            value={(settings.cosmetics?.paint_shadows ?? 'all') as 'all' | 'one' | 'none'}
            onChange={(value) => setCosmetics({ paint_shadows: value })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'one', label: 'One' },
              { value: 'none', label: 'None' },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <HighlightAppearanceSettings />

      <HighlightPhrasesSettings />

      <BuiltInHighlightsSettings />

      <UserHighlightsSettings />

      <BadgeHighlightsSettings />

      <UserCommandsSettings />

      <UserOverridesSettings />
    </div>
  );
};

export default ChatSettings;
