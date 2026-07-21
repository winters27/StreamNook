// Default Twitch-style channel points icon. Shared so the points menu, chat
// redemption rows, and anywhere else showing a cost all render the same glyph
// when a channel hasn't set a custom points icon.
export const ChannelPointsIcon = ({ className = '', size = 14 }: { className?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
    <path d="M12 5v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7Z"></path>
    <path
      fillRule="evenodd"
      d="M1 12C1 5.925 5.925 1 12 1s11 4.925 11 11-4.925 11-11 11S1 18.075 1 12Zm11 9a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z"
      clipRule="evenodd"
    ></path>
  </svg>
);
