import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';

describe('vscode workspace setup e2e', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-vscode-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('sync generates .code-workspace when vscode client is configured', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    await syncWorkspace(testDir);

    const expectedPath = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(expectedPath)).toBe(true);

    const content = JSON.parse(readFileSync(expectedPath, 'utf-8'));
    expect(content.folders).toHaveLength(2);
    expect(content.folders[0].path).toBe('.');
    expect(content.settings).toEqual({ 'chat.agent.maxRequests': 999 });
  });

  test('sync does not generate .code-workspace when vscode client is absent', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - claude
`,
    );

    await syncWorkspace(testDir);

    const expectedPath = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(expectedPath)).toBe(false);
  });
});
