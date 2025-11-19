import { useState } from 'react';

interface PenroseLogoProps {
  onClick: () => void;
}

const PenroseLogo = ({ onClick }: PenroseLogoProps) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="w-4 h-4 flex items-center justify-center cursor-pointer transition-transform duration-300 hover:scale-110"
      title="About Stream Nook"
    >
      <svg
        viewBox="0 0 526.364 477.037"
        className={`w-4 h-4 transition-all duration-700 ${isHovered ? 'animate-penrose-rotate' : ''}`}
        style={{
          filter: isHovered ? 'drop-shadow(0 0 6px rgba(151, 177, 185, 0.5))' : 'none',
        }}
      >
        <g transform="translate(-91.424,-253.587)">
          {/* Top/Right piece - White */}
          <path
            d="M 312.324,254.293 L 497.878,584.552 L 291.613,584.667 L 252.049,655.38 L 617.267,655.437 L 394.465,254.087 L 312.324,254.293 z"
            fill={isHovered ? "#97b1b9" : "#ffffff"}
            stroke="#000000"
            strokeWidth="1"
            strokeLinecap="butt"
            strokeLinejoin="round"
            className="transition-all duration-700"
          />
          
          {/* Left piece - Gray */}
          <path
            d="M 312.314,254.266 L 91.924,655.372 L 132.33,728.103 L 315.168,396.773 L 417.193,584.662 L 498.005,584.662 L 312.314,254.266 z"
            fill={isHovered ? "#8aa3ac" : "#7d7e7c"}
            stroke="#000000"
            strokeWidth="1"
            strokeLinecap="butt"
            strokeLinejoin="round"
            className="transition-all duration-700"
          />
          
          {/* Bottom piece - Black */}
          <path
            d="M 315.21,396.836 L 355.501,471.055 L 251.873,655.434 L 617.288,655.624 L 578.817,730.124 L 132.346,728.077 L 315.21,396.836 z"
            fill={isHovered ? "#6b8a94" : "#000000"}
            stroke="#000000"
            strokeWidth="1"
            strokeLinecap="butt"
            strokeLinejoin="round"
            className="transition-all duration-700"
          />
        </g>
      </svg>
    </button>
  );
};

export default PenroseLogo;
