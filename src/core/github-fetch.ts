import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitHubUrl } from '../utils/plugin-path.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  cloneToTemp,
  cleanupTempDir,
  gitHubUrl,
  refExists,
  GitCloneError,
} from './git.js';

/**
 * Result of fetching workspace from GitHub
 */
export interface FetchWorkspaceResult {
  success: boolean;
  content?: string;
  error?: string;
  /** Temp directory containing the cloned repo. Caller must call cleanupTempDir() when done. */
  tempDir?: string;
}

/**
 * Read a file from an already-cloned temp directory.
 * @param tempDir - Path to the cloned repository
 * @param filePath - Relative file path within the repository
 * @returns File content or null if not found
 */
export function readFileFromClone(
  tempDir: string,
  filePath: string,
): string | null {
  const fullPath = join(tempDir, filePath);
  if (existsSync(fullPath)) {
    return readFileSync(fullPath, 'utf-8');
  }
  return null;
}

/**
 * Resolve branch/subpath combination by checking which refs exist on the remote.
 * Handles branch names with slashes by trying different split points.
 */
async function resolveBranchAndSubpath(
  repoUrl: string,
  pathAfterTree: string,
): Promise<{ branch: string; subpath?: string } | null> {
  const parts = pathAfterTree.split('/');

  // Try each possible split point, starting from the longest branch name
  for (let i = parts.length - 1; i >= 1; i--) {
    const branch = parts.slice(0, i).join('/');
    const subpath = parts.slice(i).join('/');

    if (await refExists(repoUrl, branch)) {
      return { branch, ...(subpath && { subpath }) };
    }
  }

  return null;
}

/**
 * Fetch workspace.yaml from a GitHub URL
 *
 * Supports:
 * - https://github.com/owner/repo (looks for .allagents/workspace.yaml or workspace.yaml)
 * - https://github.com/owner/repo/tree/branch/path (looks in path/.allagents/workspace.yaml or path/workspace.yaml)
 * - owner/repo (shorthand)
 * - owner/repo/path/to/workspace (shorthand with subpath)
 *
 * Intelligently resolves branch names with slashes by checking which refs exist.
 *
 * Returns a tempDir if successful — caller must call cleanupTempDir() when done
 * reading additional files from the clone.
 *
 * @param url - GitHub URL or shorthand
 * @returns Result with workspace.yaml content, tempDir, or error
 */
export async function fetchWorkspaceFromGitHub(
  url: string,
): Promise<FetchWorkspaceResult> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo, branch } = parsed;
  // Normalize subpath to remove trailing slashes
  const subpath = parsed.subpath?.replace(/\/+$/, '');
  const repoUrl = gitHubUrl(owner, repo);

  // If we have both branch and subpath and the branch might have slashes,
  // try to resolve the correct split before cloning
  let effectiveBranch = branch;
  let effectiveSubpath = subpath;

  if (branch && subpath && !branch.includes('/')) {
    const resolved = await resolveBranchAndSubpath(
      repoUrl,
      `${branch}/${subpath}`,
    );
    if (resolved && resolved.branch !== branch) {
      effectiveBranch = resolved.branch;
      effectiveSubpath = resolved.subpath;
    }
  }

  // Clone the repository to a temp directory
  let tempDir: string;
  try {
    tempDir = await cloneToTemp(repoUrl, effectiveBranch);
  } catch (error) {
    if (error instanceof GitCloneError) {
      if (error.isAuthError) {
        return {
          success: false,
          error: `Authentication failed for ${owner}/${repo}.\n  Check your SSH keys or git credentials.`,
        };
      }
      if (error.isTimeout) {
        return {
          success: false,
          error: `Clone timed out for ${owner}/${repo}.\n  Check your network connection.`,
        };
      }
    }
    return {
      success: false,
      error: `Failed to access repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Determine the base path to look for workspace.yaml
  const basePath = effectiveSubpath || '';

  // Try to find workspace.yaml in order of preference:
  // 1. {basePath}/.allagents/workspace.yaml
  // 2. {basePath}/workspace.yaml
  const pathsToTry = basePath
    ? [
        `${basePath}/${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
        `${basePath}/${WORKSPACE_CONFIG_FILE}`,
      ]
    : [
        `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
        WORKSPACE_CONFIG_FILE,
      ];

  for (const filePath of pathsToTry) {
    const content = readFileFromClone(tempDir, filePath);
    if (content) {
      return {
        success: true,
        content,
        tempDir,
      };
    }
  }

  // No workspace.yaml found — clean up and return error
  await cleanupTempDir(tempDir);

  return {
    success: false,
    error: `No workspace.yaml found in: ${owner}/${repo}${effectiveBranch ? `@${effectiveBranch}` : ''}${effectiveSubpath ? `/${effectiveSubpath}` : ''}\n  Expected at: ${pathsToTry.join(' or ')}`,
  };
}
