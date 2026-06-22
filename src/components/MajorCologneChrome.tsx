import './MajorCologneChrome.css';

// The CS2 Major Cologne decoration, rendered wherever the look applies (behind a
// chat row, or as a profile backdrop). The animated glass texture is the base
// "background" everyone who earned it gets; the coin and frame are opt-in add-ons
// (supporter / subscriber). Sits below the row content (z -10). The asset URLs
// come from the Atmosphere row (R2), so the look retunes server-side.
export function MajorCologneChrome({
  textureUrl,
  coinUrl,
  frameUrl,
  coin = false,
  frame = false,
  bare = false,
}: {
  textureUrl: string;
  coinUrl?: string;
  frameUrl?: string;
  coin?: boolean;
  frame?: boolean;
  // Bare = a self-contained animated thumbnail (the picker swatch): just the
  // drifting wash, no readability veil, and sized to fill its box instead of
  // sitting behind a chat row.
  bare?: boolean;
}) {
  return (
    <div className={`cologne-chrome${bare ? ' cologne-chrome--bare' : ''}`} aria-hidden="true">
      <div className="cologne-clip">
        <div className="cologne-wash" style={{ backgroundImage: `url(${textureUrl})` }} />
        {!bare && <div className="cologne-veil" />}
        {coin && coinUrl && <img className="cologne-coin" src={coinUrl} alt="" draggable={false} />}
        {frame && frameUrl && <div className="cologne-frame" style={{ borderImageSource: `url(${frameUrl})` }} />}
      </div>
    </div>
  );
}
