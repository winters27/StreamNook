import { useEffect, useState, useMemo } from 'react';
import { X, ArrowUpDown, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface BadgeVersion {
  id: string;
  image_url_1x: string;
  image_url_2x: string;
  image_url_4x: string;
  title: string;
  description: string;
  click_action: string | null;
  click_url: string | null;
}

interface BadgeMetadata {
  date_added: string | null;
  usage_stats: string | null;
  more_info: string | null;
  info_url: string;
}

interface BadgeWithMetadata extends BadgeVersion {
  set_id: string;
  badgebase_info?: BadgeMetadata;
}

type SortOption = 'date-newest' | 'date-oldest' | 'usage-high' | 'usage-low' | 'available' | 'coming-soon';

interface BadgeSet {
  set_id: string;
  versions: BadgeVersion[];
}

interface BadgesOverlayProps {
  onClose: () => void;
  onBadgeClick: (badge: BadgeVersion, setId: string) => void;
}

const BadgesOverlay = ({ onClose, onBadgeClick }: BadgesOverlayProps) => {
  const [badges, setBadges] = useState<BadgeSet[]>([]);
  const [badgesWithMetadata, setBadgesWithMetadata] = useState<BadgeWithMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('date-newest');
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [newBadgesCount, setNewBadgesCount] = useState(0);

  useEffect(() => {
    loadBadges();
  }, []);

  const loadBadges = async () => {
    try {
      setLoading(true);
      setError(null);

      // Try to load from cache first
      console.log('[BadgesOverlay] Checking for cached badges...');
      const cachedBadges = await invoke<{ data: BadgeSet[] } | null>('get_cached_global_badges');

      // Also check cache age
      const age = await invoke<number | null>('get_badge_cache_age');
      setCacheAge(age);

      if (cachedBadges && cachedBadges.data && cachedBadges.data.length > 0) {
        console.log('[BadgesOverlay] Found cached badges, loading immediately');
        setBadges(cachedBadges.data);

        // Flatten all badge versions
        const flattened = cachedBadges.data.flatMap(set =>
          set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
        );

        // Pre-load ALL badge metadata from cache in ONE call (fast batch lookup)
        let badgesWithPreloadedMetadata: BadgeWithMetadata[] = flattened;
        try {
          const allBadgeCache = await invoke<Record<string, { data: any; position?: number }>>('get_all_universal_cached_items', {
            cacheType: 'badge',
          });

          if (allBadgeCache && Object.keys(allBadgeCache).length > 0) {
            console.log(`[BadgesOverlay] Loaded ${Object.keys(allBadgeCache).length} cached badge entries in single call`);
            badgesWithPreloadedMetadata = flattened.map(badge => {
              const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
              const cached = allBadgeCache[cacheKey];
              if (cached) {
                return {
                  ...badge,
                  badgebase_info: {
                    ...cached.data,
                    position: cached.position
                  }
                };
              }
              return badge;
            });
          }
        } catch (err) {
          console.error('[BadgesOverlay] Failed to batch load cache:', err);
        }

        setBadgesWithMetadata(badgesWithPreloadedMetadata);
        setLoading(false);

        // Fetch any missing metadata in the background
        fetchAllBadgeMetadata(badgesWithPreloadedMetadata);

        // Check for badges missing metadata (new badges that need BadgeBase data)
        checkAndFetchMissingMetadata();

        return;
      }

      // No cache available, fetch from API
      console.log('[BadgesOverlay] No cached badges, fetching from API...');

      // Get credentials
      const [clientId, token] = await invoke<[string, string]>('get_twitch_credentials');

      // Fetch global badges (this will cache them)
      const response = await invoke<{ data: BadgeSet[] }>('fetch_global_badges', {
        clientId,
        token,
      });

      setBadges(response.data);

      // Flatten all badge versions
      const flattened = response.data.flatMap(set =>
        set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
      );

      setBadgesWithMetadata(flattened);

      // Fetch metadata for all badges in the background
      fetchAllBadgeMetadata(flattened);
    } catch (err) {
      console.error('Failed to load badges:', err);
      setError('Failed to load badges. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Check for badges that don't have metadata and fetch from BadgeBase
  const checkAndFetchMissingMetadata = async () => {
    try {
      console.log('[BadgesOverlay] Checking for badges missing metadata...');
      const missing = await invoke<[string, string][]>('get_badges_missing_metadata');

      if (missing.length > 0) {
        console.log(`[BadgesOverlay] Found ${missing.length} badges missing metadata, fetching...`);
        setNewBadgesCount(missing.length);

        // Fetch metadata for missing badges in batches
        const batchSize = 5;
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);

          await Promise.allSettled(
            batch.map(([setId, version]) =>
              invoke<BadgeMetadata>('fetch_badge_metadata', {
                badgeSetId: setId,
                badgeVersion: version,
              })
            )
          );

          // Update progress
          setNewBadgesCount(Math.max(0, missing.length - (i + batchSize)));
        }

        console.log('[BadgesOverlay] Finished fetching missing badge metadata');
        setNewBadgesCount(0);

        // Reload metadata to update display
        if (badgesWithMetadata.length > 0) {
          fetchAllBadgeMetadata(badgesWithMetadata);
        }
      }
    } catch (err) {
      console.error('[BadgesOverlay] Error checking for missing metadata:', err);
    }
  };

  // Force refresh badges from Twitch API (bypasses cache)
  const forceRefreshBadges = async () => {
    try {
      setRefreshing(true);
      console.log('[BadgesOverlay] Force refreshing badges from Twitch API...');

      const response = await invoke<{ data: BadgeSet[] }>('force_refresh_global_badges');

      console.log(`[BadgesOverlay] Refreshed ${response.data.length} badge sets from Twitch API`);

      // Log all badge set IDs for debugging
      const badgeSetIds = response.data.map(s => s.set_id);
      console.log('[BadgesOverlay] Badge set IDs received:', badgeSetIds);

      // Count total versions
      const totalVersions = response.data.reduce((acc, set) => acc + set.versions.length, 0);
      console.log(`[BadgesOverlay] Total badge versions: ${totalVersions}`);

      // Log each badge set with its versions
      response.data.forEach(set => {
        console.log(`[BadgesOverlay] Set "${set.set_id}": ${set.versions.length} versions - ${set.versions.map(v => v.title).join(', ')}`);
      });

      setBadges(response.data);
      setCacheAge(0);

      // Flatten all badge versions
      const flattened = response.data.flatMap(set =>
        set.versions.map(version => ({ ...version, set_id: set.set_id } as BadgeWithMetadata))
      );

      console.log(`[BadgesOverlay] Flattened to ${flattened.length} badge items`);

      setBadgesWithMetadata(flattened);

      // Fetch metadata for all badges with force=true to bypass cache
      await fetchAllBadgeMetadata(flattened, true);

      // Check for and fetch any new badges that don't have metadata yet
      await checkAndFetchMissingMetadata();

    } catch (err) {
      console.error('Failed to refresh badges:', err);
      setError('Failed to refresh badges. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAllBadgeMetadata = async (badgeList: BadgeWithMetadata[], forceRefresh: boolean = false) => {
    setLoadingMetadata(true);

    // First, load ALL badge cache in ONE call (fast batch lookup)
    const metadataCache: Record<string, BadgeMetadata> = {};
    let uncachedBadges: BadgeWithMetadata[] = [];

    // If force refresh, skip cache and fetch all badges fresh
    if (forceRefresh) {
      console.log('[BadgesOverlay] Force refresh requested, fetching ALL badge metadata from BadgeBase...');
      uncachedBadges = [...badgeList];
    } else {
      console.log('[BadgesOverlay] Batch loading all badge cache...');
      try {
        const allBadgeCache = await invoke<Record<string, { data: any; position?: number }>>('get_all_universal_cached_items', {
          cacheType: 'badge',
        });

        // Map badges to their cache entries
        for (const badge of badgeList) {
          const cacheKey = `metadata:${badge.set_id}-v${badge.id}`;
          const cached = allBadgeCache[cacheKey];

          if (cached) {
            const metadata = cached.data as BadgeMetadata;
            (metadata as any).position = cached.position;
            metadataCache[`${badge.set_id}/${badge.id}`] = metadata;
          } else {
            uncachedBadges.push(badge);
          }
        }

        console.log(`[BadgesOverlay] Found ${Object.keys(metadataCache).length} badges in cache (batch), need to fetch ${uncachedBadges.length} from API`);
      } catch (err) {
        console.error('[BadgesOverlay] Failed to batch load cache, falling back to uncached:', err);
        // If batch load fails, treat all as uncached
        uncachedBadges.push(...badgeList);
      }

      // Update UI with cached data immediately
      if (Object.keys(metadataCache).length > 0) {
        const updatedBadges = badgeList.map(badge => ({
          ...badge,
          badgebase_info: metadataCache[`${badge.set_id}/${badge.id}`]
        }));
        setBadgesWithMetadata(updatedBadges);
      }
    }

    // Now fetch badges from API (all badges if force refresh, or only uncached badges)
    if (uncachedBadges.length > 0) {
      const batchSize = 10; // Process 10 badges at a time

      for (let i = 0; i < uncachedBadges.length; i += batchSize) {
        const batch = uncachedBadges.slice(i, i + batchSize);

        const batchResults = await Promise.allSettled(
          batch.map(badge =>
            invoke<BadgeMetadata>('fetch_badge_metadata', {
              badgeSetId: badge.set_id,
              badgeVersion: badge.id,
              force: forceRefresh,
            })
          )
        );

        // Process batch results
        batch.forEach((badge, index) => {
          const result = batchResults[index];
          if (result.status === 'fulfilled') {
            metadataCache[`${badge.set_id}/${badge.id}`] = result.value;
          }
        });

        // Update UI after each batch
        const updatedBadges = badgeList.map(badge => ({
          ...badge,
          badgebase_info: metadataCache[`${badge.set_id}/${badge.id}`]
        }));
        setBadgesWithMetadata(updatedBadges);
      }
    }

    setLoadingMetadata(false);
  };

  // Parse usage stats to get numeric value for sorting
  const parseUsageStats = (stats: string | null | undefined): number => {
    if (!stats) return 0;

    // Extract number from strings like "1,234 users seen with this badge" or "None users"
    const match = stats.match(/(\d+(?:,\d+)*)/);
    if (match) {
      return parseInt(match[1].replace(/,/g, ''), 10);
    }
    return 0;
  };

  // Parse date for sorting - handles multiple formats
  const parseDate = (dateStr: string | null | undefined): number => {
    if (!dateStr) return 0;
    try {
      // Month name mappings (full and abbreviated)
      const months: Record<string, number> = {
        'January': 0, 'February': 1, 'March': 2, 'April': 3,
        'May': 4, 'June': 5, 'July': 6, 'August': 7,
        'September': 8, 'October': 9, 'November': 10, 'December': 11,
        'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
        'Jun': 5, 'Jul': 6, 'Aug': 7,
        'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
      };

      // Try to match "DD Month YYYY" format (e.g., "12 November 2025")
      const fullMatch = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
      if (fullMatch) {
        const day = parseInt(fullMatch[1], 10);
        const monthName = fullMatch[2];
        const year = parseInt(fullMatch[3], 10);

        if (months.hasOwnProperty(monthName)) {
          const date = new Date(year, months[monthName], day);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Try to match abbreviated format "Mon D-D" or "Mon D - D" (e.g., "Dec 1-12" or "Dec 1 - 12")
      const abbrevMatch = dateStr.match(/(\w{3})\s+(\d{1,2})\s*-\s*(\d{1,2})/);
      if (abbrevMatch) {
        const monthAbbrev = abbrevMatch[1];
        const startDay = parseInt(abbrevMatch[2], 10);
        // Use current year since it's not provided
        const currentYear = new Date().getFullYear();

        if (months.hasOwnProperty(monthAbbrev)) {
          const date = new Date(currentYear, months[monthAbbrev], startDay);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Try to match "Mon D" format (e.g., "Dec 1")
      const singleDayMatch = dateStr.match(/(\w{3})\s+(\d{1,2})(?!\s*-)/);
      if (singleDayMatch) {
        const monthAbbrev = singleDayMatch[1];
        const day = parseInt(singleDayMatch[2], 10);
        const currentYear = new Date().getFullYear();

        if (months.hasOwnProperty(monthAbbrev)) {
          const date = new Date(currentYear, months[monthAbbrev], day);
          if (!isNaN(date.getTime())) {
            return date.getTime();
          }
        }
      }

      // Fallback: try parsing the date string directly
      const parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed.getTime();
      }
      return 0;
    } catch {
      return 0;
    }
  };

  // Decode HTML entities like &#8211; → – in text
  const decodeHtmlEntities = (text: string): string => {
    let result = text;

    // Decode numeric HTML entities (&#NNNN;)
    result = result.replace(/&#(\d+);/g, (_match, dec) => {
      const code = parseInt(dec, 10);
      return String.fromCharCode(code);
    });

    // Decode hex HTML entities (&#xHHHH;)
    result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
      const code = parseInt(hex, 16);
      return String.fromCharCode(code);
    });

    // Decode common named entities
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&nbsp;': ' ',
      '&ndash;': '–',
      '&mdash;': '—',
    };

    for (const [entity, char] of Object.entries(entities)) {
      result = result.split(entity).join(char);
    }

    return result;
  };

  // Parse abbreviated date range format like "Dec 1-12", "Dec 1 - 12", or "Dec 06 – Dec 07"
  // Also handles natural language formats like "December 4, 2025 at 9:00 AM"
  // NOTE: Handles both regular dashes (-), en-dashes (–), and em-dashes (—)
  const parseDateRange = (inputText: string): { start: Date; end: Date } | null => {
    // First decode any HTML entities in the text
    const text = decodeHtmlEntities(inputText);
    const months: Record<string, number> = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3,
      'May': 4, 'Jun': 5, 'Jul': 6, 'Aug': 7,
      'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    const fullMonths: Record<string, number> = {
      'January': 0, 'February': 1, 'March': 2, 'April': 3,
      'May': 4, 'June': 5, 'July': 6, 'August': 7,
      'September': 8, 'October': 9, 'November': 10, 'December': 11
    };
    const currentYear = new Date().getFullYear();

    // Regex pattern for dashes (regular dash, en-dash, em-dash)
    const dashPattern = '[-–—]';

    // Try to parse "Event duration: Dec 19 – Jan 01" format
    const eventDurationMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[-–—]\s*(\w{3})\s+(\d{1,2})/i);
    if (eventDurationMatch) {
      const startMonthAbbrev = eventDurationMatch[1];
      const startDay = parseInt(eventDurationMatch[2], 10);
      const endMonthAbbrev = eventDurationMatch[3];
      const endDay = parseInt(eventDurationMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];

        // Determine year - if end month is before start month, it crosses into next year
        let startYear = currentYear;
        let endYear = currentYear;

        // If event starts in Dec and ends in Jan, the end is in next year
        if (startMonthNum > endMonthNum) {
          endYear = currentYear + 1;
        }

        const startDate = new Date(startYear, startMonthNum, startDay, 0, 0, 0);
        const endDate = new Date(endYear, endMonthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Try to parse "Event duration: Dec 19-25" format (same month)
    const eventDurationSameMonthMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})/i);
    if (eventDurationSameMonthMatch) {
      const monthAbbrev = eventDurationSameMonthMatch[1];
      const startDay = parseInt(eventDurationSameMonthMatch[2], 10);
      const endDay = parseInt(eventDurationSameMonthMatch[3], 10);

      if (months.hasOwnProperty(monthAbbrev)) {
        const monthNum = months[monthAbbrev];
        const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Try to parse ISO format: "Event start: 2025-12-04T15:00:00Z"
    const isoEventStartMatch = text.match(/Event start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/i);
    if (isoEventStartMatch) {
      try {
        const startDate = new Date(isoEventStartMatch[1]);
        if (!isNaN(startDate.getTime())) {
          // Look for an end time in ISO format
          const isoEndMatch = text.match(/Event end:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/i);
          let endDate: Date;

          if (isoEndMatch) {
            endDate = new Date(isoEndMatch[1]);
          } else {
            // No explicit end, assume event lasts until end of that day
            endDate = new Date(startDate);
            endDate.setHours(23, 59, 59, 999);
          }

          if (!isNaN(endDate.getTime())) {
            return { start: startDate, end: endDate };
          }
        }
      } catch {
        // Fall through to other parsers
      }
    }

    // Try to parse ISO date range: "2025-12-04T15:00:00Z – 2025-12-04T23:59:00Z"
    const isoRangeMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)\s*[-–—]\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)/);
    if (isoRangeMatch) {
      try {
        const startDate = new Date(isoRangeMatch[1]);
        const endDate = new Date(isoRangeMatch[2]);
        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      } catch {
        // Fall through to other parsers
      }
    }

    // Try to parse natural language format: "Month Day, Year at HH:MM AM/PM – Month Day, Year at HH:MM AM/PM"
    // Example: "December 4, 2025 at 7:00 AM – December 4, 2025 at 11:59 PM"
    const fullDateRangeMatch = text.match(
      new RegExp(`(\\w+)\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s*${dashPattern}\\s*(\\w+)\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+at\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)`, 'i')
    );
    if (fullDateRangeMatch) {
      const parseDateTime = (monthName: string, day: string, year: string, hours: string, minutes: string, meridiem: string): Date | null => {
        let h = parseInt(hours, 10);
        const m = parseInt(minutes, 10);
        const y = parseInt(year, 10);
        const d = parseInt(day, 10);

        if (meridiem.toUpperCase() === 'PM' && h !== 12) h += 12;
        else if (meridiem.toUpperCase() === 'AM' && h === 12) h = 0;

        if (fullMonths.hasOwnProperty(monthName)) {
          return new Date(y, fullMonths[monthName], d, h, m, 0);
        }
        return null;
      };

      const startDate = parseDateTime(
        fullDateRangeMatch[1], fullDateRangeMatch[2], fullDateRangeMatch[3],
        fullDateRangeMatch[4], fullDateRangeMatch[5], fullDateRangeMatch[6]
      );
      const endDate = parseDateTime(
        fullDateRangeMatch[7], fullDateRangeMatch[8], fullDateRangeMatch[9],
        fullDateRangeMatch[10], fullDateRangeMatch[11], fullDateRangeMatch[12]
      );

      if (startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
        return { start: startDate, end: endDate };
      }
    }

    // Try to parse natural language format: "Event start: Month Day, Year at HH:MM AM/PM"
    // Example: "Event start: December 4, 2025 at 9:00 AM"
    const eventStartMatch = text.match(/Event start:\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (eventStartMatch) {
      const monthName = eventStartMatch[1];
      const day = parseInt(eventStartMatch[2], 10);
      const year = parseInt(eventStartMatch[3], 10);
      let hours = parseInt(eventStartMatch[4], 10);
      const minutes = parseInt(eventStartMatch[5], 10);
      const meridiem = eventStartMatch[6].toUpperCase();

      // Convert to 24-hour format
      if (meridiem === 'PM' && hours !== 12) {
        hours += 12;
      } else if (meridiem === 'AM' && hours === 12) {
        hours = 0;
      }

      if (fullMonths.hasOwnProperty(monthName)) {
        const monthNum = fullMonths[monthName];
        const startDate = new Date(year, monthNum, day, hours, minutes, 0);

        // For events with a start time but no explicit end, assume the event lasts for the rest of that day
        // or we can look for duration in the text
        let endDate = new Date(year, monthNum, day, 23, 59, 59);

        // Try to find duration hint (e.g., "60 minutes", "2 hours")
        const durationMatch = text.match(/(\d+)\s+(minute|hour)s?/i);
        if (durationMatch) {
          const duration = parseInt(durationMatch[1], 10);
          const unit = durationMatch[2].toLowerCase();
          endDate = new Date(startDate);
          if (unit === 'minute') {
            endDate.setMinutes(endDate.getMinutes() + duration);
          } else if (unit === 'hour') {
            endDate.setHours(endDate.getHours() + duration);
          }
        }

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Match "Mon DD – Mon DD" format (e.g., "Dec 06 – Dec 07") - with en-dash or regular dash
    const fullRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
    if (fullRangeMatch) {
      const startMonthAbbrev = fullRangeMatch[1];
      const startDay = parseInt(fullRangeMatch[2], 10);
      const endMonthAbbrev = fullRangeMatch[3];
      const endDay = parseInt(fullRangeMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];
        // Start at beginning of the day, end at end of the day
        const startDate = new Date(currentYear, startMonthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, endMonthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Match "Mon D-D" or "Mon D - D" format (e.g., "Dec 1-12" or "Dec 1 - 12")
    const shortRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})(?!\s*\w)/);
    if (shortRangeMatch) {
      const monthAbbrev = shortRangeMatch[1];
      const startDay = parseInt(shortRangeMatch[2], 10);
      const endDay = parseInt(shortRangeMatch[3], 10);

      if (months.hasOwnProperty(monthAbbrev)) {
        const monthNum = months[monthAbbrev];
        // Start at beginning of the day, end at end of the day
        const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    return null;
  };

  // Check badge availability status
  const getBadgeStatus = (badge: BadgeWithMetadata): 'available' | 'coming-soon' | 'expired' | null => {
    const moreInfo = badge.badgebase_info?.more_info;
    if (!moreInfo) return null;

    const now = Date.now();

    // Try to parse date range from more_info (supports multiple formats)
    const dateRange = parseDateRange(moreInfo);
    if (dateRange) {
      const startTime = dateRange.start.getTime();
      const endTime = dateRange.end.getTime();

      if (now < startTime) {
        return 'coming-soon';
      } else if (now >= startTime && now <= endTime) {
        return 'available';
      } else {
        return 'expired';
      }
    }

    // Fallback: Extract ISO timestamps from the more_info text
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;
    const timestamps = moreInfo.match(isoRegex);

    if (!timestamps || timestamps.length === 0) return null;

    try {
      if (timestamps.length === 1) {
        // Single timestamp - assume it's the start time
        const startTime = new Date(timestamps[0]).getTime();
        let endTime: number;

        // Try to find duration hint (e.g., "60 minutes", "2 hours")
        const durationMatch = moreInfo.match(/(\d+)\s+(minute|hour)s?/i);
        if (durationMatch) {
          const duration = parseInt(durationMatch[1], 10);
          const unit = durationMatch[2].toLowerCase();
          const startDate = new Date(timestamps[0]);
          if (unit === 'minute') {
            startDate.setMinutes(startDate.getMinutes() + duration);
          } else if (unit === 'hour') {
            startDate.setHours(startDate.getHours() + duration);
          }
          endTime = startDate.getTime();
        } else {
          // No duration found, assume event lasts until end of that day
          const startDate = new Date(timestamps[0]);
          endTime = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59).getTime();
        }

        if (now < startTime) {
          return 'coming-soon';
        } else if (now >= startTime && now <= endTime) {
          return 'available';
        } else {
          return 'expired';
        }
      } else {
        // Multiple timestamps - assume first is start, last is end
        const startTime = new Date(timestamps[0]).getTime();
        const endTime = new Date(timestamps[timestamps.length - 1]).getTime();

        if (now < startTime) {
          return 'coming-soon';
        } else if (now >= startTime && now <= endTime) {
          return 'available';
        } else {
          return 'expired';
        }
      }
    } catch {
      return null;
    }
  };

  const isBadgeAvailable = (badge: BadgeWithMetadata): boolean => {
    return getBadgeStatus(badge) === 'available';
  };

  const isBadgeComingSoon = (badge: BadgeWithMetadata): boolean => {
    return getBadgeStatus(badge) === 'coming-soon';
  };

  // Sort badges based on selected option - use useMemo to prevent re-sorting on every render
  const sortedBadges = useMemo(() => {
    console.log(`[BadgesOverlay] Sorting ${badgesWithMetadata.length} badges by ${sortBy}`);

    // Check if we can use pre-computed positions for date-newest sort
    // Only use positions if at least 90% of badges have them (to handle edge cases)
    const badgesWithPositions = badgesWithMetadata.filter(b =>
      b.badgebase_info && typeof (b.badgebase_info as any).position === 'number'
    ).length;

    const canUsePositions = sortBy === 'date-newest' &&
      badgesWithMetadata.length > 0 &&
      badgesWithPositions >= badgesWithMetadata.length * 0.9;

    if (canUsePositions) {
      console.log(`[BadgesOverlay] Using pre-computed positions for sorting (${badgesWithPositions}/${badgesWithMetadata.length} badges have positions)`);
      return [...badgesWithMetadata].sort((a, b) => {
        const aPos = (a.badgebase_info as any)?.position;
        const bPos = (b.badgebase_info as any)?.position;

        // If both have positions, use them
        if (typeof aPos === 'number' && typeof bPos === 'number') {
          return aPos - bPos;
        }

        // If only one has a position, sort by date for fair comparison
        const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
        if (dateCompare !== 0) return dateCompare;

        // Fallback to stable sort
        return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
      });
    }

    // Log sample badge data for debugging
    if (badgesWithMetadata.length > 0) {
      const sample = badgesWithMetadata[0];
      console.log('[BadgesOverlay] Sample badge:', {
        set_id: sample.set_id,
        id: sample.id,
        title: sample.title,
        date_added: sample.badgebase_info?.date_added,
        usage_stats: sample.badgebase_info?.usage_stats,
        more_info: sample.badgebase_info?.more_info
      });
    }

    return [...badgesWithMetadata].sort((a, b) => {
      switch (sortBy) {
        case 'available': {
          // Available badges first, then by newest
          const aAvailable = isBadgeAvailable(a) ? 1 : 0;
          const bAvailable = isBadgeAvailable(b) ? 1 : 0;
          if (aAvailable !== bAvailable) {
            return bAvailable - aAvailable;
          }
          // Secondary sort by date
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Tertiary sort by set_id and id for stability
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'coming-soon': {
          // Coming soon badges first, then by newest
          const aComingSoon = isBadgeComingSoon(a) ? 1 : 0;
          const bComingSoon = isBadgeComingSoon(b) ? 1 : 0;
          if (aComingSoon !== bComingSoon) {
            return bComingSoon - aComingSoon;
          }
          // Secondary sort by date
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Tertiary sort by set_id and id for stability
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'date-newest': {
          const dateCompare = parseDate(b.badgebase_info?.date_added) - parseDate(a.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'date-oldest': {
          const dateCompare = parseDate(a.badgebase_info?.date_added) - parseDate(b.badgebase_info?.date_added);
          if (dateCompare !== 0) return dateCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'usage-high': {
          const usageCompare = parseUsageStats(b.badgebase_info?.usage_stats) - parseUsageStats(a.badgebase_info?.usage_stats);
          if (usageCompare !== 0) return usageCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        case 'usage-low': {
          const usageCompare = parseUsageStats(a.badgebase_info?.usage_stats) - parseUsageStats(b.badgebase_info?.usage_stats);
          if (usageCompare !== 0) return usageCompare;
          // Fallback to stable sort
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
        }
        default:
          return `${a.set_id}-${a.id}`.localeCompare(`${b.set_id}-${b.id}`);
      }
    });
  }, [badgesWithMetadata, sortBy]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />

      <div className="bg-secondary border border-borderSubtle rounded-lg shadow-2xl w-[90vw] h-[85vh] max-w-7xl flex flex-col relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
          <div>
            <h2 className="text-xl font-bold text-textPrimary">Twitch Global Badges</h2>
            <p className="text-sm text-textSecondary mt-1">
              Click on any badge to view detailed information
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-glass rounded-lg transition-colors"
            title="Close"
          >
            <X size={20} className="text-textSecondary" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent mx-auto mb-4"></div>
                <p className="text-textSecondary">Loading badges...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-red-400 mb-4">{error}</p>
                <button
                  onClick={loadBadges}
                  className="px-4 py-2 bg-accent hover:bg-accent/80 rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !error && sortedBadges.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <p className="text-textSecondary">No badges found</p>
            </div>
          )}

          {!loading && !error && sortedBadges.length > 0 && (
            <>
              {/* Sort Controls */}
              <div className="flex items-center gap-3 mb-6">
                <div className="flex items-center gap-2 text-textSecondary">
                  <ArrowUpDown size={16} />
                  <span className="text-sm font-medium">Sort by:</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSortBy('date-newest')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'date-newest'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Newest First
                  </button>
                  <button
                    onClick={() => setSortBy('date-oldest')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'date-oldest'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Oldest First
                  </button>
                  <button
                    onClick={() => setSortBy('usage-high')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'usage-high'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Most Used
                  </button>
                  <button
                    onClick={() => setSortBy('usage-low')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${sortBy === 'usage-low'
                      ? 'bg-accent text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    Least Used
                  </button>
                  <button
                    onClick={() => setSortBy('available')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${sortBy === 'available'
                      ? 'bg-green-600 text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    Available Now
                  </button>
                  <button
                    onClick={() => setSortBy('coming-soon')}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2 ${sortBy === 'coming-soon'
                      ? 'bg-blue-600 text-white'
                      : 'bg-glass text-textSecondary hover:bg-glass/80'
                      }`}
                  >
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                    Coming Soon
                  </button>
                </div>
                {loadingMetadata && (
                  <div className="ml-auto flex items-center gap-2 text-textSecondary text-sm">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent"></div>
                    <span>Loading badge data...</span>
                  </div>
                )}
                {newBadgesCount > 0 && !loadingMetadata && (
                  <div className="ml-auto flex items-center gap-2 text-yellow-500 text-sm">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-yellow-500"></div>
                    <span>Fetching {newBadgesCount} new badge{newBadgesCount !== 1 ? 's' : ''}...</span>
                  </div>
                )}
                {!loadingMetadata && newBadgesCount === 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    {cacheAge !== null && cacheAge > 0 && (
                      <span className="text-textSecondary text-xs">
                        Cache age: {cacheAge} day{cacheAge !== 1 ? 's' : ''}
                      </span>
                    )}
                    <button
                      onClick={forceRefreshBadges}
                      disabled={refreshing}
                      className="flex items-center gap-1 px-2 py-1 bg-glass hover:bg-glass/80 rounded text-xs text-textSecondary hover:text-textPrimary transition-colors disabled:opacity-50"
                      title="Force refresh badges from Twitch API"
                    >
                      <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                      {refreshing ? 'Refreshing...' : 'Refresh'}
                    </button>
                  </div>
                )}
              </div>

              {/* Badge Grid */}
              <div className="grid grid-cols-8 gap-6">
                {sortedBadges.map((badge, index) => {
                  const isAvailable = isBadgeAvailable(badge);
                  const isComingSoon = isBadgeComingSoon(badge);
                  return (
                    <button
                      key={`${badge.set_id}-${badge.id}-${index}`}
                      onClick={() => onBadgeClick(badge, badge.set_id)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-lg hover:bg-glass transition-all duration-200 group relative ${isAvailable ? 'ring-2 ring-green-500/50' : isComingSoon ? 'ring-2 ring-blue-500/50' : ''
                        }`}
                      title={badge.title}
                    >
                      <div className={`w-18 h-18 flex items-center justify-center bg-glass rounded-lg group-hover:scale-110 transition-transform duration-200 ${isAvailable ? 'shadow-[0_0_20px_rgba(34,197,94,0.4)]' :
                        isComingSoon ? 'shadow-[0_0_20px_rgba(59,130,246,0.4)]' : ''
                        }`}>
                        <img
                          src={badge.image_url_4x}
                          alt={badge.title}
                          className="w-16 h-16 object-contain"
                          loading="lazy"
                        />
                      </div>
                      {isAvailable && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      )}
                      {isComingSoon && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                      )}
                      <span className="text-xs text-textSecondary text-center line-clamp-2 group-hover:text-textPrimary transition-colors">
                        {badge.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BadgesOverlay;
