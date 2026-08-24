import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import {
  isIsolatedTestRun,
  runTestFileIsolated,
} from '../../helpers/isolation.js';
import { cloneTo, createGitEnv } from '../../../src/core/git.js';

describe('createGitEnv', () => {
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalPrompt = process.env.GIT_TERMINAL_PROMPT;
  const originalSkipSmudge = process.env.GIT_LFS_SKIP_SMUDGE;

  beforeEach(() => {
    process.env.HOME = '/tmp/test-home';
    process.env.PATH = '/tmp/test-path';
    process.env.GIT_TERMINAL_PROMPT = '1';
    process.env.GIT_LFS_SKIP_SMUDGE = '0';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    process.env.GIT_TERMINAL_PROMPT = originalPrompt;
    process.env.GIT_LFS_SKIP_SMUDGE = originalSkipSmudge;
  });

  it('preserves inherited git environment while applying allagents overrides', () => {
    const gitEnv = createGitEnv();

    expect(gitEnv).toMatchObject({
      HOME: '/tmp/test-home',
      PATH: '/tmp/test-path',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    });
  });
});

describe('cloneTo', () => {
  it('clones into an empty destination with controlled LFS filters', async () => {
    if (!isIsolatedTestRun(import.meta.path)) {
      runTestFileIsolated(import.meta.path);
      return;
    }
    const fixture = await mkdtemp(join(tmpdir(), 'allagents-git-test-'));
    const upstream = join(fixture, 'upstream');
    const remote = join(fixture, 'origin.git');
    const destination = join(fixture, 'clone');

    try {
      await mkdir(upstream);
      const git = simpleGit(upstream);
      await git.init();
      await git.checkoutLocalBranch('main');
      await git.addConfig('user.name', 'AllAgents Test');
      await git.addConfig('user.email', 'test@allagents.dev');
      await writeFile(join(upstream, 'tracked.txt'), 'clean clone\n');
      await git.add('tracked.txt');
      await git.commit('fixture');
      await simpleGit().raw(['init', '--bare', remote]);
      await git.addRemote('origin', remote);
      await git.push(['-u', 'origin', 'main']);

      await cloneTo(remote, destination, 'main');

      expect(await readFile(join(destination, 'tracked.txt'), 'utf8')).toBe(
        'clean clone\n',
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
