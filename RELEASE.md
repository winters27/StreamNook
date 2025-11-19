# StreamNook Release Workflow

This document describes the automated release workflow for StreamNook.

## Version Management

StreamNook uses semantic versioning (MAJOR.MINOR.PATCH). The version is automatically synchronized across:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

## Quick Release Commands

### Interactive Mode (Recommended for First-Time Users)
Prompts you through each step with options to customize:
```bash
# Increment patch version (1.0.0 → 1.0.1)
npm run version:patch

# Increment minor version (1.0.0 → 1.1.0)
npm run version:minor

# Increment major version (1.0.0 → 2.0.0)
npm run version:major
```

The script will interactively ask you:
- ✅ Whether to commit changes (with custom message option)
- ✅ Whether to create a git tag
- ✅ Whether to push to remote
- ✅ Provides direct GitHub release link with pre-filled tag

### Fully Automated Mode (For Experienced Users)
Automatically commits, tags, and pushes without prompts:
```bash
# Increment patch version and auto-commit/tag/push
npm run version:patch:auto

# Increment minor version and auto-commit/tag/push
npm run version:minor:auto

# Increment major version and auto-commit/tag/push
npm run version:major:auto
```

### With Build
Add build step after version increment:
```bash
# Interactive mode + build
npm run release:patch
npm run release:minor
npm run release:major

# Fully automated mode + build
npm run release:patch:auto
npm run release:minor:auto
npm run release:major:auto
```

## Complete Release Process

### 1. Increment Version and Build

**Important: Close the app before building!** The build process cannot replace the exe if it's running.

Choose the appropriate version increment:
```bash
npm run release:patch  # For bug fixes
npm run release:minor  # For new features
npm run release:major  # For breaking changes
```

This will:
- Update version in all config files
- Build the application
- Create the executable in `src-tauri/target/release/`

**If you get "Access is denied" error:**
- Close StreamNook.exe completely
- Make sure no instances are running in Task Manager
- Run the build command again

### 2. Commit and Tag

```bash
# Commit the version changes
git add .
git commit -m "chore: bump version to v1.0.1"

# Create a git tag
git tag v1.0.1

# Push changes and tags
git push && git push --tags
```

### 3. Create GitHub Release

1. Go to https://github.com/winters27/StreamNook/releases/new
2. Select the tag you just created (e.g., `v1.0.1`)
3. Set the release title (e.g., `StreamNook v1.0.1`)
4. Add release notes describing changes
5. Upload the built executable:
   - File: `src-tauri/target/release/StreamNook.exe`
   - **Important**: Rename it to just `StreamNook.exe` (remove any version numbers)
6. Publish the release

### 4. Verify Auto-Update

The app will automatically check for updates when users:
- Open the Settings → General tab
- The app compares the current version with the latest GitHub release
- If an update is available, users can click "Update & Restart"

## Update System Details

### How It Works

1. **Version Check**: App queries `https://github.com/winters27/StreamNook/releases/latest`
2. **Download**: If newer version exists, downloads `StreamNook.exe` from the release
3. **Replace**: Uses a batch script to:
   - Close the current app
   - Replace the old exe with the new one
   - Restart the app
   - Clean up temporary files

### Release URL Pattern

The update system expects releases to follow this pattern:
```
https://github.com/winters27/StreamNook/releases/download/v{VERSION}/StreamNook.exe
```

Example:
```
https://github.com/winters27/StreamNook/releases/download/v1.0.1/StreamNook.exe
```

## Troubleshooting

### Version Mismatch
If versions get out of sync, manually edit:
- `package.json` → `"version": "1.0.0"`
- `src-tauri/Cargo.toml` → `version = "1.0.0"`
- `src-tauri/tauri.conf.json` → `"version": "1.0.0"`

Then run the increment script to sync them:
```bash
npm run version:patch
```

### Build Fails
Ensure all dependencies are installed:
```bash
npm install
```

### Update Not Detected
Verify:
1. GitHub release is published (not draft)
2. Release has the correct tag format (`v1.0.1`)
3. `StreamNook.exe` is attached to the release
4. File is named exactly `StreamNook.exe` (case-sensitive)

## Best Practices

1. **Always test locally** before creating a release
2. **Use semantic versioning** appropriately:
   - Patch: Bug fixes, minor improvements
   - Minor: New features, non-breaking changes
   - Major: Breaking changes, major rewrites
3. **Write clear release notes** describing what changed
4. **Test the update process** by installing an older version and updating
5. **Keep the exe name consistent** as `StreamNook.exe` in all releases
