import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import {
  parseGitHubUrl,
  getPluginCachePath,
  validatePluginSource,
} from '../utils/plugin-path.js';

/**
 * Information about a cached plugin
 */
export interface CachedPlugin {
  name: string;
  path: string;
  lastModified: Date;
}

/**
 * Result of plugin fetch operation
 */
export interface FetchResult {
  success: boolean;
  action: 'fetched' | 'updated' | 'skipped';
  cachePath: string;
  error?: string;
}

/**
 * Options for fetchPlugin
 */
export interface FetchOptions {
  force?: boolean;
  /** Branch to checkout after fetching (defaults to default branch) */
  branch?: string;
}

/**
 * Dependencies for fetchPlugin (for testing)
 */
export interface FetchDeps {
  execa?: typeof execa;
  existsSync?: typeof existsSync;
  mkdir?: typeof mkdir;
}

/**
 * Fetch a plugin from GitHub to local cache
 * @param url - GitHub URL of the plugin
 * @param options - Fetch options (force update)
 * @param deps - Optional dependencies for testing
 * @returns Result of the fetch operation
 */
export async function fetchPlugin(
  url: string,
  options: FetchOptions = {},
  deps: FetchDeps = {},
): Promise<FetchResult> {
  const { force = false, branch } = options;
  const {
    execa: execaFn = execa,
    existsSync: existsSyncFn = existsSync,
    mkdir: mkdirFn = mkdir,
  } = deps;

  // Validate plugin source
  const validation = validatePluginSource(url);
  if (!validation.valid) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      ...(validation.error && { error: validation.error }),
    };
  }

  // Parse GitHub URL
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      error:
        'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo } = parsed;
  // Use branch-specific cache path if branch is specified
  const cachePath = getPluginCachePath(owner, repo, branch);

  // Check if gh CLI is available
  try {
    await execaFn('gh', ['--version']);
  } catch {
    return {
      success: false,
      action: 'skipped',
      cachePath,
      error: 'gh CLI not installed\n  Install: https://cli.github.com',
    };
  }

  // Check if plugin is already cached
  const isCached = existsSyncFn(cachePath);

  if (isCached && !force) {
    return {
      success: true,
      action: 'skipped',
      cachePath,
    };
  }

  try {
    if (isCached && force) {
      // Update existing cache - pull latest changes
      await execaFn('git', ['pull'], { cwd: cachePath });

      return {
        success: true,
        action: 'updated',
        cachePath,
      };
    }
    // Clone new plugin
    // Ensure parent directory exists
    const parentDir = dirname(cachePath);
    await mkdirFn(parentDir, { recursive: true });

    // Clone repository with specific branch if provided
    if (branch) {
      await execaFn('gh', ['repo', 'clone', `${owner}/${repo}`, cachePath, '--', '--branch', branch]);
    } else {
      await execaFn('gh', ['repo', 'clone', `${owner}/${repo}`, cachePath]);
    }

    return {
      success: true,
      action: 'fetched',
      cachePath,
    };
  } catch (error) {
    // Handle specific errors
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      // Authentication errors
      if (
        errorMessage.includes('auth') ||
        errorMessage.includes('authentication')
      ) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: 'GitHub authentication required\n  Run: gh auth login',
        };
      }

      // Repository not found
      if (errorMessage.includes('not found') || errorMessage.includes('404')) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Repository not found: ${owner}/${repo}`,
        };
      }

      // Network errors
      if (
        errorMessage.includes('network') ||
        errorMessage.includes('timeout')
      ) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Network error: ${error.message}`,
        };
      }

      // Generic error
      return {
        success: false,
        action: 'skipped',
        cachePath,
        error: `Failed to fetch plugin: ${error.message}`,
      };
    }

    return {
      success: false,
      action: 'skipped',
      cachePath,
      error: `Unknown error: ${String(error)}`,
    };
  }
}

/**
 * Get the cache directory for plugins
 * @returns Path to plugin cache directory
 */
export function getPluginCacheDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  return resolve(homeDir, '.allagents', 'plugins', 'marketplaces');
}

/**
 * List all cached plugins
 * @returns Array of cached plugin information
 */
export async function listCachedPlugins(): Promise<CachedPlugin[]> {
  const cacheDir = getPluginCacheDir();

  if (!existsSync(cacheDir)) {
    return [];
  }

  const entries = await readdir(cacheDir, { withFileTypes: true });
  const plugins: CachedPlugin[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pluginPath = join(cacheDir, entry.name);
      const stats = await stat(pluginPath);

      plugins.push({
        name: entry.name,
        path: pluginPath,
        lastModified: stats.mtime,
      });
    }
  }

  // Sort by name
  plugins.sort((a, b) => a.name.localeCompare(b.name));

  return plugins;
}

/**
 * Result of update operation
 */
export interface UpdateResult {
  name: string;
  success: boolean;
  error?: string;
}

/**
 * Update cached plugins by running git pull
 * @param name - Optional plugin name to update (updates all if not specified)
 * @returns Array of update results
 */
export async function updateCachedPlugins(
  name?: string,
): Promise<UpdateResult[]> {
  const plugins = await listCachedPlugins();
  const results: UpdateResult[] = [];

  // Filter by name if specified
  const toUpdate = name ? plugins.filter((p) => p.name === name) : plugins;

  if (name && toUpdate.length === 0) {
    return [
      {
        name,
        success: false,
        error: `Plugin not found in cache: ${name}`,
      },
    ];
  }

  for (const plugin of toUpdate) {
    try {
      await execa('git', ['pull'], { cwd: plugin.path });
      results.push({ name: plugin.name, success: true });
    } catch (error) {
      results.push({
        name: plugin.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}
