import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
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

interface BadgeDetailOverlayProps {
  badge: BadgeVersion;
  setId: string;
  onClose: () => void;
  onBack: () => void;
}

const BadgeDetailOverlay = ({ badge, setId, onClose, onBack }: BadgeDetailOverlayProps) => {
  const [badgeBaseInfo, setBadgeBaseInfo] = useState<BadgeMetadata | null>(null);
  const [loadingBadgeBase, setLoadingBadgeBase] = useState(true);

  // Fetch BadgeBase.co information
  useEffect(() => {
    const fetchBadgeBaseInfo = async () => {
      try {
        setLoadingBadgeBase(true);
        const info = await invoke<BadgeMetadata>('fetch_badge_metadata', {
          badgeSetId: setId,
          badgeVersion: badge.id,
        });
        setBadgeBaseInfo(info);
      } catch (error) {
        console.warn('[BadgeDetail] Failed to fetch BadgeBase info:', error);
        // Silently fail - BadgeBase info is optional
      } finally {
        setLoadingBadgeBase(false);
      }
    };

    fetchBadgeBaseInfo();
  }, [setId, badge.id]);

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

  // Parse various date range formats
  const parseDateRange = (inputText: string): { start: Date; end: Date } | null => {
    // First decode HTML entities
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

    // Try to parse "Event duration: December 6, 2025 – December 7, 2025" format
    const fullDateRangeMatch = text.match(/Event duration:\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})\s*[–-]\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (fullDateRangeMatch) {
      const startMonthName = fullDateRangeMatch[1];
      const startDay = parseInt(fullDateRangeMatch[2], 10);
      const startYear = parseInt(fullDateRangeMatch[3], 10);
      const endMonthName = fullDateRangeMatch[4];
      const endDay = parseInt(fullDateRangeMatch[5], 10);
      const endYear = parseInt(fullDateRangeMatch[6], 10);

      if (fullMonths.hasOwnProperty(startMonthName) && fullMonths.hasOwnProperty(endMonthName)) {
        const startDate = new Date(startYear, fullMonths[startMonthName], startDay, 0, 0, 0);
        const endDate = new Date(endYear, fullMonths[endMonthName], endDay, 23, 59, 59);

        if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime())) {
          return { start: startDate, end: endDate };
        }
      }
    }

    // Try to parse "Event duration: Dec 19 – Jan 01" format (abbreviated, cross-month/year)
    const eventDurationMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/i);
    if (eventDurationMatch) {
      const startMonthAbbrev = eventDurationMatch[1];
      const startDay = parseInt(eventDurationMatch[2], 10);
      const endMonthAbbrev = eventDurationMatch[3];
      const endDay = parseInt(eventDurationMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];

        let startYear = currentYear;
        let endYear = currentYear;
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
    const eventDurationSameMonthMatch = text.match(/Event duration:\s*(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})/i);
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
  const getBadgeStatus = (): 'available' | 'coming-soon' | 'expired' | null => {
    const moreInfo = badgeBaseInfo?.more_info;
    if (!moreInfo) return null;

    const now = Date.now();

    // First, try to parse abbreviated date range format (e.g., "Dec 1-12")
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

  const badgeStatus = getBadgeStatus();
  const isAvailable = badgeStatus === 'available';
  const isComingSoon = badgeStatus === 'coming-soon';

  // Convert timestamps to local time and return as JSX with highlighted dates
  // Handles both ISO timestamps and abbreviated date ranges like "Dec 1-12"
  const convertTimestampsToLocalJSX = (inputText: string): JSX.Element => {
    // First decode HTML entities
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

    // Check for "Month D, YYYY – Month D, YYYY" format (e.g., "December 6, 2025 – December 7, 2025")
    const fullDateRangeMatch = text.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})\s*[–-]\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (fullDateRangeMatch) {
      const startMonthName = fullDateRangeMatch[1];
      const startDay = parseInt(fullDateRangeMatch[2], 10);
      const startYear = parseInt(fullDateRangeMatch[3], 10);
      const endMonthName = fullDateRangeMatch[4];
      const endDay = parseInt(fullDateRangeMatch[5], 10);
      const endYear = parseInt(fullDateRangeMatch[6], 10);

      if (fullMonths.hasOwnProperty(startMonthName) && fullMonths.hasOwnProperty(endMonthName)) {
        const startDate = new Date(startYear, fullMonths[startMonthName], startDay, 0, 0, 0);
        const endDate = new Date(endYear, fullMonths[endMonthName], endDay, 23, 59, 59);

        // Format the dates
        const formattedStartDate = startDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const formattedEndDate = endDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        // Determine styling based on badge status
        let startClassName = 'px-2 py-0.5 rounded font-medium inline-block ';
        let endClassName = 'px-2 py-0.5 rounded font-medium inline-block ';

        if (isAvailable) {
          startClassName += 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
          endClassName += 'bg-green-500/10 text-green-300 ring-1 ring-green-500/30';
        } else if (isComingSoon) {
          startClassName += 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]';
          endClassName += 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30';
        } else {
          startClassName += 'bg-accent/20 text-accent';
          endClassName += 'bg-accent/20 text-accent';
        }

        // Replace the date range with formatted dates
        const beforeMatch = text.substring(0, fullDateRangeMatch.index);
        const afterMatch = text.substring(fullDateRangeMatch.index! + fullDateRangeMatch[0].length);

        return (
          <>
            {beforeMatch}
            <span className={startClassName}>{formattedStartDate}</span>
            {' – '}
            <span className={endClassName}>{formattedEndDate}</span>
            {afterMatch}
          </>
        );
      }
    }

    // Check for "Mon DD – Mon DD" format (e.g., "Dec 06 – Dec 07")
    const fullRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\w{3})\s+(\d{1,2})/);
    if (fullRangeMatch) {
      const startMonthAbbrev = fullRangeMatch[1];
      const startDay = parseInt(fullRangeMatch[2], 10);
      const endMonthAbbrev = fullRangeMatch[3];
      const endDay = parseInt(fullRangeMatch[4], 10);

      if (months.hasOwnProperty(startMonthAbbrev) && months.hasOwnProperty(endMonthAbbrev)) {
        const startMonthNum = months[startMonthAbbrev];
        const endMonthNum = months[endMonthAbbrev];
        const startDate = new Date(currentYear, startMonthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, endMonthNum, endDay, 23, 59, 59);

        // Format the dates
        const formattedStartDate = startDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const formattedEndDate = endDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        // Determine styling based on badge status
        let startClassName = 'px-2 py-0.5 rounded font-medium inline-block ';
        let endClassName = 'px-2 py-0.5 rounded font-medium inline-block ';

        if (isAvailable) {
          startClassName += 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
          endClassName += 'bg-green-500/10 text-green-300 ring-1 ring-green-500/30';
        } else if (isComingSoon) {
          startClassName += 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]';
          endClassName += 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30';
        } else {
          startClassName += 'bg-accent/20 text-accent';
          endClassName += 'bg-accent/20 text-accent';
        }

        // Replace the abbreviated date with formatted dates
        const beforeMatch = text.substring(0, fullRangeMatch.index);
        const afterMatch = text.substring(fullRangeMatch.index! + fullRangeMatch[0].length);

        return (
          <>
            {beforeMatch}
            <span className={startClassName}>{formattedStartDate}</span>
            {' – '}
            <span className={endClassName}>{formattedEndDate}</span>
            {afterMatch}
          </>
        );
      }
    }

    // Check for "Mon D-D" format (e.g., "Dec 1-12")
    const shortRangeMatch = text.match(/(\w{3})\s+(\d{1,2})\s*[–-]\s*(\d{1,2})(?!\s*\w)/);
    if (shortRangeMatch) {
      const monthAbbrev = shortRangeMatch[1];
      const startDay = parseInt(shortRangeMatch[2], 10);
      const endDay = parseInt(shortRangeMatch[3], 10);

      if (months.hasOwnProperty(monthAbbrev)) {
        const monthNum = months[monthAbbrev];
        const startDate = new Date(currentYear, monthNum, startDay, 0, 0, 0);
        const endDate = new Date(currentYear, monthNum, endDay, 23, 59, 59);

        // Format the dates
        const formattedStartDate = startDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const formattedEndDate = endDate.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        // Determine styling based on badge status
        let startClassName = 'px-2 py-0.5 rounded font-medium inline-block ';
        let endClassName = 'px-2 py-0.5 rounded font-medium inline-block ';

        if (isAvailable) {
          startClassName += 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
          endClassName += 'bg-green-500/10 text-green-300 ring-1 ring-green-500/30';
        } else if (isComingSoon) {
          startClassName += 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]';
          endClassName += 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30';
        } else {
          startClassName += 'bg-accent/20 text-accent';
          endClassName += 'bg-accent/20 text-accent';
        }

        // Replace the abbreviated date with formatted dates
        const beforeMatch = text.substring(0, shortRangeMatch.index);
        const afterMatch = text.substring(shortRangeMatch.index! + shortRangeMatch[0].length);

        return (
          <>
            {beforeMatch}
            <span className={startClassName}>{formattedStartDate}</span>
            {' – '}
            <span className={endClassName}>{formattedEndDate}</span>
            {afterMatch}
          </>
        );
      }
    }

    // Fallback: Match ISO 8601 timestamps in the format: 2025-09-12T17:00 or 2025-09-12T17:00:00Z
    const isoRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z)?)/g;

    // Extract all timestamps first to determine start and end
    const timestamps = text.match(isoRegex);
    const now = Date.now();

    // Special handling for single timestamp
    if (timestamps && timestamps.length === 1) {
      const match = isoRegex.exec(text);
      if (match) {
        try {
          const startDate = new Date(match[0]);

          // Calculate end time based on duration
          let endDate: Date;
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
          } else {
            // No duration found, assume event lasts until end of that day
            endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59);
          }

          const formattedStartDate = startDate.toLocaleString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });

          const formattedEndDate = endDate.toLocaleString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });

          // Determine styling based on badge status
          let startClassName = 'px-2 py-0.5 rounded font-medium inline-block ';
          let endClassName = 'px-2 py-0.5 rounded font-medium inline-block ';

          if (isAvailable) {
            startClassName += 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
            endClassName += 'bg-green-500/10 text-green-300 ring-1 ring-green-500/30';
          } else if (isComingSoon) {
            startClassName += 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]';
            endClassName += 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30';
          } else {
            startClassName += 'bg-accent/20 text-accent';
            endClassName += 'bg-accent/20 text-accent';
          }

          const beforeMatch = text.substring(0, match.index);
          const afterMatch = text.substring(match.index + match[0].length);

          return (
            <>
              {beforeMatch}
              <span className={startClassName}>{formattedStartDate}</span>
              {' – '}
              <span className={endClassName}>{formattedEndDate}</span>
              {afterMatch}
            </>
          );
        } catch (e) {
          // If parsing fails, fall through to normal text handling
        }
      }
    }

    // Multiple timestamps handling
    const parts: (string | JSX.Element)[] = [];
    let lastIndex = 0;
    let match;
    let matchIndex = 0;

    isoRegex.lastIndex = 0; // Reset regex after previous exec

    while ((match = isoRegex.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }

      // Format and add the highlighted timestamp
      try {
        const date = new Date(match[0]);
        const dateTime = date.getTime();
        const formattedDate = date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });

        // Determine if this is the start date (first timestamp) or end date (last timestamp)
        const isStartDate = timestamps && matchIndex === 0;
        const isEndDate = timestamps && matchIndex === timestamps.length - 1;

        // Determine styling based on badge status and which date this is
        let className = 'px-2 py-0.5 rounded font-medium inline-block ';

        if (isAvailable) {
          // Badge is available now - highlight the active period
          if (isStartDate && timestamps.length > 1) {
            // Start date - when it became available (green with glow)
            className += 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]';
          } else if (isEndDate && timestamps.length > 1) {
            // End date - when it expires (softer green)
            className += 'bg-green-500/10 text-green-300 ring-1 ring-green-500/30';
          } else {
            // Other dates
            className += 'bg-accent/20 text-accent';
          }
        } else if (isComingSoon) {
          // Badge is coming soon - highlight the start date
          if (isStartDate && timestamps.length > 1) {
            // Start date - when it will become available (blue with glow)
            className += 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/50 shadow-[0_0_10px_rgba(59,130,246,0.3)]';
          } else if (isEndDate && timestamps.length > 1) {
            // End date - when it will expire (softer blue)
            className += 'bg-blue-500/10 text-blue-300 ring-1 ring-blue-500/30';
          } else {
            // Other dates
            className += 'bg-accent/20 text-accent';
          }
        } else {
          // Badge is expired or no special status - use neutral accent color
          className += 'bg-accent/20 text-accent';
        }

        parts.push(
          <span key={match.index} className={className}>
            {formattedDate}
          </span>
        );
      } catch (e) {
        // If parsing fails, add original text
        parts.push(match[0]);
      }

      lastIndex = match.index + match[0].length;
      matchIndex++;
    }

    // Add remaining text after last match
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return <>{parts}</>;
  };

  // Format the badge ID for display
  const formatBadgeId = (id: string) => {
    return id.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm group">
      {/* Hover-sensitive background overlay */}
      <div
        className="absolute inset-0 group-hover:pointer-events-none"
        onClick={onClose}
      />

      <div className="bg-secondary border border-borderSubtle rounded-lg shadow-2xl w-[90vw] h-[85vh] max-w-5xl flex flex-col relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-borderSubtle">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 hover:bg-glass rounded-lg transition-colors"
              title="Back to badges"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className="w-5 h-5 text-textSecondary"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-textPrimary">{badge.title}</h2>
                {isAvailable && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-green-600/20 border border-green-500/50 rounded-full">
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    <span className="text-xs font-medium text-green-400">Available Now</span>
                  </div>
                )}
                {isComingSoon && (
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-blue-600/20 border border-blue-500/50 rounded-full">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                    <span className="text-xs font-medium text-blue-400">Coming Soon</span>
                  </div>
                )}
              </div>
              <p className="text-sm text-accent">Twitch Chat Badge</p>
            </div>
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
          <div className="max-w-3xl mx-auto space-y-8">
            {/* Badge Variations */}
            <div className="flex items-end gap-4">
              <a
                href={badge.image_url_4x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-4 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 72px image"
              >
                <img
                  src={badge.image_url_4x}
                  alt={badge.title}
                  className="w-18 h-18 object-contain"
                />
              </a>
              <a
                href={badge.image_url_2x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-3 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 36px image"
              >
                <img
                  src={badge.image_url_2x}
                  alt={badge.title}
                  className="w-9 h-9 object-contain"
                />
              </a>
              <a
                href={badge.image_url_1x}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center bg-glass rounded-lg p-2 hover:bg-glass/80 transition-colors cursor-pointer"
                title="View 18px image"
              >
                <img
                  src={badge.image_url_1x}
                  alt={badge.title}
                  className="w-[18px] h-[18px] object-contain"
                />
              </a>
            </div>

            {/* Additional Info */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">About This Badge</h3>
              <div className="bg-glass rounded-lg p-4">
                <p className="text-textSecondary text-sm leading-relaxed">
                  This is a global Twitch chat badge that appears next to usernames in chat.
                  {badge.description && (
                    <span className="block mt-2 text-textPrimary">
                      {badge.description}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Badge Data */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-accent uppercase tracking-wide">Badge Data</h3>
              <div className="bg-glass rounded-lg divide-y divide-borderSubtle">
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">ID</span>
                  <span className="text-textPrimary break-all">{setId}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Version</span>
                  <span className="text-textPrimary">{badge.id}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Title</span>
                  <span className="text-textPrimary">{badge.title}</span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40 self-start">Description</span>
                  <span className="text-textPrimary flex-1">
                    {badge.description || 'No description available'}
                  </span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Click Action</span>
                  <span className="text-textPrimary">
                    {badge.click_action || '-'}
                  </span>
                </div>
                <div className="flex py-3 px-4">
                  <span className="text-textSecondary font-medium w-40">Click URL</span>
                  <span className="text-textPrimary break-all">
                    {badge.click_url ? (
                      <a
                        href={badge.click_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {badge.click_url}
                      </a>
                    ) : (
                      '-'
                    )}
                  </span>
                </div>
                {/* Additional fields from community data */}
                {badgeBaseInfo?.date_added && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40">Date of Addition</span>
                    <span className="text-textPrimary">{badgeBaseInfo.date_added}</span>
                  </div>
                )}
                {badgeBaseInfo?.usage_stats && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40">Usage Statistics</span>
                    <span className="text-textPrimary">{badgeBaseInfo.usage_stats}</span>
                  </div>
                )}
                {badgeBaseInfo?.more_info && (
                  <div className="flex py-3 px-4">
                    <span className="text-textSecondary font-medium w-40 self-start">More Info</span>
                    <span className="text-textPrimary flex-1">
                      {convertTimestampsToLocalJSX(badgeBaseInfo.more_info)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Loading state for BadgeBase info */}
            {loadingBadgeBase && (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent"></div>
                <span className="ml-3 text-textSecondary text-sm">Loading additional badge info...</span>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
};

export default BadgeDetailOverlay;
