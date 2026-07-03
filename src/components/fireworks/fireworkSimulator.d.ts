// Types for the vendored Firework Simulator v2 (see fireworkSimulator.js).
export interface FireworksHandle {
  setFinale(on: boolean): void;
  pause(): void;
  resume(): void;
}

export function igniteFireworks(opts: {
  trailsCanvas: HTMLCanvasElement;
  mainCanvas: HTMLCanvasElement;
  container: HTMLElement;
  // Multiplier for the sky-glow color (the original's subtle max suits a
  // full-black page; boost it when compositing over a scrim).
  skyGlow?: number;
}): FireworksHandle;
