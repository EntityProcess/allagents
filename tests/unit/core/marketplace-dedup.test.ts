import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Track cloneTo calls
const cloneToCalls: Array<{ url: string; path: string; branch?: string }> = [];

mock.module('simple-git', () => ({
  default: () => ({}),
}));

mock.module('../../../src/core/git.js', () => ({
  pull: mock(() => Promise.resolve()),
  cloneTo: mock((url: string, path: string, branch?: string) => {
    cloneToCalls.push({ url, path, branch });
    mkdirSync(path, { recursive: true });
    // Create a basic marketplace manifest
    mkdirSync(join(path, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(path, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        plugins: [
          { name: 'plugin-a', source: './plugins/plugin-a' },
          { name: 'plugin-b', source: './plugins/plugin-b' },
        ],
      }),
    );
    mkdirSync(join(path, 'plugins', 'plugin-a'), { recursive: true });
    mkdirSync(join(path, 'plugins', 'plugin-b'), { recursive: true });
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
  ensureMarketplacesRegistered,
  extractUniqueMarketplaceSources,
  findMarketplace,
  resolvePluginSpecWithAutoRegister,
  resetAutoRegisterCache,
} = await import('../../../src/core/marketplace.js');

describe('marketplace deduplication', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let logMessages: string[];

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-dedup-test-${Date.now()}`);
    process.env.HOME = testHome;
    cloneToCalls.length = 0;
    resetAutoRegisterCache();

    // Spy on console.log to capture log messages
    logMessages = [];
    consoleLogSpy = spyOn(console, 'log').mockImplementation((...args) => {
      logMessages.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    consoleLogSpy.mockRestore();
  });

  describe('extractUniqueMarketplaceSources', () => {
    it('should extract unique owner/repo sources from plugin specs', () => {
      const plugins = [
        'plugin-a@owner/repo',
        'plugin-b@owner/repo',
        'plugin-c@other/marketplace',
        'local-plugin',
        'https://github.com/direct/url',
      ];

      const sources = extractUniqueMarketplaceSources(plugins);

      expect(sources).toHaveLength(2);
      expect(sources).toContain('owner/repo');
      expect(sources).toContain('other/marketplace');
    });

    it('should return empty array for plugins without marketplace specs', () => {
      const plugins = [
        'local-plugin',
        './relative/plugin',
        'https://github.com/direct/url',
      ];

      const sources = extractUniqueMarketplaceSources(plugins);

      expect(sources).toHaveLength(0);
    });
  });

  describe('ensureMarketplacesRegistered', () => {
    it('should register each unique marketplace only once', async () => {
      const plugins = [
        'plugin-a@owner/test-repo',
        'plugin-b@owner/test-repo',
        'plugin-c@other/marketplace',
      ];

      const results = await ensureMarketplacesRegistered(plugins);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);

      // Should only have logged 2 auto-registration messages
      const autoRegLogs = logMessages.filter((m) =>
        m.includes('Auto-registering'),
      );
      expect(autoRegLogs).toHaveLength(2);
    });

    it('should skip already registered marketplaces', async () => {
      // Pre-register a marketplace
      await addMarketplace('owner/test-repo');
      logMessages.length = 0;
      cloneToCalls.length = 0;

      const plugins = ['plugin-a@owner/test-repo', 'plugin-b@owner/test-repo'];

      const results = await ensureMarketplacesRegistered(plugins);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);

      // Should not have logged any auto-registration (already registered)
      const autoRegLogs = logMessages.filter((m) =>
        m.includes('Auto-registering'),
      );
      expect(autoRegLogs).toHaveLength(0);

      // Should not have cloned again
      expect(cloneToCalls).toHaveLength(0);
    });
  });

  describe('addMarketplace idempotency', () => {
    it('should return success when marketplace is already registered by source location', async () => {
      // Register marketplace with owner/repo
      const result1 = await addMarketplace('owner/test-repo');
      expect(result1.success).toBe(true);
      expect(result1.marketplace?.name).toBe('test-marketplace'); // from manifest

      // Try to register the same marketplace again
      const result2 = await addMarketplace('owner/test-repo');
      // Should return success (idempotent) because it's already registered
      expect(result2.success).toBe(true);
      expect(result2.marketplace?.name).toBe('test-marketplace');
    });

    it('should find marketplace by source location even when registered under different name', async () => {
      // Register marketplace - manifest changes name to 'test-marketplace'
      const result1 = await addMarketplace('owner/test-repo');
      expect(result1.success).toBe(true);

      const registry = await loadRegistry();
      // Verify marketplace is registered under manifest name, not repo name
      expect(registry.marketplaces['test-marketplace']).toBeDefined();
      expect(registry.marketplaces['test-repo']).toBeUndefined();

      // findMarketplace should find by source location
      const found = await findMarketplace('test-repo', 'owner/test-repo');
      expect(found).not.toBeNull();
      expect(found?.name).toBe('test-marketplace');
    });
  });

  describe('resolvePluginSpecWithAutoRegister', () => {
    it('should not log when marketplace was pre-registered by ensureMarketplacesRegistered', async () => {
      const plugins = ['plugin-a@owner/test-repo', 'plugin-b@owner/test-repo'];

      // Pre-register marketplaces (like sync.ts does before validateAllPlugins)
      await ensureMarketplacesRegistered(plugins);
      const preRegLogs = logMessages.filter((m) =>
        m.includes('Auto-registering'),
      );
      expect(preRegLogs).toHaveLength(1);

      // Clear log messages to isolate next phase
      logMessages.length = 0;

      // Now resolve plugins (like validateAllPlugins does)
      await Promise.all(
        plugins.map((spec) => resolvePluginSpecWithAutoRegister(spec)),
      );

      // Should NOT have logged any additional auto-registration messages
      const postRegLogs = logMessages.filter((m) =>
        m.includes('Auto-registering'),
      );
      expect(postRegLogs).toHaveLength(0);
    });
  });
});
