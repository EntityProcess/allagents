import { resolve, isAbsolute } from 'node:path';
import { execa } from 'execa';
import { getHomeDir } from '../constants.js';

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
    // Check if it looks like owner/repo format (alphanumeric, hyphens, underscores, dots)
    // GitHub allows dots in repo names (e.g., WTG.AI.Prompts)
    const parts = source.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (validOwnerRepo.test(parts[0]) && validOwnerRepo.test(parts[1])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse GitHub URL or shorthand to extract owner, repo, optional branch, and optional subpath
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch/path
 * - github.com/owner/repo
 * - gh:owner/repo
 * - owner/repo (shorthand)
 * - owner/repo/path/to/plugin (shorthand with subpath)
 * @param url - GitHub URL or shorthand
 * @returns Object with owner, repo, and optional branch/subpath, or null if invalid
 */
export function parseGitHubUrl(
  url: string,
): { owner: string; repo: string; branch?: string; subpath?: string } | null {
  // Normalize URL
  let normalized = url;

  // Handle gh: prefix
  if (normalized.startsWith('gh:')) {
    normalized = normalized.replace(/^gh:/, 'https://github.com/');
  }

  // Handle github.com/ prefix without protocol
  if (normalized.startsWith('github.com/')) {
    normalized = `https://${normalized}`;
  }

  // Handle shorthand: owner/repo or owner/repo/subpath (no protocol, no github.com)
  if (!normalized.includes('://') && !normalized.startsWith('github.com')) {
    const parts = normalized.split('/');
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      // Allow dots in repo names (e.g., WTG.AI.Prompts)
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (
        owner &&
        repo &&
        validOwnerRepo.test(owner) &&
        validOwnerRepo.test(repo)
      ) {
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

  // Try to extract with /tree/: https://github.com/owner/repo/tree/branch/path or /tree/branch
  const treeMatch = normalized.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)\/tree\/(.+)$/,
  );
  if (treeMatch) {
    const owner = treeMatch[1];
    const repo = treeMatch[2]?.replace(/\.git$/, '');
    const afterTree = treeMatch[3];

    if (owner && repo && afterTree) {
      // afterTree is everything after /tree/, e.g., "feat/my-feature/path" or "main"
      const parts = afterTree.split('/');

      // Handle single part (just branch, no subpath)
      if (parts.length === 1) {
        // parts always has at least 1 element from split()
        const branch = parts[0];
        return branch ? { owner, repo, branch } : { owner, repo };
      }

      // For multiple parts, determine where branch ends and subpath begins
      // when the branch name contains slashes (e.g., feat/my-feature)
      //
      // Strategy: Look for common directory names that indicate subpath start
      // Heuristic: if we see a directory like "plugins", "src", etc., that's
      // likely where the branch ends and subpath begins
      const commonPathDirs = new Set([
        'plugins',
        'src',
        'docs',
        'examples',
        'lib',
        'test',
        'tests',
        'spec',
        'scripts',
        'config',
        '.allagents',
        'dist',
        'build',
      ]);

      // Try to find where the subpath likely begins
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (part && commonPathDirs.has(part)) {
          // Found a common directory, assume everything from here is the subpath
          const branch = parts.slice(0, i).join('/');
          const subpath = parts.slice(i).join('/');
          return { owner, repo, branch, subpath };
        }
      }

      // No common path directory found, fall back to simple branch/subpath split
      // (maintain backward compatibility with simple branches like "main", "develop")
      const branch = parts[0];
      const subpath = parts.slice(1).join('/');
      return branch ? { owner, repo, branch, subpath } : { owner, repo };
    }
  }

  // Try basic format: https://github.com/owner/repo
  const basicPattern =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/;
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
export function normalizePluginPath(
  source: string,
  baseDir: string = process.cwd(),
): string {
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
  baseDir: string = process.cwd(),
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
 * Sanitize a branch name for use in filesystem paths
 * Replaces slashes and other problematic characters with underscores
 * @param branch - Branch name to sanitize
 * @returns Sanitized branch name safe for use in paths
 */
function sanitizeBranchForPath(branch: string): string {
  // Replace forward slashes, backslashes, colons, and other problematic chars
  return branch.replace(/[/\\:*?"<>|]/g, '_');
}

/**
 * Get cache directory path for a GitHub plugin
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param branch - Optional branch name (if specified, creates branch-specific cache)
 * @returns Cache directory path
 */
export function getPluginCachePath(owner: string, repo: string, branch?: string): string {
  const basePath = `${owner}-${repo}`;

  // If branch is specified, create a branch-specific cache path
  // This allows concurrent use of different branches from the same repo
  const cacheName = branch ? `${basePath}@${sanitizeBranchForPath(branch)}` : basePath;

  return resolve(
    getHomeDir(),
    '.allagents',
    'plugins',
    'marketplaces',
    cacheName,
  );
}

/**
 * Validate plugin source format
 * @param source - Plugin source to validate
 * @returns Validation result with error message if invalid
 */
export function validatePluginSource(source: string): {
  valid: boolean;
  error?: string;
} {
  if (!source || source.trim() === '') {
    return { valid: false, error: 'Plugin source cannot be empty' };
  }

  // If it's a GitHub URL, validate the format
  if (isGitHubUrl(source)) {
    const parsed = parseGitHubUrl(source);
    if (!parsed) {
      return {
        valid: false,
        error:
          'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
      };
    }
  }

  return { valid: true };
}

/**
 * Parsed file source information
 */
export interface ParsedFileSource {
  type: PluginSourceType;
  original: string;
  /** For local: absolute path. For GitHub: the original source string */
  normalized: string;
  /** GitHub repository owner (if GitHub source) */
  owner?: string;
  /** GitHub repository name (if GitHub source) */
  repo?: string;
  /** GitHub branch name (if GitHub source with branch specified) */
  branch?: string;
  /** Path to the file within the repository (if GitHub source) */
  filePath?: string;
}

/**
 * Parse a file source string into structured information
 *
 * Supports:
 * - Local paths: ./relative, /absolute, ../parent
 * - GitHub URLs: https://github.com/owner/repo/tree/branch/path/to/file.md
 * - GitHub shorthand: owner/repo/path/to/file.md
 * - gh: prefix: gh:owner/repo/path/to/file.md
 *
 * @param source - File source string
 * @param baseDir - Base directory for resolving relative local paths
 * @returns Parsed file source information
 */
export function parseFileSource(
  source: string,
  baseDir: string = process.cwd(),
): ParsedFileSource {
  if (isGitHubUrl(source)) {
    const parsed = parseGitHubUrl(source);
    if (parsed) {
      return {
        type: 'github',
        original: source,
        normalized: source,
        owner: parsed.owner,
        repo: parsed.repo,
        ...(parsed.branch && { branch: parsed.branch }),
        ...(parsed.subpath && { filePath: parsed.subpath }),
      };
    }
    // Invalid GitHub URL format, treat as local
    return {
      type: 'local',
      original: source,
      normalized: normalizePluginPath(source, baseDir),
    };
  }

  return {
    type: 'local',
    original: source,
    normalized: normalizePluginPath(source, baseDir),
  };
}

/**
 * Result of GitHub URL verification
 */
export interface VerifyGitHubResult {
  exists: boolean;
  error?: string;
}

/**
 * Verify that a GitHub URL exists (repo and optional subpath)
 * Uses gh CLI to check repository and path existence
 * @param source - GitHub URL or shorthand
 * @returns Verification result
 */
export async function verifyGitHubUrlExists(
  source: string,
): Promise<VerifyGitHubResult> {
  const parsed = parseGitHubUrl(source);
  if (!parsed) {
    return {
      exists: false,
      error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo, subpath } = parsed;

  // Check if gh CLI is available
  try {
    await execa('gh', ['--version']);
  } catch {
    return {
      exists: false,
      error: 'gh CLI not installed. Install from: https://cli.github.com',
    };
  }

  // Check if repository exists
  try {
    await execa('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'name']);
  } catch (error) {
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();
      if (
        errorMessage.includes('not found') ||
        errorMessage.includes('404') ||
        errorMessage.includes('could not resolve to a repository')
      ) {
        return {
          exists: false,
          error: `Repository not found: ${owner}/${repo}`,
        };
      }
      if (
        errorMessage.includes('auth') ||
        errorMessage.includes('authentication')
      ) {
        return {
          exists: false,
          error: 'GitHub authentication required. Run: gh auth login',
        };
      }
    }
    return {
      exists: false,
      error: `Failed to verify repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // If subpath specified, verify it exists in the repo
  if (subpath) {
    try {
      // Use gh api to check if the path exists in the default branch
      await execa('gh', [
        'api',
        `repos/${owner}/${repo}/contents/${subpath}`,
        '--silent',
      ]);
    } catch (error) {
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        if (errorMessage.includes('not found') || errorMessage.includes('404')) {
          return {
            exists: false,
            error: `Path not found in repository: ${owner}/${repo}/${subpath}`,
          };
        }
      }
      return {
        exists: false,
        error: `Failed to verify path: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return { exists: true };
}
