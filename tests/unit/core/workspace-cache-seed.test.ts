import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedCacheFromClone } from '../../../src/core/workspace.js';
import { getPluginCachePath } from '../../../src/utils/plugin-path.js';
import { getMarketplacesDir } from '../../../src/core/marketplace.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('seedCacheFromClone', () => {
  let tempCloneDir: string;
  let tempHomeDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    tempCloneDir = await mkdtemp(join(tmpdir(), 'allagents-clone-'));
    tempHomeDir = await mkdtemp(join(tmpdir(), 'allagents-home-'));
    restoreHomeDir = stubHomeDir(tempHomeDir);
    // Add a marker file to verify the clone was copied
    await writeFile(join(tempCloneDir, 'marker.txt'), 'cloned-content');
  });

  afterEach(async () => {
    restoreHomeDir();
    await Promise.all([
      rm(tempCloneDir, { recursive: true, force: true }),
      rm(tempHomeDir, { recursive: true, force: true }),
    ]);
  });

  it('should seed both plugin and marketplace caches', async () => {
    await seedCacheFromClone(tempCloneDir, 'test-owner', 'test-repo', 'main');

    // Plugin cache should be seeded
    const pluginCachePath = getPluginCachePath('test-owner', 'test-repo', 'main');
    expect(existsSync(pluginCachePath)).toBe(true);
    expect(existsSync(join(pluginCachePath, 'marker.txt'))).toBe(true);

    // Marketplace cache should be seeded
    const marketplaceCachePath = join(getMarketplacesDir(), 'test-repo');
    expect(existsSync(marketplaceCachePath)).toBe(true);
    expect(existsSync(join(marketplaceCachePath, 'marker.txt'))).toBe(true);
  });

  it('should not overwrite existing cache', async () => {
    // Pre-populate the cache with different content
    const pluginCachePath = getPluginCachePath('test-owner', 'test-repo', 'main');
    await mkdir(pluginCachePath, { recursive: true });
    await writeFile(join(pluginCachePath, 'existing.txt'), 'existing-content');

    await seedCacheFromClone(tempCloneDir, 'test-owner', 'test-repo', 'main');

    // Existing cache should NOT be overwritten
    expect(existsSync(join(pluginCachePath, 'existing.txt'))).toBe(true);
    expect(existsSync(join(pluginCachePath, 'marker.txt'))).toBe(false);
  });

  it('should not throw when copy fails', async () => {
    // Pass a nonexistent temp dir — seedCacheFromClone should not throw
    await expect(
      seedCacheFromClone('/nonexistent/path', 'test-owner', 'test-repo', 'main'),
    ).resolves.toBeUndefined();
  });
});
