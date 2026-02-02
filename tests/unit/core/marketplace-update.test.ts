import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Mock execa to track git commands
const execaCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
const execaMock = mock(
  (cmd: string, args: string[], opts?: { cwd?: string }) => {
    execaCalls.push({ cmd, args, cwd: opts?.cwd });

    // Mock git symbolic-ref to return default branch
    if (
      args[0] === 'symbolic-ref' &&
      args[1] === 'refs/remotes/origin/HEAD'
    ) {
      return Promise.resolve({
        stdout: 'origin/main',
        stderr: '',
      });
    }

    // Mock git checkout
    if (args[0] === 'checkout') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    // Mock git pull
    if (args[0] === 'pull') {
      return Promise.resolve({ stdout: 'Already up to date.', stderr: '' });
    }

    return Promise.resolve({ stdout: '', stderr: '' });
  },
);

mock.module('execa', () => ({
  execa: execaMock,
}));

// Must import after mock.module
const { updateMarketplace, saveRegistry, getRegistryPath, getAllagentsDir } =
  await import('../../../src/core/marketplace.js');

describe('updateMarketplace', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let marketplacePath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-update-test-${Date.now()}`);
    process.env.HOME = testHome;

    // Create marketplace directory
    marketplacePath = join(testHome, '.allagents', 'marketplaces', 'test-mp');
    mkdirSync(marketplacePath, { recursive: true });

    // Write registry with a github marketplace entry
    const registry = {
      version: 1,
      marketplaces: {
        'test-mp': {
          name: 'test-mp',
          source: { type: 'github', location: 'owner/test-mp' },
          path: marketplacePath,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    };
    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify(registry, null, 2),
    );

    execaCalls.length = 0;
    execaMock.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should checkout default branch before pulling', async () => {
    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Verify git commands were called in correct order:
    // 1. git symbolic-ref to get default branch
    // 2. git checkout <default-branch>
    // 3. git pull
    const gitCalls = execaCalls.filter((c) => c.cmd === 'git');

    expect(gitCalls.length).toBeGreaterThanOrEqual(3);
    expect(gitCalls[0].args).toEqual([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      '--short',
    ]);
    expect(gitCalls[1].args[0]).toBe('checkout');
    expect(gitCalls[1].args[1]).toBe('main');
    expect(gitCalls[2].args[0]).toBe('pull');
  });

  it('should use remote show origin to detect master branch when symbolic-ref fails', async () => {
    execaMock.mockImplementation(
      (cmd: string, args: string[], opts?: { cwd?: string }) => {
        execaCalls.push({ cmd, args, cwd: opts?.cwd });

        if (args[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (args[0] === 'remote' && args[1] === 'show') {
          return Promise.resolve({
            stdout: '  HEAD branch: master\n  Remote branches:\n',
            stderr: '',
          });
        }
        if (args[0] === 'checkout') {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (args[0] === 'pull') {
          return Promise.resolve({
            stdout: 'Already up to date.',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );

    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const gitCalls = execaCalls.filter((c) => c.cmd === 'git');
    const checkoutCall = gitCalls.find((c) => c.args[0] === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[1]).toBe('master');
  });

  it('should fallback to main when both symbolic-ref and remote show fail', async () => {
    execaMock.mockImplementation(
      (cmd: string, args: string[], opts?: { cwd?: string }) => {
        execaCalls.push({ cmd, args, cwd: opts?.cwd });

        if (args[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (args[0] === 'remote' && args[1] === 'show') {
          return Promise.reject(new Error('fatal: unable to access'));
        }
        if (args[0] === 'checkout') {
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (args[0] === 'pull') {
          return Promise.resolve({
            stdout: 'Already up to date.',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );

    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const gitCalls = execaCalls.filter((c) => c.cmd === 'git');
    const checkoutCall = gitCalls.find((c) => c.args[0] === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[1]).toBe('main');
  });
});
