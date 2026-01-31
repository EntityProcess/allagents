import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePluginSpec,
  isPluginSpec,
  getMarketplacePluginsFromManifest,
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

  it('should return plugins from manifest with metadata', async () => {
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
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('plugin-a');
    expect(result[0].description).toBe('Plugin A desc');
    expect(result[0].category).toBe('development');
    expect(result[0].path).toBe(join(testDir, 'plugins', 'plugin-a'));
    expect(result[1].name).toBe('plugin-b');
    expect(result[1].description).toBe('Plugin B desc');
    expect(result[1].category).toBeUndefined();
  });

  it('should return empty array when no manifest exists', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result).toEqual([]);
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
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('external');
    expect(result[0].source).toBe('https://github.com/org/repo.git');
  });
});
