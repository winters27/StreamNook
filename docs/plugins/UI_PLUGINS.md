# UI Plugins: in-app interface add-ons (runtime kind `ui`)

A second runtime kind alongside `process`. A UI plugin is a single JavaScript module the host loads into its own interface at runtime. It can contribute real interface: a title bar button, a floating panel, a column docked into an existing pane, command palette rows, bindable shortcuts, and its own popout OS windows. Installing one brings the whole feature; uninstalling removes every trace.

Both kinds share one manifest format, one marketplace, one signing chain, and one install and consent flow. They differ only in where the code runs:

| | `process` | `ui` |
|---|---|---|
| Runs as | A separate executable beside the app | A JavaScript module inside the app interface |
| Best at | Background behavior: long-running loops, own networking, work that must not depend on the interface being awake | Interface features: panels, buttons, windows, anything the user sees and touches |
| Can ship UI | No (native UI stays in the host, driven through hooks) | Yes (contributes its own components) |
| Talks to the host via | JSON-RPC over stdio (PROTOCOL.md) | A JavaScript `api` object passed at load |
| Per-platform builds | One binary per OS | One artifact everywhere the app runs |

Choosing: if the feature is something the app *does in the background*, make it a `process` plugin. If it is something the user *sees and operates*, make it a `ui` plugin.

## Manifest

Identical schema (MANIFEST.md), with the runtime block selecting the kind:

```toml
id          = "app.streamnook.lists"
name        = "Lists"
version     = "1.0.0"
author      = "StreamNook"
tier        = "A"
description = "User-curated reference lists: usernames, commands, titles."
host_min    = "7.0.0"

[runtime]
kind  = "ui"
entry = "dist/main.js"
```

For `kind = "ui"`:

- `entry` is the path of the bundled JavaScript module, relative to the plugin directory.
- `args` and `transport` are not used and should be omitted.
- `[capabilities]` lists (`events`, `host_methods`, `credentials`, `network`, `ui`) are wire-protocol concepts for `process` plugins and stay empty. The module contract below is the complete surface a UI plugin gets.
- `[contributes]` is likewise unused: UI plugin contributions are registered live through the `api` object, not declared in the manifest.

## Module contract

The entry file is a bundled ES module exporting:

```js
// Called once when the plugin loads in the main window. Register
// contributions here. May return a cleanup function.
export function activate(api) { /* ... */ }

// Optional. Called before the plugin is unloaded (disable, uninstall,
// update). The host also tears down every registration automatically,
// so this is for the plugin's own listeners and timers.
export function deactivate() { /* ... */ }

// Optional. Called in a popout OS window opened via api.windows.open.
// Returns the React component to render as that window's content
// (the host provides the window chrome, theme, and titlebar).
export function windowSurface(surfaceId, api) { return MyComponent; }
```

Loading: the host reads the bundle from the installed plugin directory and imports it when the plugin is enabled, at app start and on every enable. Disabling unloads it: `deactivate` runs, every registration is removed, and the module instance is discarded. Re-enabling evaluates a fresh instance.

Windows that host plugin contributions (the main window, the multi-chat popout) each load enabled UI plugins into their own context. `activate` runs per window; registrations only surface where a consumer for them exists.

## The `api` object

Everything a UI plugin can reach. Frozen, per plugin, passed to `activate` and `windowSurface`.

### `api.libs`

The host's own copies of shared libraries, so plugin bundles stay small and run on the same React tree:

- `api.libs.react` (also wired through the build shims, below)
- `api.libs.reactJsxRuntime`
- `api.libs.framerMotion`

Everything else a plugin needs (icons, state libraries) it bundles itself.

### `api.components`

Native components plugins should reuse instead of rebuilding:

- `api.components.Tooltip` (props: `content`, `side`, `delay`, `disabled`, `children`)

### `api.ui`

- `api.ui.registerTitleBarButton({ id, tooltip, Icon, onClick, useIsActive? })`
  Adds a button to the title bar's action cluster, rendered in native style. `Icon` is a component receiving `{ size }`. `useIsActive` is an optional React hook returning whether the button shows the accent tint (read it from the plugin's own state).
- `api.ui.registerOverlay({ id, Component })`
  Mounts `Component` at the app root, above the main layout. The component owns its visibility (render `null` when closed), positioning, and animation. This is how a plugin ships a floating panel.
- `api.ui.registerSlot(slotId, { id, label, Icon, Component })`
  Fills a named slot a host feature exposes. The owning feature decides how slot contributions render. Slot ids are namespaced and host-defined, like hook ids in HOOKS.md.

### `api.commands`

- `api.commands.registerKeybinding({ id, label, description?, category?, defaultBindings, keywords?, run })`
  Adds a bindable command: it dispatches globally, appears in the Keybindings settings, and user rebinds persist under its `id`. A plugin replacing a former core feature may reuse the historical command id so existing user rebinds keep working.
- `api.commands.registerPaletteItems(provider)`
  `provider` is called on each palette open and returns rows: `{ id, section?, title, subtitle?, keywords?, icon?, run }`.

### `api.windows`

- `api.windows.open({ surface, title, width?, height?, minWidth?, minHeight? })`
  Opens (or focuses) a popout OS window for this plugin. The host renders the standard frameless titlebar (icon, title, keep-on-top pin, minimize, close), applies the user's theme, and mounts the component returned by the module's `windowSurface(surface, api)`. One window per `(plugin, surface)`; reopening focuses it.

### `api.events`

- `api.events.emit(name, payload)` and `api.events.listen(name, handler) -> Promise<unlisten>`
  App-wide events that cross window boundaries, for state sync between the main window and popouts. Names should be prefixed with the plugin's id unless keeping a historical name for data continuity. Listeners are cleaned up automatically at unload.

### `api.chat`

- `api.chat.useHasTarget()` React hook: true when a chat compose box exists in this window (a stream is being watched or the multi-stream grid is up).
- `api.chat.insertText(text) -> boolean` inserts into the chat compose box at the caret; false when none is mounted.

### `api.storage`

UI plugins read and write `localStorage` directly (it is shared across the app's windows, which is what makes popout sync work). Keys must be prefixed: `streamnook.<feature>.` for a feature the plugin owns. There is no separate storage API.

### `api.log`

`api.log.debug / warn / error`, prefixed with the plugin id in the app log.

## Slot catalog

Slots host features currently expose to UI plugins:

- `modlogs.dock`: a column inside the Moderator Logs pane, side by side with the log columns. The pane shows one toggle button per contribution (using its `Icon` and `label`) and persists each toggle at `streamnook.modlogs.dock.<id>`.

## Building a UI plugin

Bundle to a single ES module with the shared libraries aliased to the host's copies. With esbuild:

```js
import { build } from 'esbuild';
build({
  entryPoints: ['src/index.tsx'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/main.js',
  jsx: 'automatic',
  alias: {
    'react': './shims/react.cjs',
    'react/jsx-runtime': './shims/jsx-runtime.cjs',
    'framer-motion': './shims/framer-motion.cjs',
  },
});
```

Each shim re-exports the host copy, e.g. `shims/react.cjs`:

```js
module.exports = globalThis.__STREAMNOOK_HOST_LIBS__.react;
```

Sharing React this way is required, not an optimization: contributed components render inside the host's React tree, and hooks only work when both sides run the same React instance. Everything else (icons, a state library) is bundled into the plugin normally.

## Trust model

A UI plugin runs inside the app's interface with the same reach as the app's own interface code. That is the same trust bar as a `process` plugin, which runs native code on the machine. What protects users is unchanged across both kinds: curation into a signed index, artifact signatures and hashes verified before anything runs, the install consent dialog, and one-click disable and uninstall.

## Versioning

The module contract and `api` surface above are version 1 of the UI runtime. Additive changes (new `api` members, new slots, new optional fields) do not bump it; removing or changing existing members does. Plugins should feature-detect optional members (`if (api.ui.registerSlot)`).
