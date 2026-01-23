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
 * Detect if a plugin source is a GitHub URL or shorthand
 * Supports:
 * - https://github.com/owner/repo
 * - github.com/owner/repo
 * - gh:owner/repo
 * - owner/repo (shorthand, must have exactly one slash for repo-only, or more for subpath)
 * - owner/repo/path/to/plugin (shorthand with subpath)
 * @param source - Plugin source string
 * @returns true if source is a GitHub URL or shorthand
 */
export function isGitHubUrl(source: string): boolean {
  // Explicit GitHub patterns
  const explicitPatterns = [
    /^https?:\/\/github\.com\//,
    /^https?:\/\/www\.github\.com\//,
    /^github\.com\//,
    /^gh:/,
  ];

  if (explicitPatterns.some((pattern) => pattern.test(source))) {
    return true;
  }

  // Shorthand: owner/repo or owner/repo/subpath
  // Must not start with . or / (local paths) and must contain at least one /
  // Also must not look like a Windows path (C:/) or contain backslashes
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    !source.includes('\\') &&
    !/^[a-zA-Z]:/.test(source) &&
    source.includes('/')
  ) {
    // Check if it looks like owner/repo format (alphanumeric, hyphens, underscores)
    const parts = source.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const validOwnerRepo = /^[a-zA-Z0-9_-]+$/;
      if (validOwnerRepo.test(parts[0]) && validOwnerRepo.test(parts[1])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse GitHub URL or shorthand to extract owner, repo, and optional subpath
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch/path
 * - github.com/owner/repo
 * - gh:owner/repo
 * - owner/repo (shorthand)
 * - owner/repo/path/to/plugin (shorthand with subpath)
 * @param url - GitHub URL or shorthand
 * @returns Object with owner, repo, and optional subpath, or null if invalid
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string; subpath?: string } | null {
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

  // Handle shorthand: owner/repo or owner/repo/subpath (no protocol, no github.com)
  if (!normalized.includes('://') && !normalized.startsWith('github.com')) {
    const parts = normalized.split('/');
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      const validOwnerRepo = /^[a-zA-Z0-9_-]+$/;
      if (owner && repo && validOwnerRepo.test(owner) && validOwnerRepo.test(repo)) {
        if (parts.length > 2) {
          // Has subpath: owner/repo/path/to/plugin
          const subpath = parts.slice(2).join('/');
          return { owner, repo, subpath };
        }
        return { owner, repo };
      }
    }
    return null;
  }

  // Try to extract with subpath first: https://github.com/owner/repo/tree/branch/path
  const subpathPattern = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/tree\/[^/]+\/(.+)$/;
  const subpathMatch = normalized.match(subpathPattern);
  if (subpathMatch) {
    const owner = subpathMatch[1];
    const repo = subpathMatch[2]?.replace(/\.git$/, '');
    const subpath = subpathMatch[3];
    if (owner && repo) {
      return { owner, repo, subpath };
    }
  }

  // Try basic format: https://github.com/owner/repo
  const basicPattern = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/;
  const basicMatch = normalized.match(basicPattern);
  if (basicMatch) {
    const owner = basicMatch[1];
    const repo = basicMatch[2]?.replace(/\.git$/, '');
    if (owner && repo) {
      return { owner, repo };
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
