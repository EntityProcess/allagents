import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
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
  it('clones with controlled LFS filters despite hostile global config', async () => {
    if (!isIsolatedTestRun(import.meta.path)) {
      runTestFileIsolated(import.meta.path);
      return;
    }
    const fixture = await mkdtemp(join(tmpdir(), 'allagents-git-test-'));
    const upstream = join(fixture, 'upstream');
    const destination = join(fixture, 'clone');
    const gitConfig = join(fixture, 'gitconfig');
    const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;

    try {
      await mkdir(upstream);
      const git = simpleGit(upstream);
      await git.init();
      await git.checkoutLocalBranch('main');
      await git.addConfig('user.name', 'AllAgents Test');
      await git.addConfig('user.email', 'test@allagents.dev');
      await writeFile(join(upstream, 'tracked.txt'), 'clean clone\n');
      await writeFile(join(upstream, '.gitattributes'), '*.bin filter=lfs\n');
      const payload = Buffer.from('fixture payload\n');
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash('sha256').update(payload).digest('hex')}\nsize ${payload.byteLength}\n`;
      await writeFile(join(upstream, 'asset.bin'), pointer);
      await git.add(['tracked.txt', '.gitattributes', 'asset.bin']);
      await git.commit('fixture');
      const committedPointer = Buffer.from(
        await git.show(['HEAD:asset.bin']),
      );

      await writeFile(
        gitConfig,
        '[filter "lfs"]\n\trequired = true\n\tprocess = allagents-lfs-filter-must-not-run\n\tsmudge = allagents-lfs-filter-must-not-run\n',
      );
      process.env.GIT_CONFIG_GLOBAL = gitConfig;

      await cloneTo(upstream, destination, 'main');

      expect(await readFile(join(destination, 'tracked.txt'), 'utf8')).toBe(
        'clean clone\n',
      );
      const clonedAsset = await readFile(join(destination, 'asset.bin'));
      expect(clonedAsset).toEqual(committedPointer);
      expect(clonedAsset.toString('utf8')).toMatch(
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize \d+\n$/,
      );
      expect(clonedAsset).not.toEqual(payload);
    } finally {
      if (originalGitConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
      }
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
