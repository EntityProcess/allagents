import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import { removeMarketplace, saveRegistry } from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('removeMarketplace cascade', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-cascade-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRegistry(marketplaces: MarketplaceRegistry['marketplaces']): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await saveRegistry({ version: 1, marketplaces });
  }

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function readUserConfig(): Promise<WorkspaceConfig> {
    const content = await readFile(
      join(testDir, '.allagents', WORKSPACE_CONFIG_FILE),
      'utf-8',
    );
    return load(content) as WorkspaceConfig;
  }

  it('should remove user plugins referencing the removed marketplace', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: [
        'pluginA@my-marketplace',
        'pluginB@my-marketplace',
        'pluginC@other-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);

    const config = await readUserConfig();
    expect(config.plugins).toEqual(['pluginC@other-marketplace']);
  });

  it('should return removed user plugins in result', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: ['pluginA@my-marketplace'],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.removedUserPlugins).toEqual(['pluginA@my-marketplace']);
  });

  it('should succeed even when no user config exists', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.removedUserPlugins).toEqual([]);
  });

  it('should succeed when no user plugins reference the marketplace', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: ['pluginC@other-marketplace'],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.removedUserPlugins).toEqual([]);
  });

  it('should delete the marketplace directory when it exists', async () => {
    const marketplacePath = join(testDir, '.allagents', 'plugins', 'marketplaces', 'my-marketplace');
    await mkdir(marketplacePath, { recursive: true });
    await writeFile(join(marketplacePath, 'manifest.yaml'), 'name: my-marketplace', 'utf-8');

    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'github', location: 'owner/repo' },
        path: marketplacePath,
      },
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(marketplacePath)).toBe(true);

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(existsSync(marketplacePath)).toBe(false);
  });

  it('should not delete the source directory for local marketplaces', async () => {
    const localSourceDir = join(testDir, 'external-marketplace');
    await mkdir(localSourceDir, { recursive: true });
    await writeFile(join(localSourceDir, 'README.md'), '# My Marketplace', 'utf-8');

    await writeRegistry({
      'local-mp': {
        name: 'local-mp',
        source: { type: 'local', location: localSourceDir },
        path: localSourceDir,
      },
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(localSourceDir)).toBe(true);

    const result = await removeMarketplace('local-mp');
    expect(result.success).toBe(true);
    // Local source directory must NOT be deleted
    expect(existsSync(localSourceDir)).toBe(true);
  });
});
