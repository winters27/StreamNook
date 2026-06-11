# Plugin Protocol v1

JSON-RPC 2.0 between the host (StreamNook) and a plugin process, over the plugin's stdin and stdout. This document freezes protocol version 1.

## 1. Transport

- The host spawns the plugin executable (manifest `runtime.entry`) with `runtime.args`, working directory set to the plugin's install directory.
- stdin and stdout carry protocol messages only. stderr is free-form: the host captures it to the plugin's log file.
- Each message is one JSON-RPC 2.0 envelope, framed with a byte-length header:

```
Content-Length: <byte count>\r\n
\r\n
<exactly that many bytes of UTF-8 JSON>
```

- One envelope per frame. JSON-RPC batch arrays are not supported.
- Maximum frame size is 4 MiB. An oversized or malformed frame is a protocol violation; the host may terminate the plugin.
- Requests carry `id` and expect exactly one response. Notifications carry no `id` and receive no response, including no error response.

## 2. Lifecycle

### 2.1 Handshake

1. Host spawns the process and sends the `initialize` request.
2. Plugin responds within 10 seconds or the host terminates it.
3. Host sends the `initialized` notification. Event delivery begins only after this point.

`initialize` request, host to plugin:

```json
{
  "protocol_version": 1,
  "host_version": "7.8.6",
  "plugin_id": "community.example",
  "granted": {
    "events": ["on_watch_tick", "on_followed_live"],
    "host_methods": ["get_followed_live", "notify", "log"],
    "credentials": ["twitch.android"],
    "ui": ["panel"]
  },
  "data_dir": "<absolute path the plugin may persist state in>",
  "log_dir": "<absolute path of the directory holding the plugin's log file>"
}
```

`granted` is the subset of the manifest's requested capabilities the user actually granted. A plugin must work with any subset (degrade or report via `log`, not crash).

`initialize` result, plugin to host:

```json
{
  "plugin_version": "1.2.0",
  "hooks": ["on_watch_tick", "on_followed_live"]
}
```

`hooks` is the list of events the plugin wants delivered. It must be a subset of `granted.events`; names outside it are ignored. The host only emits events listed in `hooks`.

### 2.2 Shutdown

1. Host sends the `shutdown` request. The plugin finishes in-flight work and responds with `null`.
2. Host sends the `exit` notification. The plugin exits with code 0.
3. If the process is still alive 5 seconds after `exit`, the host kills it.

### 2.3 Health and restarts

- The host sends a `ping` request every 30 seconds. The plugin responds with `{}`. Three consecutive missed responses count as unhealthy and the host restarts the plugin.
- On process exit or unhealthy state, the host restarts with backoff: 1s, then 5s, then 25s. More than 3 restarts within 10 minutes disables the plugin and notifies the user.
- Events emitted while a plugin is down are not replayed. After any (re)start a plugin must rebuild its view of the world from host methods (for example `get_followed_live`) instead of assuming it saw every event.
- Event delivery order is preserved per plugin.

## 3. Events (host to plugin, notifications)

Shared shape, the channel object:

```json
{
  "channel_id": "12345",
  "login": "somechannel",
  "display_name": "SomeChannel",
  "game_id": "509658",
  "game_name": "Just Chatting",
  "started_at": "2026-06-10T17:00:00Z",
  "viewer_count": 14203
}
```

`game_id`, `game_name`, `started_at`, and `viewer_count` are nullable. Timestamps are RFC 3339 UTC throughout.

| Event | Payload | Semantics |
|---|---|---|
| `on_stream_start` | `{ "channel": <channel> }` | The user started playback of a channel in the app |
| `on_stream_stop` | `{ "channel_id": "12345" }` | Playback of that channel stopped |
| `on_channel_change` | `{ "channel_id": "12345", "login": "somechannel" }` | The active on-screen channel changed (channel switch, or focus change in the multi-stream grid) |
| `on_watch_tick` | `{ "active_channel_id": "12345", "ts": "<RFC 3339>" }` | Periodic tick, nominally every 60 seconds while the app runs. `active_channel_id` is null when nothing is playing. Plugins must not assume exact cadence |
| `on_followed_live` | `{ "channels": [<channel>...] }` | The set of live followed channels, sent after startup and whenever the host refreshes it |
| `on_ad_window` | `{ "stream_id": "12345", "active": true, "ts": "<RFC 3339>" }` | Read-only ad detection state changed for a stream the app is playing |
| `on_settings_change` | `{ "keys": ["..."] }` | Reserved. Host settings keys the host chooses to expose changed. No keys are guaranteed in v1 |
| `on_panel_change` | `{ "values": { "<key>": <value> } }` | The user changed values in the plugin's settings panel (requires `ui: panel`) |

## 4. Host methods (plugin to host)

All calls are requests unless marked as a notification. Every method is gated: calling a method outside the granted set fails with `capability_denied`. Sending an ungranted notification is silently dropped and logged.

### get_followed_live

Params: `{}`. Result: `{ "channels": [<channel>...] }`.

### set_upstream

Params: `{ "stream_id": "12345", "playlist_url": "https://..." }`. Result: `{}`.

Replaces the upstream playlist the host's local relay serves for that stream. This is how a resolution-owning plugin feeds the relay. Errors: `unknown_stream` if no relay session matches `stream_id`.

### get_credential

Params: `{ "kind": "twitch.android" }`.

Result:

```json
{
  "kind": "twitch.android",
  "token": "...",
  "client_id": "...",
  "user_id": "...",
  "device_id": "...",
  "expires_at": "2026-06-11T00:00:00Z"
}
```

Fields other than `kind` and `token` are nullable. The first call for a kind in a session may block up to 120 seconds while the host shows the consent prompt. Every successful handover is written to the plugin's audit log. Errors: `capability_denied` (kind not in the manifest grant), `consent_denied` (user declined, or the grant was revoked), `credential_unavailable` (the user has never completed the auth that produces this credential).

### notify

Params: `{ "level": "info" | "warning" | "error", "message": "..." }`. Result: `{}`.

Shows a user-facing notification attributed to the plugin. Rate limited by the host (burst of 3, then at most one per 10 seconds); excess calls fail with `rate_limited`. Use `log` for anything the user does not need to see.

### log (notification)

Params: `{ "level": "debug" | "info" | "warning" | "error", "message": "..." }`.

Appends to the plugin's log file under `log_dir`.

### register_panel

Params: `{ "schema": <panel schema> }`. Result: `{}`. Requires `ui: panel`.

Registers (or replaces) the plugin's settings panel. The host renders it; the plugin never gets arbitrary UI access. Panel schema:

```json
{
  "title": "Example Plugin",
  "sections": [
    {
      "label": "Behavior",
      "description": "Optional section description",
      "fields": [
        { "key": "enabled", "type": "toggle", "label": "Enable", "description": "...", "default": false },
        { "key": "slots", "type": "number", "label": "Slots", "min": 1, "max": 2, "default": 2 },
        { "key": "mode", "type": "select", "label": "Mode", "options": [ { "value": "a", "label": "Mode A" } ], "default": "a" },
        { "key": "note", "type": "text", "label": "Note", "placeholder": "...", "default": "" },
        { "key": "channels", "type": "string_list", "label": "Channels" }
      ]
    }
  ]
}
```

Field types in v1: `toggle` (boolean), `number`, `select` (one of `options`), `text`, `string_list` (rendered as add-and-remove chip rows, value is a string array), `channel_list` (a Twitch channel search-and-pick control, value is an array of `{ channel_id, channel_login, display_name }`), and `slider` (a range with `min`/`max`/`step`, plus optional `unit` and `display_divisor` for the readout). The host renders each type with a rich native control and persists values per plugin, delivering changes via `on_panel_change`. These are generic: any plugin composes them, and the host renders them without knowing which plugin or feature it serves.

### get_panel_values

Params: `{}`. Result: `{ "values": { "<key>": <value> } }`. Requires `ui: panel`.

## 5. Errors

Standard JSON-RPC 2.0 codes apply (`-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error). Host-defined codes:

| Code | Name | Meaning |
|---|---|---|
| -32000 | `capability_denied` | Method or credential kind not granted |
| -32001 | `consent_denied` | User declined the consent prompt, or revoked the grant |
| -32002 | `unknown_stream` | `stream_id` does not match an active relay session |
| -32003 | `rate_limited` | Too many calls; retry later |
| -32004 | `shutting_down` | Host is shutting down; the call was not performed |
| -32005 | `credential_unavailable` | No credential of that kind exists to hand over |

Error responses use the JSON-RPC error object; `error.data` may carry `{ "name": "<name above>", "retry_after_ms": <number|null> }`.

## 6. Versioning rules

- `protocol_version` is an integer, currently 1. It bumps only on breaking changes.
- Additive changes (new events, new methods, new optional fields, new panel field types, new error codes) do not bump it.
- Both sides must ignore unknown fields in any payload.
- A plugin must not call methods or rely on events outside its granted set, regardless of what this document defines.
- The manifest's `host_min` gates installation against the host application version; `protocol_version` gates the wire contract at the handshake. A host that cannot satisfy the plugin's protocol version fails `initialize` with `-32600` and disables the plugin with a user notice.

## 7. Reserved, not in v1

- `runtime.kind = "wasm"`: in-process sandboxed extensions for safe extension points. Reserved in the manifest enum; the v1 host rejects it at install.
- `runtime.transport = "socket"`: connecting to an independently running plugin instead of spawning it. Reserved; the v1 host rejects it at install.
- `on_settings_change` payloads beyond an empty reserved shape.
