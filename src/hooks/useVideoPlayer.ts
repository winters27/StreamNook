import { useRef } from 'react';

export const useVideoPlayer = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Add controls like play, pause, etc.
  return { videoRef };
};