import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track cloneTo calls to verify refresh behavior
const cloneToCalls: Array<{ url: string; path: string; branch?: string }> = [];

mock.module('simple-git', () => ({
  default: () => ({}),
}));

mock.module('../../../src/core/git.js', () => ({
  pull: mock(() => Promise.resolve()),
  cloneTo: mock((url: string, path: string, branch?: string) => {
    cloneToCalls.push({ url, path, branch });
    // Simulate clone by creating the directory
    mkdirSync(path, { recursive: true });
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

const { resolvePluginSpecWithAutoRegister } = await import(
  '../../../src/core/marketplace.js'
);

describe('resolvePluginSpecWithAutoRegister refresh', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-refresh-test-${Date.now()}`);
    process.env.HOME = testHome;
    cloneToCalls.length = 0;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  function setupRegistry(marketplaces: Record<string, unknown>) {
    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify({ version: 1, marketplaces }, null, 2),
    );
  }

  function setupMarketplace(
    name: string,
    plugins: Array<{ name: string; source: string }>,
  ) {
    const mpPath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      name,
    );
    mkdirSync(join(mpPath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(mpPath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name, plugins }),
    );
    // Create plugin directories for local-source plugins
    for (const p of plugins) {
      if (p.source.startsWith('./')) {
        const pluginDir = join(mpPath, p.source.slice(2));
        mkdirSync(pluginDir, { recursive: true });
      }
    }
    return mpPath;
  }

  it('should refresh marketplace and find plugin after re-clone', async () => {
    // Set up a marketplace that does NOT have the target plugin initially
    const mpPath = setupMarketplace('test-mp', [
      { name: 'existing-plugin', source: './plugins/existing-plugin' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    // Override cloneTo to create the directory with the new plugin included
    cloneToCalls.length = 0;
    const originalCloneTo = (
      await import('../../../src/core/git.js')
    ).cloneTo as ReturnType<typeof mock>;
    originalCloneTo.mockImplementation(
      (url: string, path: string, branch?: string) => {
        cloneToCalls.push({ url, path, branch });
        // Simulate fresh clone that now includes the missing plugin
        mkdirSync(join(path, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(path, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: 'test-mp',
            plugins: [
              {
                name: 'existing-plugin',
                source: './plugins/existing-plugin',
              },
              { name: 'new-plugin', source: './plugins/new-plugin' },
            ],
          }),
        );
        mkdirSync(join(path, 'plugins', 'existing-plugin'), {
          recursive: true,
        });
        mkdirSync(join(path, 'plugins', 'new-plugin'), { recursive: true });
        return Promise.resolve();
      },
    );

    const result = await resolvePluginSpecWithAutoRegister(
      'new-plugin@test-mp',
    );

    expect(result.success).toBe(true);
    expect(result.pluginName).toBe('new-plugin');
    // Verify a clone was triggered (refresh happened)
    expect(cloneToCalls.length).toBe(1);
    expect(cloneToCalls[0].url).toContain('owner/test-mp');
  });

  it('should not refresh when offline', async () => {
    const mpPath = setupMarketplace('test-mp', []);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'missing-plugin@test-mp',
      { offline: true },
    );

    expect(result.success).toBe(false);
    expect(cloneToCalls.length).toBe(0);
  });

  it('should not refresh local marketplaces', async () => {
    const mpPath = setupMarketplace('local-mp', []);
    setupRegistry({
      'local-mp': {
        name: 'local-mp',
        source: { type: 'local', location: mpPath },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'missing-plugin@local-mp',
    );

    expect(result.success).toBe(false);
    expect(cloneToCalls.length).toBe(0);
  });

  it('should delete old cache directory during refresh', async () => {
    const mpPath = setupMarketplace('test-mp', []);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    // Create a marker file in the old directory
    writeFileSync(join(mpPath, 'old-marker.txt'), 'old');

    const originalCloneTo = (
      await import('../../../src/core/git.js')
    ).cloneTo as ReturnType<typeof mock>;
    originalCloneTo.mockImplementation(
      (_url: string, path: string, _branch?: string) => {
        // By the time clone is called, old directory should be deleted
        // (clone target is the new path based on marketplace name)
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
    );

    await resolvePluginSpecWithAutoRegister('missing@test-mp');

    // Old directory should be gone (rm was called before clone)
    expect(existsSync(join(mpPath, 'old-marker.txt'))).toBe(false);
  });
});
