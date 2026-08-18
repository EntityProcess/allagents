import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

  it('should not delete a pre-existing cache with an unsafe manifest name', async () => {
    const cachePath = join(
      testHome,
      '.allagents',
      'plugins',
      'marketplaces',
      'unsafe-manifest',
    );
    mkdirSync(join(cachePath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(cachePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: '../../..', plugins: [] }),
    );
    writeFileSync(join(cachePath, 'marker.txt'), 'keep');

    const result = await addMarketplace('owner/unsafe-manifest');

    expect(result.success).toBe(false);
    expect(readFileSync(join(cachePath, 'marker.txt'), 'utf-8')).toBe('keep');
  });
});
