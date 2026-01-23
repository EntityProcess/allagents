import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execa } from 'execa';
import {
  parseGitHubUrl,
  getPluginCachePath,
  validatePluginSource,
} from '../utils/plugin-path.js';

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
}

/**
 * Fetch a plugin from GitHub to local cache
 * @param url - GitHub URL of the plugin
 * @param options - Fetch options (force update)
 * @returns Result of the fetch operation
 */
export async function fetchPlugin(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const { force = false } = options;

  // Validate plugin source
  const validation = validatePluginSource(url);
  if (!validation.valid) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      error: validation.error,
    };
  }

  // Parse GitHub URL
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo } = parsed;
  const cachePath = getPluginCachePath(owner, repo);

  // Check if gh CLI is available
  try {
    await execa('gh', ['--version']);
  } catch {
    return {
      success: false,
      action: 'skipped',
      cachePath,
      error: 'gh CLI not installed\n  Install: https://cli.github.com',
    };
  }

  // Check if plugin is already cached
  const isCached = existsSync(cachePath);

  if (isCached && !force) {
    return {
      success: true,
      action: 'skipped',
      cachePath,
    };
  }

  try {
    if (isCached && force) {
      // Update existing cache
      await execa('git', ['pull'], { cwd: cachePath });
      return {
        success: true,
        action: 'updated',
        cachePath,
      };
    } else {
      // Clone new plugin
      // Ensure parent directory exists
      const parentDir = cachePath.split('/').slice(0, -1).join('/');
      await mkdir(parentDir, { recursive: true });

      // Clone repository
      await execa('gh', ['repo', 'clone', `${owner}/${repo}`, cachePath]);

      return {
        success: true,
        action: 'fetched',
        cachePath,
      };
    }
  } catch (error) {
    // Handle specific errors
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      // Authentication errors
      if (errorMessage.includes('auth') || errorMessage.includes('authentication')) {
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
      if (errorMessage.includes('network') || errorMessage.includes('timeout')) {
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
