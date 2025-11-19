import { useState, useCallback, useRef, useEffect } from 'react';

interface ColorWheelPickerProps {
  color: string;
  onChange: (color: string) => void;
  label?: string;
}

const ColorWheelPicker = ({ color, onChange, label }: ColorWheelPickerProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hue, setHue] = useState(0);
  const [saturation, setSaturation] = useState(100);
  const [lightness, setLightness] = useState(50);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Convert hex to HSL on mount and when color changes
  useEffect(() => {
    const hexToHsl = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;

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

    if (color.startsWith('#')) {
      hexToHsl(color);
    }
  }, [color]);

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
    onChange(hslToHex(h, saturation, lightness));
  };

  const handleSaturationChange = (s: number) => {
    setSaturation(s);
    onChange(hslToHex(hue, s, lightness));
  };

  const handleLightnessChange = (l: number) => {
    setLightness(l);
    onChange(hslToHex(hue, saturation, l));
  };

  // Close picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Preset colors
  const presetColors = [
    '#ff4444', '#ff6b6b', '#4ecdc4', '#45b7d1',
    '#f7b731', '#5f27cd', '#00d2d3', '#ff6348',
    '#54a0ff', '#48dbfb', '#feca57', '#ff9ff3',
    '#ee5a24', '#10ac84', '#c8d6e5', '#576574'
  ];

  return (
    <div className="relative" ref={pickerRef}>
      {label && (
        <label className="block text-sm font-medium text-textPrimary mb-2">
          {label}
        </label>
      )}
      
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-3 px-3 py-2 glass-input w-full text-left"
      >
        <div 
          className="w-8 h-8 rounded border-2 border-borderSubtle"
          style={{ backgroundColor: color }}
        />
        <span className="text-sm text-textPrimary font-mono">{color.toUpperCase()}</span>
      </button>

      {isOpen && (
        <div className="absolute top-full mt-2 left-0 z-50 p-4 glass-panel backdrop-blur-lg shadow-xl rounded-lg border border-borderSubtle">
          <div className="space-y-4 w-64">
            {/* Hue Slider */}
            <div>
              <label className="text-xs text-textSecondary mb-1 block">Hue</label>
              <input
                type="range"
                min="0"
                max="360"
                value={hue}
                onChange={(e) => handleHueChange(parseInt(e.target.value))}
                className="w-full accent-accent"
                style={{
                  background: `linear-gradient(to right, 
                    hsl(0, 100%, 50%), 
                    hsl(60, 100%, 50%), 
                    hsl(120, 100%, 50%), 
                    hsl(180, 100%, 50%), 
                    hsl(240, 100%, 50%), 
                    hsl(300, 100%, 50%), 
                    hsl(360, 100%, 50%))`
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
                className="w-full accent-accent"
                style={{
                  background: `linear-gradient(to right, 
                    hsl(${hue}, 0%, ${lightness}%), 
                    hsl(${hue}, 100%, ${lightness}%))`
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
                className="w-full accent-accent"
                style={{
                  background: `linear-gradient(to right, 
                    hsl(${hue}, ${saturation}%, 0%), 
                    hsl(${hue}, ${saturation}%, 50%), 
                    hsl(${hue}, ${saturation}%, 100%))`
                }}
              />
            </div>

            {/* Preview */}
            <div className="flex items-center gap-3 p-3 glass-input rounded">
              <div 
                className="w-12 h-12 rounded border-2 border-borderSubtle"
                style={{ backgroundColor: hslToHex(hue, saturation, lightness) }}
              />
              <div>
                <p className="text-xs text-textSecondary">Current Color</p>
                <p className="text-sm text-textPrimary font-mono">
                  {hslToHex(hue, saturation, lightness).toUpperCase()}
                </p>
              </div>
            </div>

            {/* Preset Colors */}
            <div>
              <p className="text-xs text-textSecondary mb-2">Quick Select</p>
              <div className="grid grid-cols-8 gap-1">
                {presetColors.map((preset) => (
                  <button
                    key={preset}
                    onClick={() => {
                      onChange(preset);
                      setIsOpen(false);
                    }}
                    className="w-7 h-7 rounded border border-borderSubtle hover:scale-110 transition-transform"
                    style={{ backgroundColor: preset }}
                    title={preset}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColorWheelPicker;
