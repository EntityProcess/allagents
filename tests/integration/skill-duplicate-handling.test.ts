/**
 * Integration tests for duplicate skill handling in the full sync flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../src/constants.js';
import { getShortId } from '../../src/utils/hash.js';

describe('Skill duplicate handling', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-skill-dup-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPlugin(path: string, name: string, skills: string[]): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
    for (const skill of skills) {
      const skillDir = join(path, 'skills', skill);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Test skill\n---\n# ${skill}`);
    }
  }

  async function createWorkspaceConfig(plugins: string[]): Promise<void> {
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `repositories: []\nplugins:\n${plugins.map((p) => `  - ${p}`).join('\n')}\nclients:\n  - claude`,
    );
  }

  async function getSyncedSkills(): Promise<string[]> {
    const dir = join(testDir, '.claude', 'skills');
    return existsSync(dir) ? readdir(dir) : [];
  }

  it('should keep original names when no conflicts', async () => {
    await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['skill-a']);
    await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['skill-b']);
    await createWorkspaceConfig(['./plugin-a', './plugin-b']);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    expect(skills.sort()).toEqual(['skill-a', 'skill-b']);
  });

  it('should qualify with plugin name when skill folders conflict', async () => {
    await createPlugin(join(testDir, 'alpha'), 'alpha', ['common']);
    await createPlugin(join(testDir, 'beta'), 'beta', ['common']);
    await createWorkspaceConfig(['./alpha', './beta']);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    expect(skills.sort()).toEqual(['alpha_common', 'beta_common']);
  });

  it('should only rename conflicting skills', async () => {
    await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['unique-a', 'shared']);
    await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['shared', 'unique-b']);
    await createWorkspaceConfig(['./plugin-a', './plugin-b']);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    expect(skills).toContain('unique-a');
    expect(skills).toContain('unique-b');
    expect(skills).toContain('plugin-a_shared');
    expect(skills).toContain('plugin-b_shared');
    expect(skills).not.toContain('shared');
  });

  it('should add hash prefix when both skill and plugin names conflict', async () => {
    const path1 = join(testDir, 'vendor', 'my-plugin');
    const path2 = join(testDir, 'local', 'my-plugin');
    await createPlugin(path1, 'my-plugin', ['build']);
    await createPlugin(path2, 'my-plugin', ['build']);
    await createWorkspaceConfig(['./vendor/my-plugin', './local/my-plugin']);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    const hash1 = getShortId('./vendor/my-plugin');
    const hash2 = getShortId('./local/my-plugin');
    expect(skills).toContain(`${hash1}_my-plugin_build`);
    expect(skills).toContain(`${hash2}_my-plugin_build`);
  });

  it('should handle mixed conflict levels', async () => {
    await createPlugin(join(testDir, 'unique-plugin'), 'unique-plugin', ['unique']);
    await createPlugin(join(testDir, 'alpha'), 'alpha', ['shared']);
    await createPlugin(join(testDir, 'beta'), 'beta', ['shared']);
    await createPlugin(join(testDir, 'path-a', 'fork'), 'fork', ['common']);
    await createPlugin(join(testDir, 'path-b', 'fork'), 'fork', ['common']);
    await createWorkspaceConfig([
      './unique-plugin',
      './alpha',
      './beta',
      './path-a/fork',
      './path-b/fork',
    ]);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    expect(skills).toContain('unique'); // no conflict
    expect(skills).toContain('alpha_shared'); // plugin conflict
    expect(skills).toContain('beta_shared');
    const hashA = getShortId('./path-a/fork');
    const hashB = getShortId('./path-b/fork');
    expect(skills).toContain(`${hashA}_fork_common`); // full conflict
    expect(skills).toContain(`${hashB}_fork_common`);
  });

  it('should revert to original name when conflict resolves', async () => {
    await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['coding']);
    await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['coding']);
    await createWorkspaceConfig(['./plugin-a', './plugin-b']);

    await syncWorkspace(testDir);
    let skills = await getSyncedSkills();
    expect(skills).toContain('plugin-a_coding');
    expect(skills).toContain('plugin-b_coding');

    // Remove conflict
    await createWorkspaceConfig(['./plugin-a']);
    await syncWorkspace(testDir);

    skills = await getSyncedSkills();
    expect(skills).toContain('coding');
    expect(skills).not.toContain('plugin-a_coding');
  });

  it('should use directory name when plugin.json is missing', async () => {
    const dir1 = join(testDir, 'tools-alpha');
    const dir2 = join(testDir, 'tools-beta');
    await mkdir(join(dir1, 'skills', 'shared'), { recursive: true });
    await mkdir(join(dir2, 'skills', 'shared'), { recursive: true });
    await writeFile(join(dir1, 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Test\n---');
    await writeFile(join(dir2, 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Test\n---');
    await createWorkspaceConfig(['./tools-alpha', './tools-beta']);

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skills = await getSyncedSkills();
    expect(skills).toContain('tools-alpha_shared');
    expect(skills).toContain('tools-beta_shared');
  });
});
