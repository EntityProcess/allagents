import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track clone calls to verify arguments
const cloneCalls: Array<{ url: string; dest: string; ref?: string }> = [];

// Mock the git module
mock.module('../../../src/core/git.js', () => ({
  cloneTo: mock((url: string, dest: string, ref?: string) => {
    cloneCalls.push({ url, dest, ref });
    // Create the directory to simulate clone
    mkdirSync(dest, { recursive: true });
    return Promise.resolve();
  }),
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
  pull: mock(() => Promise.resolve()),
}));

// Mock simple-git for updateMarketplace (it uses simpleGit directly)
mock.module('simple-git', () => ({
  default: () => ({
    raw: mock(() => Promise.resolve('')),
    checkout: mock(() => Promise.resolve()),
  }),
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
    cloneCalls.length = 0;
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

  it('should clone with branch when --name is provided', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('repo-v2');
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');

    // Verify cloneTo was called with the correct URL and branch
    const cloneCall = cloneCalls.find((c) => c.url.includes('owner/repo'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.url).toBe('https://github.com/owner/repo.git');
    expect(cloneCall!.ref).toBe('feat/v2');
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

  it('should clone without branch when no branch specified', async () => {
    const result = await addMarketplace('https://github.com/owner/repo');
    expect(result.success).toBe(true);

    // Verify cloneTo was called without a branch ref
    const cloneCall = cloneCalls.find((c) => c.url.includes('owner/repo'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.ref).toBeUndefined();
  });
});
