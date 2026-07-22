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
actions  = ["drops.mine", "drops.mine-auto", "drops.mine-all", "drops.stop"]
status   = ["drops.status"]
provides = ["drops.mining"]
```

Settings are a host-rendered panel built from generic field types (see MANIFEST.md and the register_panel schema in PROTOCOL.md), so a plugin gets a rich native settings screen without core importing or naming anything plugin-specific. The field vocabulary includes list and picker types (`channel_list`, `string_list` as add-remove chips, `slider`), so a settings screen is never a bare text box. Any plugin composes the same generic fields; the host renders them blind to which plugin it is.

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

## Hook catalog

Contracts for the hooks core currently exposes. Hook names are owned by the host feature; any plugin may fill them.

### Drops center (`drops.*`)

- Actions: `drops.mine { campaign_id? }`, `drops.mine-auto`, `drops.mine-all`, `drops.stop` — each returns `{ "ok": true }`.
- Status slot: `drops.status` — `{ active, is_mining, game_name, campaign_id, channel_login, current_minutes, required_minutes }`.
- Provides: `drops.mining` lights up the Drops center's mine controls.

### Playback resolution (`playback.*`)

- Action: `playback.resolve` — invoked when a live stream starts and the viewer is not already entitled to watch it without proxying (Twitch Turbo or a channel subscription). Entitled streams never reach the hook.

  Args:

  ```json
  {
    "stream_id": "solo",
    "channel": "somechannel",
    "quality": "best",
    "auth_master": "<the master playlist core resolved itself, or null>"
  }
  ```

  `stream_id` is the relay session id this resolution will serve (`solo`, or a multi-stream tile id); the plugin keeps it to address later `set_upstream` calls. `auth_master` is core's own direct resolution when it succeeded; a plugin that resolves through an anonymous source can merge the above-1080p tiers from it, since anonymous masters are capped at 1080p.

  Response, either shape:

  ```json
  { "master": "<HLS master playlist body>", "base": "https://...", "region": "EU" }
  { "declined": true }
  ```

  On `master`, core parses it and selects the variant exactly as it would its own resolution; `base` and `region` are optional provenance for the player's source badge. On `declined` (or any error or timeout), core falls back to its own direct resolution.

- Provides: `playback.resolve` makes core invoke the action at stream start.

The mid-stream loop is entirely the plugin's own: it detects ad windows in its own process (polling the playlist it resolved) and answers a leaked ad by re-resolving and calling `set_upstream` with a fresh media-playlist URL for that session. Core never scans for ads on the plugin's behalf; it only exposes `playback.resolve` and `set_upstream`, neither of which is ad-specific.

## Why this shape

It keeps the host generic. The Drops center is a core feature, so it owns the `drops.*` hook names, but it has no knowledge of any particular plugin: it invokes actions, reads a status slot, and checks a provides flag. The drops plugin happens to fill those hooks; a different one could fill the same ones. The same mechanism serves every future plugin, so features become extension points rather than per-plugin wiring.
