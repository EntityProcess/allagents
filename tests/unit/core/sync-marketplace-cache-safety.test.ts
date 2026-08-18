import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchPlugin, resetFetchCache } from '../../../src/core/plugin.js';
import { seedFetchCacheFromMarketplaces } from '../../../src/core/sync.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('seedFetchCacheFromMarketplaces ownership', () => {
  let testHome: string;
  let restoreHomeDir: () => void;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-seed-safety-${Date.now()}`);
    restoreHomeDir = stubHomeDir(testHome);
    mkdirSync(join(testHome, '.allagents'), { recursive: true });
    resetFetchCache();
  });

  afterEach(() => {
    resetFetchCache();
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should not seed an unsafe marketplace registry path', async () => {
    writeFileSync(
      join(testHome, '.allagents', 'marketplaces.json'),
      JSON.stringify({
        version: 1,
        marketplaces: {
          unsafe: {
            name: 'unsafe',
            source: { type: 'github', location: 'owner/repo' },
            path: testHome,
          },
        },
      }),
    );
    await seedFetchCacheFromMarketplaces([
      { source: 'owner/repo', success: true, name: 'unsafe' },
    ]);

    let cloneCalled = false;
    const result = await fetchPlugin('owner/repo', {}, {
      existsSync: () => false,
      mkdir: async () => undefined,
      cloneTo: async () => {
        cloneCalled = true;
      },
      pull: async () => undefined,
    });

    expect(cloneCalled).toBe(true);
    expect(result.cachePath).not.toBe(testHome);
  });
});
