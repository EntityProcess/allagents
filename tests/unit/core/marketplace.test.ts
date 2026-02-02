import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePluginSpec,
  isPluginSpec,
  getMarketplacePluginsFromManifest,
  resolvePluginSpec,
} from '../../../src/core/marketplace.js';

describe('parsePluginSpec', () => {
  it('should parse simple marketplace name', () => {
    const result = parsePluginSpec('my-plugin@claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo format', () => {
    const result = parsePluginSpec('my-plugin@anthropics/claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo/subpath format', () => {
    const result = parsePluginSpec('feature-dev@anthropics/claude-plugins-official/plugins');
    expect(result).toEqual({
      plugin: 'feature-dev',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      subpath: 'plugins',
    });
  });

  it('should parse owner/repo with nested subpath', () => {
    const result = parsePluginSpec('addon@owner/repo/src/addons');
    expect(result).toEqual({
      plugin: 'addon',
      marketplaceName: 'repo',
      owner: 'owner',
      repo: 'repo',
      subpath: 'src/addons',
    });
  });

  it('should return null for invalid specs', () => {
    expect(parsePluginSpec('no-at-sign')).toBeNull();
    expect(parsePluginSpec('@missing-plugin')).toBeNull();
    expect(parsePluginSpec('missing-marketplace@')).toBeNull();
    expect(parsePluginSpec('')).toBeNull();
  });

  it('should not confuse URL with owner/repo', () => {
    // URLs with :// should not be treated as owner/repo
    const result = parsePluginSpec('plugin@https://github.com/owner/repo');
    expect(result).toEqual({
      plugin: 'plugin',
      marketplaceName: 'https://github.com/owner/repo',
    });
  });
});

describe('isPluginSpec', () => {
  it('should return true for valid specs', () => {
    expect(isPluginSpec('plugin@marketplace')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo/subpath')).toBe(true);
  });

  it('should return false for invalid specs', () => {
    expect(isPluginSpec('no-at-sign')).toBe(false);
    expect(isPluginSpec('@missing-plugin')).toBe(false);
    expect(isPluginSpec('missing-marketplace@')).toBe(false);
    expect(isPluginSpec('')).toBe(false);
  });
});

describe('getMarketplacePluginsFromManifest', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `marketplace-manifest-test-${Date.now()}`);
    mkdirSync(join(testDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(testDir, 'plugins', 'plugin-a'), { recursive: true });
    mkdirSync(join(testDir, 'plugins', 'plugin-b'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return plugins from manifest with metadata and no warnings', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'plugin-a',
          description: 'Plugin A desc',
          source: './plugins/plugin-a',
          category: 'development',
        },
        {
          name: 'plugin-b',
          description: 'Plugin B desc',
          source: './plugins/plugin-b',
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].name).toBe('plugin-a');
    expect(result.plugins[0].description).toBe('Plugin A desc');
    expect(result.plugins[0].category).toBe('development');
    expect(result.plugins[0].path).toBe(join(testDir, 'plugins', 'plugin-a'));
    expect(result.plugins[1].name).toBe('plugin-b');
    expect(result.plugins[1].description).toBe('Plugin B desc');
    expect(result.plugins[1].category).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('should return empty plugins and warnings when no manifest exists', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('should handle URL source plugins', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe('external');
    expect(result.plugins[0].source).toBe('https://github.com/org/repo.git');
  });

  it('should handle URL source plugins with resolved cache path', async () => {
    // Create a fake cached plugin directory (simulating what fetchPlugin would produce)
    const cachedPluginDir = join(testDir, 'cached-external');
    mkdirSync(cachedPluginDir, { recursive: true });

    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    // resolvePluginSpec should resolve URL-source plugins by fetching them
    // We pass a mock fetchFn that returns the cached path
    const result = await resolvePluginSpec('external@test-marketplace', {
      marketplacePathOverride: testDir,
      fetchFn: async () => ({
        success: true,
        action: 'fetched' as const,
        cachePath: cachedPluginDir,
      }),
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachedPluginDir);
    expect(result!.plugin).toBe('external');
  });

  it('should return null for URL source plugins when fetch fails', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await resolvePluginSpec('external@test-marketplace', {
      marketplacePathOverride: testDir,
      fetchFn: async () => ({
        success: false,
        action: 'skipped' as const,
        cachePath: '',
        error: 'Network error',
      }),
    });

    expect(result).toBeNull();
  });

  it('should resolve GitHub source plugin via fetch (normalized to URL)', async () => {
    // Simulates the WTG marketplace.json where ediprod has a github source
    const cachedPluginDir = join(testDir, 'cached-ediprod');
    mkdirSync(cachedPluginDir, { recursive: true });

    const manifest = {
      name: 'wtg-ai-prompts',
      description: 'WiseTech Global plugins',
      plugins: [
        {
          name: 'cargowise',
          description: 'CargoWise coding guidelines',
          source: './plugins/cargowise',
        },
        {
          name: 'ediprod',
          source: { source: 'github', repo: 'WiseTechGlobal/mcp-ediprod' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    // Create local plugin dir for cargowise
    mkdirSync(join(testDir, 'plugins', 'cargowise'), { recursive: true });

    let fetchedUrl = '';
    const result = await resolvePluginSpec('ediprod@wtg-ai-prompts', {
      marketplacePathOverride: testDir,
      fetchFn: async (url: string) => {
        fetchedUrl = url;
        return {
          success: true,
          action: 'fetched' as const,
          cachePath: cachedPluginDir,
        };
      },
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachedPluginDir);
    expect(result!.plugin).toBe('ediprod');
    // Verify the github source was normalized to a full URL
    expect(fetchedUrl).toBe('https://github.com/WiseTechGlobal/mcp-ediprod');
  });

  it('should handle GitHub source plugins in plugin listing', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'local-plugin',
          description: 'Local plugin',
          source: './plugins/local-plugin',
        },
        {
          name: 'github-plugin',
          description: 'GitHub plugin',
          source: { source: 'github', repo: 'org/repo' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[1].name).toBe('github-plugin');
    expect(result.plugins[1].source).toBe('https://github.com/org/repo');
  });

  it('should return plugins without warnings when manifest is missing description', async () => {
    const manifest = {
      name: 'test',
      plugins: [
        {
          name: 'plugin-a',
          description: 'Plugin A desc',
          source: './plugins/plugin-a',
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe('plugin-a');
    expect(result.warnings).toEqual([]);
  });
});
