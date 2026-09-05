import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKTREE_SCRIPT = resolve(
  import.meta.dir,
  '../../../plugins/engineering/skills/worktree/scripts/worktree.sh',
);

const tempDirs: string[] = [];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface WorktreeRepository {
  root: string;
  repo: string;
  worktreeRoot: string;
}

function run(
  cwd: string,
  command: string[],
  extraEnv: Record<string, string> = {},
): CommandResult {
  const env = { ...process.env, ...extraEnv };
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
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createRepository(): Promise<WorktreeRepository> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-worktree-test-'));
  tempDirs.push(root);
  const repo = join(root, 'repo');
  const worktreeRoot = join(root, 'worktrees');

  git(root, 'init', '--initial-branch=main', repo);
  git(repo, 'config', '--local', 'user.name', 'Worktree Test');
  git(repo, 'config', '--local', 'user.email', 'worktree-test@example.com');
  await writeFile(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-m', 'base');

  return { root, repo, worktreeRoot };
}

function worktree(
  fixture: WorktreeRepository,
  ...args: string[]
): CommandResult {
  return run(
    fixture.repo,
    [WORKTREE_SCRIPT, '-C', fixture.repo, ...args],
    { WORKTREE_ROOT: fixture.worktreeRoot },
  );
}

function addedPath(result: CommandResult): string {
  expect(result.exitCode).toBe(0);
  return result.stdout.trim().split('\n').at(-1) ?? '';
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('worktree remove', () => {
  test('preserves the branch during normal removal', async () => {
    const fixture = await createRepository();
    const path = addedPath(worktree(fixture, 'add', 'feat/unfinished', 'main'));

    const result = worktree(fixture, 'remove', 'feat/unfinished');

    expect(result.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(git(fixture.repo, 'branch', '--list', 'feat/unfinished')).toBe('feat/unfinished');
  });

  test('deletes the branch after a confirmed squash merge', async () => {
    const fixture = await createRepository();
    const path = addedPath(worktree(fixture, 'add', 'feat/merged', 'main'));
    await writeFile(join(path, 'feature.txt'), 'feature\n');
    git(path, 'add', 'feature.txt');
    git(path, 'commit', '-m', 'feature');
    git(fixture.repo, 'merge', '--squash', 'feat/merged');
    git(fixture.repo, 'commit', '-m', 'squash feature');

    expect(run(fixture.repo, ['git', 'merge-base', '--is-ancestor', 'feat/merged', 'main']).exitCode).not.toBe(0);

    const result = worktree(fixture, 'remove', '--merged', 'feat/merged');

    expect(result.exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(git(fixture.repo, 'branch', '--list', 'feat/merged')).toBe('');
  });
});
