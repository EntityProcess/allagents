import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateMarketplace } from '../../../src/core/marketplace.js';
import { stubHomeDir } from '../../helpers/env.js';

// Track calls for assertions
const simpleGitCalls: Array<{ method: string; args: unknown[] }> = [];
const pullCalls: Array<{ path: string }> = [];

function createMockGit(
  overrides: {
    raw?: (args: string[]) => Promise<string>;
    checkout?: (branch: string) => Promise<void>;
  } = {},
) {
  return {
    raw: mock((args: string[]) => {
      simpleGitCalls.push({ method: 'raw', args: [args] });
      if (overrides.raw) return overrides.raw(args);
      // Default: symbolic-ref returns origin/main
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve('origin/main');
      }
      return Promise.resolve('');
    }),
    checkout: mock((branch: string) => {
      simpleGitCalls.push({ method: 'checkout', args: [branch] });
      if (overrides.checkout) return overrides.checkout(branch);
      return Promise.resolve();
    }),
  };
}

let currentMockGit = createMockGit();

function marketplaceUpdateDeps() {
  return {
    createGit: () => currentMockGit,
    pull: async (path: string) => {
      pullCalls.push({ path });
    },
  };
}

describe('updateMarketplace', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let marketplacePath: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-update-test-${Date.now()}`);
    restoreHomeDir = stubHomeDir(testHome);

    // Create marketplace directory
    marketplacePath = join(testHome, '.allagents', 'plugins', 'marketplaces', 'test-mp');
    mkdirSync(marketplacePath, { recursive: true });

    // Write registry with a github marketplace entry
    const registry = {
      version: 1,
      marketplaces: {
        'test-mp': {
          name: 'test-mp',
          source: { type: 'github', location: 'owner/test-mp' },
          path: marketplacePath,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    };
    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify(registry, null, 2),
    );

    simpleGitCalls.length = 0;
    pullCalls.length = 0;
    currentMockGit = createMockGit();
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  it('should checkout default branch before pulling', async () => {
    const results = await updateMarketplace(
      'test-mp',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Verify calls: symbolic-ref -> checkout -> pull
    const symbolicRefCall = simpleGitCalls.find(
      (c) => c.method === 'raw' && (c.args[0] as string[])?.[0] === 'symbolic-ref',
    );
    expect(symbolicRefCall).toBeDefined();

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('main');

    expect(pullCalls.length).toBe(1);
  });

  it('should use remote show origin to detect master branch when symbolic-ref fails', async () => {
    currentMockGit = createMockGit({
      raw: (...args: unknown[]) => {
        const rawArgs = args[0] as string[];
        if (rawArgs?.[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (rawArgs?.[0] === 'remote' && rawArgs?.[1] === 'show') {
          return Promise.resolve('  HEAD branch: master\n  Remote branches:\n');
        }
        return Promise.resolve('');
      },
    });

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('master');
  });

  it('should fallback to main when both symbolic-ref and remote show fail', async () => {
    currentMockGit = createMockGit({
      raw: (...args: unknown[]) => {
        const rawArgs = args[0] as string[];
        if (rawArgs?.[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (rawArgs?.[0] === 'remote') {
          return Promise.reject(new Error('fatal: unable to access'));
        }
        return Promise.resolve('');
      },
    });

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('main');
  });

  it('should checkout stored branch instead of detecting default branch', async () => {
    // Update registry to include a branch in location
    const registry = {
      version: 1,
      marketplaces: {
        'test-mp-branch': {
          name: 'test-mp-branch',
          source: { type: 'github', location: 'owner/test-mp/feat/v2' },
          path: marketplacePath,
          lastUpdated: '2024-01-01T00:00:00.000Z',
        },
      },
    };
    const registryDir = join(testHome, '.allagents');
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify(registry, null, 2),
    );

    simpleGitCalls.length = 0;

    const results = await updateMarketplace(
      'test-mp-branch',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    // Should NOT call symbolic-ref (no default branch detection)
    const symbolicRefCall = simpleGitCalls.find(
      (c) => c.method === 'raw' && (c.args[0] as string[])?.[0] === 'symbolic-ref',
    );
    expect(symbolicRefCall).toBeUndefined();

    // Should checkout feat/v2 directly
    const checkoutCall = simpleGitCalls.find((c) => c.method === 'checkout');
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args[0]).toBe('feat/v2');

    // Should pull
    expect(pullCalls.length).toBe(1);
  });

  it('should remove an unsafe registration without opening its directory', async () => {
    const markerPath = join(testHome, 'home-marker.txt');
    writeFileSync(markerPath, 'keep');
    const registryPath = join(testHome, '.allagents', 'marketplaces.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          unsafe: {
            name: 'unsafe',
            source: { type: 'github', location: 'owner/unsafe' },
            path: testHome,
          },
        },
      }),
    );

    const results = await updateMarketplace(
      'unsafe',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain(
      'Removed invalid marketplace registration',
    );
    expect(readFileSync(markerPath, 'utf-8')).toBe('keep');
    expect(simpleGitCalls).toHaveLength(0);
    expect(pullCalls).toHaveLength(0);
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.marketplaces.unsafe).toBeUndefined();
  });

  it('should remove an unsafe alias by exact key without rewriting a safe entry', async () => {
    const safePath = join(testHome, 'safe-local-marketplace');
    mkdirSync(safePath, { recursive: true });
    const registryPath = join(testHome, '.allagents', 'marketplaces.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          victim: {
            name: 'other',
            source: { type: 'local', location: safePath },
            path: safePath,
          },
          alias: {
            name: 'victim',
            source: { type: 'github', location: 'owner/unsafe' },
            path: testHome,
          },
        },
      }),
    );

    const results = await updateMarketplace(
      undefined,
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toHaveLength(2);
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.marketplaces.alias).toBeUndefined();
    expect(registry.marketplaces.victim).toEqual({
      name: 'other',
      source: { type: 'local', location: safePath },
      path: safePath,
    });
    expect(registry.marketplaces.other).toBeUndefined();
    expect(simpleGitCalls).toHaveLength(0);
    expect(pullCalls).toHaveLength(0);
  });
});
