import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { addRepository, removeRepository, listRepositories } from '../../../src/core/workspace-repo.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('addRepository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'allagents-repo-test-'));
    mkdirSync(join(tmpDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - claude\n',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add a repository with path only', async () => {
    const result = await addRepository('../my-repo', {}, tmpDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(tmpDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0].path).toBe('../my-repo');
  });

  it('should add a repository with all fields', async () => {
    const result = await addRepository('../Glow', {
      source: 'github',
      repo: 'WiseTechGlobal/Glow',
      description: 'Main app',
    }, tmpDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(tmpDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.repositories[0]).toEqual({
      path: '../Glow',
      source: 'github',
      repo: 'WiseTechGlobal/Glow',
      description: 'Main app',
    });
  });

  it('should reject duplicate path', async () => {
    await addRepository('../Glow', {}, tmpDir);
    const result = await addRepository('../Glow', {}, tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });
});

describe('removeRepository', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'allagents-repo-test-'));
    mkdirSync(join(tmpDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ../Glow\n    source: github\n    repo: WiseTechGlobal/Glow\nplugins: []\nclients:\n  - claude\n',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should remove a repository by path', async () => {
    const result = await removeRepository('../Glow', tmpDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(tmpDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.repositories).toHaveLength(0);
  });

  it('should fail if path not found', async () => {
    const result = await removeRepository('../NotExist', tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('listRepositories', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'allagents-repo-test-'));
    mkdirSync(join(tmpDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ../Glow\n    source: github\n    repo: WiseTechGlobal/Glow\n    description: Main app\nplugins: []\nclients:\n  - claude\n',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should list repositories', async () => {
    const repos = await listRepositories(tmpDir);
    expect(repos).toHaveLength(1);
    expect(repos[0].path).toBe('../Glow');
    expect(repos[0].source).toBe('github');
    expect(repos[0].repo).toBe('WiseTechGlobal/Glow');
  });

  it('should return empty array when no config exists', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'allagents-repo-empty-'));
    const repos = await listRepositories(emptyDir);
    expect(repos).toHaveLength(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
