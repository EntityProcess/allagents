import simpleGit from 'simple-git';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { GitCloneError, classifyError } from './git-errors.js';
import {
  canonicalizeGitSource,
  normalizeGitRef,
} from '../utils/git-source.js';

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

export function createGit(baseDir?: string) {
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

export interface GitFactClient {
  listRemote(args: string[]): Promise<string>;
  raw(args: string[]): Promise<string>;
}

export interface GitFactDependencies {
  createGit?: (baseDir?: string) => GitFactClient;
}

export type RemoteRevisionFailureReason =
  | 'ambiguous'
  | 'malformed'
  | 'not-advertised'
  | 'failed';

export type RemoteRevisionResult =
  | {
      status: 'resolved';
      commit: string;
      ref: string;
    }
  | {
      status: 'unresolved';
      reason: RemoteRevisionFailureReason;
      error?: GitCloneError;
    };

interface RemoteAdvertisement {
  value: string;
  name: string;
  symbolic: boolean;
}

function parseRemoteAdvertisement(
  output: string,
): RemoteAdvertisement[] | undefined {
  const advertisements: RemoteAdvertisement[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const symbolic = /^ref:\s+(\S+)\t(\S+)$/.exec(line);
    if (symbolic?.[1] && symbolic[2]) {
      advertisements.push({
        value: symbolic[1],
        name: symbolic[2],
        symbolic: true,
      });
      continue;
    }
    const direct = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\t(\S+)$/.exec(line);
    if (!direct?.[1] || !direct[2]) return undefined;
    advertisements.push({
      value: direct[1].toLowerCase(),
      name: direct[2],
      symbolic: false,
    });
  }
  return advertisements;
}

function uniqueAdvertisementValue(
  advertisements: RemoteAdvertisement[],
  name: string,
): string | undefined | null {
  const values = new Set(
    advertisements
      .filter((entry) => !entry.symbolic && entry.name === name)
      .map((entry) => entry.value),
  );
  if (values.size > 1) return null;
  return values.values().next().value;
}

/**
 * Resolve one advertised remote ref without fetching or mutating a checkout.
 * Ambiguous and unverifiable inputs stay unresolved so callers can fall back.
 */
export async function resolveRemoteRevision(
  source: string,
  requestedRef?: string,
  dependencies: GitFactDependencies = {},
): Promise<RemoteRevisionResult> {
  const git = (dependencies.createGit ?? createGit)();
  const ref = normalizeGitRef(requestedRef);
  const immutablePin = ref && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(ref);
  const args = ref
    ? immutablePin
      ? [source]
      : [
          source,
          `refs/heads/${ref}`,
          `refs/tags/${ref}`,
          `refs/tags/${ref}^{}`,
        ]
    : ['--symref', source, 'HEAD'];

  let output: string;
  try {
    output = await git.listRemote(args);
  } catch (error) {
    return {
      status: 'unresolved',
      reason: 'failed',
      error: classifyError(error, source, CLONE_TIMEOUT_MS),
    };
  }

  const advertisements = parseRemoteAdvertisement(output);
  if (!advertisements) {
    return { status: 'unresolved', reason: 'malformed' };
  }

  if (!ref) {
    const symbolicHeads = new Set(
      advertisements
        .filter(
          (entry) =>
            entry.symbolic &&
            entry.name === 'HEAD' &&
            entry.value.startsWith('refs/heads/'),
        )
        .map((entry) => entry.value.slice('refs/heads/'.length)),
    );
    const commit = uniqueAdvertisementValue(advertisements, 'HEAD');
    if (symbolicHeads.size !== 1 || commit === null) {
      return { status: 'unresolved', reason: 'ambiguous' };
    }
    const resolvedRef = symbolicHeads.values().next().value;
    if (!resolvedRef || !commit) {
      return { status: 'unresolved', reason: 'malformed' };
    }
    return { status: 'resolved', commit, ref: resolvedRef };
  }

  if (immutablePin) {
    const peeledTags = new Set(
      advertisements
        .filter((entry) => !entry.symbolic && entry.name.endsWith('^{}'))
        .map((entry) => entry.name.slice(0, -3)),
    );
    const advertisedCommits = new Set(
      advertisements
        .filter(
          (entry) =>
            !entry.symbolic &&
            (!entry.name.startsWith('refs/tags/') ||
              entry.name.endsWith('^{}') ||
              !peeledTags.has(entry.name)),
        )
        .map((entry) => entry.value),
    );
    const normalizedPin = ref.toLowerCase();
    return advertisedCommits.has(normalizedPin)
      ? { status: 'resolved', commit: normalizedPin, ref }
      : { status: 'unresolved', reason: 'not-advertised' };
  }

  const branch = uniqueAdvertisementValue(
    advertisements,
    `refs/heads/${ref}`,
  );
  const tag = uniqueAdvertisementValue(advertisements, `refs/tags/${ref}`);
  const peeledTag = uniqueAdvertisementValue(
    advertisements,
    `refs/tags/${ref}^{}`,
  );
  if (
    branch === null ||
    tag === null ||
    peeledTag === null ||
    (branch && tag)
  ) {
    return { status: 'unresolved', reason: 'ambiguous' };
  }
  const commit = branch ?? peeledTag ?? tag;
  return commit
    ? { status: 'resolved', commit, ref }
    : { status: 'unresolved', reason: 'not-advertised' };
}

export interface RepositoryHealthExpectation {
  source: string;
  ref?: string;
  head: string;
}

export type RepositoryHealthReason =
  | 'not-repository'
  | 'origin-mismatch'
  | 'ref-mismatch'
  | 'head-mismatch'
  | 'dirty'
  | 'inspection-failed';

export type RepositoryHealthResult =
  | {
      status: 'healthy';
      head: string;
      ref?: string;
    }
  | {
      status: 'unhealthy';
      reason: RepositoryHealthReason;
      head?: string;
      ref?: string;
      error?: Error;
    };

function healthError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Inspect reusable checkout facts using read-only Git commands.
 * Domain-specific files and roots remain the caller's responsibility.
 */
export async function checkRepositoryHealth(
  repoPath: string,
  expected: RepositoryHealthExpectation,
  dependencies: GitFactDependencies = {},
): Promise<RepositoryHealthResult> {
  let git: GitFactClient;
  try {
    git = (dependencies.createGit ?? createGit)(repoPath);
    const insideWorkTree = await git.raw([
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (insideWorkTree.trim() !== 'true') {
      return { status: 'unhealthy', reason: 'not-repository' };
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      reason: 'not-repository',
      error: healthError(error),
    };
  }

  try {
    const origin = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    if (
      canonicalizeGitSource(origin) !== canonicalizeGitSource(expected.source)
    ) {
      return { status: 'unhealthy', reason: 'origin-mismatch' };
    }

    const head = (await git.raw(['rev-parse', 'HEAD'])).trim().toLowerCase();
    if (head !== expected.head.trim().toLowerCase()) {
      return { status: 'unhealthy', reason: 'head-mismatch', head };
    }

    const expectedRef = normalizeGitRef(expected.ref);
    let actualRef: string | undefined;
    if (expectedRef) {
      try {
        actualRef = normalizeGitRef(
          await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']),
        );
        if (actualRef !== expectedRef) {
          return {
            status: 'unhealthy',
            reason: 'ref-mismatch',
            head,
            ...(actualRef && { ref: actualRef }),
          };
        }
      } catch {
        let tagHead: string;
        try {
          tagHead = (
            await git.raw([
              'rev-parse',
              '--verify',
              `refs/tags/${expectedRef}^{commit}`,
            ])
          )
            .trim()
            .toLowerCase();
        } catch {
          return { status: 'unhealthy', reason: 'ref-mismatch', head };
        }
        if (tagHead !== head) {
          return { status: 'unhealthy', reason: 'ref-mismatch', head };
        }
        actualRef = expectedRef;
      }
    }

    const worktree = await git.raw([
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (worktree.trim().length > 0) {
      return {
        status: 'unhealthy',
        reason: 'dirty',
        head,
        ...(actualRef && { ref: actualRef }),
      };
    }
    return {
      status: 'healthy',
      head,
      ...(actualRef && { ref: actualRef }),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      reason: 'inspection-failed',
      error: healthError(error),
    };
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
