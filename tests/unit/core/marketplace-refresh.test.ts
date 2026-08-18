import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stubHomeDir } from '../../helpers/env.js';

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

const {
  listMarketplacePlugins,
  resolvePluginSpec,
  resolvePluginSpecWithAutoRegister,
} = await import('../../../src/core/marketplace.js');
const { cloneTo } = await import('../../../src/core/git.js');
const cloneToMock = cloneTo as ReturnType<typeof mock>;

describe('resolvePluginSpecWithAutoRegister refresh', () => {
  let restoreHomeDir: () => void;
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-refresh-test-${Date.now()}`);
    restoreHomeDir = stubHomeDir(testHome);
    cloneToCalls.length = 0;
    cloneToMock.mockImplementation(
      (url: string, path: string, branch?: string) => {
        cloneToCalls.push({ url, path, branch });
        mkdirSync(path, { recursive: true });
        return Promise.resolve();
      },
    );
  });

  afterEach(() => {
    restoreHomeDir();
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
    cloneToMock.mockImplementation(
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

  it('should refresh a canonical marketplace whose cache uses the repository name', async () => {
    const mpPath = setupMarketplace('repo-name', []);
    writeFileSync(
      join(mpPath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'canonical-name', plugins: [] }),
    );
    setupRegistry({
      'canonical-name': {
        name: 'canonical-name',
        source: { type: 'github', location: 'owner/repo-name' },
        path: mpPath,
      },
    });
    cloneToMock.mockImplementation(
      (_url: string, path: string, _branch?: string) => {
        mkdirSync(join(path, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(path, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: 'canonical-name',
            plugins: [{ name: 'new-plugin', source: './plugins/new-plugin' }],
          }),
        );
        mkdirSync(join(path, 'plugins', 'new-plugin'), { recursive: true });
        return Promise.resolve();
      },
    );

    const result = await resolvePluginSpecWithAutoRegister(
      'new-plugin@canonical-name',
    );

    expect(result.success).toBe(true);
    expect(result.pluginName).toBe('new-plugin');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces['canonical-name'].path).toBe(mpPath);
  });

  it('should refresh a malformed alias under its exact registry key', async () => {
    const mpPath = setupMarketplace('repo-name', []);
    setupRegistry({
      alias: {
        name: 'canonical-name',
        source: { type: 'github', location: 'owner/repo-name' },
        path: mpPath,
      },
    });
    cloneToMock.mockImplementation(
      (_url: string, path: string, _branch?: string) => {
        mkdirSync(join(path, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(path, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: 'canonical-name',
            plugins: [{ name: 'new-plugin', source: './plugins/new-plugin' }],
          }),
        );
        mkdirSync(join(path, 'plugins', 'new-plugin'), { recursive: true });
        return Promise.resolve();
      },
    );

    const result = await resolvePluginSpecWithAutoRegister('new-plugin@alias');

    expect(result.success).toBe(true);
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(Object.keys(registry.marketplaces)).toEqual(['alias']);
    expect(registry.marketplaces.alias.name).toBe('canonical-name');
    expect(registry.marketplaces.alias.path).toBe(mpPath);
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

  it('should accept a remote cache beneath an intentionally relocated AllAgents directory', async () => {
    const relocatedAllagents = join(testHome, 'relocated-allagents');
    mkdirSync(relocatedAllagents, { recursive: true });
    symlinkSync(relocatedAllagents, join(testHome, '.allagents'), 'dir');
    const mpPath = setupMarketplace('test-mp', [
      { name: 'existing-plugin', source: './plugins/existing-plugin' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
      },
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'existing-plugin@test-mp',
      { offline: true },
    );

    expect(result.success).toBe(true);
    expect(result.pluginName).toBe('existing-plugin');
    expect(lstatSync(join(testHome, '.allagents')).isSymbolicLink()).toBe(true);
    expect(cloneToCalls).toHaveLength(0);
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

    cloneToMock.mockImplementation(
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

  it('should preserve the registry entry and cache when refresh fails', async () => {
    const mpPath = setupMarketplace('test-mp', []);
    writeFileSync(join(mpPath, 'old-marker.txt'), 'old');
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    cloneToMock.mockImplementation(() =>
      Promise.reject(new Error('clone failed')),
    );

    const result = await resolvePluginSpecWithAutoRegister(
      'missing-plugin@test-mp',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('clone failed');
    expect(readFileSync(join(mpPath, 'old-marker.txt'), 'utf-8')).toBe('old');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces['test-mp']).toEqual({
      name: 'test-mp',
      source: { type: 'github', location: 'owner/test-mp' },
      path: mpPath,
      lastUpdated: '2024-01-01T00:00:00.000Z',
    });
  });

  it('should restore the old cache without overwriting a concurrent registry repair', async () => {
    const mpPath = setupMarketplace('test-mp', []);
    writeFileSync(join(mpPath, 'old-marker.txt'), 'old');
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
      },
    });
    const repairedPath = join(testHome, 'repaired-local-marketplace');
    mkdirSync(repairedPath, { recursive: true });
    cloneToMock.mockImplementation((_url: string, path: string) => {
      mkdirSync(path, { recursive: true });
      setupRegistry({
        'test-mp': {
          name: 'test-mp',
          source: { type: 'local', location: repairedPath },
          path: repairedPath,
        },
      });
      return Promise.resolve();
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'missing-plugin@test-mp',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("registration 'test-mp' changed during refresh");
    expect(readFileSync(join(mpPath, 'old-marker.txt'), 'utf-8')).toBe('old');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces['test-mp']).toEqual({
      name: 'test-mp',
      source: { type: 'local', location: repairedPath },
      path: repairedPath,
    });
  });

  it('should restore the old cache when replacing the staged clone fails', async () => {
    const mpPath = setupMarketplace('test-mp', []);
    writeFileSync(join(mpPath, 'old-marker.txt'), 'old');
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
      },
    });
    cloneToMock.mockImplementation(() => Promise.resolve());

    const result = await resolvePluginSpecWithAutoRegister(
      'missing-plugin@test-mp',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to replace marketplace cache');
    expect(readFileSync(join(mpPath, 'old-marker.txt'), 'utf-8')).toBe('old');
  });

  it('should remove only an unsafe remote registry entry without deleting its path', async () => {
    const homeMarker = join(testHome, 'home-marker.txt');
    mkdirSync(testHome, { recursive: true });
    writeFileSync(homeMarker, 'keep');
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: testHome,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      unrelated: {
        name: 'unrelated',
        source: { type: 'local', location: '/tmp/unrelated' },
        path: '/tmp/unrelated',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('missing@unsafe');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Removed invalid marketplace registration');
    expect(result.error).toContain('Refused to access or delete unmanaged path');
    expect(readFileSync(homeMarker, 'utf-8')).toBe('keep');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces.unsafe).toBeUndefined();
    expect(registry.marketplaces.unrelated).toEqual({
      name: 'unrelated',
      source: { type: 'local', location: '/tmp/unrelated' },
      path: '/tmp/unrelated',
    });
  });

  it('should refuse to list plugins through an unsafe registry path', async () => {
    mkdirSync(join(testHome, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(testHome, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'unsafe',
        plugins: [{ name: 'should-not-be-read', source: './plugin' }],
      }),
    );
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: testHome,
      },
    });

    const result = await listMarketplacePlugins('unsafe');

    expect(result.plugins).toEqual([]);
    expect(result.warnings).toEqual([
      `Refused to access unmanaged marketplace path: ${testHome}`,
    ]);
  });

  it('should refuse direct plugin resolution through an unsafe registry path', async () => {
    mkdirSync(join(testHome, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(testHome, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'unsafe',
        plugins: [{ name: 'should-not-be-read', source: './plugin' }],
      }),
    );
    mkdirSync(join(testHome, 'plugin'), { recursive: true });
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: testHome,
      },
    });

    const result = await resolvePluginSpec('should-not-be-read@unsafe');

    expect(result).toBeNull();
  });

  it('should remove an unsafe project alias without deleting a safe user entry', async () => {
    const workspacePath = join(testHome, 'workspace');
    const safePath = join(testHome, 'safe-local-marketplace');
    mkdirSync(safePath, { recursive: true });
    setupRegistry({
      victim: {
        name: 'victim',
        source: { type: 'local', location: safePath },
        path: safePath,
      },
    });
    const projectRegistryPath = join(
      workspacePath,
      '.allagents',
      'marketplaces.json',
    );
    mkdirSync(join(projectRegistryPath, '..'), { recursive: true });
    writeFileSync(
      projectRegistryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          alias: {
            name: 'victim',
            source: { type: 'github', location: 'owner/unsafe' },
            path: testHome,
          },
        },
      }),
    );

    const result = await resolvePluginSpecWithAutoRegister(
      'missing@owner/unsafe',
      { workspacePath },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("registration 'alias'");
    const userRegistry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    const projectRegistry = JSON.parse(
      readFileSync(projectRegistryPath, 'utf-8'),
    );
    expect(userRegistry.marketplaces.victim).toBeDefined();
    expect(projectRegistry.marketplaces.alias).toBeUndefined();
    expect(cloneToCalls).toHaveLength(0);
  });

  it('should remove a broad local registration without accessing its home directory', async () => {
    const homeMarker = join(testHome, 'home-marker.txt');
    mkdirSync(testHome, { recursive: true });
    writeFileSync(homeMarker, 'keep');
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'local', location: testHome },
        path: testHome,
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('missing@unsafe');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Removed invalid marketplace registration');
    expect(readFileSync(homeMarker, 'utf-8')).toBe('keep');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces.unsafe).toBeUndefined();
    expect(cloneToCalls).toHaveLength(0);
  });

  it('should remove a symlinked remote registration without touching the link or target', async () => {
    const targetPath = join(testHome, 'user-owned-target');
    const cachePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'unsafe',
    );
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, 'marker.txt'), 'keep');
    mkdirSync(join(cachePath, '..'), { recursive: true });
    symlinkSync(targetPath, cachePath, 'dir');
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: cachePath,
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('missing@unsafe');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Removed invalid marketplace registration');
    expect(lstatSync(cachePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(targetPath, 'marker.txt'), 'utf-8')).toBe('keep');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces.unsafe).toBeUndefined();
    expect(cloneToCalls).toHaveLength(0);
  });

  it('should not access a sibling marketplace cache referenced by an invalid entry', async () => {
    const otherPath = setupMarketplace('other', []);
    const markerPath = join(otherPath, 'other-marker.txt');
    writeFileSync(markerPath, 'keep');
    setupRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: otherPath,
      },
      other: {
        name: 'other',
        source: { type: 'github', location: 'owner/other' },
        path: otherPath,
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('missing@unsafe');

    expect(result.success).toBe(false);
    expect(readFileSync(markerPath, 'utf-8')).toBe('keep');
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces.unsafe).toBeUndefined();
    expect(registry.marketplaces.other).toBeDefined();
  });
});
