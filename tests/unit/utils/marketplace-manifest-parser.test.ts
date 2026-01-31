import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../../../src/utils/marketplace-manifest-parser.js';

describe('parseMarketplaceManifest', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `marketplace-test-${Date.now()}`);
    mkdirSync(join(testDir, '.claude-plugin'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse a valid marketplace.json', async () => {
    const manifest = {
      name: 'test-marketplace',
      description: 'Test marketplace',
      plugins: [
        { name: 'plugin-a', description: 'Plugin A', source: './plugins/plugin-a' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test-marketplace');
      expect(result.data.plugins).toHaveLength(1);
    }
  });

  it('should return error when marketplace.json does not exist', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });

  it('should return error for invalid JSON', async () => {
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      'not valid json{{{',
    );
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('parse');
    }
  });

  it('should return error for JSON that fails schema validation', async () => {
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ invalid: true }),
    );
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('validation');
    }
  });
});

describe('resolvePluginSourcePath', () => {
  it('should resolve relative path source', () => {
    const result = resolvePluginSourcePath('./plugins/my-plugin', '/home/user/marketplace');
    expect(result).toBe('/home/user/marketplace/plugins/my-plugin');
  });

  it('should resolve plain relative path', () => {
    const result = resolvePluginSourcePath('plugins/my-plugin', '/home/user/marketplace');
    expect(result).toBe('/home/user/marketplace/plugins/my-plugin');
  });

  it('should return url for URL source objects', () => {
    const source = { source: 'url' as const, url: 'https://github.com/org/repo.git' };
    const result = resolvePluginSourcePath(source, '/home/user/marketplace');
    expect(result).toBe('https://github.com/org/repo.git');
  });
});
