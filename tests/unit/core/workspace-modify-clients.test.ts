import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { setClients } from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('setClients', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-clients-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - claude\n  - copilot\n',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should replace clients list in workspace.yaml', async () => {
    const result = await setClients(['cursor', 'gemini'], testDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['cursor', 'gemini']);
  });

  it('should auto-create workspace.yaml when it does not exist', async () => {
    const emptyDir = join(tmpdir(), `allagents-test-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const result = await setClients(['claude'], emptyDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(emptyDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude']);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
