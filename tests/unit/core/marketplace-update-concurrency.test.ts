import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateMarketplace } from '../../../src/core/marketplace.js';
import { stubHomeDir } from '../../helpers/env.js';

function createMockGit() {
  return {
    raw: async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'origin/main';
      return '';
    },
    checkout: async () => undefined,
  };
}

describe('updateMarketplace concurrency', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let registryPath: string;
  let marketplacePathA: string;
  let marketplacePathB: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-update-race-${Date.now()}`);
    restoreHomeDir = stubHomeDir(testHome);

    marketplacePathA = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'test-mp-a',
    );
    marketplacePathB = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'test-mp-b',
    );
    mkdirSync(marketplacePathA, { recursive: true });
    mkdirSync(marketplacePathB, { recursive: true });

    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    registryPath = join(registryDir, 'marketplaces.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          'test-mp-a': {
            name: 'test-mp-a',
            source: { type: 'github', location: 'owner/test-mp-a' },
            path: marketplacePathA,
            lastUpdated: '2024-01-01T00:00:00.000Z',
          },
          'test-mp-b': {
            name: 'test-mp-b',
            source: { type: 'github', location: 'owner/test-mp-b' },
            path: marketplacePathB,
            lastUpdated: '2024-01-01T00:00:00.000Z',
          },
        },
      }),
    );
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('persists both updates when two updateMarketplace calls race on the same shared registry file', async () => {
    // Simulates `allagents update` validating two plugins in parallel, each
    // backed by a different marketplace (validateAllPlugins uses
    // Promise.all). Marketplace A's git pull is slower, so its
    // updateMarketplace() call loads the registry before B's call has saved
    // its own update, then finishes (and saves) after B has already
    // persisted. A naive load-mutate-save must not let A's save silently
    // discard B's already-saved update.
    const callA = updateMarketplace('test-mp-a', undefined, {
      createGit: () => createMockGit(),
      pull: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    const callB = updateMarketplace('test-mp-b', undefined, {
      createGit: () => createMockGit(),
      pull: async () => undefined,
    });

    const [resultA, resultB] = await Promise.all([callA, callB]);

    expect(resultA[0]?.success).toBe(true);
    expect(resultB[0]?.success).toBe(true);

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.marketplaces['test-mp-a'].lastUpdated).not.toBe(
      '2024-01-01T00:00:00.000Z',
    );
    expect(registry.marketplaces['test-mp-b'].lastUpdated).not.toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });
});
