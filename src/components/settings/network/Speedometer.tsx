/**
 * Speedometer - Live speed display for speed test visualization
 * Just the animated number, no gauge graphics
 */

interface SpeedometerProps {
  value: number;           // Current speed value (Mbps)
  label?: string;          // Unit label (default: "Mbps")
}

export function Speedometer({
  value,
  label = "Mbps",
}: SpeedometerProps) {
  return (
    <div className="flex flex-col items-center py-4">
      <div className="text-center">
        <span 
          className="text-5xl font-bold text-accent tabular-nums transition-all duration-300"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {value.toFixed(1)}
        </span>
        <span className="text-lg text-gray-400 ml-2">{label}</span>
      </div>
    </div>
  );
}

export default Speedometer;
