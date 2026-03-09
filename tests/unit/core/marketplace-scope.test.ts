import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock git module before importing marketplace (needed for addMarketplace tests)
mock.module('../../../src/core/git.js', () => ({
  cloneTo: mock((url: string, dest: string) => {
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
}));

mock.module('simple-git', () => ({
  default: () => ({
    raw: mock(() => Promise.resolve('')),
    checkout: mock(() => Promise.resolve()),
  }),
}));

import {
  loadRegistryFromPath,
  saveRegistryToPath,
  getProjectRegistryPath,
  loadMergedRegistries,
  listMarketplacesWithScope,
  addMarketplace,
  getRegistryPath,
} from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';

describe('scope-aware registry loading and saving', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `marketplace-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getProjectRegistryPath', () => {
    it('returns correct path under .allagents', () => {
      const result = getProjectRegistryPath('/some/workspace');
      expect(result).toBe(join('/some/workspace', '.allagents', 'marketplaces.json'));
    });
  });

  describe('loadRegistryFromPath', () => {
    it('loads valid registry from file', async () => {
      const registryPath = join(tmpDir, 'marketplaces.json');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'test-marketplace': {
            name: 'test-marketplace',
            source: { type: 'github', location: 'owner/repo' },
            path: '/some/path',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      const loaded = await loadRegistryFromPath(registryPath);
      expect(loaded).toEqual(registry);
    });

    it('returns empty registry for nonexistent path', async () => {
      const loaded = await loadRegistryFromPath(join(tmpDir, 'nonexistent.json'));
      expect(loaded).toEqual({ version: 1, marketplaces: {} });
    });

    it('returns empty registry for invalid JSON', async () => {
      const registryPath = join(tmpDir, 'bad.json');
      writeFileSync(registryPath, 'not valid json {{{');

      const loaded = await loadRegistryFromPath(registryPath);
      expect(loaded).toEqual({ version: 1, marketplaces: {} });
    });
  });

  describe('saveRegistryToPath', () => {
    it('writes registry to specified path and creates parent dirs', async () => {
      const nestedPath = join(tmpDir, 'deep', 'nested', 'dir', 'marketplaces.json');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'my-marketplace': {
            name: 'my-marketplace',
            source: { type: 'local', location: '/local/path' },
            path: '/local/path',
          },
        },
      };

      await saveRegistryToPath(registry, nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
      const content = readFileSync(nestedPath, 'utf-8');
      expect(JSON.parse(content)).toEqual(registry);
      // Verify trailing newline
      expect(content.endsWith('\n')).toBe(true);
    });
  });

  describe('loadMergedRegistries', () => {
    it('merges user and project registries with project taking precedence', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'user-org/shared' },
            path: '/user/shared',
          },
          'user-only': {
            name: 'user-only',
            source: { type: 'github', location: 'user-org/user-only' },
            path: '/user/user-only',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'project-org/shared' },
            path: '/project/shared',
          },
          'project-only': {
            name: 'project-only',
            source: { type: 'local', location: '/project/project-only' },
            path: '/project/project-only',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      // Project wins on shared name
      expect(result.registry.marketplaces['shared'].source.location).toBe('project-org/shared');
      // Both unique entries present
      expect(result.registry.marketplaces['user-only']).toBeDefined();
      expect(result.registry.marketplaces['project-only']).toBeDefined();
      // Overrides list correct
      expect(result.overrides).toEqual(['shared']);
    });

    it('works when project registry does not exist', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'nonexistent.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'user-mp': {
            name: 'user-mp',
            source: { type: 'github', location: 'org/repo' },
            path: '/user/mp',
          },
        },
      };
      writeFileSync(userPath, JSON.stringify(userRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      expect(result.registry.marketplaces['user-mp']).toBeDefined();
      expect(result.overrides).toEqual([]);
    });

    it('works when user registry does not exist', async () => {
      const userPath = join(tmpDir, 'nonexistent.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'project-mp': {
            name: 'project-mp',
            source: { type: 'local', location: '/local/path' },
            path: '/local/path',
          },
        },
      };
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      expect(result.registry.marketplaces['project-mp']).toBeDefined();
      expect(Object.keys(result.registry.marketplaces)).toHaveLength(1);
    });
  });

  describe('listMarketplacesWithScope', () => {
    it('lists entries with correct scope annotations', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'alpha': {
            name: 'alpha',
            source: { type: 'github', location: 'org/alpha' },
            path: '/user/alpha',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'beta': {
            name: 'beta',
            source: { type: 'local', location: '/project/beta' },
            path: '/project/beta',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await listMarketplacesWithScope(userPath, projectPath);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('alpha');
      expect(result[0].scope).toBe('user');
      expect(result[1].name).toBe('beta');
      expect(result[1].scope).toBe('project');
    });

    it('overridden entries show as project scope with project values', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'user-org/shared' },
            path: '/user/shared',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'local', location: '/project/shared' },
            path: '/project/shared',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await listMarketplacesWithScope(userPath, projectPath);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('shared');
      expect(result[0].scope).toBe('project');
      expect(result[0].source.location).toBe('/project/shared');
    });
  });
});

describe('addMarketplace with scope', () => {
  let originalHome: string | undefined;
  let testHome: string;
  let tmpProject: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(tmpdir(), `marketplace-scope-add-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HOME = testHome;
    mkdirSync(join(testHome, '.allagents'), { recursive: true });

    tmpProject = join(tmpdir(), `marketplace-scope-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpProject, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('should add local marketplace to project scope', async () => {
    // Create a local marketplace directory
    const localMarketplace = join(tmpProject, 'my-local-marketplace');
    mkdirSync(localMarketplace, { recursive: true });

    const result = await addMarketplace(localMarketplace, undefined, undefined, {
      scope: 'project',
      workspacePath: tmpProject,
    });

    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('my-local-marketplace');

    // Verify project registry was written
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    expect(existsSync(projectRegistryPath)).toBe(true);
    const projectRegistry = JSON.parse(readFileSync(projectRegistryPath, 'utf-8'));
    expect(projectRegistry.marketplaces['my-local-marketplace']).toBeDefined();

    // Verify user registry was NOT written to
    const userRegistryPath = getRegistryPath();
    expect(existsSync(userRegistryPath)).toBe(false);
  });

  it('should default to user scope when no scope provided', async () => {
    // Create a local marketplace directory
    const localMarketplace = join(testHome, 'default-scope-marketplace');
    mkdirSync(localMarketplace, { recursive: true });

    const result = await addMarketplace(localMarketplace);

    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('default-scope-marketplace');

    // Verify user registry was written
    const userRegistryPath = getRegistryPath();
    expect(existsSync(userRegistryPath)).toBe(true);
    const userRegistry = JSON.parse(readFileSync(userRegistryPath, 'utf-8'));
    expect(userRegistry.marketplaces['default-scope-marketplace']).toBeDefined();
  });
});
