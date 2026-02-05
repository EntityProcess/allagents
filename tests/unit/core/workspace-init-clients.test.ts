import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { initWorkspace } from '../../../src/core/workspace.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('initWorkspace with clients option', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-init-clients-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should use provided clients instead of template defaults', async () => {
    await initWorkspace(testDir, { clients: ['cursor', 'gemini'] });

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['cursor', 'gemini']);
  });

  it('should use template default clients when no clients option provided', async () => {
    await initWorkspace(testDir);

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    // Default template has: claude, copilot, codex, opencode
    expect(config.clients).toContain('claude');
  });
});
