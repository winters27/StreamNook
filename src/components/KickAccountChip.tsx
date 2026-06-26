// Compact in-composer quick-connect pill. Shows a small "Connect <platform>" pill
// when disconnected so you can connect right where you're trying to chat; renders
// nothing once connected. Disconnect (and full account management) lives in
// MultiChat Settings → Connections, so the composer stays uncluttered. Defaults to
// Kick for back-compat; pass `provider` for other platforms (YouTube, ...).

import { ProviderLogo } from './ProviderLogo';
import { PROVIDERS, type ProviderId } from '../types/providers';

interface Props {
  connected: boolean;
  busy?: boolean;
  onConnect: () => void;
  provider?: ProviderId;
}

export function KickAccountChip({ connected, busy, onConnect, provider = 'kick' }: Props) {
  if (connected) return null;
  const meta = PROVIDERS[provider];
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold transition-colors hover:bg-white/5 disabled:opacity-60"
      style={{ borderColor: `${meta.color}73`, color: meta.color }}
    >
      <ProviderLogo provider={provider} size={13} />
      {busy ? 'Connecting…' : `Connect ${meta.label}`}
    </button>
  );
}

export default KickAccountChip;
