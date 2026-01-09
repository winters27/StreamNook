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
  const [hasLoaded, setHasLoaded] = useState(false);

  // Reset state when src changes
  useEffect(() => {
    setCurrentSrc(src);
    setFallbackIndex(0);
    setHasLoaded(false);
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

  const handleLoad = () => {
    setHasLoaded(true);
  };

  return (
    <img
      {...props}
      src={currentSrc}
      onError={handleError}
      onLoad={handleLoad}
    />
  );
};

export default FallbackImage;
