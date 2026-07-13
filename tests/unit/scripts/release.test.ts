import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RELEASE_SCRIPT = resolve(import.meta.dir, '../../../scripts/release.ts');
const PUBLISH_WORKFLOW = resolve(import.meta.dir, '../../../.github/workflows/publish.yml');
const PRERELEASE_VERSION = '2.0.0-next.1';
const PRERELEASE_TAG = `v${PRERELEASE_VERSION}`;
const STABLE_VERSION = '2.0.0';
const STABLE_TAG = `v${STABLE_VERSION}`;

const tempDirs: string[] = [];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ReleaseRepository {
  root: string;
  repo: string;
  remote: string;
  baseCommit: string;
  prereleaseCommit: string;
}

function run(cwd: string, command: string[]): CommandResult {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';

  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, ['git', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function remoteGit(remote: string, ...args: string[]): string {
  return git(remote, `--git-dir=${remote}`, ...args);
}

async function writePackage(repo: string, version: string): Promise<void> {
  await writeFile(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'release-fixture', version }, null, 2)}\n`,
  );
}

async function createReleaseRepository(): Promise<ReleaseRepository> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-release-test-'));
  tempDirs.push(root);
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');

  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', repo);
  git(repo, 'config', '--local', 'user.name', 'Release Test');
  git(repo, 'config', '--local', 'user.email', 'release-test@example.com');

  await writePackage(repo, '1.9.0');
  git(repo, 'add', 'package.json');
  git(repo, 'commit', '-m', 'base release');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');

  await writePackage(repo, PRERELEASE_VERSION);
  git(repo, 'add', 'package.json');
  git(repo, 'commit', '-m', `chore(release): bump version to ${PRERELEASE_VERSION}`);
  git(repo, 'tag', '-a', PRERELEASE_TAG, '-m', `Release ${PRERELEASE_VERSION}`);
  const prereleaseCommit = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  git(repo, 'push', 'origin', PRERELEASE_TAG);

  return { root, repo, remote, baseCommit, prereleaseCommit };
}

async function createDetachedStableTag(
  fixture: ReleaseRepository,
  startRef = PRERELEASE_TAG,
): Promise<string> {
  git(fixture.repo, 'checkout', '--detach', startRef);
  await writePackage(fixture.repo, STABLE_VERSION);
  git(fixture.repo, 'add', 'package.json');
  git(fixture.repo, 'commit', '-m', `chore(release): bump version to ${STABLE_VERSION}`);
  git(fixture.repo, 'tag', '-a', STABLE_TAG, '-m', `Release ${STABLE_VERSION}`);
  const stableCommit = git(fixture.repo, 'rev-parse', 'HEAD');
  git(fixture.repo, 'push', 'origin', STABLE_TAG);
  git(fixture.repo, 'checkout', 'main');
  return stableCommit;
}

function finalize(repo: string): CommandResult {
  return run(repo, ['bun', RELEASE_SCRIPT, 'finalize', PRERELEASE_TAG]);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('release finalize', () => {
  test('commits the stable version on main and pushes main with the annotated tag', async () => {
    const fixture = await createReleaseRepository();

    const result = finalize(fixture.repo);

    expect(result.exitCode).toBe(0);
    const remoteMain = remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main');
    const stableCommit = remoteGit(fixture.remote, 'rev-parse', `${STABLE_TAG}^{}`);
    expect(remoteMain).toBe(stableCommit);
    expect(remoteMain).not.toBe(fixture.prereleaseCommit);
    expect(git(fixture.repo, 'branch', '--show-current')).toBe('main');
    expect(remoteGit(fixture.remote, 'cat-file', '-t', `refs/tags/${STABLE_TAG}`)).toBe(
      'tag',
    );

    const pkg = JSON.parse(
      remoteGit(fixture.remote, 'show', 'refs/heads/main:package.json'),
    ) as { version: string };
    expect(pkg.version).toBe(STABLE_VERSION);
  });

  test('rejects finalize when main advanced after the selected prerelease', async () => {
    const fixture = await createReleaseRepository();
    await writeFile(join(fixture.repo, 'README.md'), 'advanced main\n');
    git(fixture.repo, 'add', 'README.md');
    git(fixture.repo, 'commit', '-m', 'advance main');
    git(fixture.repo, 'push', 'origin', 'main');
    const advancedMain = git(fixture.repo, 'rev-parse', 'HEAD');

    const result = finalize(fixture.repo);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Create a new prerelease from current main',
    );
    expect(remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main')).toBe(
      advancedMain,
    );
    expect(
      run(fixture.root, [
        'git',
        `--git-dir=${fixture.remote}`,
        'rev-parse',
        '--verify',
        `refs/tags/${STABLE_TAG}`,
      ]).exitCode,
    ).not.toBe(0);
  });

  test('fast-forwards main to an existing detached stable tag', async () => {
    const fixture = await createReleaseRepository();
    const stableCommit = await createDetachedStableTag(fixture);
    expect(remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main')).toBe(
      fixture.prereleaseCommit,
    );

    const result = finalize(fixture.repo);

    expect(result.exitCode).toBe(0);
    expect(remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main')).toBe(
      stableCommit,
    );
    expect(remoteGit(fixture.remote, 'rev-parse', `${STABLE_TAG}^{}`)).toBe(
      stableCommit,
    );
    expect(git(fixture.repo, 'branch', '--show-current')).toBe('main');

    const retry = finalize(fixture.repo);
    expect(retry.exitCode).toBe(0);
    expect(remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main')).toBe(
      stableCommit,
    );
  });

  test('rejects recovery when the detached stable tag diverged from the prerelease', async () => {
    const fixture = await createReleaseRepository();
    const stableCommit = await createDetachedStableTag(fixture, fixture.baseCommit);

    const result = finalize(fixture.repo);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `cannot be fast-forwarded from ${PRERELEASE_TAG}`,
    );
    expect(remoteGit(fixture.remote, 'rev-parse', 'refs/heads/main')).toBe(
      fixture.prereleaseCommit,
    );
    expect(remoteGit(fixture.remote, 'rev-parse', `${STABLE_TAG}^{}`)).toBe(
      stableCommit,
    );
  });
});

test('publish workflow validates the finalize tag without detaching from main', async () => {
  const workflow = await readFile(PUBLISH_WORKFLOW, 'utf8');

  expect(workflow).toContain('git rev-parse --verify "$TAG^{commit}" >/dev/null');
  expect(workflow).not.toContain('git checkout --detach "$TAG"');
});
