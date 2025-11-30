# StreamNook Bundled Distribution System - Implementation Status

## Overview

Transform StreamNook from a separate-download model to an all-in-one bundled distribution where Streamlink and TTV LOL plugin are pre-packaged with the app.

**Key Insight**: 7z compression reduces the ~35MB uncompressed bundle to ~7-10MB. This makes "always download full bundle" the simplest and best approach.

---

## Implementation Progress

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | GitHub Actions Workflows | ✅ COMPLETE |
| Phase 2 | Component Manifest System (Rust structs) | ✅ COMPLETE |
| Phase 3 | Backend Component Commands | ✅ COMPLETE |
| Phase 4 | Frontend SetupWizard Simplification | ✅ COMPLETE |
| Phase 5 | Frontend UpdatesSettings Redesign | ✅ COMPLETE |
| Phase 6 | Release Manager Simplification | ✅ COMPLETE |

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                    RELEASE PACKAGE STRUCTURE                        │
├─────────────────────────────────────────────────────────────────────┤
│ StreamNook-v2.2.0-bundle.7z  (~7-10 MB compressed)                 │
│ ├── StreamNook.exe              (Main app ~15 MB)                  │
│ ├── streamlink/                 (Portable Streamlink ~15 MB)       │
│ │   ├── streamlink.exe                                             │
│ │   ├── plugins/                                                   │
│ │   │   └── twitch.py           (TTV LOL ~200 KB)                  │
│ │   └── ...                                                        │
│ ├── components.json             (Version manifest)                  │
│ └── CHANGELOG.md                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Directory Structure After Install:**
```
%LOCALAPPDATA%/StreamNook/
├── settings.json
├── components.json          ← Version tracking
├── cache/
│   ├── emotes/
│   └── ...
├── streamlink/              ← Portable Streamlink
│   ├── streamlink.exe
│   ├── plugins/
│   │   └── twitch.py        ← TTV LOL plugin
│   └── (other streamlink files)
└── ...
```

---

## PHASE 1: GitHub Actions Workflows ✅ COMPLETE

### Created Files

#### `.github/workflows/build-release.yml`
**Triggers:**
- Push to `main` that modifies `src-tauri/Cargo.toml` (version bump)
- Manual trigger via `workflow_dispatch`

**What it does:**
1. Extracts version from Cargo.toml
2. Checks if release already exists (skips if so)
3. Builds StreamNook with `npm run tauri build`
4. Downloads latest Streamlink portable from `streamlink/windows-builds`
5. Downloads latest TTV LOL plugin (`twitch.py`) from `2bc4/streamlink-ttvlol`
6. Generates `components.json` manifest with all versions
7. Creates 7z bundle with max compression
8. Creates GitHub release with: bundle, components.json, checksums.txt

#### `.github/workflows/check-dependencies.yml`
**Triggers:**
- Daily at 6 AM UTC (cron)
- Manual trigger via `workflow_dispatch`

**What it does:**
1. Checks latest Streamlink & TTV LOL versions against current release
2. If updates found:
   - Downloads StreamNook.exe from last release (doesn't rebuild)
   - Downloads new Streamlink/TTV LOL versions
   - Bundles and creates new release with tag like `v2.1.0-dep.1`

---

## PHASE 2: Component Manifest System ✅ COMPLETE

### Created Files

#### `components.json` (repo root - template)
```json
{
    "schema_version": 1,
    "streamnook": {
        "version": "2.1.0",
        "build_date": "2025-11-30T00:00:00Z"
    },
    "components": {
        "streamlink": {
            "version": "7.1.3",
            "source_url": "https://github.com/streamlink/windows-builds/releases"
        },
        "ttvlol": {
            "version": "7.0.1-20241015",
            "source_url": "https://github.com/2bc4/streamlink-ttvlol/releases"
        }
    }
}
```

#### `src-tauri/src/models/components.rs`
```rust
// Key structs:
pub struct ComponentManifest {
    pub schema_version: u32,
    pub streamnook: StreamNookInfo,
    pub components: Components,
}

pub struct StreamNookInfo {
    pub version: String,
    pub build_date: String,
}

pub struct Components {
    pub streamlink: ComponentInfo,
    pub ttvlol: ComponentInfo,
}

pub struct ComponentInfo {
    pub version: String,
    pub source_url: String,
}

pub struct BundleUpdateStatus {
    pub update_available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: Option<String>,
    pub bundle_name: Option<String>,
    pub download_size: Option<String>,
    pub component_changes: Option<ComponentChanges>,
}

pub struct ComponentChanges {
    pub streamnook: Option<VersionChange>,
    pub streamlink: Option<VersionChange>,
    pub ttvlol: Option<VersionChange>,
}

pub struct VersionChange {
    pub from: String,
    pub to: String,
}
```

**Key Methods:**
- `ComponentManifest::load_from_file(path)` - Load from JSON file
- `ComponentManifest::save_to_file(path)` - Save to JSON file
- `ComponentManifest::compare(&self, remote)` - Compare versions, return BundleUpdateStatus

---

## PHASE 3: Backend Component Commands ✅ COMPLETE

### Created Files

#### `src-tauri/src/commands/components.rs`

**Available Tauri Commands:**

| Command | Description | Returns |
|---------|-------------|---------|
| `check_components_installed()` | Check if bundled components exist in AppData | `bool` |
| `get_bundled_streamlink_path()` | Get path to bundled streamlink.exe | `String` |
| `get_local_component_versions()` | Read local components.json | `ComponentManifest` |
| `get_remote_component_versions()` | Fetch components.json from GitHub releases | `ComponentManifest` |
| `check_for_bundle_update()` | Compare local vs remote, get update info | `BundleUpdateStatus` |
| `extract_bundled_components()` | Copy from exe directory to AppData (first run) | `()` |
| `download_and_install_bundle(app_handle)` | Download & install full bundle update | `()` |

**Usage Examples (TypeScript):**
```typescript
import { invoke } from '@tauri-apps/api/core';

// Check if components are installed
const installed = await invoke<boolean>('check_components_installed');

// Get local versions
const local = await invoke<ComponentManifest>('get_local_component_versions');

// Check for updates
const updateStatus = await invoke<BundleUpdateStatus>('check_for_bundle_update');
if (updateStatus.update_available) {
  console.log(`Update available: ${updateStatus.latest_version}`);
  console.log(`Download size: ${updateStatus.download_size}`);
}

// Install update
await invoke('download_and_install_bundle');
```

#### `src-tauri/src/services/streamlink_manager.rs` (Updated)

**New Methods:**

| Method | Description |
|--------|-------------|
| `get_effective_path(user_path)` | Get streamlink path with priority: bundled → user → system PATH |
| `is_bundled_available()` | Check if bundled streamlink exists |
| `get_bundled_path()` | Get Option<PathBuf> to bundled streamlink |

**Path Priority:**
1. `%LOCALAPPDATA%/StreamNook/streamlink/streamlink.exe` (bundled)
2. User-configured custom path (if exists)
3. `"streamlink"` (system PATH)

---

## PHASE 4: Frontend SetupWizard Simplification ✅ COMPLETE

### File to Modify
`src/components/SetupWizard.tsx`

### Current Steps (7 steps)
1. Welcome
2. Download Streamlink ← **REMOVE**
3. Verify Streamlink ← **CHANGE to "Setting Up..."**
4. Install TTV LOL ← **REMOVE**
5. Drops Login
6. Main Login
7. Ready

### New Steps (5 steps)
1. **Welcome** - Explain all-in-one bundle
2. **Setting Up** - Auto-extract components with progress
3. **Drops Login** - Optional
4. **Main Login** - Optional
5. **Ready!**

### Implementation Guide

```tsx
// Step 2: Setting Up
const [extractionStatus, setExtractionStatus] = useState<'checking' | 'extracting' | 'done' | 'error'>('checking');

useEffect(() => {
  const setup = async () => {
    try {
      // Check if already installed
      const installed = await invoke<boolean>('check_components_installed');
      if (installed) {
        setExtractionStatus('done');
        // Auto-advance to next step
        setTimeout(() => setCurrentStep(3), 500);
        return;
      }
      
      // Extract components
      setExtractionStatus('extracting');
      await invoke('extract_bundled_components');
      setExtractionStatus('done');
      
      // Auto-advance after success
      setTimeout(() => setCurrentStep(3), 1000);
    } catch (error) {
      setExtractionStatus('error');
      console.error('Extraction failed:', error);
    }
  };
  
  setup();
}, []);

// UI: Show progress indicators
// - "Extracting Streamlink..." with spinner
// - "Installing TTV LOL plugin..." with spinner
// - Checkmarks as each completes
```

---

## PHASE 5: Frontend UpdatesSettings Redesign ✅ COMPLETE

### File to Modify
`src/components/settings/UpdatesSettings.tsx`

### Current Structure
- StreamNook Updates section (version check, update button)
- Streamlink Path input + download button
- TTV LOL section (install/update button)
- **3 separate update flows**

### New Structure
- **Single unified section**
- Shows current version: "v2.1.0"
- Update indicator: "Update available: v2.2.0"
- **One "Update & Restart" button**
- Optional: Expandable "What's in this update" with component changes

### TypeScript Interface (from Rust)
```typescript
interface BundleUpdateStatus {
  update_available: boolean;
  current_version: string;      // e.g., "2.1.0"
  latest_version: string;       // e.g., "2.2.0"
  download_url: string | null;
  bundle_name: string | null;
  download_size: string | null; // e.g., "7.5 MB"
  component_changes: {
    streamnook: { from: string; to: string } | null;
    streamlink: { from: string; to: string } | null;
    ttvlol: { from: string; to: string } | null;
  } | null;
}
```

### Implementation Guide

```tsx
const [updateStatus, setUpdateStatus] = useState<BundleUpdateStatus | null>(null);
const [checking, setChecking] = useState(true);
const [updating, setUpdating] = useState(false);

// Check for updates on mount
useEffect(() => {
  const checkUpdates = async () => {
    try {
      const status = await invoke<BundleUpdateStatus>('check_for_bundle_update');
      setUpdateStatus(status);
    } catch (error) {
      console.error('Failed to check updates:', error);
    } finally {
      setChecking(false);
    }
  };
  checkUpdates();
}, []);

// Listen for progress events
useEffect(() => {
  const unlisten = listen('bundle-update-progress', (event) => {
    console.log('Update progress:', event.payload);
    // Show progress to user
  });
  return () => { unlisten.then(fn => fn()); };
}, []);

// Update handler
const handleUpdate = async () => {
  setUpdating(true);
  try {
    await invoke('download_and_install_bundle');
    // App will restart automatically
  } catch (error) {
    console.error('Update failed:', error);
    setUpdating(false);
  }
};

// UI Example
return (
  <div>
    <h3>StreamNook</h3>
    {checking ? (
      <p>Checking for updates...</p>
    ) : updateStatus?.update_available ? (
      <>
        <p>Current: v{updateStatus.current_version}</p>
        <p>Available: v{updateStatus.latest_version}</p>
        <p>Download size: {updateStatus.download_size}</p>
        <button onClick={handleUpdate} disabled={updating}>
          {updating ? 'Updating...' : 'Update & Restart'}
        </button>
      </>
    ) : (
      <p>You're up to date! v{updateStatus?.current_version}</p>
    )}
  </div>
);
```

---

## PHASE 6: Release Manager Simplification ✅ COMPLETE

### File to Modify
`scripts/release_manager.ps1`

### What to Remove
- ~~Download Streamlink~~
- ~~Download TTV LOL~~
- ~~Create .7z bundle~~
- ~~Upload to GitHub~~
- ~~Create release~~

### What to Keep/Add
1. Gemini analysis of git diffs → generate atomic commits
2. Health checks: `cargo fmt --check`, `cargo clippy`
3. **LOCAL BUILD TEST**: `npm run tauri build` (verify no errors)
4. If build passes → Version bump (Cargo.toml, package.json)
5. Update CHANGELOG.md
6. Commit all changes
7. Push to main → **GitHub Actions takes over**

---

## Update Flow Diagrams

### New User (First Install)
```
Download StreamNook-v2.2.0-bundle.7z (~7-10 MB)
        │
        ▼
   Extract .7z to desired location
        │
        ▼
   Run StreamNook.exe
        │
        ▼
   App detects first run (no components.json in AppData)
        │
        ▼
   SetupWizard Step 2: "Setting Up..."
   ├── invoke('extract_bundled_components')
   ├── Copies streamlink/ to %LOCALAPPDATA%/StreamNook/
   └── Copies components.json to AppData
        │
        ▼
   Setup complete → Continue to login steps
```

### Existing User (Update)
```
   App startup or Settings → Updates tab
        │
        ▼
   invoke('check_for_bundle_update')
        │
        ▼
   Returns BundleUpdateStatus with:
   - update_available: true/false
   - version info
   - download_size
   - component_changes
        │
        ▼
   User clicks "Update & Restart"
        │
        ▼
   invoke('download_and_install_bundle')
   ├── Downloads .7z to %TEMP%
   ├── Extracts with 7z
   ├── Updates components in AppData
   ├── Creates batch script for exe replacement
   └── Exits app, batch script restarts
```

---

## Files Changed Summary

### Completed (Phases 1-3)

| File | Change Type | Description |
|------|-------------|-------------|
| `.github/workflows/build-release.yml` | **NEW** | Build & release on version bump |
| `.github/workflows/check-dependencies.yml` | **NEW** | Daily dependency check |
| `components.json` | **NEW** | Template manifest in repo root |
| `src-tauri/src/models/components.rs` | **NEW** | Rust structs for manifest |
| `src-tauri/src/models/mod.rs` | Modified | Added `pub mod components;` |
| `src-tauri/src/commands/components.rs` | **NEW** | 7 Tauri commands |
| `src-tauri/src/commands/mod.rs` | Modified | Added `pub mod components;` |
| `src-tauri/src/main.rs` | Modified | Import + register 7 commands |
| `src-tauri/src/services/streamlink_manager.rs` | Modified | Added bundled path helpers |

### Pending (Phases 4-6)

| File | Change Type | Description |
|------|-------------|-------------|
| `src/components/SetupWizard.tsx` | Modify | Simplify 7→5 steps |
| `src/components/settings/UpdatesSettings.tsx` | Modify | Unified update UI |
| `src/stores/AppStore.ts` | Modify | Add `bundleUpdateStatus` state (optional) |
| `scripts/release_manager.ps1` | Modify | Remove build/bundle logic |

---

## Testing Checklist

Before deploying:

- [ ] Run `cargo check` to verify Rust compiles
- [ ] Run `cargo clippy` for linting
- [ ] Test `extract_bundled_components()` with mock streamlink folder
- [ ] Test `check_for_bundle_update()` against real GitHub API
- [ ] Test full update flow with a test release
- [ ] Verify SetupWizard works for new users
- [ ] Verify UpdatesSettings shows correct status
- [ ] Test rollback by manually installing Streamlink

---

## Rollback Plan

If bundled approach has issues:
1. Old download commands in `settings.rs` still exist (deprecated but functional)
2. Users can manually install Streamlink and point to custom path
3. `streamlink_manager.rs` falls back to system PATH if bundled not found
