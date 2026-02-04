import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

describe('plugin install --scope integration', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-scope-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test('user scope: addUserPlugin + syncUserWorkspace installs to home', async () => {
    // Create a local plugin
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: A test\n---\nContent');

    const { addUserPlugin } = await import('../../src/core/user-workspace.js');
    const { syncUserWorkspace } = await import('../../src/core/sync.js');

    const result = await addUserPlugin(pluginDir);
    expect(result.success).toBe(true);

    const syncResult = await syncUserWorkspace();
    expect(syncResult.success).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(true);
  });

  test('project scope: addPlugin auto-creates workspace.yaml when missing', async () => {
    // Create a local plugin so addPlugin has something valid to add
    const pluginDir = join(tempHome, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });

    const { addPlugin } = await import('../../src/core/workspace-modify.js');
    const configPath = join(tempHome, '.allagents', 'workspace.yaml');

    // workspace.yaml should not exist yet
    expect(existsSync(configPath)).toBe(false);

    const result = await addPlugin(pluginDir, tempHome);
    expect(result.success).toBe(true);

    // workspace.yaml should now exist with the plugin added
    expect(existsSync(configPath)).toBe(true);

    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.repositories).toEqual([]);
    expect(config.plugins).toContain(pluginDir);
    expect(config.clients).toEqual(['claude', 'copilot', 'codex', 'opencode']);
  });

  test('user scope uninstall: removeUserPlugin + syncUserWorkspace purges files', async () => {
    // Create a local plugin
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: A test\n---\nContent');

    const { addUserPlugin, removeUserPlugin } = await import('../../src/core/user-workspace.js');
    const { syncUserWorkspace } = await import('../../src/core/sync.js');

    // Install
    await addUserPlugin(pluginDir);
    await syncUserWorkspace();
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(true);

    // Uninstall
    const result = await removeUserPlugin(pluginDir);
    expect(result.success).toBe(true);
    await syncUserWorkspace();
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(false);
  });
});
