import { useState, useCallback, useRef, useEffect } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { CustomThemeColor } from '../types';

interface ThemeColorPickerProps {
  label: string;
  color: CustomThemeColor;
  onChange: (color: CustomThemeColor) => void;
  showOpacity?: boolean;
}

const ThemeColorPicker = ({ label, color, onChange, showOpacity = true }: ThemeColorPickerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hue, setHue] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [lightness, setLightness] = useState(50);
  const [hexInput, setHexInput] = useState(color.value);
  const [copied, setCopied] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Convert hex to HSL on mount and when color changes
  useEffect(() => {
    const hexToHsl = (hex: string) => {
      const cleanHex = hex.replace('#', '');
      const r = parseInt(cleanHex.slice(0, 2), 16) / 255;
      const g = parseInt(cleanHex.slice(2, 4), 16) / 255;
      const b = parseInt(cleanHex.slice(4, 6), 16) / 255;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h = 0;
      let s = 0;

      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        switch (max) {
          case r:
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            break;
          case g:
            h = ((b - r) / d + 2) / 6;
            break;
          case b:
            h = ((r - g) / d + 4) / 6;
            break;
        }
      }

      setHue(Math.round(h * 360));
      setSaturation(Math.round(s * 100));
      setLightness(Math.round(l * 100));
    };

    if (color.value.startsWith('#') && color.value.length >= 7) {
      hexToHsl(color.value);
      queueMicrotask(() => setHexInput(color.value));
    }
  }, [color.value]);

  const hslToHex = useCallback((h: number, s: number, l: number) => {
    s = s / 100;
    l = l / 100;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;

    if (h >= 0 && h < 60) {
      r = c; g = x; b = 0;
    } else if (h >= 60 && h < 120) {
      r = x; g = c; b = 0;
    } else if (h >= 120 && h < 180) {
      r = 0; g = c; b = x;
    } else if (h >= 180 && h < 240) {
      r = 0; g = x; b = c;
    } else if (h >= 240 && h < 300) {
      r = x; g = 0; b = c;
    } else if (h >= 300 && h < 360) {
      r = c; g = 0; b = x;
    }

    const toHex = (n: number) => {
      const hex = Math.round((n + m) * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };

    return '#' + toHex(r) + toHex(g) + toHex(b);
  }, []);

  const handleHueChange = (h: number) => {
    setHue(h);
    const newHex = hslToHex(h, saturation, lightness);
    setHexInput(newHex);
    onChange({ ...color, value: newHex });
  };

  const handleSaturationChange = (s: number) => {
    setSaturation(s);
    const newHex = hslToHex(hue, s, lightness);
    setHexInput(newHex);
    onChange({ ...color, value: newHex });
  };

  const handleLightnessChange = (l: number) => {
    setLightness(l);
    const newHex = hslToHex(hue, saturation, l);
    setHexInput(newHex);
    onChange({ ...color, value: newHex });
  };

  const handleOpacityChange = (opacity: number) => {
    onChange({ ...color, opacity });
  };

  const handleHexInput = (value: string) => {
    setHexInput(value);
    // Validate and apply hex
    const hexRegex = /^#[0-9A-Fa-f]{6}$/;
    if (hexRegex.test(value)) {
      onChange({ ...color, value });
    }
  };

  const handleCopy = () => {
    const displayColor = color.opacity < 100
      ? `rgba(${parseInt(color.value.slice(1, 3), 16)}, ${parseInt(color.value.slice(3, 5), 16)}, ${parseInt(color.value.slice(5, 7), 16)}, ${color.opacity / 100})`
      : color.value;
    navigator.clipboard.writeText(displayColor);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Preset colors
  const presetColors = [
    '#000000', '#1a1a1a', '#2d2d2d', '#3d3d3d',
    '#ffffff', '#f0f0f0', '#d0d0d0', '#b0b0b0',
    '#ff4444', '#ff6b6b', '#ff9999', '#ffcccc',
    '#44ff44', '#6bff6b', '#99ff99', '#ccffcc',
    '#4444ff', '#6b6bff', '#9999ff', '#ccccff',
    '#ffff44', '#ff44ff', '#44ffff', '#ff9933',
  ];

  // Calculate preview color with opacity
  const previewColor = color.opacity < 100
    ? `rgba(${parseInt(color.value.slice(1, 3), 16)}, ${parseInt(color.value.slice(3, 5), 16)}, ${parseInt(color.value.slice(5, 7), 16)}, ${color.opacity / 100})`
    : color.value;

  return (
    <div ref={pickerRef}>
      {/* Header Row - Clickable to expand */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-4 py-2 px-1 rounded hover:bg-glass-hover transition-colors"
      >
        <div className="flex items-center gap-3">
          <div
            className="w-6 h-6 rounded border border-borderSubtle flex-shrink-0"
            style={{ backgroundColor: previewColor }}
          />
          <span className="text-sm font-medium text-textPrimary">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-textMuted font-mono">
            {color.value.toUpperCase()}
            {showOpacity && color.opacity < 100 && ` ${color.opacity}%`}
          </span>
          {isOpen ? (
            <ChevronUp size={14} className="text-textMuted" />
          ) : (
            <ChevronDown size={14} className="text-textMuted" />
          )}
        </div>
      </button>

      {/* Inline Expanded Picker */}
      {isOpen && (
        <div className="mt-2 p-4 glass-input rounded-lg space-y-4">
          {/* Hue Slider */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Hue</label>
            <input
              type="range"
              min="0"
              max="360"
              value={hue}
              onChange={(e) => handleHueChange(parseInt(e.target.value))}
              className="w-full h-3 rounded cursor-pointer"
              style={{
                background: `linear-gradient(to right, 
                  hsl(0, 100%, 50%), 
                  hsl(60, 100%, 50%), 
                  hsl(120, 100%, 50%), 
                  hsl(180, 100%, 50%), 
                  hsl(240, 100%, 50%), 
                  hsl(300, 100%, 50%), 
                  hsl(360, 100%, 50%))`,
              }}
            />
          </div>

          {/* Saturation Slider */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Saturation</label>
            <input
              type="range"
              min="0"
              max="100"
              value={saturation}
              onChange={(e) => handleSaturationChange(parseInt(e.target.value))}
              className="w-full h-3 rounded cursor-pointer"
              style={{
                background: `linear-gradient(to right, 
                  hsl(${hue}, 0%, ${lightness}%), 
                  hsl(${hue}, 100%, ${lightness}%))`,
              }}
            />
          </div>

          {/* Lightness Slider */}
          <div>
            <label className="text-xs text-textSecondary mb-1 block">Lightness</label>
            <input
              type="range"
              min="0"
              max="100"
              value={lightness}
              onChange={(e) => handleLightnessChange(parseInt(e.target.value))}
              className="w-full h-3 rounded cursor-pointer"
              style={{
                background: `linear-gradient(to right, 
                  hsl(${hue}, ${saturation}%, 0%), 
                  hsl(${hue}, ${saturation}%, 50%), 
                  hsl(${hue}, ${saturation}%, 100%))`,
              }}
            />
          </div>

          {/* Opacity Slider */}
          {showOpacity && (
            <div>
              <label className="text-xs text-textSecondary mb-1 block">
                Opacity: {color.opacity}%
              </label>
              <input
                type="range"
                min="0"
                max="100"
                value={color.opacity}
                onChange={(e) => handleOpacityChange(parseInt(e.target.value))}
                className="w-full h-3 rounded cursor-pointer"
                style={{
                  background: `linear-gradient(to right, 
                    transparent, 
                    ${color.value})`,
                }}
              />
            </div>
          )}

          {/* Hex Input + Preview Row */}
          <div className="flex items-center gap-3">
            {/* Preview */}
            <div className="relative w-10 h-10 rounded border border-borderSubtle overflow-hidden flex-shrink-0">
              <div
                className="absolute inset-0"
                style={{
                  background: `repeating-conic-gradient(#808080 0% 25%, #ffffff 0% 50%) 50% / 6px 6px`,
                }}
              />
              <div
                className="absolute inset-0"
                style={{ backgroundColor: previewColor }}
              />
            </div>

            {/* Hex Input */}
            <input
              type="text"
              value={hexInput}
              onChange={(e) => handleHexInput(e.target.value)}
              placeholder="#000000"
              className="flex-1 px-3 py-2 glass-input text-sm font-mono text-textPrimary"
              maxLength={7}
            />

            {/* Copy Button */}
            <button
              onClick={handleCopy}
              className="px-3 py-2 glass-button text-textSecondary hover:text-textPrimary"
              title="Copy color"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>

          {/* Preset Colors */}
          <div>
            <p className="text-xs text-textSecondary mb-2">Quick Select</p>
            <div className="grid grid-cols-12 gap-1">
              {presetColors.map((preset) => (
                <button
                  key={preset}
                  onClick={() => {
                    setHexInput(preset);
                    onChange({ ...color, value: preset });
                  }}
                  className="w-full aspect-square rounded border border-borderSubtle hover:scale-110 transition-transform"
                  style={{ backgroundColor: preset }}
                  title={preset}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemeColorPicker;
