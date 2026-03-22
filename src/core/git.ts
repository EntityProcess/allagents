import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GitCloneError, classifyError } from './git-errors.js';

export { GitCloneError, classifyError };

const CLONE_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Build an HTTPS GitHub URL from owner/repo.
 */
export function gitHubUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Shallow-clone a repository to an auto-created temp directory.
 * Caller must call `cleanupTempDir()` when done.
 */
export async function cloneToTemp(
  url: string,
  ref?: string,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'allagents-'));
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw classifyError(error, url);
  }
}

/**
 * Clone a repository to a specific persistent path (plugin cache, marketplace dir).
 */
export async function cloneTo(
  url: string,
  dest: string,
  ref?: string,
): Promise<void> {
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, dest, cloneOptions);
  } catch (error) {
    throw classifyError(error, url);
  }
}

/**
 * Pull latest changes in an existing repository.
 */
export async function pull(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath, {
    timeout: { block: CLONE_TIMEOUT_MS },
  });
  await git.pull();
}

/**
 * Check if a remote repository is accessible via git ls-remote.
 * Returns true if accessible, false otherwise.
 */
export async function repoExists(url: string): Promise<boolean> {
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  try {
    await git.listRemote([url]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific ref (branch/tag) exists on the remote.
 */
export async function refExists(
  url: string,
  ref: string,
): Promise<boolean> {
  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  try {
    const result = await git.listRemote([
      '--refs',
      url,
      ref,
    ]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Safe cleanup of a temp directory. Validates path is under os.tmpdir()
 * to prevent accidental deletion of arbitrary paths.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));

  if (
    !normalizedDir.startsWith(normalizedTmpDir + sep) &&
    normalizedDir !== normalizedTmpDir
  ) {
    throw new Error(
      'Attempted to clean up directory outside of temp directory',
    );
  }

  await rm(dir, { recursive: true, force: true });
}

