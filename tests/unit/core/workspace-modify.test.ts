import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

// Mock git module to avoid network calls in verifyGitHubUrlExists
mock.module('../../../src/core/git.js', () => ({
  repoExists: async () => true,
  cloneToTemp: async () => '',
  cloneTo: async () => {},
  pull: async () => {},
  refExists: async () => false,
  cleanupTempDir: async () => {},
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.name = 'GitCloneError';
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
}));

const { updateRepositories, addPlugin } = await import('../../../src/core/workspace-modify.js');

describe('updateRepositories', () => {
  const testDir = join(tmpdir(), `allagents-test-repos-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('removes specified repositories and adds new ones', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\n  - path: ../frontend\n  - path: ../shared\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: ['../frontend'], add: [{ path: '../new-service' }] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([
      { path: '../backend' },
      { path: '../shared' },
      { path: '../new-service' },
    ]);
  });

  test('returns success with no changes when nothing to add or remove', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories({ remove: [], add: [] }, testDir);
    expect(result.success).toBe(true);
  });

  test('handles remove-only operation', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\n  - path: ../frontend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: ['../frontend'], add: [] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([{ path: '../backend' }]);
  });

  test('handles add-only operation', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: [], add: [{ path: '../new-service' }] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([
      { path: '../backend' },
      { path: '../new-service' },
    ]);
  });
});

describe('addPlugin with --force flag', () => {
  let testDir = join(tmpdir(), `allagents-force-test-${Date.now()}`);

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-force-test-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('addPlugin with force replaces existing exact match plugin', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/plugin1'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: add same plugin spec with force=true
    const result = await addPlugin('https://github.com/owner/plugin1', testDir, true);

    // Assert: succeeds with replaced=true
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);

    // Verify: config still has one entry
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(1);
    expect(updated.plugins[0]).toBe('https://github.com/owner/plugin1');
  });

  test('addPlugin with force on first add returns replaced=undefined', async () => {
    const result = await addPlugin('https://github.com/owner/brand-new-plugin', testDir, true);

    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin without force errors on existing exact match', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/plugin1'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: try to add same plugin without force
    const result = await addPlugin('https://github.com/owner/plugin1', testDir, false);

    // Assert: fails with error
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin with force skips semantic duplicate check and adds new entry', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/repo'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: add same repo via different format with force=true
    // (These resolve to the same GitHub identity, so normally semantic duplicate)
    const result = await addPlugin('https://github.com/owner/repo.git', testDir, true);

    // Assert: succeeds with force despite semantic duplicate
    // Note: force skips semantic check but doesn't "replace" semantic duplicates,
    // it just adds the new entry alongside the existing one
    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();

    // Verify: both entries exist (force allowed the semantic duplicate)
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(2);
    expect(updated.plugins).toContain('https://github.com/owner/repo');
    expect(updated.plugins).toContain('https://github.com/owner/repo.git');
  });

  test('addPlugin without force errors on semantic duplicate (same repo, different format)', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/repo'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: try to add same repo via different format without force
    const result = await addPlugin('https://github.com/owner/repo.git', testDir, false);

    // Assert: fails due to semantic duplicate
    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicates');
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin with force replaces and keeps only one entry when multiple plugins exist', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: [
        'https://github.com/owner/plugin1',
        'https://github.com/owner/plugin2',
        'https://github.com/owner/plugin3',
      ],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: replace middle plugin with force
    const result = await addPlugin('https://github.com/owner/plugin2', testDir, true);

    // Assert: succeeds with replaced=true
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);

    // Verify: config has three entries with plugin2 still there
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(3);
    expect(updated.plugins).toContain('https://github.com/owner/plugin2');
  });

  test('addPlugin without force on empty config adds plugin with replaced=undefined', async () => {
    // Config exists but is empty
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: [],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    const result = await addPlugin('https://github.com/owner/new-plugin', testDir, false);

    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();

    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(1);
  });
});
