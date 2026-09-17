import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { stubHomeDir } from '../../helpers/env.js';

// Track clone calls to verify arguments
const cloneCalls: Array<{ url: string; dest: string; ref?: string }> = [];

// Mock the git module
mock.module('../../../src/core/git.js', () => ({
  createGit: () => ({}),
  cloneTo: mock((url: string, dest: string, ref?: string) => {
    cloneCalls.push({ url, dest, ref });
    // Create the directory to simulate clone
    mkdirSync(dest, { recursive: true });
    return Promise.resolve();
  }),
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
  pull: mock(() => Promise.resolve()),
  repoExists: mock(() => Promise.resolve(true)),
  refExists: mock(() => Promise.resolve(true)),
  cloneToTemp: mock((url: string) => {
    const dest = join(tmpdir(), `mock-clone-${Date.now()}`);
    mkdirSync(dest, { recursive: true });
    return Promise.resolve(dest);
  }),
  classifyError: (err: Error) => err,
  cleanupTempDir: mock(() => Promise.resolve()),
  resolveRemoteRevision: mock(() =>
    Promise.resolve({ status: 'unresolved' as const, reason: 'failed' as const }),
  ),
  checkRepositoryHealth: mock(() =>
    Promise.resolve({
      status: 'unhealthy' as const,
      reason: 'inspection-failed' as const,
    }),
  ),
}));

// Mock simple-git for updateMarketplace (it uses simpleGit directly)
mock.module('simple-git', () => ({
  default: () => ({
    raw: mock(() => Promise.resolve('')),
    checkout: mock(() => Promise.resolve()),
  }),
}));

const { addMarketplace, loadRegistry } = await import('../../../src/core/marketplace.js');
const { cloneTo } = await import('../../../src/core/git.js');
const cloneToMock = cloneTo as ReturnType<typeof mock>;

describe('addMarketplace branch support', () => {
  let restoreHomeDir: () => void;
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-add-branch-test-${Date.now()}`);
    restoreHomeDir = stubHomeDir(testHome);
    mkdirSync(join(testHome, '.allagents'), { recursive: true });
    cloneCalls.length = 0;
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(dest, { recursive: true });
        return Promise.resolve();
      },
    );
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  function materializeClone(
    url: string,
    dest: string,
    ref?: string,
  ): Promise<void> {
    cloneCalls.push({ url, dest, ref });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'origin.txt'), url);
    return Promise.resolve();
  }

  it('should error when non-default branch is specified without --name', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('--name is required');
  });

  it('should error when --name matches bare repo name for non-default branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved for the default branch');
  });

  it('fails before cloning when the registry is unreadable', async () => {
    const registryPath = join(testHome, '.allagents', 'marketplaces.json');
    const cachePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'repo',
    );
    writeFileSync(registryPath, '{"version":1,"marketplaces":');

    await expect(addMarketplace('owner/repo')).rejects.toThrow(
      `Marketplace registry at ${registryPath} is unreadable`,
    );

    expect(cloneCalls).toHaveLength(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('preserves concurrent marketplace registrations', async () => {
    let cloneCount = 0;
    let signalBothClones!: () => void;
    const bothClonesReached = new Promise<void>((resolve) => {
      signalBothClones = resolve;
    });
    let releaseClones!: () => void;
    const clonesReleased = new Promise<void>((resolve) => {
      releaseClones = resolve;
    });
    cloneToMock.mockImplementation(
      async (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(dest, { recursive: true });
        cloneCount++;
        if (cloneCount === 2) signalBothClones();
        await clonesReleased;
      },
    );

    const addA = addMarketplace('owner/repo-a', 'repo-a');
    const addB = addMarketplace('owner/repo-b', 'repo-b');
    await bothClonesReached;
    releaseClones();

    const [resultA, resultB] = await Promise.all([addA, addB]);
    const registry = await loadRegistry();

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(Object.keys(registry.marketplaces).sort()).toEqual([
      'repo-a',
      'repo-b',
    ]);
  });

  it('publishes the requested remote source when replacing a managed cache', async () => {
    cloneToMock.mockImplementation(materializeClone);

    await addMarketplace('owner/source-a', 'shared');
    const result = await addMarketplace('owner/source-b', 'shared');
    const registry = await loadRegistry();
    const cachePath = registry.marketplaces.shared.path;

    expect(result.success).toBe(true);
    expect(registry.marketplaces.shared.source.location).toBe('owner/source-b');
    expect(readFileSync(join(cachePath, 'origin.txt'), 'utf-8')).toBe(
      'https://github.com/owner/source-b.git',
    );
    expect(cloneCalls).toHaveLength(2);
  });

  it('publishes a remote cache under its canonical manifest name', async () => {
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(dest, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({ name: 'canonical-name', plugins: [] }),
        );
        writeFileSync(join(dest, 'origin.txt'), url);
        return Promise.resolve();
      },
    );

    const result = await addMarketplace('owner/source-a');
    const registry = await loadRegistry();

    expect(result.success).toBe(true);
    expect(parse(registry.marketplaces['canonical-name'].path).base).toBe(
      'canonical-name',
    );
    expect(
      readFileSync(
        join(registry.marketplaces['canonical-name'].path, 'origin.txt'),
        'utf-8',
      ),
    ).toBe('https://github.com/owner/source-a.git');
  });

  it('preserves the previous remote when replacement cloning fails', async () => {
    cloneToMock.mockImplementation(materializeClone);
    await addMarketplace('owner/source-a', 'shared');
    cloneToMock.mockImplementation(() =>
      Promise.reject(new Error('replacement clone failed')),
    );

    const result = await addMarketplace('owner/source-b', 'shared');
    const registry = await loadRegistry();

    expect(result.success).toBe(false);
    expect(registry.marketplaces.shared.source.location).toBe('owner/source-a');
    expect(
      readFileSync(join(registry.marketplaces.shared.path, 'origin.txt'), 'utf-8'),
    ).toBe('https://github.com/owner/source-a.git');
  });

  it('restores the previous remote when the registry save fails', async () => {
    cloneToMock.mockImplementation(materializeClone);
    await addMarketplace('owner/source-a', 'shared');
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        const clone = materializeClone(url, dest, ref);
        chmodSync(join(testHome, '.allagents'), 0o500);
        return clone;
      },
    );

    try {
      await expect(
        addMarketplace('owner/source-b', 'shared'),
      ).rejects.toThrow();
    } finally {
      chmodSync(join(testHome, '.allagents'), 0o700);
    }

    const registry = await loadRegistry();
    expect(registry.marketplaces.shared.source.location).toBe('owner/source-a');
    expect(
      readFileSync(join(registry.marketplaces.shared.path, 'origin.txt'), 'utf-8'),
    ).toBe('https://github.com/owner/source-a.git');
  });

  it('reports incomplete clone cleanup without masking the clone error', async () => {
    const cacheRoot = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
    );
    cloneToMock.mockImplementation((_url: string, dest: string) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'partial.txt'), 'partial');
      chmodSync(cacheRoot, 0o500);
      return Promise.reject(new Error('replacement clone failed'));
    });

    const result = await addMarketplace(
      'owner/source-b',
      'shared',
    ).finally(() => chmodSync(cacheRoot, 0o700));

    expect(result.success).toBe(false);
    expect(result.error).toContain('replacement clone failed');
    expect(result.warnings?.[0]).toContain('incomplete marketplace clone');
  });

  it('reports a retained backup after a successful replacement', async () => {
    cloneToMock.mockImplementation(materializeClone);
    const first = await addMarketplace('owner/source-a', 'shared');
    chmodSync(first.marketplace!.path, 0o500);

    let backupPath: string | undefined;
    try {
      const result = await addMarketplace('owner/source-b', 'shared');
      const cacheRoot = parse(result.marketplace!.path).dir;
      backupPath = readdirSync(cacheRoot)
        .map((entry) => join(cacheRoot, entry))
        .find((entry) => parse(entry).base.startsWith('.backup-'));

      expect(result.success).toBe(true);
      expect(result.warnings?.[0]).toContain(
        "previous marketplace cache for 'shared'",
      );
      expect(backupPath).toBeDefined();
    } finally {
      if (backupPath && existsSync(backupPath)) {
        chmodSync(backupPath, 0o700);
      }
    }
  });

  it('preserves the previous remote when staged cache publication fails', async () => {
    cloneToMock.mockImplementation(materializeClone);
    await addMarketplace('owner/source-a', 'shared');
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        return Promise.resolve();
      },
    );

    const result = await addMarketplace('owner/source-b', 'shared');
    const registry = await loadRegistry();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to publish marketplace cache');
    expect(registry.marketplaces.shared.source.location).toBe('owner/source-a');
    expect(
      readFileSync(join(registry.marketplaces.shared.path, 'origin.txt'), 'utf-8'),
    ).toBe('https://github.com/owner/source-a.git');
  });

  it('preserves the previous remote when staged validation fails', async () => {
    cloneToMock.mockImplementation(materializeClone);
    await addMarketplace('https://git.example/source-a/repo.git');
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(dest, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({ name: '../../..', plugins: [] }),
        );
        return Promise.resolve();
      },
    );

    const result = await addMarketplace(
      'https://git.example/source-b/repo.git',
    );
    const registry = await loadRegistry();

    expect(result.success).toBe(false);
    expect(registry.marketplaces.repo.source.location).toBe(
      'https://git.example/source-a/repo.git',
    );
    expect(
      readFileSync(join(registry.marketplaces.repo.path, 'origin.txt'), 'utf-8'),
    ).toBe('https://git.example/source-a/repo.git');
  });

  it('should clone with branch when --name is provided', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('repo-v2');
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');

    // Verify cloneTo was called with the correct URL and branch
    const cloneCall = cloneCalls.find((c) => c.url.includes('owner/repo'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.url).toBe('https://github.com/owner/repo.git');
    expect(cloneCall!.ref).toBe('feat/v2');
  });

  it('should store branch in location in registry', async () => {
    await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-v2',
    );
    const registry = await loadRegistry();
    expect(registry.marketplaces['repo-v2'].source.location).toBe('owner/repo/feat/v2');
  });

  it('should accept --branch flag with owner/repo shorthand', async () => {
    const result = await addMarketplace('owner/repo', 'repo-v2', 'feat/v2');
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v2');
  });

  it('should prefer explicit --branch over URL branch', async () => {
    const result = await addMarketplace(
      'https://github.com/owner/repo/tree/feat/v2',
      'repo-override',
      'feat/v3',
    );
    expect(result.success).toBe(true);
    expect(result.marketplace?.source.location).toBe('owner/repo/feat/v3');
  });

  it('should clone without branch when no branch specified', async () => {
    const result = await addMarketplace('https://github.com/owner/repo');
    expect(result.success).toBe(true);

    // Verify cloneTo was called without a branch ref
    const cloneCall = cloneCalls.find((c) => c.url.includes('owner/repo'));
    expect(cloneCall).toBeDefined();
    expect(cloneCall!.ref).toBeUndefined();
  });

  it('should reject a remote marketplace with an unsafe custom name', async () => {
    const result = await addMarketplace('owner/repo', '../../..');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid marketplace name');
    expect(cloneCalls).toHaveLength(0);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should reject a remote marketplace with an unsafe derived name', async () => {
    const result = await addMarketplace('owner/..');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid marketplace name');
    expect(cloneCalls).toHaveLength(0);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should reject marketplace names that alias or special-case Windows paths', async () => {
    for (const name of ['CON', 'repo.', 'repo ', 'bad:name']) {
      const result = await addMarketplace('owner/repo', name);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid marketplace name');
    }

    expect(cloneCalls).toHaveLength(0);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should allow local aliases that are valid registry keys but unsafe remote cache names', async () => {
    const localPath = join(testHome, 'local-marketplace');
    mkdirSync(localPath, { recursive: true });

    for (const alias of ['foo:bar', 'CON']) {
      const result = await addMarketplace(localPath, alias);
      expect(result.success).toBe(true);
      expect(result.marketplace?.name).toBe(alias);
    }

    const registry = await loadRegistry();
    expect(registry.marketplaces['foo:bar']).toBeDefined();
    expect(registry.marketplaces.CON).toBeDefined();
    expect(cloneCalls).toHaveLength(0);
  });

  it('should persist a prototype-named remote alias as an own registry entry', async () => {
    const result = await addMarketplace('owner/repo', '__proto__');

    expect(result.success).toBe(true);
    const registry = await loadRegistry();
    expect(Object.hasOwn(registry.marketplaces, '__proto__')).toBe(true);
    expect(registry.marketplaces['__proto__'].name).toBe('__proto__');
    expect(existsSync(registry.marketplaces['__proto__'].path)).toBe(true);
  });

  it('should allow a platform-valid local manifest name', async () => {
    const localPath = join(testHome, 'local-manifest-marketplace');
    mkdirSync(join(localPath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(localPath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'foo:bar', plugins: [] }),
    );

    const result = await addMarketplace(localPath);

    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('foo:bar');
    expect((await loadRegistry()).marketplaces['foo:bar']).toBeDefined();
    expect(cloneCalls).toHaveLength(0);
  });

  it('should reject ambiguous local aliases', async () => {
    const localPath = join(testHome, 'local-marketplace');
    mkdirSync(localPath, { recursive: true });

    for (const alias of ['.', '..', 'bad/name', 'bad\\name', 'bad\u0001name']) {
      const result = await addMarketplace(localPath, alias);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid marketplace name');
    }

    expect((await loadRegistry()).marketplaces).toEqual({});
    expect(cloneCalls).toHaveLength(0);
  });

  it('should reject broad local roots without modifying them', async () => {
    const markerPath = join(testHome, 'home-marker.txt');
    const homeLink = join(testHome, 'home-link');
    const rootLink = join(testHome, 'root-link');
    writeFileSync(markerPath, 'keep');
    symlinkSync(testHome, homeLink, 'dir');
    symlinkSync(parse(testHome).root, rootLink, 'dir');

    for (const source of [
      testHome,
      parse(testHome).root,
      homeLink,
      rootLink,
    ]) {
      const result = await addMarketplace(source);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'must be a specific directory, not a filesystem root or the user\'s home directory',
      );
    }

    expect(readFileSync(markerPath, 'utf-8')).toBe('keep');
    expect(lstatSync(homeLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(rootLink).isSymbolicLink()).toBe(true);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should reject a symlink at a managed remote cache path', async () => {
    const targetPath = join(testHome, 'user-owned-target');
    const cachePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'repo',
    );
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, 'marker.txt'), 'keep');
    mkdirSync(join(cachePath, '..'), { recursive: true });
    symlinkSync(targetPath, cachePath, 'dir');

    const result = await addMarketplace('owner/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot be a symbolic link');
    expect(lstatSync(cachePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(targetPath, 'marker.txt'), 'utf-8')).toBe('keep');
    expect(cloneCalls).toHaveLength(0);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should reject relocation of only the internal marketplace cache root', async () => {
    const targetPath = join(testHome, 'user-owned-cache-root');
    const marketplaceRoot = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
    );
    mkdirSync(targetPath, { recursive: true });
    writeFileSync(join(targetPath, 'marker.txt'), 'keep');
    mkdirSync(join(marketplaceRoot, '..'), { recursive: true });
    symlinkSync(targetPath, marketplaceRoot, 'dir');

    const result = await addMarketplace('owner/repo');

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'cache root is not a safe AllAgents-owned directory',
    );
    expect(lstatSync(marketplaceRoot).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(targetPath, 'marker.txt'), 'utf-8')).toBe('keep');
    expect(cloneCalls).toHaveLength(0);
    expect((await loadRegistry()).marketplaces).toEqual({});
  });

  it('should remove a newly cloned cache with an unsafe manifest name', async () => {
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(dest, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({ name: '../../..', plugins: [] }),
        );
        return Promise.resolve();
      },
    );

    const result = await addMarketplace('owner/unsafe-manifest');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid marketplace name');
    expect(existsSync(cloneCalls[0].dest)).toBe(false);
  });

  it('preserves a pre-existing cache when the staged manifest is unsafe', async () => {
    const cachePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'unsafe-manifest',
    );
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'marker.txt'), 'keep');
    cloneToMock.mockImplementation(
      (url: string, dest: string, ref?: string) => {
        cloneCalls.push({ url, dest, ref });
        mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
        writeFileSync(
          join(dest, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({ name: '../../..', plugins: [] }),
        );
        return Promise.resolve();
      },
    );

    const result = await addMarketplace('owner/unsafe-manifest');

    expect(result.success).toBe(false);
    expect(readFileSync(join(cachePath, 'marker.txt'), 'utf-8')).toBe('keep');
  });
});
