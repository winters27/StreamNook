/**
 * ULID Timestamp Extraction Utilities
 * 
 * 7TV uses ULID format for badge/paint IDs. ULIDs embed a 48-bit timestamp
 * (milliseconds since Unix epoch) in the first 10 Crockford Base32 characters.
 * 
 * This allows us to extract the exact creation date from any 7TV cosmetic ID
 * without needing external API calls or scraping.
 */

// Crockford's Base32 alphabet (excludes I, L, O, U to avoid confusion)
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Decode the timestamp from a ULID string.
 * 
 * @param ulid - The ULID string (e.g., "01KA84S7GDS77JGK2RRG7ZZ946")
 * @returns Date object representing the creation time, or null if invalid
 * 
 * @example
 * decodeUlidTimestamp("01KA84S7GDS77JGK2RRG7ZZ946")
 * // Returns: Date for November 17, 2025
 */
export function decodeUlidTimestamp(ulid: string): Date | null {
  if (!ulid || ulid.length < 10) {
    return null;
  }

  try {
    // First 10 characters encode the 48-bit timestamp
    const timeChars = ulid.substring(0, 10).toUpperCase();
    let timestamp = 0;

    for (let i = 0; i < 10; i++) {
      const char = timeChars[i];
      const value = CROCKFORD_ALPHABET.indexOf(char);
      
      if (value === -1) {
        // Invalid character for Crockford Base32
        return null;
      }
      
      timestamp = timestamp * 32 + value;
    }

    // Validate timestamp is reasonable (between 2010 and 2100)
    const MIN_TIMESTAMP = new Date('2010-01-01').getTime();
    const MAX_TIMESTAMP = new Date('2100-01-01').getTime();
    
    if (timestamp < MIN_TIMESTAMP || timestamp > MAX_TIMESTAMP) {
      return null;
    }

    return new Date(timestamp);
  } catch {
    return null;
  }
}

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return 'th';
  }
  
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/**
 * Format a date as "Month DDth, YYYY" in the user's local timezone.
 * 
 * @param date - Date object to format
 * @returns Formatted string like "November 16th, 2025"
 * 
 * @example
 * formatDateAdded(new Date('2025-11-17T05:32:11.661Z'))
 * // Returns: "November 16th, 2025" (in PST timezone)
 */
export function formatDateAdded(date: Date | null): string {
  if (!date) {
    return 'Unknown';
  }

  try {
    const month = date.toLocaleDateString('en-US', { month: 'long' });
    const day = date.getDate();
    const year = date.getFullYear();
    const ordinal = getOrdinalSuffix(day);

    return `${month} ${day}${ordinal}, ${year}`;
  } catch {
    return 'Unknown';
  }
}

/**
 * Get the creation date from a 7TV cosmetic ID and format it for display.
 * 
 * @param id - The 7TV ULID (badge or paint ID)
 * @returns Formatted date string like "November 16th, 2025"
 */
export function getFormattedCreationDate(id: string): string {
  const date = decodeUlidTimestamp(id);
  return formatDateAdded(date);
}

/**
 * Get the raw timestamp (ms since epoch) from a ULID for sorting purposes.
 * 
 * @param ulid - The ULID string
 * @returns Timestamp in milliseconds, or 0 if invalid
 */
export function getUlidTimestamp(ulid: string): number {
  const date = decodeUlidTimestamp(ulid);
  return date ? date.getTime() : 0;
}
