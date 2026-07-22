# Official StreamNook Plugins

What "official" means, how first-party plugins are branded, and what can never be official.

## Definition

An official plugin is one that is:

1. Authored and maintained by the StreamNook project.
2. Signed by the StreamNook author key.
3. Listed in the official index (the one the app trusts out of the box).

All three must hold. A fork of an official plugin signed by someone else is not official, and the key pinning in SIGNING.md is what makes that distinction enforceable rather than cosmetic.

## Scope of the official index

The official index lists the curated A and B tiers only; this is decision 10 in the migration audit and the host enforces it (a tier C entry in the official index is ignored). The official set is the focused, first-party collection. Heavier or specialized add-ons such as background automation or alternate playback resolution are tier C: they are community-distributed, published under their authors' own identity, and not part of the first-party set. Keeping them out of the official index keeps that set focused and first-party, which is the same reason the core itself stays lean.

What is official: emote and badge providers, chat tools, overlays, notifiers, integrations, and similar A and B functionality.

## Branding conventions

- Id namespace: official plugins use `app.streamnook.<name>` (for example `app.streamnook.example-tick`). Community plugins must not use the `app.streamnook.` prefix; the official index curator rejects it from third parties, and its presence outside the official index is a red flag the UI may surface.
- Author: `StreamNook`, with `verified: true` in the official index entry.
- The UI derives the official presentation (badge on the source, verified mark on the author) from the index and pinned keys, never from the manifest alone. A manifest cannot self-declare officialness.
- Marketplace presentation: every official entry should carry `icon_url`, `readme_url`, and accurate `updated_at`, so official plugins set the quality bar for detail pages.

## Repository and release shape (per plugin)

```
streamnook-plugin-<name>/
├── README.md          (drives the marketplace detail page via readme_url)
├── plugin.toml
├── src/ ...
└── release: <id>-<version>.zip + .zip.minisig
```

The README leads with what the plugin does and a screenshot; the marketplace renders it as plain markdown (no HTML).

## Open items before the first official release

- Where the official index lives (a public git repository serving `index.json` raw is the working assumption) and the publishing workflow.
- Custody of the two project keys (index operator key and plugin author key): generated and held by the project owner, never in CI or the repo. Minisign keypairs; the public halves get pinned in the app (`install.rs OFFICIAL_INDEX`) and the index respectively.
- Whether download counts are tracked at all, and by what (the `downloads` field is optional).
