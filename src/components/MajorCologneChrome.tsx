import frameUrl from '../assets/major-cologne-2026-frame.png';
import textureUrl from '../assets/major-cologne-2026-texture.png';
import coinUrl from '../assets/major-cologne-2026-coin.png';
import './MajorCologneChrome.css';

// The CS2 Major Cologne decoration, rendered wherever the look applies (behind a
// chat row, or as a profile backdrop). The animated glass texture is the base
// "background" everyone who earned it gets; the coin and frame are opt-in add-ons
// (supporter / subscriber). Sits below the row content (z -10).
export function MajorCologneChrome({ coin = false, frame = false }: { coin?: boolean; frame?: boolean }) {
  return (
    <div className="cologne-chrome" aria-hidden="true">
      <div className="cologne-clip">
        <div className="cologne-wash" style={{ backgroundImage: `url(${textureUrl})` }} />
        <div className="cologne-veil" />
        {coin && <img className="cologne-coin" src={coinUrl} alt="" draggable={false} />}
        {frame && <div className="cologne-frame" style={{ borderImageSource: `url(${frameUrl})` }} />}
      </div>
    </div>
  );
}
