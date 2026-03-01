import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { updateRepositories } from '../../../src/core/workspace-modify.js';

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
