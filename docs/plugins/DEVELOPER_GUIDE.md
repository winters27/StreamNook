# Plugin Developer Guide

A start-to-finish walkthrough: from an empty folder to a plugin running inside StreamNook, to a signed release in the marketplace. This is the guide; the other documents in this folder are the reference you reach for once you know the shape.

If you want the precise field-by-field contracts, jump to:

| You want | Read |
|---|---|
| The wire protocol, events, host methods | [PROTOCOL.md](PROTOCOL.md) |
| Every `plugin.toml` field and the tiers | [MANIFEST.md](MANIFEST.md) |
| The permission vocabulary and consent text | [CAPABILITIES.md](CAPABILITIES.md) |
| Driving native UI from a plugin | [HOOKS.md](HOOKS.md) |
| The in-app `ui` runtime and the `api` object | [UI_PLUGINS.md](UI_PLUGINS.md) |
| Signing, the index format, key rotation | [SIGNING.md](SIGNING.md) |
| What makes a plugin "official" | [OFFICIAL.md](OFFICIAL.md) |

---

## 1. What a plugin is

The StreamNook core ships with zero plugins and contains none of their behavior. A plugin is an opt-in add-on the user installs, grants permissions to, and can disable or remove at any time. There are two runtime kinds, and the first decision you make is which one you are building.

| Kind | What it is | Best for | Language |
|---|---|---|---|
| `process` | A separate executable that runs beside the app and talks JSON-RPC over stdio | Background behavior: long-running loops, its own networking, work that should keep going whether or not any window is open | Any language that can read stdin and write stdout |
| `ui` | A JavaScript module the app loads into its own interface | Interface features the user sees and operates: panels, title-bar buttons, popout windows, palette commands, hotkeys | TypeScript or JavaScript, bundled to one ES module |

A third shape, **hybrid**, is a `process` plugin that also ships a `ui` module: the executable does the background work, the module contributes the native controls and settings screen. Both halves install, enable, and disable as one plugin.

### Choosing

- The feature is something the app **does in the background** (tracking, polling, networking on a timer): build a `process` plugin.
- The feature is something the user **sees and touches** (a panel, a button, a window, a command): build a `ui` plugin.
- It is both (a background worker with its own native controls and settings): build a **hybrid**.

### Why `process` plugins are out-of-process

A behavior plugin is a separate program, not a library loaded into the app, for three concrete reasons:

1. The OS process boundary is the strongest practical isolation. A crashing or misbehaving plugin cannot corrupt the app.
2. The plugin brings its own network stack. The core contains none of the endpoints, queries, or loops a plugin uses.
3. A plugin can be written in any language.

The deliberate omission that makes this safe: the host exposes no generic HTTP method. A plugin that needs the network brings its own. The host hands a plugin only events, a few read/display methods, and (with explicit per-use consent) a credential. That credential handoff is the one sensitive boundary crossing, and it is gated, logged, and revocable.

---

## 2. Before you start

You need:

- A working StreamNook build you can run (the dev build for plugin work). You will register your plugin folder through Settings, Plugins, Develop, which gives you the real install and consent behavior with no packaging.
- For a `process` plugin: a toolchain for your language (Node, Rust, Go, Python, anything that does stdio).
- For a `ui` plugin: Node and esbuild for bundling.
- For publishing later: [minisign](https://jedisct1.github.io/minisign/) to sign your release.

Every plugin, regardless of kind, ships a `plugin.toml` manifest at the root of its folder. That file is the complete machine-readable statement of what the plugin is and what it may ask for. Anything not declared there is denied at runtime.

---

## 3. Build a `process` plugin

We will build a minimal plugin that logs a line every time the watch tick fires and registers a settings panel. It is the smallest thing that exercises the whole lifecycle. The full working version of this lives at `examples/plugins/example-tick/`.

### 3.1 The folder

```
my-plugin/
├── plugin.toml      the manifest
├── main.js          your code
└── plugin.cmd       a launcher (Windows), optional but convenient
```

### 3.2 The manifest

```toml
id          = "yourhandle.my-plugin"
name        = "My Plugin"
version     = "0.1.0"
author      = "yourhandle"
tier        = "A"
description = "Logs watch ticks and adds a settings panel."
host_min    = "7.0.0"

[runtime]
kind      = "process"
entry     = "plugin.cmd"
args      = []
transport = "stdio"

[capabilities]
events       = ["on_watch_tick", "on_followed_live", "on_panel_change"]
host_methods = ["notify", "log", "register_panel", "get_panel_values"]
credentials  = []
network      = "none"
ui           = ["panel"]
```

Key points:

- `id` is a unique, dotted namespace that **never changes** across versions. It is lowercase with at least two dot-separated segments (it matches `^[a-z0-9]+(\.[a-z0-9-]+)+$`). You do not need a domain or website: a handle plus the plugin name works, like `yourhandle.my-plugin`, the way the examples use `community.drops-farmer` and `dev.example-tick`. Just pick something unlikely to collide with anyone else. Do not use the `app.streamnook.` prefix; that is reserved for first-party plugins.
- `entry` is the program the host spawns, relative to the plugin folder. No `..`, no absolute paths. On Windows a one-line `.cmd` launcher is the simplest way to run an interpreted script:

  ```bat
  @echo off
  node "%~dp0main.js"
  ```

- `[capabilities]` is the whole permission contract. **Request only what you use.** Every line shows up in the consent dialog, and a plugin asking for more than it plausibly needs reads exactly the way you would expect it to.
- `network = "none"` is a promise. The host cannot stop a separate process from using the network, so this field states intent to the user. A plugin observed networking despite declaring `none` is grounds for removal from an index.

### 3.3 The protocol loop

Communication is JSON-RPC 2.0 over stdin/stdout. Each message is one JSON envelope, framed with a byte-length header:

```
Content-Length: <byte count>\r\n
\r\n
<exactly that many bytes of UTF-8 JSON>
```

stderr is yours for free-form output; the host captures it to your log file. Here is the complete minimal plugin in Node. Read it top to bottom once; the comments mark every required piece.

```js
'use strict';

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

// --- framing: write one Content-Length-framed JSON envelope ---
function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function respond(id, result) { writeFrame({ jsonrpc: '2.0', id, result }); }
function notifyHost(method, params) { writeFrame({ jsonrpc: '2.0', method, params }); }
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    writeFrame({ jsonrpc: '2.0', id, method, params });
  });
}
function log(level, message) { notifyHost('log', { level, message }); }

// --- a settings panel the host renders for us ---
const PANEL = {
  title: 'My Plugin',
  sections: [{
    label: 'Behavior',
    fields: [
      { key: 'chatty', type: 'toggle', label: 'Log every tick', default: true },
    ],
  }],
};
let chatty = true;

// runs after the host sends `initialized`
async function onInitialized() {
  await request('register_panel', { schema: PANEL });
  const panel = await request('get_panel_values', {});
  if (panel?.values && typeof panel.values.chatty === 'boolean') chatty = panel.values.chatty;
  await request('notify', { level: 'info', message: 'My Plugin started' });
}

function handleMessage(message) {
  // a response to one of our own requests
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    }
    return;
  }
  // a request or notification from the host
  switch (message.method) {
    case 'initialize':
      // declare our version and the events we actually want delivered
      respond(message.id, { plugin_version: '0.1.0', hooks: ['on_watch_tick', 'on_followed_live', 'on_panel_change'] });
      break;
    case 'initialized': onInitialized(); break;
    case 'ping':        respond(message.id, {}); break;
    case 'shutdown':    respond(message.id, null); break;
    case 'exit':        process.exit(0); break;
    case 'on_watch_tick':
      if (chatty) log('info', `tick, active channel: ${message.params?.active_channel_id || 'none'}`);
      break;
    case 'on_followed_live':
      log('info', `followed live: ${(message.params?.channels || []).length} channels`);
      break;
    case 'on_panel_change':
      if (typeof message.params?.values?.chatty === 'boolean') chatty = message.params.values.chatty;
      break;
    default:
      // unknown request -> method not found; unknown notification -> ignore
      if (message.id !== undefined) {
        writeFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
      }
  }
}

// --- read stdin, split frames on Content-Length, dispatch each ---
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const match = /content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd).toString('utf8'));
    if (!match) process.exit(1);
    const frameEnd = headerEnd + 4 + parseInt(match[1], 10);
    if (buffer.length < frameEnd) return;
    const body = buffer.slice(headerEnd + 4, frameEnd).toString('utf8');
    buffer = buffer.slice(frameEnd);
    try { handleMessage(JSON.parse(body)); } catch (err) { process.stderr.write(`bad frame: ${err}\n`); }
  }
});
process.stdin.on('end', () => process.exit(0));
```

### 3.4 The lifecycle you must honor

This is the contract every `process` plugin lives by. Get these five things right and the rest is your own logic.

1. **Handshake.** The host sends `initialize`. You must respond within 10 seconds with `{ plugin_version, hooks }`. `hooks` is the subset of events you want delivered; it must be a subset of what your manifest requested and the user granted. Then the host sends the `initialized` notification, and event delivery begins. Do your startup work (register a panel, read its values, build initial state) in response to `initialized`, not `initialize`.

2. **Granted is a subset.** The `initialize` request carries a `granted` object: the capabilities the user actually approved, which may be fewer than you requested. Your plugin must work with any subset. Degrade or report through `log`, never crash.

3. **Health.** The host pings you every 30 seconds; respond with `{}`. Three missed pings and the host restarts you. More than three restarts in ten minutes disables the plugin and tells the user.

4. **No replay.** Events emitted while you were down are gone. After any start or restart, rebuild your view of the world from host methods (for example `get_followed_live`), do not assume you saw every event.

5. **Shutdown.** On `shutdown`, finish in-flight work and respond `null`. On `exit`, exit with code 0. If you are still alive 5 seconds after `exit`, the host kills you.

### 3.5 What the host can tell you, and what you can ask it

Events the host pushes to you (you opt in via `hooks`), and the methods you can call back, are the complete surface. The headline ones:

- Events: `on_stream_start`, `on_stream_stop`, `on_channel_change`, `on_watch_tick` (every ~60s, cadence not guaranteed), `on_followed_live`, `on_chat_message`, `on_panel_change`.
- Methods: `get_followed_live`, `notify` (user-facing, rate-limited), `log` (to your log file), `register_panel` / `get_panel_values` (your settings UI), `get_credential` (the gated login handoff, see section 6), `set_upstream` (for playback-resolving plugins).

Every method is gated. Calling one outside your granted set fails with `capability_denied`. The full payloads, the channel and chat-message shapes, and the error codes are in [PROTOCOL.md](PROTOCOL.md).

---

## 4. Build a `ui` plugin

A `ui` plugin is a single bundled ES module the app imports into its own interface. It contributes real UI through one `api` object handed to it at load. The reference implementation is `plugins/lists/`.

### 4.1 The manifest

A `ui` plugin's manifest is short. The `[capabilities]` and `[contributes]` blocks stay empty: those are wire-protocol concepts for `process` plugins. A UI plugin's whole surface is the `api` object, and its contributions are registered live at load, not declared in the manifest.

```toml
id          = "yourhandle.my-ui-plugin"
name        = "My UI Plugin"
version     = "1.0.0"
author      = "yourhandle"
tier        = "A"
description = "A floating panel with a title-bar button and a hotkey."
host_min    = "7.8.6"

[runtime]
kind  = "ui"
entry = "dist/main.js"
```

### 4.2 The module contract

Your bundle exports up to three functions:

```ts
import type { PluginApi } from 'streamnook'; // see note on types below

// Called once when the plugin loads in a window. Register contributions here.
// May return a cleanup function.
export function activate(api: PluginApi) { /* ... */ }

// Optional. Called before unload (disable, uninstall, update). The host also
// tears down every registration for you; this is for your own timers/listeners.
export function deactivate() { /* ... */ }

// Optional. Called inside a popout OS window opened via api.windows.open.
// Return the React component to render as that window's content.
export function windowSurface(surfaceId: string, api: PluginApi) { return MyComponent; }
```

`activate` runs once per window that hosts contributions (the main window, the multi-chat popout), so registrations only surface where something consumes them. Disabling unloads the module and removes every registration; re-enabling evaluates a fresh instance.

### 4.3 The `api` object

This is everything a UI plugin can reach. It is frozen and passed to `activate` and `windowSurface`.

- `api.libs` — the host's own React, react/jsx-runtime, and framer-motion. Your build aliases these (next section) so your components run on the host's React tree.
- `api.components` — native components to reuse: `Tooltip`, plus the settings UI kit (toggles, chip lists, sliders, the channel search-picker, section and row layout) so your own panel looks native.
- `api.ui.registerTitleBarButton({ id, tooltip, Icon, onClick, useIsActive?, useIsVisible? })` — a button in the title bar. `useIsVisible` is a hook you can wire to one of your own settings so the user decides whether the button shows.
- `api.ui.registerOverlay({ id, Component })` — mounts a component at the app root. It owns its own visibility (render `null` when closed). This is how you ship a floating panel.
- `api.ui.registerSlot(slotId, { id, label, Icon, Component })` — fills a named slot a host feature exposes (see the slot catalog in UI_PLUGINS.md).
- `api.commands.registerKeybinding({ id, label, defaultBindings, run, ... })` — a bindable command that appears in Keybindings settings; user rebinds persist under its id.
- `api.commands.registerPaletteItems(provider)` — `provider` runs on each palette open and returns rows.
- `api.settings.registerPanel(Component)` — your own settings component, rendered on the plugin's card. You ship the actual UI; build it from `api.components` so it reads as part of the app.
- `api.windows.open({ surface, title, width?, height?, ... })` — opens (or focuses) a popout OS window; the host supplies the frame, theme, and titlebar and mounts your `windowSurface(surface, api)`.
- `api.events.emit(name, payload)` / `api.events.listen(name, handler)` — app-wide events that cross window boundaries, for syncing state between the main window and popouts. Prefix names with your plugin id.
- `api.chat.useHasTarget()` / `api.chat.insertText(text)` — detect a chat compose box and insert text at the caret.
- `api.log.debug / warn / error` — to the app log, prefixed with your plugin id.

For storage, UI plugins read and write `localStorage` directly (it is shared across the app's windows, which is what makes popout sync work). Prefix every key with `streamnook.<feature>.`.

### 4.4 A minimal `activate`

```tsx
import { ClipboardList } from 'lucide-react';
import type { PluginApi } from '../../../src/plugins-ui/types';

export function activate(api: PluginApi): void {
  api.ui.registerTitleBarButton({
    id: 'my-panel',
    tooltip: 'My Panel',
    Icon: ClipboardList,
    onClick: () => { /* toggle your overlay's open state */ },
  });

  api.ui.registerOverlay({ id: 'my-panel', Component: MyOverlay });

  api.commands.registerKeybinding({
    id: 'myplugin.toggle',
    label: 'Toggle My Panel',
    category: 'Navigation',
    defaultBindings: ['Ctrl+Shift+M'],
    run: () => { /* toggle */ },
  });
}
```

### 4.5 Building the bundle

Bundle to one ES module with the shared libraries aliased to the host's copies. This sharing is required, not an optimization: your components render inside the host's React tree, and hooks only work when both sides run the same React instance. Everything else (icons, a state library) bundles in normally.

`build.mjs`:

```js
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const hostLibShims = {
  name: 'host-lib-shims',
  setup(b) {
    b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: path.join(dir, 'shims', 'jsx-runtime.cjs') }));
    b.onResolve({ filter: /^react$/ }, () => ({ path: path.join(dir, 'shims', 'react.cjs') }));
    b.onResolve({ filter: /^framer-motion$/ }, () => ({ path: path.join(dir, 'shims', 'framer-motion.cjs') }));
  },
};

await build({
  entryPoints: [path.join(dir, 'src', 'index.tsx')],
  outfile: path.join(dir, 'dist', 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  plugins: [hostLibShims],
  logLevel: 'info',
});
```

Each shim re-exports the host copy. `shims/react.cjs`:

```js
module.exports = globalThis.__STREAMNOOK_HOST_LIBS__.react;
```

`shims/jsx-runtime.cjs` and `shims/framer-motion.cjs` follow the same pattern with `.reactJsxRuntime` and `.framerMotion`.

A note on types: the `PluginApi` type lives in the StreamNook source at `src/plugins-ui/types.ts`. When developing inside or beside the StreamNook tree, import it from there (the reference plugins use a relative path). When developing standalone, copy the interface or declare a minimal local type; the runtime object is what matters.

---

## 5. Hybrid plugins (process + ui)

A background worker that also wants native controls is a hybrid: a `process` plugin that adds `ui_entry` to its runtime block. The reference implementations are `plugins/drops-farmer/` and `plugins/ad-bypass/`.

```toml
[runtime]
kind      = "process"
entry     = "target/release/worker.exe"   # the sidecar
ui_entry  = "ui/dist/main.js"             # the in-app UI module
transport = "stdio"
```

When the plugin is enabled the host runs both halves: it spawns the sidecar and the frontend loads the UI module. Disabling shuts the sidecar down and unloads the module. One plugin, one install, one toggle.

The two halves are separate programs, so they do not call each other directly. They talk through the hook system (section 7): the UI module invokes the sidecar's actions and reads its status with the same calls the host's own UI uses.

- `invoke('plugins_invoke_action', { action, args })` drives the sidecar.
- `invoke('plugins_provides', { feature })` checks the sidecar is backing a feature.
- `listen('plugin://status', ...)` receives the sidecar's status pushes (filter by the event's `plugin_id`).

---

## 6. Hooks: driving native UI from a plugin

The core never contains code that names a specific plugin. Instead, core features expose named **hooks**, and a plugin declares which it fills. The host routes by name. This is what lets a native control (say the Drops center's Mine button) be powered by an add-on the core has never heard of.

Three kinds:

- **Actions** — operations the native UI invokes that a plugin handles. The UI fires `drops.mine`; the host routes it to whichever plugin declared that action. If none did, the call fails and the UI shows "needs an add-on."
- **Status slots** — regions a plugin pushes values into for the native UI to display. The plugin pushes to `drops.status`; the host forwards it and the owning component renders it natively.
- **Provides** — feature flags. The host answers "does anything provide `drops.mining`?" so the UI lights up or grays out its controls.

You declare what you fill in `[contributes]`:

```toml
[contributes]
actions  = ["drops.mine", "drops.mine-auto", "drops.mine-all", "drops.stop"]
status   = ["drops.status"]
provides = ["drops.mining"]
```

Hook ids are namespaced (`feature.name`) and owned by the host feature, not by you. You only fill hooks; you cannot reach anything you were not handed. On the wire, the host sends you `invoke_action { action, args }` requests, and you send `set_status { slot, value }` notifications. The current hook catalog (Drops center, playback resolution) is in [HOOKS.md](HOOKS.md).

Settings for a hook-filling `process` plugin are a host-rendered panel built from generic field types (`toggle`, `number`, `select`, `text`, `string_list` as add-remove chips, `channel_list` as a Twitch search-picker, `slider`, `folder`). You declare the panel, the host renders it with rich native controls, and changes arrive via `on_panel_change`. A settings screen is never a bare text box. The field schema is in [PROTOCOL.md](PROTOCOL.md) section 4.

---

## 7. Capabilities, consent, and credentials

Default deny. A plugin gets exactly what its manifest lists and the user grants, nothing else. The host enforces this by not answering ungranted requests and never emitting unsubscribed events.

The capability lines are deliberately coarse so the consent dialog can show them verbatim and a non-technical user can understand what they are agreeing to. Request the minimum. The mapping from a capability to the exact sentence the user sees is in [CAPABILITIES.md](CAPABILITIES.md).

The one sensitive capability is `credentials = ["twitch.android"]`, the user's Twitch login token. With it, your plugin can act as the user's account. Two separate consent steps gate it:

1. Granting the capability at install (shown with emphasis in the consent dialog) only allows your plugin to **ask** later.
2. The first actual `get_credential` call triggers its own prompt. The user picks Allow, Allow and don't ask again, or Deny. Every handover is written to a per-plugin audit log the user can view, and the grant is revocable at any time (after which `get_credential` fails with `consent_denied`).

So design your plugin to handle `consent_denied` and `credential_unavailable` gracefully: the user may never grant it, or may revoke it mid-session.

---

## 8. Run it, test it, debug it

### Dev install

You do not package anything to develop. In StreamNook: Settings, Plugins, Sources, Develop, and register the folder that contains your `plugin.toml`. The plugin gets the same capability and consent behavior an installed plugin gets. Enable it from the plugins list.

### Logs

The host hands your plugin a `log_dir` in the `initialize` handshake and captures both your `log` calls and your stderr into a log file there. On Windows dev builds this is under:

```
%LOCALAPPDATA%\com.streamnook.dev\plugins\<your-plugin-id>\plugin.log
```

Reading this file is the fastest way to see what your plugin is actually doing. It is readable even while the plugin runs.

### Re-registering after a manifest change

The folder registration reads `plugin.toml` once. If you change the manifest (new capabilities, new `[contributes]` entries), disable the plugin, re-register the folder via Develop so the new manifest is picked up, then enable it again.

### The rebuild lock (compiled `process` plugins)

A running plugin process holds its own executable open. On Windows a fresh `cargo build --release` (or any rebuild that overwrites the exe) fails with "Access is denied" while the plugin is enabled. The flow is: disable the plugin in Settings (the process exits cleanly), rebuild, then re-enable. A `cargo check` works while it runs because it writes no exe.

### Common pitfalls

- **No response to `initialize` within 10 seconds** kills the plugin. Do not do slow startup work before responding; do it on `initialized`.
- **Missing `ping` responses** restart you. Make sure your read loop is never blocked.
- **Assuming event replay.** After a restart, rebuild state from host methods.
- **Requesting capabilities you do not use.** It reads as a red flag in the consent dialog and during index review.
- **`ui` plugin hooks not working.** If React hooks throw, your bundle did not alias `react` to the host copy. Check the shims.

---

## 9. Publish and contribute a plugin

Once it works locally, you publish by packaging a signed release, hosting it, and adding an entry to an index. The official index lives at the [streamnook-plugins](https://github.com/StreamNook/streamnook-plugins) repository.

### Which index

- The **official index** lists a focused, curated set of tier A and B plugins (emote and badge providers, chat tools, overlays, notifiers, integrations, local features). The app trusts it out of the box.
- **Community sources** carry everything else, including tier C power-user add-ons that run their own background work or use the user's login. Anyone can run a community source; the format is identical. Users add a community source explicitly, confirming its key fingerprint.

Your tier (declared in the manifest, verified by the curator) decides where you can be listed. You cannot self-certify into a lower tier. See the tier table in [MANIFEST.md](MANIFEST.md).

### Step 1: Create your signing key

```
minisign -G
```

Keep the secret key offline and treat it like a password. Your **public** key identifies you to every StreamNook user: the first install of your plugin pins it, and every future update must be signed with the same key. Losing or leaking it is a real problem.

### Step 2: Package the release

Zip the plugin folder contents so the manifest sits at the **zip root**, not inside a subfolder:

```
my-plugin-1.0.0.zip
├── plugin.toml
├── my-plugin.exe     (or dist/main.js for a ui plugin)
└── assets/
```

### Step 3: Sign and hash

```
minisign -Sm my-plugin-1.0.0.zip          produces my-plugin-1.0.0.zip.minisig
certutil -hashfile my-plugin-1.0.0.zip SHA256
```

### Step 4: Host the files

Upload the zip and the `.minisig` to a stable, direct-download location you control. A GitHub release on your plugin's own repository is the expected shape. StreamNook never hosts plugin artifacts; authors do.

### Step 5: Open a pull request to the index

Add your entry to `index.json`:

```json
{
  "id": "yourhandle.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "tier": "A",
  "description": "One or two plain sentences about what it does.",
  "homepage": "https://github.com/yourhandle/my-plugin",
  "host_min": "8.0.0",
  "released_at": "2026-06-10T00:00:00Z",
  "author": {
    "name": "yourhandle",
    "pubkey": "RW...your minisign public key..."
  },
  "artifact": {
    "url": "https://github.com/yourhandle/my-plugin/releases/download/v1.0.0/my-plugin-1.0.0.zip",
    "sha256": "...",
    "signature_url": "https://github.com/yourhandle/my-plugin/releases/download/v1.0.0/my-plugin-1.0.0.zip.minisig"
  }
}
```

Make the detail page worth opening by adding the optional presentation fields, which the marketplace renders:

```json
"icon_url":   "https://raw.githubusercontent.com/yourhandle/my-plugin/main/assets/icon.png",
"readme_url": "https://raw.githubusercontent.com/yourhandle/my-plugin/main/README.md"
```

The README renders as plain markdown in the app (headings, lists, images, code blocks; raw HTML shows as text, not rendered). Lead with what the plugin does and a screenshot.

### Step 6: Review

Before an entry merges, the curator checks:

- The manifest inside the artifact matches the index entry exactly (id, version, tier).
- The declared tier matches what the plugin actually does, including its network behavior.
- The signature verifies against the public key in the entry.
- The id does not squat another author's namespace. The `app.streamnook.` prefix is reserved for first-party plugins and rejected from third parties.

### Multi-platform builds

A `process` plugin is a native binary, so ship one build per OS. An index entry can carry a `platforms` map keyed by `<os>-<arch>` (`windows-x86_64`, `macos-x86_64`, `macos-aarch64`, `linux-x86_64`, `linux-aarch64`), each with its own url, hash, size, and signature. The host installs the build matching the user's platform and shows the plugin as unavailable where there is no build. `id`, `version`, and `tier` must be identical across platforms. A `ui` plugin is one artifact everywhere, so it needs no `platforms` map. Details in [SIGNING.md](SIGNING.md).

---

## 10. Updating and rotating keys

Ship a new version by uploading a new signed zip and opening a PR that bumps `version`, `artifact`, and `updated_at`. **Sign with the same key.**

If you must change your key, the index entry lists the old key in `previous_pubkeys` and the artifact carries a second signature by the old key (`<artifact>.minisig.prev`). With that rotation proof the host re-pins silently. Without it, the update is blocked for everyone who has your plugin installed, and they see a prominent warning naming both fingerprints. So guard your key, and if you rotate, provide the proof.

An update that requests **new capabilities** re-runs the consent flow on the user's machine. Adding capabilities is a visible event, not a silent one.

---

## 11. Pre-publish checklist

- [ ] `id` is a unique lowercase dotted id (e.g. `yourhandle.my-plugin`), not under `app.streamnook.`
- [ ] `version` bumped (semver) since the last release
- [ ] `[capabilities]` lists only what the plugin actually uses
- [ ] `network` honestly reflects whether the plugin connects out
- [ ] `tier` matches what the plugin does
- [ ] `host_min` set to the lowest StreamNook version you tested against
- [ ] Plugin responds to `initialize` fast, answers `ping`, handles `shutdown`/`exit` (process kind)
- [ ] Plugin degrades cleanly when a capability is denied or a credential is revoked
- [ ] `ui` bundle aliases `react`, `react/jsx-runtime`, `framer-motion` to the host shims
- [ ] README leads with what it does and a screenshot
- [ ] Zip has `plugin.toml` at the root, signed with minisign, SHA-256 computed
- [ ] Artifact and `.minisig` hosted at stable URLs you control
- [ ] Index entry matches the manifest exactly

---

## 12. Reference map

| Topic | Document |
|---|---|
| Overview and vocabulary | [README.md](README.md) |
| Wire protocol, events, methods, errors, versioning | [PROTOCOL.md](PROTOCOL.md) |
| Manifest schema and tiers | [MANIFEST.md](MANIFEST.md) |
| Capability vocabulary and consent strings | [CAPABILITIES.md](CAPABILITIES.md) |
| Hook mechanism and catalog | [HOOKS.md](HOOKS.md) |
| The `ui` runtime, the `api` object, building, hybrid plugins | [UI_PLUGINS.md](UI_PLUGINS.md) |
| Signing, index format, key pinning and rotation | [SIGNING.md](SIGNING.md) |
| What "official" means | [OFFICIAL.md](OFFICIAL.md) |
| Publishing walkthrough (in the index repo) | [streamnook-plugins/PUBLISHING.md](https://github.com/StreamNook/streamnook-plugins/blob/main/PUBLISHING.md) |

Working examples in this tree:

- `examples/plugins/example-tick/` — minimal `process` plugin (Node)
- `plugins/lists/` — pure `ui` plugin (TypeScript/React)
- `plugins/drops-farmer/`, `plugins/ad-bypass/` — hybrid `process` + `ui` plugins (Rust sidecar + React module)
