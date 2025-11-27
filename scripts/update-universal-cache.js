/**
 * Universal Cache Updater Script
 * 
 * This script runs via GitHub Actions to:
 * 1. Fetch global badges from Twitch API
 * 2. Fetch metadata for each badge from BadgeBase
 * 3. Update the universal cache manifest
 * 
 * Required GitHub Secrets:
 * - TWITCH_CLIENT_ID: Twitch API client ID
 * - TWITCH_CLIENT_SECRET: Twitch API client secret
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const CACHE_DIR = path.join(__dirname, '..', 'universal-cache', 'main');
const MANIFEST_PATH = path.join(CACHE_DIR, 'manifest.json');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// Rate limiting for BadgeBase
const BADGEBASE_DELAY_MS = 300;

/**
 * Make an HTTPS GET request
 */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'StreamNook-Universal-Cache-Updater/1.0',
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data, statusCode: res.statusCode });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Make an HTTPS POST request
 */
function httpsPost(url, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data, statusCode: res.statusCode });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Get Twitch app access token
 */
async function getTwitchToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET environment variables are required');
  }

  console.log('[Twitch] Getting app access token...');
  
  const body = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'client_credentials',
  }).toString();

  const response = await httpsPost('https://id.twitch.tv/oauth2/token', body);
  const data = JSON.parse(response.data);
  
  console.log('[Twitch] Got access token');
  return data.access_token;
}

/**
 * Fetch global badges from Twitch API
 */
async function fetchTwitchBadges(token) {
  console.log('[Twitch] Fetching global badges...');

  const response = await httpsGet('https://api.twitch.tv/helix/chat/badges/global', {
    'Client-Id': TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${token}`,
  });

  const data = JSON.parse(response.data);
  console.log(`[Twitch] Fetched ${data.data.length} badge sets`);
  return data.data;
}

/**
 * Fetch badge metadata from BadgeBase
 */
async function fetchBadgeMetadata(setId, versionId) {
  const url = `https://badgebase.co/badges/${setId}-v${versionId}/`;
  
  try {
    const response = await httpsGet(url);
    const html = response.data;
    
    return {
      date_added: extractDateAdded(html),
      usage_stats: extractUsageStats(html),
      more_info: extractMoreInfo(html),
    };
  } catch (error) {
    // Badge might not exist on BadgeBase yet
    return null;
  }
}

/**
 * Extract date added from BadgeBase HTML
 */
function extractDateAdded(html) {
  // Pattern: "Date of addition" followed by a date
  const patterns = [
    /Date of addition[^<]*<\/span>\s*<span[^>]*>([^<]+)/i,
    /Date of addition[^<]*([0-9]{1,2}\s+\w+\s+[0-9]{4})/i,
    /<li[^>]*>.*?Date of addition.*?([0-9]{1,2}\s+\w+\s+[0-9]{4})/is,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  return null;
}

/**
 * Extract usage stats from BadgeBase HTML
 */
function extractUsageStats(html) {
  const match = html.match(/(\d+(?:,\d+)*)\s*users?\s*seen\s*with\s*this\s*badge/i);
  if (match) {
    return `${match[1]} users seen with this badge`;
  }
  return null;
}

/**
 * Extract more info from BadgeBase HTML
 */
function extractMoreInfo(html) {
  const match = html.match(/More Info From Us[\s\S]*?<div[^>]*class="[^"]*text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (match) {
    let text = match[1];
    
    // Extract timestamps from timezone-converter spans
    text = text.replace(/<span[^>]*class="[^"]*timezone-converter[^"]*"[^>]*data-original="([^"]*)"[^>]*>[^<]*<\/span>/gi, '$1');
    
    // Remove HTML tags
    text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    
    return text || null;
  }
  return null;
}

/**
 * Sleep for ms milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get current timestamp in seconds
 */
function getTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Load existing manifest or create new one
 */
function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const data = fs.readFileSync(MANIFEST_PATH, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.log('[Manifest] Failed to load existing manifest, creating new one');
    }
  }
  return {
    version: 1,
    last_sync: null,
    entries: {},
  };
}

/**
 * Save manifest to file
 */
function saveManifest(manifest) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Universal Badge Cache Updater');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('='.repeat(50));

  try {
    // Step 1: Get Twitch token
    const token = await getTwitchToken();

    // Step 2: Fetch badges from Twitch
    const badgeSets = await fetchTwitchBadges(token);

    // Step 3: Load existing manifest
    const manifest = loadManifest();
    console.log(`[Manifest] Loaded ${Object.keys(manifest.entries).length} existing entries`);

    // Step 4: Store global badges
    const badgesData = {
      badges: { data: badgeSets },
      cached_at: getTimestamp(),
    };
    
    manifest.entries['global_badges'] = {
      id: 'global_badges',
      cache_type: 'badge',
      data: badgesData,
      metadata: {
        timestamp: getTimestamp(),
        expiry_days: 7,
        source: 'twitch',
        version: 1,
      },
    };

    // Count badges
    let totalVersions = 0;
    badgeSets.forEach(set => totalVersions += set.versions.length);
    console.log(`[Badges] ${badgeSets.length} sets, ${totalVersions} total versions`);

    // Step 5: Fetch metadata for each badge
    console.log('\n[Metadata] Fetching badge metadata...');
    let fetched = 0;
    let skipped = 0;
    let failed = 0;
    let newBadges = [];

    for (const badgeSet of badgeSets) {
      for (const version of badgeSet.versions) {
        const metadataKey = `metadata:${badgeSet.set_id}-v${version.id}`;
        
        // Check if we already have this metadata
        const existing = manifest.entries[metadataKey];
        if (existing && existing.metadata && existing.data) {
          // Skip if we have valid metadata and it's from badgebase
          if (existing.metadata.source === 'badgebase' && existing.data.date_added) {
            skipped++;
            continue;
          }
        }

        // Fetch metadata from external source
        await sleep(BADGEBASE_DELAY_MS);
        const metadata = await fetchBadgeMetadata(badgeSet.set_id, version.id);
        
        if (metadata) {
          manifest.entries[metadataKey] = {
            id: metadataKey,
            cache_type: 'badge',
            data: metadata,
            metadata: {
              timestamp: getTimestamp(),
              expiry_days: 0, // Never expire
              source: 'badgebase',
              version: 1,
            },
          };
          fetched++;
          newBadges.push(`${badgeSet.set_id}-v${version.id} (${version.title})`);
          console.log(`[Metadata] ✓ ${badgeSet.set_id}-v${version.id} (${version.title})`);
        } else {
          failed++;
          console.log(`[Metadata] ✗ ${badgeSet.set_id}-v${version.id} (not found)`);
        }
      }
    }

    // Step 6: Assign positions based on date
    console.log('\n[Positions] Sorting badges by date...');
    const metadataEntries = Object.entries(manifest.entries)
      .filter(([_, entry]) => entry.metadata?.source === 'badgebase')
      .map(([id, entry]) => ({ id, entry }));

    // Sort by date (newest first)
    metadataEntries.sort((a, b) => {
      const dateA = parseDate(a.entry.data?.date_added);
      const dateB = parseDate(b.entry.data?.date_added);
      return dateB - dateA;
    });

    // Assign positions
    metadataEntries.forEach(({ id, entry }, index) => {
      manifest.entries[id].position = index;
    });
    console.log(`[Positions] Assigned positions to ${metadataEntries.length} badges`);

    // Step 7: Update sync time and save
    manifest.last_sync = getTimestamp();
    saveManifest(manifest);

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  Total badge sets: ${badgeSets.length}`);
    console.log(`  Total versions: ${totalVersions}`);
    console.log(`  Metadata fetched: ${fetched}`);
    console.log(`  Metadata skipped (already cached): ${skipped}`);
    console.log(`  Metadata failed: ${failed}`);
    console.log(`  Manifest entries: ${Object.keys(manifest.entries).length}`);
    
    if (newBadges.length > 0) {
      console.log('\nNew badges added:');
      newBadges.forEach(b => console.log(`  - ${b}`));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`Completed at: ${new Date().toISOString()}`);

  } catch (error) {
    console.error('\n[ERROR]', error.message);
    process.exit(1);
  }
}

/**
 * Parse date string to timestamp
 */
function parseDate(dateStr) {
  if (!dateStr) return 0;
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  } catch {
    return 0;
  }
}

// Run
main();
