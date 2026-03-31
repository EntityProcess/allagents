import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import simpleGit from 'simple-git';
import type { Repository, ManagedMode } from '../models/workspace-config.js';
import { getHomeDir } from '../constants.js';

const CLONE_TIMEOUT_MS = 120_000; // 2 minutes for full clone

export interface ManagedRepoResult {
  path: string;
  repo: string;
  action: 'cloned' | 'pulled' | 'skipped';
  error?: string;
}

/**
 * Expand ~ to home directory in a path.
 */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', getHomeDir());
  }
  return p;
}

/**
 * Should this repository be cloned if missing?
 */
export function shouldClone(managed: ManagedMode | undefined): boolean {
  if (managed === undefined || managed === false) return false;
  return true; // true, 'clone', 'sync' all clone if missing
}

/**
 * Should this repository be pulled on sync?
 */
export function shouldPull(managed: ManagedMode | undefined): boolean {
  if (managed === true || managed === 'sync') return true;
  return false;
}

/**
 * Build a clone URL from source platform and owner/repo.
 */
export function buildCloneUrl(source: string, repo: string): string {
  switch (source) {
    case 'github':
      return `https://github.com/${repo}.git`;
    case 'gitlab':
      return `https://gitlab.com/${repo}.git`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo}.git`;
    case 'azure-devops': {
      // repo format: org/project/repo
      const parts = repo.split('/');
      if (parts.length === 3) {
        return `https://dev.azure.com/${parts[0]}/${parts[1]}/_git/${parts[2]}`;
      }
      return `https://dev.azure.com/${repo}`;
    }
    default:
      return `https://${source}/${repo}.git`;
  }
}

/**
 * Clone a repository to the specified path.
 */
async function cloneRepo(url: string, dest: string, branch?: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  const cloneOptions = branch ? ['--branch', branch] : [];
  await git.clone(url, dest, cloneOptions);
}

/**
 * Pull latest changes in an existing repository.
 * Returns a skip reason if pull is unsafe, or undefined on success.
 */
async function pullRepo(repoPath: string, branch?: string): Promise<string | undefined> {
  const git = simpleGit(repoPath, { timeout: { block: CLONE_TIMEOUT_MS } });

  // Check for uncommitted changes
  const status = await git.status();
  if (!status.isClean()) {
    return 'uncommitted changes';
  }

  // If branch is specified, check we're on it
  if (branch) {
    const currentBranch = status.current;
    if (currentBranch !== branch) {
      return `on branch '${currentBranch}', expected '${branch}'`;
    }
  }

  await git.pull();
  return undefined;
}

/**
 * Process all managed repositories: clone missing ones and pull updates.
 * Runs before plugin sync so newly cloned repos are available for skill discovery.
 */
export async function processManagedRepos(
  repositories: Repository[],
  workspacePath: string,
  options: { offline?: boolean; skipManaged?: boolean } = {},
): Promise<ManagedRepoResult[]> {
  if (options.skipManaged || options.offline) return [];

  const managed = repositories.filter((r) => r.managed);
  if (managed.length === 0) return [];

  const results: ManagedRepoResult[] = [];

  for (const repo of managed) {
    if (!repo.source || !repo.repo) {
      results.push({
        path: repo.path,
        repo: repo.repo ?? repo.path,
        action: 'skipped',
        error: 'managed requires both source and repo fields',
      });
      continue;
    }

    const expandedPath = expandHome(repo.path);
    const absolutePath = resolve(workspacePath, expandedPath);

    if (!existsSync(absolutePath)) {
      // Clone
      if (!shouldClone(repo.managed)) {
        results.push({ path: repo.path, repo: repo.repo, action: 'skipped' });
        continue;
      }

      try {
        const url = buildCloneUrl(repo.source, repo.repo);
        await cloneRepo(url, absolutePath, repo.branch);
        results.push({ path: repo.path, repo: repo.repo, action: 'cloned' });
      } catch (error) {
        results.push({
          path: repo.path,
          repo: repo.repo,
          action: 'skipped',
          error: `clone failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else if (shouldPull(repo.managed)) {
      // Pull
      try {
        const skipReason = await pullRepo(absolutePath, repo.branch);
        if (skipReason) {
          results.push({
            path: repo.path,
            repo: repo.repo,
            action: 'skipped',
            error: `pull skipped: ${skipReason}`,
          });
        } else {
          results.push({ path: repo.path, repo: repo.repo, action: 'pulled' });
        }
      } catch (error) {
        results.push({
          path: repo.path,
          repo: repo.repo,
          action: 'skipped',
          error: `pull failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      // managed: 'clone' and path exists — nothing to do
      results.push({ path: repo.path, repo: repo.repo, action: 'skipped' });
    }
  }

  return results;
}
