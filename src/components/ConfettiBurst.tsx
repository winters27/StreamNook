import { useEffect, useRef } from 'react';

/**
 * One-shot confetti celebration for Hype Train level-ups.
 *
 * Renders a canvas over the full chat widget: a burst of paper confetti
 * erupts upward from the top (where the hype bar lives) and then flutters
 * down the entire height. The paper "flip" is faked by oscillating each
 * piece's vertical scale with a cosine and swapping a front/back color, and
 * the lazy side-to-side sway comes from drag plus a per-frame random nudge.
 *
 * Mount it with a `key` that changes per level-up so each level-up replays a
 * fresh burst, and unmount it when the celebration ends. The animation stops
 * on its own once every piece has fallen past the bottom edge.
 */

interface ColorPair {
  front: string;
  back: string; // darker shade shown while a piece is flipped away from us
}

// Echoes the rainbow hype-train gradient.
const RAINBOW: ColorPair[] = [
  { front: '#ff5b9e', back: '#d63d7d' }, // pink
  { front: '#9b6bff', back: '#7a4fe0' }, // purple
  { front: '#4d96ff', back: '#345dd1' }, // blue
  { front: '#3ed8e0', back: '#2bb0b8' }, // cyan
  { front: '#ffd93d', back: '#e0b81f' }, // yellow
  { front: '#6bcb77', back: '#4ea85a' }, // green
];

// Used for golden-kappa hype trains.
const GOLD: ColorPair[] = [
  { front: '#FFD700', back: '#D4AF37' },
  { front: '#FFF1B8', back: '#E6C200' },
  { front: '#FFB300', back: '#CC8F00' },
];

// "Physics" tuning for confetti and sequin fall.
const GRAVITY_CONFETTI = 0.3;
const GRAVITY_SEQUINS = 0.55;
const DRAG_CONFETTI = 0.075;
const DRAG_SEQUINS = 0.02;
const TERMINAL_VELOCITY = 3;

const CONFETTI_COUNT = 60;
const SEQUIN_COUNT = 24;

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

// Weighted upward spread so most pieces launch near the top of the range,
// which reads as a livelier burst than a flat random.
function initConfettoVelocity(xRange: [number, number], yRange: [number, number]) {
  const x = rand(xRange[0], xRange[1]);
  const range = yRange[1] - yRange[0] + 1;
  let y = yRange[1] - Math.abs(rand(0, range) + rand(0, range) - range);
  if (y >= yRange[1] - 1) {
    y += Math.random() < 0.25 ? rand(1, 3) : 0;
  }
  return { x, y: -y }; // negative y is upward
}

interface Confetto {
  randomModifier: number;
  color: ColorPair;
  dimensions: { x: number; y: number };
  position: { x: number; y: number };
  rotation: number;
  scaleY: number;
  velocity: { x: number; y: number };
}

interface Sequin {
  color: string;
  radius: number;
  position: { x: number; y: number };
  velocity: { x: number; y: number };
}

export default function ConfettiBurst({ golden = false }: { golden?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = parent.clientWidth;
    const H = parent.clientHeight;
    if (W === 0 || H === 0) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    const colors = golden ? GOLD : RAINBOW;
    // Erupt from the upper area (around the hype bar) and rain down the rest.
    const originY = Math.min(H * 0.16, 110);
    const spread = Math.max(40, W * 0.28);
    const spawnX = () => rand(W / 2 - spread, W / 2 + spread);
    const spawnY = () => originY + rand(-6, 8);

    let confetti: Confetto[] = Array.from({ length: CONFETTI_COUNT }, () => ({
      randomModifier: rand(0, 99),
      color: pick(colors),
      dimensions: { x: rand(5, 9), y: rand(8, 15) },
      position: { x: spawnX(), y: spawnY() },
      rotation: rand(0, 2 * Math.PI),
      scaleY: 1,
      velocity: initConfettoVelocity([-9, 9], [6, 11]),
    }));

    let sequins: Sequin[] = Array.from({ length: SEQUIN_COUNT }, () => ({
      color: pick(colors).back,
      radius: rand(1, 2),
      position: { x: spawnX(), y: spawnY() },
      velocity: { x: rand(-6, 6), y: -rand(8, 12) },
    }));

    let raf = 0;

    const render = () => {
      ctx.clearRect(0, 0, W, H);

      for (const c of confetti) {
        c.velocity.x -= c.velocity.x * DRAG_CONFETTI;
        c.velocity.y = Math.min(c.velocity.y + GRAVITY_CONFETTI, TERMINAL_VELOCITY);
        c.velocity.x += Math.random() > 0.5 ? Math.random() : -Math.random();
        c.position.x += c.velocity.x;
        c.position.y += c.velocity.y;
        // .09 slows the flip frequency
        c.scaleY = Math.cos((c.position.y + c.randomModifier) * 0.09);

        const width = c.dimensions.x;
        const height = c.dimensions.y * c.scaleY;
        ctx.save();
        ctx.translate(c.position.x, c.position.y);
        ctx.rotate(c.rotation);
        ctx.fillStyle = c.scaleY > 0 ? c.color.front : c.color.back;
        ctx.fillRect(-width / 2, -height / 2, width, height);
        ctx.restore();
      }

      for (const s of sequins) {
        s.velocity.x -= s.velocity.x * DRAG_SEQUINS;
        s.velocity.y += GRAVITY_SEQUINS;
        s.position.x += s.velocity.x;
        s.position.y += s.velocity.y;

        ctx.save();
        ctx.translate(s.position.x, s.position.y);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(0, 0, s.radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      confetti = confetti.filter((c) => c.position.y < H + 20);
      sequins = sequins.filter((s) => s.position.y < H + 20);

      if (confetti.length || sequins.length) {
        raf = requestAnimationFrame(render);
      }
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [golden]);

  return <canvas ref={canvasRef} className="absolute inset-0 z-30 pointer-events-none" aria-hidden="true" />;
}
