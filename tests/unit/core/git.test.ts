import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createGitEnv } from '../../../src/core/git.js';

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
