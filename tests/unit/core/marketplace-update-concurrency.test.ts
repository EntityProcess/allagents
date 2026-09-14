import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  removeMarketplace,
  updateMarketplace,
  type MarketplaceRegistry,
} from '../../../src/core/marketplace.js';
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

const INITIAL_LAST_UPDATED = '2024-01-01T00:00:00.000Z';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readRegistry(path: string): MarketplaceRegistry {
  return JSON.parse(readFileSync(path, 'utf-8')) as MarketplaceRegistry;
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
            lastUpdated: INITIAL_LAST_UPDATED,
          },
          'test-mp-b': {
            name: 'test-mp-b',
            source: { type: 'github', location: 'owner/test-mp-b' },
            path: marketplacePathB,
            lastUpdated: INITIAL_LAST_UPDATED,
          },
        },
      }),
    );
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('preserves a completed marketplace update when an earlier update finishes later', async () => {
    const aPullReached = deferred();
    const resumeAPull = deferred();
    const callA = updateMarketplace('test-mp-a', undefined, {
      createGit: () => createMockGit(),
      pull: async () => {
        aPullReached.resolve();
        await resumeAPull.promise;
      },
    });

    await aPullReached.promise;

    const resultB = await updateMarketplace('test-mp-b', undefined, {
      createGit: () => createMockGit(),
      pull: async () => undefined,
    });
    const entryBAfterUpdate = readRegistry(registryPath).marketplaces['test-mp-b'];

    resumeAPull.resolve();
    const resultA = await callA;
    const finalRegistry = readRegistry(registryPath);

    expect(resultA).toEqual([{ name: 'test-mp-a', success: true }]);
    expect(resultB).toEqual([{ name: 'test-mp-b', success: true }]);
    expect(entryBAfterUpdate?.lastUpdated).not.toBe(INITIAL_LAST_UPDATED);
    expect(finalRegistry.marketplaces['test-mp-b']).toEqual(entryBAfterUpdate);
    expect(finalRegistry.marketplaces['test-mp-a']?.lastUpdated).not.toBe(
      INITIAL_LAST_UPDATED,
    );
  });

  it('preserves a successful named update when update-all previously failed that entry', async () => {
    const registry = readRegistry(registryPath);
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          'test-mp-b': registry.marketplaces['test-mp-b'],
          'test-mp-a': registry.marketplaces['test-mp-a'],
        },
      }),
    );

    const aPullReached = deferred();
    const resumeAPull = deferred();
    const updateAll = updateMarketplace(undefined, undefined, {
      createGit: () => createMockGit(),
      pull: async (path) => {
        if (path === marketplacePathB) {
          throw new Error('B pull failed');
        }
        expect(path).toBe(marketplacePathA);
        aPullReached.resolve();
        await resumeAPull.promise;
      },
    });

    await aPullReached.promise;

    const namedBResult = await updateMarketplace('test-mp-b', undefined, {
      createGit: () => createMockGit(),
      pull: async () => undefined,
    });
    const entryBAfterNamedUpdate =
      readRegistry(registryPath).marketplaces['test-mp-b'];

    resumeAPull.resolve();
    const updateAllResult = await updateAll;
    const finalRegistry = readRegistry(registryPath);

    expect(namedBResult).toEqual([{ name: 'test-mp-b', success: true }]);
    expect(updateAllResult).toEqual([
      { name: 'test-mp-b', success: false, error: 'B pull failed' },
      { name: 'test-mp-a', success: true },
    ]);
    expect(entryBAfterNamedUpdate?.lastUpdated).not.toBe(INITIAL_LAST_UPDATED);
    expect(finalRegistry.marketplaces['test-mp-b']).toEqual(entryBAfterNamedUpdate);
    expect(finalRegistry.marketplaces['test-mp-a']?.lastUpdated).not.toBe(
      INITIAL_LAST_UPDATED,
    );
  });

  it('preserves a newer timestamp from a concurrent named update', async () => {
    const olderUpdate = new Date('2024-02-01T00:00:00.000Z');
    const newerUpdate = new Date('2024-03-01T00:00:00.000Z');
    const bUpdate = new Date('2024-04-01T00:00:00.000Z');
    const bPullReached = deferred();
    const resumeBPull = deferred();
    const updateTimes = [olderUpdate, bUpdate];
    const updateAll = updateMarketplace(undefined, undefined, {
      createGit: () => createMockGit(),
      pull: async (path) => {
        if (path === marketplacePathB) {
          bPullReached.resolve();
          await resumeBPull.promise;
        }
      },
      now: () => updateTimes.shift()!,
    });

    await bPullReached.promise;

    const namedAResult = await updateMarketplace('test-mp-a', undefined, {
      createGit: () => createMockGit(),
      pull: async () => undefined,
      now: () => newerUpdate,
    });

    resumeBPull.resolve();
    const updateAllResult = await updateAll;
    const finalRegistry = readRegistry(registryPath);

    expect(namedAResult).toEqual([{ name: 'test-mp-a', success: true }]);
    expect(updateAllResult).toEqual([
      { name: 'test-mp-a', success: true },
      { name: 'test-mp-b', success: true },
    ]);
    expect(finalRegistry.marketplaces['test-mp-a']?.lastUpdated).toBe(
      newerUpdate.toISOString(),
    );
    expect(finalRegistry.marketplaces['test-mp-b']?.lastUpdated).toBe(
      bUpdate.toISOString(),
    );
  });

  it('keeps removal authoritative when an in-flight named update finishes afterward', async () => {
    const pullReached = deferred();
    const resumePull = deferred();
    const update = updateMarketplace('test-mp-a', undefined, {
      createGit: () => createMockGit(),
      pull: async () => {
        pullReached.resolve();
        await resumePull.promise;
      },
    });

    await pullReached.promise;

    const removeResult = await removeMarketplace('test-mp-a');
    const registryAfterRemoval = readRegistry(registryPath);
    expect(removeResult.success).toBe(true);
    expect(registryAfterRemoval.marketplaces['test-mp-a']).toBeUndefined();
    expect(existsSync(marketplacePathA)).toBe(false);

    resumePull.resolve();
    const updateResult = await update;
    const finalRegistry = readRegistry(registryPath);

    expect(updateResult).toEqual([
      {
        name: 'test-mp-a',
        success: false,
        error:
          "Marketplace 'test-mp-a' changed during update. The registry was not overwritten; retry the command.",
      },
    ]);
    expect(finalRegistry).toEqual(registryAfterRemoval);
    expect(existsSync(marketplacePathA)).toBe(false);
  });
});
