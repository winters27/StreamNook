import { Plug } from 'lucide-react';
import { useAppStore } from '../../stores/AppStore';
import { DiscordGlyph } from '../ui/DiscordGlyph';
import streamnookLogo from '../../assets/streamnook-logo.png';

const IntegrationsSettings = () => {
  const { settings, updateSettings } = useAppStore();

  const Toggle = ({ enabled, onChange }: { enabled: boolean; onChange: () => void }) => (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
        enabled ? 'bg-accent' : 'bg-gray-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );

  return (
    <div className="flex min-h-full flex-col items-center py-6">
      {/* my-auto centers the group vertically when there's room and degrades to
          top-aligned + scrollable when the content outgrows the pane — unlike
          justify-center, which clips the top out of reach. */}
      <div className="my-auto flex w-full max-w-[400px] flex-col items-center">
        {/* Intro — anchors the tab so a single integration reads as a deliberate,
            centered screen rather than one stray row across a wide empty page. */}
        <div className="mb-5 flex max-w-[340px] flex-col items-center text-center">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Plug className="h-6 w-6" />
        </div>
        <h2 className="text-[17px] font-semibold text-textPrimary">Integrations</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-textSecondary">
          Connect StreamNook with the apps you already use.
        </p>
      </div>

        {/* Integration cards (room to stack as more land here) */}
        <div className="w-full space-y-3">
        <div className="glass-panel rounded-lg p-4">
          <div className="flex items-center gap-3.5">
            {/* Just the two marks with a + between them, signalling StreamNook and
                Discord working together — no tiles, aligned on one line. */}
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <img
                src={streamnookLogo}
                alt="StreamNook"
                className="h-7 w-7 object-contain"
              />
              <span className="text-[13px] font-medium text-textMuted">+</span>
              <DiscordGlyph size={26} className="text-[#5865F2]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-textPrimary">Discord Rich Presence</div>
              <p className="mt-0.5 text-[12px] leading-relaxed text-textSecondary">
                Show what you're watching on your Discord profile.
              </p>
            </div>
            <Toggle
              enabled={settings.discord_rpc_enabled}
              onChange={() =>
                updateSettings({ ...settings, discord_rpc_enabled: !settings.discord_rpc_enabled })
              }
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
};

export default IntegrationsSettings;
