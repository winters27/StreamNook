import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/AppStore';
import type { MiningStatus, MiningChannel, CurrentDropInfo, DropCampaign, TimeBasedDrop } from '../../types';

// Shape a drops-mining plugin pushes into its status slot (see HOOKS.md). The
// host never names the plugin; it only knows the generic `drops.mining`
// feature and the `drops.status` slot.
interface DropsStatusValue {
    active?: boolean;
    is_mining?: boolean;
    game_name?: string | null;
    campaign_id?: string | null;
    channel_login?: string | null;
    drop_name?: string | null;
    current_minutes?: number | null;
    required_minutes?: number | null;
}

/**
 * Bridges a drops-mining plugin's status into the app's native mining display.
 *
 * The title bar badge, the sidebar, and the Drops center all listen for the
 * built-in miner's 'mining-status-update' event and read the global
 * isMiningActive flag. A plugin instead pushes 'plugin://status'. This always
 * mounted, headless component is the one place that translates the plugin's
 * pushes into those exact native signals, so every existing consumer lights up
 * identically whether mining is powered by the core miner or by a plugin and
 * works even while the Drops overlay is closed.
 *
 * It does nothing unless a plugin actually provides drops mining.
 */
export default function PluginMiningBridge() {
    const providerRef = useRef<string | null>(null);
    // Campaign cache used only to resolve a reward NAME for the title bar when a
    // plugin's status push doesn't carry one (older plugin builds). The name
    // lives only in campaign data; the backend progress records don't have it.
    const campaignsRef = useRef<DropCampaign[]>([]);
    const fetchingRef = useRef(false);
    const lastFetchRef = useRef(0);

    useEffect(() => {
        let disposed = false;
        const unlisteners: (() => void)[] = [];

        const refreshCampaigns = async () => {
            if (fetchingRef.current || Date.now() - lastFetchRef.current < 60_000) return;
            lastFetchRef.current = Date.now();
            fetchingRef.current = true;
            try {
                const list = await invoke<DropCampaign[]>('get_active_drop_campaigns');
                if (!disposed && Array.isArray(list)) campaignsRef.current = list;
            } catch {
                /* campaigns unavailable */
            } finally {
                fetchingRef.current = false;
            }
        };

        // The reward currently being worked toward in a campaign: the unclaimed,
        // still-incomplete mineable drop closest to finishing (fewest minutes
        // left). Mirrors what the miner is actually progressing.
        const resolveDropName = (campaignId: string): string => {
            const campaign = campaignsRef.current.find((c) => c.id === campaignId);
            if (!campaign) return '';
            const remaining = (d: TimeBasedDrop) =>
                (d.progress?.required_minutes_watched ?? d.required_minutes_watched) -
                (d.progress?.current_minutes_watched ?? 0);
            let best: TimeBasedDrop | null = null;
            for (const d of campaign.time_based_drops) {
                if ((d.required_minutes_watched ?? 0) <= 0 || d.progress?.is_claimed) continue;
                if (remaining(d) <= 0) continue;
                if (!best || remaining(d) < remaining(best)) best = d;
            }
            const pick = best
                ?? campaign.time_based_drops.find((d) => (d.required_minutes_watched ?? 0) > 0)
                ?? null;
            return pick ? (pick.benefit_edges?.[0]?.name || pick.name || '') : '';
        };

        const refreshProvider = async () => {
            try {
                const id = await invoke<string | null>('plugins_provides', { feature: 'drops.mining' });
                if (disposed) return;
                const next = id ?? null;
                const had = providerRef.current;
                providerRef.current = next;
                // Warm the campaign cache while a mining plugin is active, so a
                // name is ready to resolve the moment mining starts.
                if (next) refreshCampaigns();
                // The mining provider went away (plugin disabled or removed). It
                // can't push a final stopped status once its process is gone, so
                // stand the native mining UI down here, otherwise a reopened
                // overlay would seed from a stale "mining" status.
                if (had && !next) {
                    const store = useAppStore.getState();
                    store.setLiveMiningStatus(null);
                    store.setMiningActive(false);
                    emit('mining-status-update', {
                        is_mining: false,
                        current_channel: null,
                        current_campaign: null,
                        current_drop: null,
                        eligible_channels: [],
                        last_update: new Date().toISOString(),
                    } as MiningStatus).catch(() => {});
                }
            } catch {
                /* plugin host unavailable */
            }
        };
        refreshProvider();

        const setup = async () => {
            const unState = await listen('plugin://state-changed', () => refreshProvider());
            const unStatus = await listen<{ slot: string; value: DropsStatusValue }>(
                'plugin://status',
                (event) => {
                    if (!providerRef.current || event.payload.slot !== 'drops.status') return;
                    const v = event.payload.value || {};

                    const channel: MiningChannel | null = v.channel_login
                        ? {
                              id: '',
                              name: v.channel_login,
                              display_name: v.channel_login,
                              game_name: v.game_name ?? '',
                              viewer_count: 0,
                              is_live: true,
                              drops_enabled: true,
                          }
                        : null;
                    // Reward name: prefer what the plugin reports; fall back to
                    // resolving it from campaign data for plugin builds that
                    // don't send it. A cache miss kicks off a refresh so the next
                    // status push resolves.
                    let dropName = (v.drop_name ?? '').trim();
                    if (!dropName && v.campaign_id) {
                        dropName = resolveDropName(v.campaign_id);
                        if (!dropName) refreshCampaigns();
                    }
                    const drop: CurrentDropInfo | null = v.game_name
                        ? {
                              campaign_id: v.campaign_id ?? '',
                              campaign_name: '',
                              // No real drop id over the wire; key it to the
                              // campaign so the title bar's per-drop matching
                              // stays stable across pushes.
                              drop_id: v.campaign_id ?? '',
                              drop_name: dropName,
                              required_minutes: v.required_minutes ?? 0,
                              current_minutes: v.current_minutes ?? 0,
                              game_name: v.game_name,
                          }
                        : null;

                    const status: MiningStatus = {
                        is_mining: !!v.is_mining,
                        current_channel: channel,
                        current_campaign: v.campaign_id ?? null,
                        current_drop: drop,
                        eligible_channels: [],
                        last_update: new Date().toISOString(),
                    };

                    // Drive the same native signals the built-in miner emits, so
                    // the title bar, sidebar, and Drops center all update. The
                    // lit state tracks actually mining a channel (is_mining), not
                    // merely having a target, so the indicator is honest.
                    emit('mining-status-update', status).catch(() => {});
                    useAppStore.getState().setMiningActive(!!v.is_mining);
                    // Cache the live status so a reopened Drops overlay can seed
                    // from it. Held while a target is set (mining or finding a
                    // channel); cleared when mining stops.
                    useAppStore.getState().setLiveMiningStatus(v.active ? status : null);
                }
            );
            if (disposed) {
                unState();
                unStatus();
            } else {
                unlisteners.push(unState, unStatus);
            }
        };
        setup();

        return () => {
            disposed = true;
            unlisteners.forEach((u) => u());
        };
    }, []);

    return null;
}
