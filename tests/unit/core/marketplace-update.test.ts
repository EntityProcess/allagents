import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateMarketplace } from '../../../src/core/marketplace.js';
import { stubHomeDir } from '../../helpers/env.js';
import { UpdateContext } from '../../../src/core/update-context.js';

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

  it('advances the marketplace timestamp after a successful update', async () => {
    const updatedAt = new Date('2026-09-17T12:00:00.000Z');

    const results = await updateMarketplace('test-mp', undefined, {
      ...marketplaceUpdateDeps(),
      now: () => updatedAt,
    });

    expect(results).toEqual([{ name: 'test-mp', success: true }]);
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces['test-mp'].lastUpdated).toBe(
      updatedAt.toISOString(),
    );
  });

  it('writes a successful project update timestamp only to its owning registry', async () => {
    const workspacePath = join(testHome, 'workspace');
    const projectRegistryPath = join(
      workspacePath,
      '.allagents',
      'marketplaces.json',
    );
    const projectScope = createHash('sha256')
      .update(projectRegistryPath)
      .digest('hex')
      .slice(0, 16);
    const projectMarketplacePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      '.projects',
      projectScope,
      'test-mp',
    );
    mkdirSync(join(workspacePath, '.allagents'), { recursive: true });
    mkdirSync(projectMarketplacePath, { recursive: true });
    writeFileSync(
      projectRegistryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          'test-mp': {
            name: 'test-mp',
            source: { type: 'github', location: 'owner/project-mp' },
            path: projectMarketplacePath,
            lastUpdated: '2024-02-01T00:00:00.000Z',
          },
        },
      }),
    );
    const updatedAt = new Date('2026-09-17T12:30:00.000Z');

    const results = await updateMarketplace('test-mp', workspacePath, {
      ...marketplaceUpdateDeps(),
      now: () => updatedAt,
    });

    expect(results).toEqual([{ name: 'test-mp', success: true }]);
    const userRegistry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    const projectRegistry = JSON.parse(
      readFileSync(projectRegistryPath, 'utf-8'),
    );
    expect(userRegistry.marketplaces['test-mp'].lastUpdated).toBe(
      '2024-01-01T00:00:00.000Z',
    );
    expect(projectRegistry.marketplaces['test-mp'].lastUpdated).toBe(
      updatedAt.toISOString(),
    );
  });

  it('keeps a missing marketplace directory as a failure without recreating it', async () => {
    rmSync(marketplacePath, { recursive: true, force: true });

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      marketplaceUpdateDeps(),
    );

    expect(results).toEqual([
      {
        name: 'test-mp',
        success: false,
        error: `Marketplace directory not found: ${marketplacePath}`,
      },
    ]);
    expect(simpleGitCalls).toHaveLength(0);
    expect(pullCalls).toHaveLength(0);
  });

  it('skips checkout and pull for a healthy equal remote while advancing its timestamp', async () => {
    const updatedAt = new Date('2026-09-17T13:00:00.000Z');
    const resolveRemoteRevision = mock(async () => ({
      status: 'resolved' as const,
      commit: 'a'.repeat(40),
      ref: 'main',
    }));
    const checkRepositoryHealth = mock(async () => ({
      status: 'healthy' as const,
      head: 'a'.repeat(40),
      ref: 'main',
    }));

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      {
        ...marketplaceUpdateDeps(),
        now: () => updatedAt,
        resolveRemoteRevision,
        checkRepositoryHealth,
      },
      new UpdateContext(),
    );

    expect(results).toEqual([
      { name: 'test-mp', success: true, changed: false },
    ]);
    expect(resolveRemoteRevision).toHaveBeenCalledTimes(1);
    expect(checkRepositoryHealth).toHaveBeenCalledTimes(1);
    expect(simpleGitCalls).toHaveLength(0);
    expect(pullCalls).toHaveLength(0);
    const registry = JSON.parse(
      readFileSync(join(testHome, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(registry.marketplaces['test-mp'].lastUpdated).toBe(
      updatedAt.toISOString(),
    );
  });

  it('shares one remote fact while persisting distinct healthy checkout consumers', async () => {
    const registryPath = join(testHome, '.allagents', 'marketplaces.json');
    const pathA = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'shared-a',
    );
    const pathB = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'shared-b',
    );
    mkdirSync(pathA, { recursive: true });
    mkdirSync(pathB, { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        marketplaces: {
          'shared-a': {
            name: 'shared-a',
            source: { type: 'github', location: 'owner/shared' },
            path: pathA,
            lastUpdated: '2024-01-01T00:00:00.000Z',
          },
          'shared-b': {
            name: 'shared-b',
            source: { type: 'github', location: 'owner/shared' },
            path: pathB,
            lastUpdated: '2024-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const resolveRemoteRevision = mock(async () => ({
      status: 'resolved' as const,
      commit: 'a'.repeat(40),
      ref: 'main',
    }));
    const checkRepositoryHealth = mock(async () => ({
      status: 'healthy' as const,
      head: 'a'.repeat(40),
      ref: 'main',
    }));

    const results = await updateMarketplace(
      undefined,
      undefined,
      {
        ...marketplaceUpdateDeps(),
        now: () => new Date('2026-09-17T14:00:00.000Z'),
        resolveRemoteRevision,
        checkRepositoryHealth,
      },
      new UpdateContext(),
    );

    expect(results).toEqual([
      { name: 'shared-a', success: true, changed: false },
      { name: 'shared-b', success: true, changed: false },
    ]);
    expect(resolveRemoteRevision).toHaveBeenCalledTimes(1);
    expect(checkRepositoryHealth).toHaveBeenCalledTimes(2);
    expect(pullCalls).toHaveLength(0);
    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(registry.marketplaces['shared-a'].lastUpdated).toBe(
      '2026-09-17T14:00:00.000Z',
    );
    expect(registry.marketplaces['shared-b'].lastUpdated).toBe(
      '2026-09-17T14:00:00.000Z',
    );
  });

  it('derives marketplace change from fallback pre and post commits', async () => {
    let head = 'a'.repeat(40);
    currentMockGit = createMockGit({
      raw: async (args) => {
        if (args[0] === 'rev-parse') return head;
        if (args[0] === 'symbolic-ref') return 'origin/main';
        return '';
      },
    });
    const dependencies = marketplaceUpdateDeps();
    dependencies.pull = async (path: string) => {
      pullCalls.push({ path });
      head = 'b'.repeat(40);
    };

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      {
        ...dependencies,
        resolveRemoteRevision: async () => ({
          status: 'resolved' as const,
          commit: 'b'.repeat(40),
          ref: 'main',
        }),
        checkRepositoryHealth: async () => ({
          status: 'unhealthy' as const,
          reason: 'head-mismatch' as const,
          head,
        }),
      },
      new UpdateContext(),
    );

    expect(results).toEqual([
      { name: 'test-mp', success: true, changed: true },
    ]);
    expect(pullCalls).toHaveLength(1);
  });

  it('marks a successful equal fallback unchanged when the remote cannot be resolved', async () => {
    currentMockGit = createMockGit({
      raw: async (args) => {
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (args[0] === 'symbolic-ref') return 'origin/main';
        return '';
      },
    });

    const results = await updateMarketplace(
      'test-mp',
      undefined,
      {
        ...marketplaceUpdateDeps(),
        resolveRemoteRevision: async () => ({
          status: 'unresolved' as const,
          reason: 'failed' as const,
        }),
        checkRepositoryHealth: async () => ({
          status: 'unhealthy' as const,
          reason: 'inspection-failed' as const,
        }),
      },
      new UpdateContext(),
    );

    expect(results).toEqual([
      { name: 'test-mp', success: true, changed: false },
    ]);
    expect(pullCalls).toHaveLength(1);
  });

  it('should use remote show origin to detect master branch when symbolic-ref fails', async () => {
    currentMockGit = createMockGit({
      raw: (args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (args[0] === 'remote' && args[1] === 'show') {
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
      raw: (args: string[]) => {
        if (args[0] === 'symbolic-ref') {
          return Promise.reject(new Error('fatal: ref not found'));
        }
        if (args[0] === 'remote') {
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
