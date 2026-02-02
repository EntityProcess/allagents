import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  test('project scope: addPlugin requires workspace.yaml', async () => {
    const { addPlugin } = await import('../../src/core/workspace-modify.js');
    const result = await addPlugin('/nonexistent-plugin', tempHome);
    expect(result.success).toBe(false);
    expect(result.error).toContain('workspace.yaml');
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
