import React, { useState, useEffect } from 'react';

interface FallbackImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  fallbackUrls?: string[];
  onAllFailed?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Image component with automatic resolution fallback.
 * Tries each URL in order (src first, then fallbackUrls) until one succeeds.
 * If all fail, calls onAllFailed and hides the image.
 */
export const FallbackImage: React.FC<FallbackImageProps> = ({
  src,
  fallbackUrls = [],
  onAllFailed,
  onError,
  ...props
}) => {
  const [currentSrc, setCurrentSrc] = useState(src);
  const [fallbackIndex, setFallbackIndex] = useState(0);

  // Reset state when src changes
  useEffect(() => {
    queueMicrotask(() => {
      setCurrentSrc(src);
      setFallbackIndex(0);
    });
  }, [src]);

  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (fallbackIndex < fallbackUrls.length) {
      // Try next fallback URL
      setCurrentSrc(fallbackUrls[fallbackIndex]);
      setFallbackIndex(prev => prev + 1);
    } else {
      // All URLs failed - hide and call callback
      e.currentTarget.style.display = 'none';
      onAllFailed?.(e);
      onError?.(e);
    }
  };

  return (
    <img
      {...props}
      src={currentSrc}
      loading="lazy"
      onError={handleError}
    />
  );
};

export default FallbackImage;
