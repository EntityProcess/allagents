import { execa } from 'execa';
import { parseGitHubUrl } from '../utils/plugin-path.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';

/**
 * Resolve branch/subpath combination by checking which refs exist
 * Handles branch names with slashes by trying different split points
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param pathAfterTree - Full path after /tree/ (e.g., "feat/my-feature/plugins/cargowise")
 * @returns Object with resolved branch and subpath, or null if no valid branch found
 */
async function resolveBranchAndSubpath(
  owner: string,
  repo: string,
  pathAfterTree: string,
): Promise<{ branch: string; subpath?: string } | null> {
  const parts = pathAfterTree.split('/');

  // Try each possible split point, starting from the longest branch name
  for (let i = parts.length - 1; i >= 1; i--) {
    const branch = parts.slice(0, i).join('/');
    const subpath = parts.slice(i).join('/');

    // Check if this branch ref exists
    try {
      await execa('gh', [
        'api',
        `repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
        '--silent',
      ]);
      // If successful, this is a valid ref
      return { branch, ...(subpath && { subpath }) };
    } catch {
      // This ref doesn't exist, try the next split point
    }
  }

  // No valid branch found
  return null;
}

/**
 * Result of fetching workspace from GitHub
 */
export interface FetchWorkspaceResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Fetch a single file from GitHub using the gh CLI
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param path - File path within the repository
 * @param branch - Optional branch name (defaults to default branch if not specified)
 * @returns File content or null if not found
 */
export async function fetchFileFromGitHub(
  owner: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<string | null> {
  try {
    // Use gh api to fetch file contents
    // The API returns base64 encoded content
    let endpoint = `repos/${owner}/${repo}/contents/${path}`;

    // Add ref parameter as query string to specify branch if provided
    if (branch) {
      endpoint += `?ref=${encodeURIComponent(branch)}`;
    }

    const result = await execa('gh', [
      'api',
      endpoint,
      '--jq',
      '.content',
    ]);

    if (result.stdout) {
      // Decode base64 content
      const content = Buffer.from(result.stdout, 'base64').toString('utf-8');
      return content;
    }
    return null;
  } catch {
    return null;
  }
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
 * @param url - GitHub URL or shorthand
 * @returns Result with workspace.yaml content or error
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

  const { owner, repo, branch, subpath } = parsed;

  // Check if gh CLI is available
  try {
    await execa('gh', ['--version']);
  } catch {
    return {
      success: false,
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
          success: false,
          error: `Repository not found: ${owner}/${repo}`,
        };
      }
      if (
        errorMessage.includes('auth') ||
        errorMessage.includes('authentication')
      ) {
        return {
          success: false,
          error: 'GitHub authentication required. Run: gh auth login',
        };
      }
    }
    return {
      success: false,
      error: `Failed to access repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Determine the base path to look for workspace.yaml
  const basePath = subpath || '';

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

  for (const path of pathsToTry) {
    const content = await fetchFileFromGitHub(owner, repo, path, branch);
    if (content) {
      return {
        success: true,
        content,
      };
    }
  }

  // If we have both branch and subpath and the simple approach failed,
  // try to intelligently resolve in case the branch name has slashes
  // (e.g., feat/my-feature was parsed as branch:feat, subpath:my-feature/...)
  if (branch && subpath && !branch.includes('/')) {
    const resolved = await resolveBranchAndSubpath(
      owner,
      repo,
      `${branch}/${subpath}`,
    );
    if (resolved && resolved.branch !== branch) {
      // Found a different branch, try fetching with the new split
      const newBasePath = resolved.subpath || '';
      const newPathsToTry = newBasePath
        ? [
            `${newBasePath}/${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
            `${newBasePath}/${WORKSPACE_CONFIG_FILE}`,
          ]
        : [
            `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
            WORKSPACE_CONFIG_FILE,
          ];

      for (const path of newPathsToTry) {
        const content = await fetchFileFromGitHub(
          owner,
          repo,
          path,
          resolved.branch,
        );
        if (content) {
          return {
            success: true,
            content,
          };
        }
      }
    }
  }

  return {
    success: false,
    error: `No workspace.yaml found in: ${owner}/${repo}${branch ? `@${branch}` : ''}${subpath ? `/${subpath}` : ''}\n  Expected at: ${pathsToTry.join(' or ')}`,
  };
}
