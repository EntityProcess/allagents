import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

// Mock verifyGitHubUrlExists to avoid network calls
mock.module('../../../src/utils/plugin-path.js', () => {
  const actual = require('../../../src/utils/plugin-path.js');
  return {
    ...actual,
    verifyGitHubUrlExists: async () => ({ exists: true }),
  };
});

const { addPlugin } = await import('../../../src/core/workspace-modify.js');

describe('addPlugin project-scope deduplication', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-dedup-test-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('rejects duplicate GitHub URL with different format', async () => {
    const config: WorkspaceConfig = {
      repositories: [],
      plugins: ['https://github.com/Owner/Repo'],
      clients: ['universal'],
    };
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      dump(config, { lineWidth: -1 }),
    );

    const result = await addPlugin('https://github.com/Owner/Repo.git', testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicates existing entry');
    expect(result.error).toContain('owner/repo');
  });

  test('rejects exact duplicate plugin', async () => {
    const config: WorkspaceConfig = {
      repositories: [],
      plugins: ['https://github.com/Owner/Repo'],
      clients: ['universal'],
    };
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      dump(config, { lineWidth: -1 }),
    );

    const result = await addPlugin('https://github.com/Owner/Repo', testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  test('allows non-duplicate plugins', async () => {
    const config: WorkspaceConfig = {
      repositories: [],
      plugins: ['./local-plugin'],
      clients: ['universal'],
    };
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    writeFileSync(configPath, dump(config, { lineWidth: -1 }));

    mkdirSync(join(testDir, 'another-plugin'), { recursive: true });

    const result = await addPlugin('./another-plugin', testDir);
    expect(result.success).toBe(true);

    const updated = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(updated.plugins).toHaveLength(2);
  });
});
