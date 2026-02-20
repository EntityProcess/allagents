import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

async function createPlugin(baseDir: string, name: string, skillName: string): Promise<string> {
  const pluginDir = join(baseDir, name);
  const skillDir = join(pluginDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: ${skillName}
description: ${skillName} description
---
`,
    'utf-8',
  );
  return pluginDir;
}

describe('syncWorkspace - plugin-level clients', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-plugin-clients-'));
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('uses plugin-level clients override instead of workspace clients', async () => {
    await createPlugin(testDir, 'override-plugin', 'override-skill');

    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./override-plugin
    clients:
      - claude
clients:
  - claude
  - copilot
`,
      'utf-8',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'override-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'override-skill'))).toBe(false);
  });

  it('falls back to workspace clients when plugin-level clients are not set', async () => {
    await createPlugin(testDir, 'fallback-plugin', 'fallback-skill');

    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./fallback-plugin
clients:
  - claude
  - copilot
`,
      'utf-8',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'fallback-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'fallback-skill'))).toBe(true);
  });

  it('partial sync ignores plugins that do not target the selected client', async () => {
    await createPlugin(testDir, 'copilot-plugin', 'copilot-skill');

    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./missing-claude-plugin
    clients:
      - claude
  - source: ./copilot-plugin
    clients:
      - copilot
clients:
  - claude
  - copilot
`,
      'utf-8',
    );

    const result = await syncWorkspace(testDir, { clients: ['copilot'] });
    expect(result.success).toBe(true);
    expect(result.totalFailed).toBe(0);
    expect(existsSync(join(testDir, '.github', 'skills', 'copilot-skill'))).toBe(true);
  });

  it('tracks plugin-level-only client in sync state and allows partial sync for it', async () => {
    await createPlugin(testDir, 'codex-plugin', 'codex-skill');

    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./codex-plugin
    clients:
      - codex
clients:
  - claude
syncMode: copy
`,
      'utf-8',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'codex-skill'))).toBe(true);

    const stateContent = await readFile(
      join(testDir, CONFIG_DIR, 'sync-state.json'),
      'utf-8',
    );
    const state = JSON.parse(stateContent) as { files: Record<string, string[]> };
    expect(state.files.codex).toBeDefined();
    expect(state.files.codex?.length).toBeGreaterThan(0);

    const partial = await syncWorkspace(testDir, { clients: ['codex'] });
    expect(partial.success).toBe(true);
    expect(partial.totalFailed).toBe(0);
  });
});
