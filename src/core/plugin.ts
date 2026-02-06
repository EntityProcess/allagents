import { mkdir, readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  parseGitHubUrl,
  getPluginCachePath,
  validatePluginSource,
} from '../utils/plugin-path.js';
import { PluginManifestSchema } from '../models/plugin-config.js';
import { getHomeDir } from '../constants.js';
import { cloneTo, gitHubUrl, GitCloneError, pull } from './git.js';

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
  /** Skip fetching from remote and use cached version if available */
  offline?: boolean;
  /** Branch to checkout after fetching (defaults to default branch) */
  branch?: string;
}

/**
 * Dependencies for fetchPlugin (for testing)
 */
export interface FetchDeps {
  existsSync?: typeof existsSync;
  mkdir?: typeof mkdir;
  cloneTo?: typeof cloneTo;
  pull?: typeof pull;
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
  const { offline = false, branch } = options;
  const {
    existsSync: existsSyncFn = existsSync,
    mkdir: mkdirFn = mkdir,
    cloneTo: cloneToFn = cloneTo,
    pull: pullFn = pull,
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

  // Check if plugin is already cached
  const isCached = existsSyncFn(cachePath);

  if (isCached && offline) {
    // Offline mode: use cached version without fetching
    return {
      success: true,
      action: 'skipped',
      cachePath,
    };
  }

  const repoUrl = gitHubUrl(owner, repo);

  try {
    if (isCached) {
      // Default: pull latest changes
      await pullFn(cachePath);

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

    await cloneToFn(repoUrl, cachePath, branch);

    return {
      success: true,
      action: 'fetched',
      cachePath,
    };
  } catch (error) {
    if (error instanceof GitCloneError) {
      if (error.isAuthError) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Authentication failed for ${owner}/${repo}.\n  Check your SSH keys or git credentials.`,
        };
      }
      if (error.isTimeout) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Clone timed out for ${owner}/${repo}.\n  Check your network connection.`,
        };
      }
    }

    return {
      success: false,
      action: 'skipped',
      cachePath,
      error: `Failed to fetch plugin: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get the cache directory for plugins
 * @returns Path to plugin cache directory
 */
export function getPluginCacheDir(): string {
  return resolve(getHomeDir(), '.allagents', 'plugins', 'marketplaces');
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
      await pull(plugin.path);
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

/**
 * Get the plugin name from plugin.json or fallback to directory name
 * @param pluginPath - Resolved path to the plugin directory
 * @returns The plugin name
 */
export async function getPluginName(pluginPath: string): Promise<string> {
  const manifestPath = join(pluginPath, 'plugin.json');

  if (existsSync(manifestPath)) {
    try {
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      const result = PluginManifestSchema.safeParse(manifest);

      if (result.success && result.data.name) {
        return result.data.name;
      }
    } catch {
      // Fall through to directory name fallback
    }
  }

  // Fallback to directory name
  return basename(pluginPath);
}
