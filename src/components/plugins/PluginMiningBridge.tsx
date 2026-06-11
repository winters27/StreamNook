import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { useAppStore } from '../../stores/AppStore';
import type { MiningStatus, MiningChannel, CurrentDropInfo } from '../../types';

// Shape a drops-mining plugin pushes into its status slot (see HOOKS.md). The
// host never names the plugin; it only knows the generic `drops.mining`
// feature and the `drops.status` slot.
interface DropsStatusValue {
    active?: boolean;
    is_mining?: boolean;
    game_name?: string | null;
    campaign_id?: string | null;
    channel_login?: string | null;
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

    useEffect(() => {
        let disposed = false;
        const unlisteners: (() => void)[] = [];

        const refreshProvider = async () => {
            try {
                const id = await invoke<string | null>('plugins_provides', { feature: 'drops.mining' });
                if (!disposed) providerRef.current = id ?? null;
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
                    const drop: CurrentDropInfo | null = v.game_name
                        ? {
                              campaign_id: v.campaign_id ?? '',
                              campaign_name: '',
                              // No real drop id over the wire; key it to the
                              // campaign so the title bar's per-drop matching
                              // stays stable across pushes.
                              drop_id: v.campaign_id ?? '',
                              drop_name: '',
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
                    // the title bar, sidebar, and Drops center all update.
                    emit('mining-status-update', status).catch(() => {});
                    useAppStore.getState().setMiningActive(!!v.is_mining || !!v.active);
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
