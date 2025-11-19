import { useAppStore } from '../../stores/AppStore';
import ColorWheelPicker from '../ColorWheelPicker';

const ChatSettings = () => {
  const { settings, updateSettings } = useAppStore();

  return (
    <div className="space-y-6">
      {/* Chat History */}
      <div>
        <label className="block text-sm font-medium text-textPrimary mb-2">
          Chat History Max: {settings.chat_history_max ?? 500} messages
        </label>
        <input
          type="range"
          min="50"
          max="1500"
          step="50"
          value={settings.chat_history_max ?? 500}
          onChange={(e) =>
            updateSettings({
              ...settings,
              chat_history_max: parseInt(e.target.value),
            })
          }
          className="w-full accent-accent cursor-pointer"
        />
        <p className="text-xs text-textSecondary mt-1">
          Maximum number of chat messages to keep in history (lower = better for RAM)
        </p>
      </div>

      {/* Chat Design Section */}
      <div className="pt-4 border-t border-borderSubtle">
        <h3 className="text-lg font-semibold text-textPrimary mb-4">Chat Design</h3>

        <div className="space-y-4">
          {/* Dark Mode */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.chat_design?.dark_mode ?? false}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    chat_design: {
                      ...settings.chat_design,
                      show_dividers: settings.chat_design?.show_dividers ?? true,
                      alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                      dark_mode: e.target.checked,
                      message_spacing: settings.chat_design?.message_spacing ?? 2,
                      font_size: settings.chat_design?.font_size ?? 14,
                      font_weight: settings.chat_design?.font_weight ?? 400,
                      mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                      reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                      mention_animation: settings.chat_design?.mention_animation ?? true,
                    },
                  })
                }
                className="w-5 h-5 accent-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-medium text-textPrimary">Dark Mode</span>
                <p className="text-xs text-textSecondary">
                  Use black background for chat messages (inverts alternating colors)
                </p>
              </div>
            </label>
          </div>

          {/* Show Dividers */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.chat_design?.show_dividers ?? true}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    chat_design: {
                      ...settings.chat_design,
                      show_dividers: e.target.checked,
                      alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                      dark_mode: settings.chat_design?.dark_mode ?? false,
                      message_spacing: settings.chat_design?.message_spacing ?? 2,
                      font_size: settings.chat_design?.font_size ?? 14,
                      font_weight: settings.chat_design?.font_weight ?? 400,
                      mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                      reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                      mention_animation: settings.chat_design?.mention_animation ?? true,
                    },
                  })
                }
                className="w-5 h-5 accent-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-medium text-textPrimary">Show Message Dividers</span>
                <p className="text-xs text-textSecondary">
                  Display subtle lines between chat messages
                </p>
              </div>
            </label>
          </div>

          {/* Alternating Backgrounds */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.chat_design?.alternating_backgrounds ?? false}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    chat_design: {
                      ...settings.chat_design,
                      show_dividers: settings.chat_design?.show_dividers ?? true,
                      alternating_backgrounds: e.target.checked,
                      dark_mode: settings.chat_design?.dark_mode ?? false,
                      message_spacing: settings.chat_design?.message_spacing ?? 2,
                      font_size: settings.chat_design?.font_size ?? 14,
                      font_weight: settings.chat_design?.font_weight ?? 400,
                      mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                      reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                      mention_animation: settings.chat_design?.mention_animation ?? true,
                    },
                  })
                }
                className="w-5 h-5 accent-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-medium text-textPrimary">
                  Alternating Backgrounds
                </span>
                <p className="text-xs text-textSecondary">
                  Alternate message background colors for better readability
                </p>
              </div>
            </label>
          </div>

          {/* Message Spacing */}
          <div>
            <label className="block text-sm font-medium text-textPrimary mb-2">
              Message Spacing: {settings.chat_design?.message_spacing ?? 2}px
            </label>
            <input
              type="range"
              min="0"
              max="20"
              step="1"
              value={settings.chat_design?.message_spacing ?? 2}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  chat_design: {
                    ...settings.chat_design,
                    show_dividers: settings.chat_design?.show_dividers ?? true,
                    alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                    dark_mode: settings.chat_design?.dark_mode ?? false,
                    message_spacing: parseInt(e.target.value),
                    font_size: settings.chat_design?.font_size ?? 14,
                    font_weight: settings.chat_design?.font_weight ?? 400,
                    mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                    reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                    mention_animation: settings.chat_design?.mention_animation ?? true,
                  },
                })
              }
              className="w-full accent-accent cursor-pointer"
            />
            <p className="text-xs text-textSecondary mt-1">Space between chat messages</p>
          </div>

          {/* Font Size */}
          <div>
            <label className="block text-sm font-medium text-textPrimary mb-2">
              Font Size: {settings.chat_design?.font_size ?? 14}px
            </label>
            <input
              type="range"
              min="10"
              max="20"
              step="1"
              value={settings.chat_design?.font_size ?? 14}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  chat_design: {
                    ...settings.chat_design,
                    show_dividers: settings.chat_design?.show_dividers ?? true,
                    alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                    dark_mode: settings.chat_design?.dark_mode ?? false,
                    message_spacing: settings.chat_design?.message_spacing ?? 2,
                    font_size: parseInt(e.target.value),
                    font_weight: settings.chat_design?.font_weight ?? 400,
                    mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                    reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                    mention_animation: settings.chat_design?.mention_animation ?? true,
                  },
                })
              }
              className="w-full accent-accent cursor-pointer"
            />
            <p className="text-xs text-textSecondary mt-1">Chat message text size</p>
          </div>

          {/* Font Weight */}
          <div>
            <label className="block text-sm font-medium text-textPrimary mb-2">Font Weight</label>
            <select
              value={settings.chat_design?.font_weight ?? 400}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  chat_design: {
                    ...settings.chat_design,
                    show_dividers: settings.chat_design?.show_dividers ?? true,
                    alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                    dark_mode: settings.chat_design?.dark_mode ?? false,
                    message_spacing: settings.chat_design?.message_spacing ?? 2,
                    font_size: settings.chat_design?.font_size ?? 14,
                    font_weight: parseInt(e.target.value),
                    mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                    reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                    mention_animation: settings.chat_design?.mention_animation ?? true,
                  },
                })
              }
              className="w-full glass-input text-textPrimary text-sm px-3 py-2"
            >
              <option value="300">Light (300)</option>
              <option value="400">Normal (400)</option>
              <option value="500">Medium (500)</option>
              <option value="600">Semi-Bold (600)</option>
              <option value="700">Bold (700)</option>
            </select>
          </div>

          {/* Mention Animation */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.chat_design?.mention_animation ?? true}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    chat_design: {
                      ...settings.chat_design,
                      show_dividers: settings.chat_design?.show_dividers ?? true,
                      alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                      dark_mode: settings.chat_design?.dark_mode ?? false,
                      message_spacing: settings.chat_design?.message_spacing ?? 2,
                      font_size: settings.chat_design?.font_size ?? 14,
                      font_weight: settings.chat_design?.font_weight ?? 400,
                      mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                      reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                      mention_animation: e.target.checked,
                    },
                  })
                }
                className="w-5 h-5 accent-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-medium text-textPrimary">Mention Animation</span>
                <p className="text-xs text-textSecondary">
                  Flash animation when you're mentioned or replied to
                </p>
              </div>
            </label>
          </div>

          {/* Mention Color */}
          <ColorWheelPicker
            label="@ Mention Color"
            color={settings.chat_design?.mention_color ?? '#ff4444'}
            onChange={(color) =>
              updateSettings({
                ...settings,
                chat_design: {
                  ...settings.chat_design,
                  show_dividers: settings.chat_design?.show_dividers ?? true,
                  alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                  dark_mode: settings.chat_design?.dark_mode ?? false,
                  message_spacing: settings.chat_design?.message_spacing ?? 2,
                  font_size: settings.chat_design?.font_size ?? 14,
                  font_weight: settings.chat_design?.font_weight ?? 400,
                  mention_color: color,
                  reply_color: settings.chat_design?.reply_color ?? '#ff6b6b',
                  mention_animation: settings.chat_design?.mention_animation ?? true,
                },
              })
            }
          />

          {/* Reply Color */}
          <ColorWheelPicker
            label="Reply Thread Color"
            color={settings.chat_design?.reply_color ?? '#ff6b6b'}
            onChange={(color) =>
              updateSettings({
                ...settings,
                chat_design: {
                  ...settings.chat_design,
                  show_dividers: settings.chat_design?.show_dividers ?? true,
                  alternating_backgrounds: settings.chat_design?.alternating_backgrounds ?? false,
                  dark_mode: settings.chat_design?.dark_mode ?? false,
                  message_spacing: settings.chat_design?.message_spacing ?? 2,
                  font_size: settings.chat_design?.font_size ?? 14,
                  font_weight: settings.chat_design?.font_weight ?? 400,
                  mention_color: settings.chat_design?.mention_color ?? '#ff4444',
                  reply_color: color,
                  mention_animation: settings.chat_design?.mention_animation ?? true,
                },
              })
            }
          />
        </div>
      </div>
    </div>
  );
};

export default ChatSettings;
