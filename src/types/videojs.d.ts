import 'video.js';

declare module 'video.js' {
  interface Player {
    qualityLevels(): any;
  }
}
