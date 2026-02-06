import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track calls for assertions
const simpleGitCalls: Array<{ method: string; args: unknown[] }> = [];
const pullCalls: Array<{ path: string }> = [];

// Create a mock simple-git instance
function createMockGit(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  return {
    raw: mock((...args: unknown[]) => {
      simpleGitCalls.push({ method: 'raw', args });
      if (overrides.raw) return overrides.raw(...args);
      // Default: symbolic-ref returns origin/main
      const rawArgs = args[0] as string[];
      if (rawArgs?.[0] === 'symbolic-ref') {
        return Promise.resolve('origin/main');
      }
      return Promise.resolve('');
    }),
    checkout: mock((...args: unknown[]) => {
      simpleGitCalls.push({ method: 'checkout', args });
      if (overrides.checkout) return overrides.checkout(...args);
      return Promise.resolve();
    }),
  };
}

let currentMockGit = createMockGit();

mock.module('simple-git', () => ({
  default: () => currentMockGit,
}));

// Mock the git module's pull function
mock.module('../../../src/core/git.js', () => ({
  pull: mock((path: string) => {
    pullCalls.push({ path });
    return Promise.resolve();
  }),
  cloneTo: mock(() => Promise.resolve()),
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class extends Error {},
}));

// Must import after mock.module
const { updateMarketplace } = await import('../../../src/core/marketplace.js');

describe('updateMarketplace', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let marketplacePath: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-update-test-${Date.now()}`);
    process.env.HOME = testHome;

    // Create marketplace directory
    marketplacePath = join(testHome, '.allagents', 'plugins', 'marketplaces', 'test-mp');
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

    simpleGitCalls.length = 0;
    pullCalls.length = 0;
    currentMockGit = createMockGit();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should checkout default branch before pulling', async () => {
    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Verify calls: symbolic-ref -> checkout -> pull
    const symbolicRefCall = simpleGitCalls.find(
      (c) => c.method === 'raw' && (c.args[0] as string[])?.[0] === 'symbolic-ref',
    );
    expect(symbolicRefCall).toBeDefined();

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('main');

    expect(pullCalls.length).toBe(1);
  });

  it('should use remote show origin to detect master branch when symbolic-ref fails', async () => {
    currentMockGit = createMockGit({
      raw: (...args: unknown[]) => {
        const rawArgs = args[0] as string[];
        if (rawArgs?.[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (rawArgs?.[0] === 'remote' && rawArgs?.[1] === 'show') {
          return Promise.resolve('  HEAD branch: master\n  Remote branches:\n');
        }
        return Promise.resolve('');
      },
    });

    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('master');
  });

  it('should fallback to main when both symbolic-ref and remote show fail', async () => {
    currentMockGit = createMockGit({
      raw: (...args: unknown[]) => {
        const rawArgs = args[0] as string[];
        if (rawArgs?.[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (rawArgs?.[0] === 'remote') {
          return Promise.reject(new Error('fatal: unable to access'));
        }
        return Promise.resolve('');
      },
    });

    const results = await updateMarketplace('test-mp');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('main');
  });

  it('should checkout stored branch instead of detecting default branch', async () => {
    // Update registry to include a branch in location
    const registry = {
      version: 1,
      marketplaces: {
        'test-mp-branch': {
          name: 'test-mp-branch',
          source: { type: 'github', location: 'owner/test-mp/feat/v2' },
          path: marketplacePath,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    };
    const registryDir = join(testHome, '.allagents');
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify(registry, null, 2),
    );

    simpleGitCalls.length = 0;

    const results = await updateMarketplace('test-mp-branch');

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Should NOT call symbolic-ref (no default branch detection)
    const symbolicRefCall = simpleGitCalls.find(
      (c) => c.method === 'raw' && (c.args[0] as string[])?.[0] === 'symbolic-ref',
    );
    expect(symbolicRefCall).toBeUndefined();

    // Should checkout feat/v2 directly
    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('feat/v2');

    // Should pull
    expect(pullCalls.length).toBe(1);
  });
});
