import type { CompactViewPreset } from '../types';

/**
 * Built-in compact view presets for common monitor configurations.
 * Heights are calculated for 16:9 aspect ratio windows.
 */
export const BUILT_IN_COMPACT_PRESETS: CompactViewPreset[] = [
  // User's primary preset - perfect for 1920x1080 second monitor
  { id: 'preset-1080x608', name: '1080p Second Monitor', width: 1080, height: 608, isBuiltIn: true },
  
  // 4K monitor preset (half of 3840x2160)
  { id: 'preset-1920x1080', name: '4K Monitor Compact', width: 1920, height: 1080, isBuiltIn: true },
  
  // 1440p monitor preset (half of 2560x1440)
  { id: 'preset-1280x720', name: '1440p Monitor Compact', width: 1280, height: 720, isBuiltIn: true },
  
  // Additional size options
  { id: 'preset-1366x768', name: 'Laptop HD', width: 1366, height: 768, isBuiltIn: true },
  { id: 'preset-960x540', name: 'Small Compact', width: 960, height: 540, isBuiltIn: true },
  { id: 'preset-854x480', name: 'Mini', width: 854, height: 480, isBuiltIn: true },
];

export const DEFAULT_COMPACT_PRESET_ID = 'preset-1080x608';

/**
 * Resolves the selected preset from settings.
 * Returns the matching built-in or custom preset, or the default if not found.
 */
export function getSelectedCompactViewPreset(
  selectedPresetId?: string,
  customPresets?: CompactViewPreset[]
): CompactViewPreset {
  const id = selectedPresetId || DEFAULT_COMPACT_PRESET_ID;
  
  // Check built-in presets first
  const builtIn = BUILT_IN_COMPACT_PRESETS.find(p => p.id === id);
  if (builtIn) return builtIn;
  
  // Check custom presets
  const custom = customPresets?.find(p => p.id === id);
  if (custom) return custom;
  
  // Fallback to default
  return BUILT_IN_COMPACT_PRESETS[0];
}
