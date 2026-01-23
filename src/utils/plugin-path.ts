import { resolve, isAbsolute } from 'path';

/**
 * Plugin source types
 */
export type PluginSourceType = 'github' | 'local';

/**
 * Parsed plugin source information
 */
export interface ParsedPluginSource {
  type: PluginSourceType;
  original: string;
  normalized: string;
  owner?: string;
  repo?: string;
}

/**
 * Detect if a plugin source is a GitHub URL
 * @param source - Plugin source string
 * @returns true if source is a GitHub URL
 */
export function isGitHubUrl(source: string): boolean {
  const githubPatterns = [
    /^https?:\/\/github\.com\//,
    /^https?:\/\/www\.github\.com\//,
    /^github\.com\//,
    /^gh:/,
  ];

  return githubPatterns.some((pattern) => pattern.test(source));
}

/**
 * Parse GitHub URL to extract owner and repo
 * @param url - GitHub URL
 * @returns Object with owner and repo, or null if invalid
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Normalize URL
  let normalized = url;

  // Handle gh: prefix
  if (normalized.startsWith('gh:')) {
    normalized = normalized.replace(/^gh:/, 'https://github.com/');
  }

  // Handle github.com/ prefix without protocol
  if (normalized.startsWith('github.com/')) {
    normalized = 'https://' + normalized;
  }

  // Extract owner/repo from URL
  const patterns = [
    // https://github.com/owner/repo
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
    // https://github.com/owner/repo/tree/main/path
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/tree\/[^/]+\/(.+)$/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const owner = match[1];
      const repo = match[2]?.replace(/\.git$/, '');

      if (owner && repo) {
        return { owner, repo };
      }
    }
  }

  return null;
}

/**
 * Normalize plugin source path
 * Converts relative paths to absolute, leaves GitHub URLs as-is
 * @param source - Plugin source (path or URL)
 * @param baseDir - Base directory for resolving relative paths (default: process.cwd())
 * @returns Normalized source
 */
export function normalizePluginPath(source: string, baseDir: string = process.cwd()): string {
  // GitHub URLs remain unchanged
  if (isGitHubUrl(source)) {
    return source;
  }

  // Already absolute path
  if (isAbsolute(source)) {
    return source;
  }

  // Relative path - convert to absolute
  return resolve(baseDir, source);
}

/**
 * Parse plugin source into structured information
 * @param source - Plugin source (path or URL)
 * @param baseDir - Base directory for resolving relative paths
 * @returns Parsed plugin source information
 */
export function parsePluginSource(
  source: string,
  baseDir: string = process.cwd()
): ParsedPluginSource {
  if (isGitHubUrl(source)) {
    const parsed = parseGitHubUrl(source);
    return {
      type: 'github',
      original: source,
      normalized: source,
      ...(parsed?.owner && { owner: parsed.owner }),
      ...(parsed?.repo && { repo: parsed.repo }),
    };
  }

  return {
    type: 'local',
    original: source,
    normalized: normalizePluginPath(source, baseDir),
  };
}

/**
 * Get cache directory path for a GitHub plugin
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns Cache directory path
 */
export function getPluginCachePath(owner: string, repo: string): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  return resolve(homeDir, '.allagents', 'plugins', 'marketplaces', `${owner}-${repo}`);
}

/**
 * Validate plugin source format
 * @param source - Plugin source to validate
 * @returns Validation result with error message if invalid
 */
export function validatePluginSource(source: string): { valid: boolean; error?: string } {
  if (!source || source.trim() === '') {
    return { valid: false, error: 'Plugin source cannot be empty' };
  }

  // If it's a GitHub URL, validate the format
  if (isGitHubUrl(source)) {
    const parsed = parseGitHubUrl(source);
    if (!parsed) {
      return {
        valid: false,
        error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
      };
    }
  }

  return { valid: true };
}
