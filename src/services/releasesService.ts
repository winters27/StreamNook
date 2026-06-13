// Shared GitHub releases fetch + cache, used by the post-update changelog popup
// (version switcher) and the What's New settings tab. One ETag-cached source so
// both surfaces share a single fetch and stay in sync.

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string;
  published_at: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const REPO = 'winters27/StreamNook';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
// Bumped to _v2 when the cache schema gained an etag field.
const CACHE_KEY = 'streamnook_whatsnew_cache_v2';

interface CachedReleases {
  fetchedAt: number;
  etag: string | null;
  releases: GitHubRelease[];
}

export const loadReleasesCache = (): CachedReleases | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedReleases = JSON.parse(raw);
    if (!parsed.releases || !Array.isArray(parsed.releases)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const saveReleasesCache = (data: CachedReleases) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Silently fail; cache is opportunistic.
  }
};

// Fetch via GitHub's conditional-request flow. With a previous ETag we send
// If-None-Match; GitHub returns 304 when nothing changed, and 304s don't count
// against the 60/hour unauthenticated limit, so probing on every open is free.
// bypassEtag skips the header to force a true refresh.
export type FetchReleasesResult =
  | { ok: true; kind: 'fresh'; releases: GitHubRelease[]; etag: string | null }
  | { ok: true; kind: 'not-modified' }
  | { ok: false; error: string };

export const fetchReleases = async (
  opts: { bypassEtag?: boolean; signal?: AbortSignal } = {},
): Promise<FetchReleasesResult> => {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (!opts.bypassEtag) {
      const cached = loadReleasesCache();
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
    }
    const response = await fetch(RELEASES_URL, { headers, signal: opts.signal });
    if (response.status === 304) return { ok: true, kind: 'not-modified' };
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const data = (await response.json()) as GitHubRelease[];
    return {
      ok: true,
      kind: 'fresh',
      releases: data.filter((r) => !r.draft),
      etag: response.headers.get('ETag'),
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};
