# Hooks: how the native UI delegates to plugins

The host never contains code that names a specific plugin. Instead, the app's own features expose named **hooks**, and a plugin declares which hooks it fills. The host routes by name. Swap in a different plugin that fills the same hooks and the feature works identically.

This is what lets a native control (say the Drops center's Mine button) be powered by an add-on without core knowing the add-on exists.

## Three kinds of hooks

- **Actions** — named operations the native UI can invoke that a plugin handles. The UI fires `drops.mine`; the host routes it to whichever plugin declared that action and returns the result. If no plugin declared it, the call fails and the UI can show "needs an add-on."
- **Status slots** — named regions a plugin pushes values into for the native UI to display. The plugin pushes to `drops.status`; the host forwards it to the frontend, where the owning component renders it in native style.
- **Provides** — feature flags a plugin declares. The host answers "does anything provide `drops.mining`?" so the UI lights up (or grays out) its controls accordingly.

Hook ids are namespaced (`feature.name`), defined by the host feature that exposes them, not by the plugin. A plugin only fills hooks; it cannot reach anything it was not handed.

## Manifest

```toml
[contributes]
actions  = ["drops.mine", "drops.mine-auto", "drops.mine-all", "drops.stop", "drops.configure"]
status   = ["drops.status"]
provides = ["drops.mining"]
```

A plugin can also be configured through an action rather than a host-rendered panel: the drops plugin handles `drops.configure` (the app's native Drops settings, pushed in as args), so its settings UI is core's own rich settings tab, not a constrained panel schema. The native UI is the single source of config; the plugin keeps none of its own.

## Wire protocol (additive to PROTOCOL.md v1)

### Action call (host to plugin, request)

```json
{ "jsonrpc": "2.0", "id": 7, "method": "invoke_action",
  "params": { "action": "drops.mine", "args": { "campaign_id": "..." } } }
```

The plugin handles the action and replies with a result (or a JSON-RPC error). The host fans the call only to a plugin whose manifest declared that action.

### Status push (plugin to host, notification)

```json
{ "jsonrpc": "2.0", "method": "set_status",
  "params": { "slot": "drops.status", "value": { "active": true, "is_mining": true,
    "game_name": "...", "channel_login": "...", "current_minutes": 12, "required_minutes": 15 } } }
```

The host ignores a slot the plugin did not declare. Accepted pushes are forwarded to the frontend as a `plugin://status` event carrying `{ plugin_id, slot, value }`.

## Host surface

- `plugins_invoke_action(action, args) -> result` — core UI invokes a hooked action; the host routes to the providing plugin.
- `plugins_provides(feature) -> plugin_id | null` — core UI checks whether a feature is backed before enabling its controls.
- `plugin://status` event — core UI subscribes to receive a plugin's status-slot pushes.

## Why this shape

It keeps the host generic. The Drops center is a core feature, so it owns the `drops.*` hook names, but it has no knowledge of any particular plugin: it invokes actions, reads a status slot, and checks a provides flag. The farming plugin happens to fill those hooks; a different miner could fill the same ones. The same mechanism serves every future plugin, so features become extension points rather than per-plugin wiring.
