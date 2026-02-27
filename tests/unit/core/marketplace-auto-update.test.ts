import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track calls
const pullCalls: Array<{ path: string }> = [];
const simpleGitCalls: Array<{ method: string; args: unknown[] }> = [];
let pullShouldFail = false;

function createMockGit() {
  return {
    raw: mock((...args: unknown[]) => {
      simpleGitCalls.push({ method: 'raw', args });
      const rawArgs = args[0] as string[];
      if (rawArgs?.[0] === 'symbolic-ref') {
        return Promise.resolve('origin/main');
      }
      return Promise.resolve('');
    }),
    checkout: mock((...args: unknown[]) => {
      simpleGitCalls.push({ method: 'checkout', args });
      return Promise.resolve();
    }),
    log: mock(() => Promise.resolve({ latest: { hash: 'abc1234' } })),
  };
}

mock.module('simple-git', () => ({
  default: () => createMockGit(),
}));

mock.module('../../../src/core/git.js', () => ({
  pull: mock((path: string) => {
    pullCalls.push({ path });
    if (pullShouldFail) return Promise.reject(new Error('network timeout'));
    return Promise.resolve();
  }),
  cloneTo: mock((_url: string, path: string) => {
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
  resolvePluginSpecWithAutoRegister,
  resetUpdatedMarketplaceCache,
} = await import('../../../src/core/marketplace.js');

describe('resolvePluginSpecWithAutoRegister auto-updates marketplace', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-auto-update-test-${Date.now()}`);
    process.env.HOME = testHome;
    pullCalls.length = 0;
    simpleGitCalls.length = 0;
    pullShouldFail = false;
    resetUpdatedMarketplaceCache();
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
    for (const p of plugins) {
      if (p.source.startsWith('./')) {
        const pluginDir = join(mpPath, p.source.slice(2));
        mkdirSync(pluginDir, { recursive: true });
      }
    }
    return mpPath;
  }

  it('pulls latest marketplace before resolving plugin', async () => {
    const mpPath = setupMarketplace('test-mp', [
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('my-plugin@test-mp');

    expect(result.success).toBe(true);
    // The key assertion: git pull was called on the marketplace
    expect(pullCalls.length).toBe(1);
    expect(pullCalls[0].path).toBe(mpPath);
  });

  it('skips pull for same marketplace on second call in same session', async () => {
    const mpPath = setupMarketplace('test-mp', [
      { name: 'plugin-a', source: './plugins/plugin-a' },
      { name: 'plugin-b', source: './plugins/plugin-b' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    await resolvePluginSpecWithAutoRegister('plugin-a@test-mp');
    pullCalls.length = 0;

    await resolvePluginSpecWithAutoRegister('plugin-b@test-mp');

    // Second call should NOT trigger another pull
    expect(pullCalls.length).toBe(0);
  });

  it('skips pull when offline', async () => {
    const mpPath = setupMarketplace('test-mp', [
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister('my-plugin@test-mp', {
      offline: true,
    });

    expect(result.success).toBe(true);
    expect(pullCalls.length).toBe(0);
  });

  it('skips pull for local marketplaces', async () => {
    const mpPath = setupMarketplace('local-mp', [
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);
    setupRegistry({
      'local-mp': {
        name: 'local-mp',
        source: { type: 'local', location: mpPath },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'my-plugin@local-mp',
    );

    expect(result.success).toBe(true);
    expect(pullCalls.length).toBe(0);
  });

  it('pulls different marketplaces independently', async () => {
    const mpPath1 = setupMarketplace('mp-one', [
      { name: 'plugin-a', source: './plugins/plugin-a' },
    ]);
    const mpPath2 = setupMarketplace('mp-two', [
      { name: 'plugin-b', source: './plugins/plugin-b' },
    ]);
    setupRegistry({
      'mp-one': {
        name: 'mp-one',
        source: { type: 'github', location: 'owner/mp-one' },
        path: mpPath1,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      'mp-two': {
        name: 'mp-two',
        source: { type: 'github', location: 'owner/mp-two' },
        path: mpPath2,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    await resolvePluginSpecWithAutoRegister('plugin-a@mp-one');
    await resolvePluginSpecWithAutoRegister('plugin-b@mp-two');

    // Both marketplaces should have been pulled
    expect(pullCalls.length).toBe(2);
    expect(pullCalls[0].path).toBe(mpPath1);
    expect(pullCalls[1].path).toBe(mpPath2);
  });

  it('retries pull on next call when previous pull failed', async () => {
    const mpPath = setupMarketplace('test-mp', [
      { name: 'my-plugin', source: './plugins/my-plugin' },
    ]);
    setupRegistry({
      'test-mp': {
        name: 'test-mp',
        source: { type: 'github', location: 'owner/test-mp' },
        path: mpPath,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    });

    // First call: pull fails
    pullShouldFail = true;
    const result1 = await resolvePluginSpecWithAutoRegister('my-plugin@test-mp');
    // Plugin still resolves from cached state
    expect(result1.success).toBe(true);
    expect(pullCalls.length).toBe(1);

    // Second call: pull should be retried (not cached as updated)
    pullShouldFail = false;
    pullCalls.length = 0;
    const result2 = await resolvePluginSpecWithAutoRegister('my-plugin@test-mp');
    expect(result2.success).toBe(true);
    expect(pullCalls.length).toBe(1);
  });

  it('skips pull for freshly auto-registered marketplace', async () => {
    // No registry or marketplace pre-setup — auto-register will clone fresh
    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify({ version: 1, marketplaces: {} }, null, 2),
    );

    // The auto-register path will clone the marketplace. We need the cloned
    // directory to contain the plugin so resolution succeeds.
    const gitMod = await import('../../../src/core/git.js');
    const cloneToMock = gitMod.cloneTo as ReturnType<typeof mock>;
    cloneToMock.mockImplementation((_url: string, path: string) => {
      mkdirSync(join(path, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(path, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'fresh-mp',
          plugins: [{ name: 'my-plugin', source: './plugins/my-plugin' }],
        }),
      );
      mkdirSync(join(path, 'plugins', 'my-plugin'), { recursive: true });
      return Promise.resolve();
    });

    const result = await resolvePluginSpecWithAutoRegister(
      'my-plugin@owner/fresh-mp',
    );

    expect(result.success).toBe(true);
    // No pull should have happened — marketplace was just cloned fresh
    expect(pullCalls.length).toBe(0);
  });
});
