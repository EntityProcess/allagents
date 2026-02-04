import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import https from 'node:https';
import { getHomeDir, CONFIG_DIR } from '../constants.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = 'version-check.json';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/allagents/latest';

export interface UpdateCache {
  latestVersion: string;
  lastCheckedAt: string; // ISO 8601
}

/**
 * Read the cached update info from disk. Returns null if missing or malformed.
 */
export async function getCachedUpdateInfo(
  path?: string,
): Promise<UpdateCache | null> {
  const filePath = path ?? join(getHomeDir(), CONFIG_DIR, CACHE_FILE);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (
      typeof data.latestVersion === 'string' &&
      typeof data.lastCheckedAt === 'string'
    ) {
      return data as UpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a fresh check is needed based on the cache.
 */
export function shouldCheck(cache: UpdateCache | null): boolean {
  if (!cache) return true;
  const elapsed = Date.now() - new Date(cache.lastCheckedAt).getTime();
  return elapsed > CHECK_INTERVAL_MS;
}

/**
 * Compare two semver strings. Returns true if a > b.
 */
function isNewer(a: string, b: string): boolean {
  // Strip pre-release suffixes (e.g. "1.0.0-beta.1" -> "1.0.0")
  // The npm `latest` dist-tag should never have pre-release versions,
  // but handle it defensively.
  const pa = a.split('.').map((s) => Number(s.replace(/-.*$/, '')));
  const pb = b.split('.').map((s) => Number(s.replace(/-.*$/, '')));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Build a human-readable update notice, or null if no update available.
 */
export function buildNotice(
  currentVersion: string,
  latestVersion: string | null,
): string | null {
  if (!latestVersion) return null;
  if (!isNewer(latestVersion, currentVersion)) return null;
  return `  Update available: ${currentVersion} → ${latestVersion}\n  Run \`allagents self update\` to upgrade.`;
}

/**
 * Fetch the latest version from the npm registry.
 * Uses raw https to avoid adding dependencies.
 */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(NPM_REGISTRY_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain
        resolve(null);
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(typeof data.version === 'string' ? data.version : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Write the cache file.
 */
async function writeCache(cache: UpdateCache): Promise<void> {
  const dir = join(getHomeDir(), CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2));
}

/**
 * Fire-and-forget background check. Fetches latest version from npm and
 * updates the cache file. Errors are silently swallowed.
 */
export function backgroundUpdateCheck(): void {
  fetchLatestVersion()
    .then(async (version) => {
      if (version) {
        await writeCache({
          latestVersion: version,
          lastCheckedAt: new Date().toISOString(),
        });
      }
    })
    .catch(() => {});
}

/**
 * Get the update notice to display, or null. Kicks off a background
 * refresh if the cache is stale. Never blocks startup.
 */
export async function getUpdateNotice(
  currentVersion: string,
): Promise<string | null> {
  const cache = await getCachedUpdateInfo();
  if (shouldCheck(cache)) {
    backgroundUpdateCheck();
  }
  return buildNotice(currentVersion, cache?.latestVersion ?? null);
}
