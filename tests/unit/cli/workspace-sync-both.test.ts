import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace } from '../../../src/core/workspace.js';
import { addUserPlugin } from '../../../src/core/user-workspace.js';
import { syncUserWorkspace, syncWorkspace } from '../../../src/core/sync.js';

describe('workspace sync both scopes', () => {
  let tempHome: string;
  let tempProject: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-both-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-both-proj-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('syncs user workspace when only user config exists', async () => {
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: A test\n---\nContent');
    await addUserPlugin(pluginDir);

    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(true);

    const projResult = await syncWorkspace(tempProject);
    expect(projResult.success).toBe(false);
  });

  test('syncs both when both configs exist', async () => {
    const userPluginDir = join(tempHome, 'user-plugin');
    const userSkillDir = join(userPluginDir, 'skills', 'user-skill');
    await mkdir(userSkillDir, { recursive: true });
    await writeFile(join(userSkillDir, 'SKILL.md'), '---\nname: user-skill\ndescription: User skill\n---\nContent');
    await addUserPlugin(userPluginDir);

    await initWorkspace(tempProject);
    const projPluginDir = join(tempHome, 'proj-plugin');
    const projSkillDir = join(projPluginDir, 'skills', 'proj-skill');
    await mkdir(projSkillDir, { recursive: true });
    await writeFile(join(projSkillDir, 'SKILL.md'), '---\nname: proj-skill\ndescription: Project skill\n---\nContent');
    const { addPlugin } = await import('../../../src/core/workspace-modify.js');
    await addPlugin(projPluginDir, tempProject);

    const userResult = await syncUserWorkspace();
    expect(userResult.success).toBe(true);
    const projResult = await syncWorkspace(tempProject);
    expect(projResult.success).toBe(true);

    expect(existsSync(join(tempHome, '.claude', 'skills', 'user-skill'))).toBe(true);
    expect(existsSync(join(tempProject, '.claude', 'skills', 'proj-skill'))).toBe(true);
  });
});
