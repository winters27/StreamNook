// Module-level handle to the currently active player <video> element. The chat
// "/song" command runs outside the player component, so it needs a way to reach
// the element that's actually producing audio. VideoPlayer registers its element
// here; the getter falls back to scanning the DOM for an audible video so the
// MultiNook tiles (which don't go through VideoPlayer) still work.

let activeVideo: HTMLVideoElement | null = null;

export function setActiveVideo(el: HTMLVideoElement | null): void {
  activeVideo = el;
}

export function getActiveVideo(): HTMLVideoElement | null {
  if (activeVideo && activeVideo.isConnected && !activeVideo.paused) return activeVideo;

  const videos = Array.from(document.querySelectorAll('video'));
  // Prefer a tile that's actually audible (playing and unmuted) for MultiNook.
  const audible = videos.find((v) => !v.paused && !v.muted && v.volume > 0);
  if (audible) return audible;

  return (activeVideo && activeVideo.isConnected ? activeVideo : null) ?? videos[0] ?? null;
}
