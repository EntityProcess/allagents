import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execaCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
const execaMock = mock(
  (cmd: string, args: string[], opts?: { cwd?: string; stdin?: string }) => {
    execaCalls.push({ cmd, args, cwd: opts?.cwd });

    // Mock gh --version
    if (cmd === 'gh' && args[0] === '--version') {
      return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
    }

    // Mock gh repo clone — create the directory to simulate clone
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      const clonePath = args[3];
      if (clonePath) mkdirSync(clonePath, { recursive: true });
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    // Mock git checkout
    if (cmd === 'git' && args[0] === 'checkout') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }

    return Promise.resolve({ stdout: '', stderr: '' });
  },
);

mock.module('execa', () => ({
  execa: execaMock,
}));

const { addMarketplace, loadRegistry } = await import('../../../src/core/marketplace.js');

describe('addMarketplace branch support', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-add-branch-test-${Date.now()}`);
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.allagents'), { recursive: true });
    execaCalls.length = 0;
    execaMock.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should error when non-default branch is specified without --name', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('--name is required');
  });

  it('should error when --name matches bare repo name for non-default branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved for the default branch');
  });

  it('should clone and checkout branch when --name is provided', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('repo-v2');
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');

    // Verify gh repo clone was called with owner/repo (not owner/repo/feat/v2)
    const cloneCall = execaCalls.find(
      (c) => c.cmd === 'gh' && c.args[1] === 'clone',
    );
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.args[2]).toBe('owner/repo');

    // Verify git checkout was called with the branch
    const checkoutCall = execaCalls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout',
    );
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[1]).toBe('feat/v2');
  });

  it('should store branch in location in registry', async () => {
    await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    const registry = await loadRegistry();
    expect(registry.marketplaces['repo-v2'].source.location).toBe('owner/repo/feat/v2');
  });

  it('should accept --branch flag with owner/repo shorthand', async () => {
    const result = await addMarketplace('owner/repo', 'repo-v2', 'feat/v2');
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');
  });

  it('should prefer explicit --branch over URL branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-override',
      'feat/v3',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v3');
  });

  it('should clone default branch without checkout when no branch specified', async () => {
    const result = await addMarketplace('https://github.com/owner/repo');
    expect(result.success).toBe(true);

    const checkoutCall = execaCalls.find(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout',
    );
    expect(checkoutCall).toBeUndefined();
  });
});
