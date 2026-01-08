/**
 * Chat Layout Utilities
 *
 * Minimal utilities for chat message layout.
 * With native CSS virtualization (content-visibility: auto), the browser handles
 * all height calculations. Only padding calculation is needed.
 */

/**
 * Calculate the half-spacing value for use with paddingTop/paddingBottom.
 *
 * @param messageSpacing - User setting (0-20 pixels typically)
 * @returns Single-side padding value
 */
export function calculateHalfPadding(messageSpacing: number): number {
  return Math.max(4, messageSpacing / 2);
}
