import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GitCloneError, classifyError } from './git-errors.js';

export { GitCloneError, classifyError };

const DEFAULT_CLONE_TIMEOUT_MS = 300_000;
const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.ALLAGENTS_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();

export function createGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

function createGit(baseDir?: string) {
  return simpleGit(baseDir, {
    timeout: { block: CLONE_TIMEOUT_MS },
    config: [
      'filter.lfs.required=false',
      'filter.lfs.smudge=',
      'filter.lfs.clean=',
      'filter.lfs.process=',
    ],
  }).env(createGitEnv());
}

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
  const git = createGit();
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw classifyError(error, url, CLONE_TIMEOUT_MS);
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
  const git = createGit();
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, dest, cloneOptions);
  } catch (error) {
    throw classifyError(error, url, CLONE_TIMEOUT_MS);
  }
}

/**
 * Pull latest changes in an existing repository.
 */
export async function pull(repoPath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.pull();
}

/**
 * Check if a remote repository is accessible via git ls-remote.
 * Returns true if accessible, false otherwise.
 */
export async function repoExists(url: string): Promise<boolean> {
  const git = createGit();
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
  const git = createGit();
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
