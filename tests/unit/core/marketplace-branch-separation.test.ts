import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track cloneTo calls
const cloneToCalls: Array<{ url: string; path: string; branch?: string }> = [];

function createManifest(dir: string, name: string, plugins: string[]) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name,
      plugins: plugins.map((p) => ({ name: p, source: `./plugins/${p}` })),
    }),
  );
  for (const p of plugins) {
    mkdirSync(join(dir, 'plugins', p), { recursive: true });
  }
}

mock.module('simple-git', () => ({
  default: () => ({
    raw: mock(() => Promise.resolve('')),
    checkout: mock(() => Promise.resolve()),
  }),
}));

mock.module('../../../src/core/git.js', () => ({
  pull: mock(() => Promise.resolve()),
  cloneTo: mock((url: string, path: string, branch?: string) => {
    cloneToCalls.push({ url, path, branch });
    mkdirSync(path, { recursive: true });
    // Create different plugins depending on branch
    if (branch === 'feat/v2') {
      createManifest(path, 'test-marketplace-v2', ['plugin-a', 'plugin-b', 'plugin-new']);
    } else {
      createManifest(path, 'test-marketplace', ['plugin-a', 'plugin-b']);
    }
    return Promise.resolve();
  }),
  cloneToTemp: mock(() => Promise.resolve('/tmp/fake')),
  gitHubUrl: (owner: string, repo: string) =>
    `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class extends Error {},
  repoExists: mock(() => Promise.resolve(true)),
  refExists: mock(() => Promise.resolve(true)),
  cleanupTempDir: mock(() => Promise.resolve()),
}));

const {
  addMarketplace,
  loadRegistry,
  findMarketplace,
} = await import('../../../src/core/marketplace.js');

describe('branch separation — each branch is a separate marketplace', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-branch-sep-test-${Date.now()}`);
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.allagents'), { recursive: true });
    cloneToCalls.length = 0;
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
  });

  it('should allow registering default branch and a feature branch as separate marketplaces', async () => {
    // Register default branch
    const result1 = await addMarketplace('owner/repo');
    expect(result1.success).toBe(true);
    expect(result1.marketplace?.name).toBe('test-marketplace');

    // Register feature branch (requires --name)
    const result2 = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'test-marketplace-v2',
    );
    expect(result2.success).toBe(true);
    expect(result2.marketplace?.name).toBe('test-marketplace-v2');

    // Both should exist in registry
    const registry = await loadRegistry();
    expect(registry.marketplaces['test-marketplace']).toBeDefined();
    expect(registry.marketplaces['test-marketplace-v2']).toBeDefined();

    // Locations should differ
    expect(registry.marketplaces['test-marketplace'].source.location).toBe('owner/repo');
    expect(registry.marketplaces['test-marketplace-v2'].source.location).toBe('owner/repo/feat/v2');
  });

  it('should not collapse branch-specific marketplace into default branch', async () => {
    // Register feature branch first
    const result1 = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result1.success).toBe(true);

    // Register default branch — should NOT return the feature branch entry
    const result2 = await addMarketplace('owner/repo');
    expect(result2.success).toBe(true);
    expect(result2.marketplace?.name).toBe('test-marketplace'); // from manifest, not 'repo-v2'

    // Two clones should have happened
    expect(cloneToCalls).toHaveLength(2);
  });

  it('findMarketplace should not match branch-specific when looking for default', async () => {
    // Register branch-specific marketplace
    await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );

    // Looking for default branch source should NOT find the branch-specific one
    const found = await findMarketplace('repo', 'owner/repo');
    expect(found).toBeNull();
  });

  it('should be idempotent for the same branch', async () => {
    // Register feature branch
    const result1 = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result1.success).toBe(true);

    // Try registering the same branch again with a different name
    // Should find existing by source location and return it
    const result2 = await addMarketplace('owner/repo', 'repo-v2-copy', 'feat/v2');
    expect(result2.success).toBe(true);
    expect(result2.marketplace?.name).toBe('repo-v2'); // returns existing
  });
});
