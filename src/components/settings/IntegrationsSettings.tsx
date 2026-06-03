import { useAppStore } from '../../stores/AppStore';
import { SettingsSection, SettingsRow } from './_primitives';

const IntegrationsSettings = () => {
  const { settings, updateSettings } = useAppStore();

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

  return (
    <div className="space-y-8">
      <SettingsSection label="Discord">
        <SettingsRow
          title="Discord Rich Presence"
          description="Show what you're watching on Discord"
          control={
            <Toggle
              enabled={settings.discord_rpc_enabled}
              onChange={() => updateSettings({ ...settings, discord_rpc_enabled: !settings.discord_rpc_enabled })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
};

export default IntegrationsSettings;
