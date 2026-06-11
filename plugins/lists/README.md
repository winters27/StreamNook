# Lists

Keep reference lists at hand while you watch: known usernames, reusable chat commands, stream titles, giveaway winners, anything line-shaped.

## What you get

- **Floating panel** inside the app: draggable, resizable, non-modal, so the stream and chat stay interactive while you compare names against live chat. Toggle it from the title bar button or Ctrl+Shift+L.
- **Popout window** that can leave the app entirely, with a keep-on-top pin for floating over a game while moderating.
- **Mod Logs dock**: show a list as a column right inside the Moderator Logs pane.
- **Command palette rows**: "Open Lists" plus one row per list for jumping straight to it.

## Working with entries

- Click an entry to copy it. Burst-copying is the core workflow, so feedback is a quiet inline check, not a toast.
- Hover an entry to insert it into chat, edit it, or remove it.
- Entries take an optional note (shown muted, searchable, never copied), so "alt of X" annotations can't pollute what gets pasted into /ban.
- Paste a whole roster into the add box and every line becomes an entry. Comma-separated single words split too, and spreadsheet rows become text + note.
- Big lists get a search box, an A-Z sort toggle, and copy-whole-list.

## Building from source

```
node plugins/lists/build.mjs
```

The bundle lands at `dist/main.js`. Register the plugin folder via the app's plugin development flow to run a local build.
