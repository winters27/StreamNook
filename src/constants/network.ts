/**
 * Network speed test configuration constants
 */

// Speed test phases
export const SPEED_TEST_PHASES = {
  IDLE: 'idle',
  TESTING: 'testing',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;
export type SpeedTestPhase = (typeof SPEED_TEST_PHASES)[keyof typeof SPEED_TEST_PHASES];

// Network stability thresholds
export const STABILITY_THRESHOLDS = {
  /** Download speed (Mbps) required for each quality */
  QUALITY_REQUIREMENTS: {
    '480p': 3,
    '720p': 5,
    '720p60': 7,
    '1080p': 10,
    '1080p60': 15,
  } as Record<string, number>,
  
  /** Stability score thresholds (0-100) */
  EXCELLENT: 90,
  GOOD: 75,
  FAIR: 50,
  // Below FAIR is considered 'poor'
} as const;

/**
 * Get stability rating string based on score
 */
export function getStabilityRating(score: number): 'excellent' | 'good' | 'fair' | 'poor' {
  if (score >= STABILITY_THRESHOLDS.EXCELLENT) return 'excellent';
  if (score >= STABILITY_THRESHOLDS.GOOD) return 'good';
  if (score >= STABILITY_THRESHOLDS.FAIR) return 'fair';
  return 'poor';
}

/**
 * Get recommended quality based on download speed
 */
export function getRecommendedQuality(downloadMbps: number): string {
  if (downloadMbps >= 15) return '1080p60';
  if (downloadMbps >= 10) return '1080p';
  if (downloadMbps >= 7) return '720p60';
  if (downloadMbps >= 5) return '720p';
  if (downloadMbps >= 3) return '480p';
  return '360p';
}

/**
 * Get recommendation message based on download speed
 */
export function getRecommendationMessage(downloadMbps: number): string {
  const quality = getRecommendedQuality(downloadMbps);
  
  if (downloadMbps >= 25) {
    return `Your ${downloadMbps.toFixed(0)} Mbps connection can easily handle ${quality} streaming.`;
  }
  
  if (downloadMbps >= 10) {
    return `Recommended: ${quality} for smooth playback with your ${downloadMbps.toFixed(0)} Mbps connection.`;
  }
  
  return `${quality} is best for your ${downloadMbps.toFixed(0)} Mbps connection.`;
}
