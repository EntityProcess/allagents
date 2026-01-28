/**
 * Integration tests for duplicate skill handling in the full sync flow.
 *
 * These tests verify that when multiple plugins have skills with the same
 * folder name, the sync correctly disambiguates them based on:
 * 1. No conflict - skill name unchanged
 * 2. Skill conflict with different plugins - {plugin}_{skill} format
 * 3. Skill + plugin conflict with GitHub sources - {org}_{plugin}_{skill} format
 * 4. Skill + plugin conflict with local sources - {hash}_{plugin}_{skill} format
 * 5. Mixed sources (some GitHub, some local) with conflicts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../src/constants.js';
import { getShortId } from '../../src/utils/hash.js';

describe('Skill duplicate handling integration tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-skill-dup-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a plugin with skills
   */
  async function createPlugin(
    pluginPath: string,
    pluginName: string,
    skillNames: string[],
  ): Promise<void> {
    await mkdir(pluginPath, { recursive: true });

    // Create plugin.json
    await writeFile(
      join(pluginPath, 'plugin.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.0.0',
        description: `Test plugin ${pluginName}`,
      }),
    );

    // Create skills
    for (const skillName of skillNames) {
      const skillDir = join(pluginPath, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: ${skillName}
description: Skill ${skillName} from ${pluginName}
---

# ${skillName}

This skill is from ${pluginName}.
`,
      );
    }
  }

  /**
   * Helper to create workspace.yaml
   */
  async function createWorkspaceConfig(plugins: string[]): Promise<void> {
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
${plugins.map((p) => `  - ${p}`).join('\n')}
clients:
  - claude
`,
    );
  }

  /**
   * Helper to get all skill directory names after sync
   */
  async function getSyncedSkills(): Promise<string[]> {
    const skillsDir = join(testDir, '.claude', 'skills');
    if (!existsSync(skillsDir)) {
      return [];
    }
    return readdir(skillsDir);
  }

  describe('Scenario 1: No conflict - skill name unchanged', () => {
    it('should keep original folder names when no skills conflict', async () => {
      // Setup: Two plugins with unique skill names
      await createPlugin(join(testDir, 'plugin-alpha'), 'plugin-alpha', [
        'skill-a',
        'skill-b',
      ]);
      await createPlugin(join(testDir, 'plugin-beta'), 'plugin-beta', [
        'skill-c',
        'skill-d',
      ]);

      await createWorkspaceConfig(['./plugin-alpha', './plugin-beta']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify skills keep original names
      const skills = await getSyncedSkills();
      expect(skills.sort()).toEqual(['skill-a', 'skill-b', 'skill-c', 'skill-d']);
    });

    it('should handle single plugin with multiple unique skills', async () => {
      // Setup: One plugin with multiple skills
      await createPlugin(join(testDir, 'my-plugin'), 'my-plugin', [
        'coding',
        'testing',
        'debugging',
      ]);

      await createWorkspaceConfig(['./my-plugin']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify skills keep original names
      const skills = await getSyncedSkills();
      expect(skills.sort()).toEqual(['coding', 'debugging', 'testing']);
    });
  });

  describe('Scenario 2: Skill conflict with different plugin names - {plugin}_{skill} format', () => {
    it('should qualify skill names with plugin prefix when folder names conflict', async () => {
      // Setup: Two plugins with same skill folder name but different plugin names
      await createPlugin(join(testDir, 'alpha-tools'), 'alpha-tools', ['common-skill']);
      await createPlugin(join(testDir, 'beta-tools'), 'beta-tools', ['common-skill']);

      await createWorkspaceConfig(['./alpha-tools', './beta-tools']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify skills are qualified with plugin name
      const skills = await getSyncedSkills();
      expect(skills.sort()).toEqual(['alpha-tools_common-skill', 'beta-tools_common-skill']);
    });

    it('should only rename conflicting skills, not unique ones', async () => {
      // Setup: Two plugins, one skill conflicts, others unique
      await createPlugin(join(testDir, 'plugin-one'), 'plugin-one', [
        'unique-to-one',
        'shared-skill',
      ]);
      await createPlugin(join(testDir, 'plugin-two'), 'plugin-two', [
        'shared-skill',
        'unique-to-two',
      ]);

      await createWorkspaceConfig(['./plugin-one', './plugin-two']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify: unique skills unchanged, shared skills qualified
      const skills = await getSyncedSkills();
      expect(skills).toContain('unique-to-one');
      expect(skills).toContain('unique-to-two');
      expect(skills).toContain('plugin-one_shared-skill');
      expect(skills).toContain('plugin-two_shared-skill');
      expect(skills).not.toContain('shared-skill'); // Should be qualified
    });

    it('should handle multiple conflicting skills across three plugins', async () => {
      // Setup: Three plugins with overlapping skills
      await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['common', 'special-a']);
      await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['common', 'special-b']);
      await createPlugin(join(testDir, 'plugin-c'), 'plugin-c', ['common', 'special-c']);

      await createWorkspaceConfig(['./plugin-a', './plugin-b', './plugin-c']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify: unique skills unchanged, common skill qualified for all three
      const skills = await getSyncedSkills();
      expect(skills).toContain('special-a');
      expect(skills).toContain('special-b');
      expect(skills).toContain('special-c');
      expect(skills).toContain('plugin-a_common');
      expect(skills).toContain('plugin-b_common');
      expect(skills).toContain('plugin-c_common');
    });
  });

  describe('Scenario 3: Skill + plugin conflict with local sources - {hash}_{plugin}_{skill} format', () => {
    it('should add hash prefix when both skill folder and plugin name conflict (local paths)', async () => {
      // Setup: Two plugins from DIFFERENT local paths with SAME plugin name
      // This simulates having two different versions/forks of the same plugin
      const path1 = join(testDir, 'vendor', 'acme', 'my-plugin');
      const path2 = join(testDir, 'local', 'custom', 'my-plugin');

      await createPlugin(path1, 'my-plugin', ['coding']);
      await createPlugin(path2, 'my-plugin', ['coding']);

      // Workspace config uses relative paths from testDir
      await createWorkspaceConfig(['./vendor/acme/my-plugin', './local/custom/my-plugin']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify: Skills should be prefixed with hash of the source path
      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(2);

      // Both skills should have the pattern: {6-char-hash}_my-plugin_coding
      // The hash is based on the plugin source string
      const hash1 = getShortId('./vendor/acme/my-plugin');
      const hash2 = getShortId('./local/custom/my-plugin');

      expect(skills).toContain(`${hash1}_my-plugin_coding`);
      expect(skills).toContain(`${hash2}_my-plugin_coding`);
    });

    it('should handle multiple skills with full disambiguation', async () => {
      // Setup: Two plugins from different paths, same name, multiple conflicting skills
      const path1 = join(testDir, 'team-a', 'shared-plugin');
      const path2 = join(testDir, 'team-b', 'shared-plugin');

      await createPlugin(path1, 'shared-plugin', ['analyze', 'generate', 'validate']);
      await createPlugin(path2, 'shared-plugin', ['analyze', 'transform', 'validate']);

      await createWorkspaceConfig(['./team-a/shared-plugin', './team-b/shared-plugin']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();

      // Unique skills should keep original names
      expect(skills).toContain('generate');
      expect(skills).toContain('transform');

      // Conflicting skills should have hash prefix
      const hash1 = getShortId('./team-a/shared-plugin');
      const hash2 = getShortId('./team-b/shared-plugin');

      expect(skills).toContain(`${hash1}_shared-plugin_analyze`);
      expect(skills).toContain(`${hash2}_shared-plugin_analyze`);
      expect(skills).toContain(`${hash1}_shared-plugin_validate`);
      expect(skills).toContain(`${hash2}_shared-plugin_validate`);
    });
  });

  describe('Scenario 4: Mixed conflict levels', () => {
    it('should handle mix of no-conflict, plugin-conflict, and full-conflict skills', async () => {
      // Setup:
      // - plugin-unique: has "unique-skill" (no conflict)
      // - plugin-alpha: has "shared-skill" (conflicts with beta, different plugin names)
      // - plugin-beta: has "shared-skill" (conflicts with alpha)
      // - same-name plugins from different paths with "common" skill (full conflict)

      await createPlugin(join(testDir, 'plugin-unique'), 'plugin-unique', ['unique-skill']);
      await createPlugin(join(testDir, 'plugin-alpha'), 'plugin-alpha', ['shared-skill']);
      await createPlugin(join(testDir, 'plugin-beta'), 'plugin-beta', ['shared-skill']);
      await createPlugin(join(testDir, 'path-a', 'forked-plugin'), 'forked-plugin', ['common']);
      await createPlugin(join(testDir, 'path-b', 'forked-plugin'), 'forked-plugin', ['common']);

      await createWorkspaceConfig([
        './plugin-unique',
        './plugin-alpha',
        './plugin-beta',
        './path-a/forked-plugin',
        './path-b/forked-plugin',
      ]);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();

      // No conflict - keeps original name
      expect(skills).toContain('unique-skill');

      // Plugin-level conflict - {plugin}_{skill}
      expect(skills).toContain('plugin-alpha_shared-skill');
      expect(skills).toContain('plugin-beta_shared-skill');

      // Full conflict - {hash}_{plugin}_{skill}
      const hashA = getShortId('./path-a/forked-plugin');
      const hashB = getShortId('./path-b/forked-plugin');
      expect(skills).toContain(`${hashA}_forked-plugin_common`);
      expect(skills).toContain(`${hashB}_forked-plugin_common`);
    });
  });

  describe('Scenario 5: State tracking and purging of renamed skills', () => {
    it('should correctly track renamed skills in sync state', async () => {
      // Setup: Two plugins with conflicting skills
      await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['shared']);
      await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['shared']);

      await createWorkspaceConfig(['./plugin-a', './plugin-b']);

      // First sync
      await syncWorkspace(testDir);

      // Verify state file contains renamed skill paths
      const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
      const stateContent = await readFile(statePath, 'utf-8');
      const state = JSON.parse(stateContent);

      expect(state.files.claude).toContain('.claude/skills/plugin-a_shared/');
      expect(state.files.claude).toContain('.claude/skills/plugin-b_shared/');
    });

    it('should purge renamed skills and revert to original names when conflict resolves', async () => {
      // Setup: Two plugins with conflicting skills
      await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['shared']);
      await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['shared']);

      await createWorkspaceConfig(['./plugin-a', './plugin-b']);

      // First sync - should create qualified names
      await syncWorkspace(testDir);

      let skills = await getSyncedSkills();
      expect(skills).toContain('plugin-a_shared');
      expect(skills).toContain('plugin-b_shared');

      // Remove plugin-b from workspace
      await createWorkspaceConfig(['./plugin-a']);

      // Second sync - conflict resolved, should use original name
      await syncWorkspace(testDir);

      skills = await getSyncedSkills();
      expect(skills).toContain('shared'); // Reverted to original
      expect(skills).not.toContain('plugin-a_shared'); // Old qualified name gone
      expect(skills).not.toContain('plugin-b_shared'); // Removed plugin's skill gone
    });

    it('should handle transition from non-conflicting to conflicting state', async () => {
      // Setup: Start with one plugin
      await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', ['coding']);

      await createWorkspaceConfig(['./plugin-a']);

      // First sync - no conflict
      await syncWorkspace(testDir);

      let skills = await getSyncedSkills();
      expect(skills).toContain('coding');

      // Add second plugin with same skill name
      await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['coding']);
      await createWorkspaceConfig(['./plugin-a', './plugin-b']);

      // Second sync - now has conflict
      await syncWorkspace(testDir);

      skills = await getSyncedSkills();
      expect(skills).not.toContain('coding'); // Original name should be gone
      expect(skills).toContain('plugin-a_coding');
      expect(skills).toContain('plugin-b_coding');
    });
  });

  describe('Scenario 6: Skill content verification', () => {
    it('should preserve skill content when renaming', async () => {
      // Setup: Two plugins with conflicting skill names
      await createPlugin(join(testDir, 'plugin-alpha'), 'plugin-alpha', ['common']);
      await createPlugin(join(testDir, 'plugin-beta'), 'plugin-beta', ['common']);

      // Modify skill content to be unique
      await writeFile(
        join(testDir, 'plugin-alpha', 'skills', 'common', 'SKILL.md'),
        `---
name: common
description: Alpha version
---

# Common Skill

This is the ALPHA version.
`,
      );

      await writeFile(
        join(testDir, 'plugin-beta', 'skills', 'common', 'SKILL.md'),
        `---
name: common
description: Beta version
---

# Common Skill

This is the BETA version.
`,
      );

      await createWorkspaceConfig(['./plugin-alpha', './plugin-beta']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify content is preserved correctly
      const alphaContent = await readFile(
        join(testDir, '.claude', 'skills', 'plugin-alpha_common', 'SKILL.md'),
        'utf-8',
      );
      const betaContent = await readFile(
        join(testDir, '.claude', 'skills', 'plugin-beta_common', 'SKILL.md'),
        'utf-8',
      );

      expect(alphaContent).toContain('ALPHA version');
      expect(betaContent).toContain('BETA version');
    });

    it('should copy all files in skill directory when renaming', async () => {
      // Setup: Plugin with skill containing multiple files
      const pluginDir = join(testDir, 'plugin-alpha');
      const skillDir = join(pluginDir, 'skills', 'complex-skill');

      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'plugin-alpha', version: '1.0.0', description: 'Alpha' }),
      );
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: complex-skill
description: A complex skill
---

# Complex Skill
`,
      );
      await writeFile(join(skillDir, 'helper.py'), '# Helper script');
      await writeFile(join(skillDir, 'config.json'), '{"setting": true}');

      // Second plugin with same skill name
      await createPlugin(join(testDir, 'plugin-beta'), 'plugin-beta', ['complex-skill']);

      await createWorkspaceConfig(['./plugin-alpha', './plugin-beta']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify all files are copied to renamed directory
      const renamedDir = join(testDir, '.claude', 'skills', 'plugin-alpha_complex-skill');
      expect(existsSync(join(renamedDir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(renamedDir, 'helper.py'))).toBe(true);
      expect(existsSync(join(renamedDir, 'config.json'))).toBe(true);
    });
  });

  describe('Scenario 7: Edge cases', () => {
    it('should handle plugins without plugin.json (fallback to directory name)', async () => {
      // Setup: Plugins without plugin.json
      const plugin1Dir = join(testDir, 'tools-alpha');
      const plugin2Dir = join(testDir, 'tools-beta');

      await mkdir(join(plugin1Dir, 'skills', 'shared'), { recursive: true });
      await mkdir(join(plugin2Dir, 'skills', 'shared'), { recursive: true });

      // No plugin.json - should use directory name
      await writeFile(
        join(plugin1Dir, 'skills', 'shared', 'SKILL.md'),
        `---
name: shared
description: Shared from alpha
---`,
      );
      await writeFile(
        join(plugin2Dir, 'skills', 'shared', 'SKILL.md'),
        `---
name: shared
description: Shared from beta
---`,
      );

      await createWorkspaceConfig(['./tools-alpha', './tools-beta']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify skills are qualified with directory name
      const skills = await getSyncedSkills();
      expect(skills).toContain('tools-alpha_shared');
      expect(skills).toContain('tools-beta_shared');
    });

    it('should handle skill names with hyphens correctly', async () => {
      // Setup: Skills with various hyphenated naming conventions
      // Note: Underscores are NOT allowed in skill names per validation rules
      await createPlugin(join(testDir, 'plugin-a'), 'plugin-a', [
        'my-skill',
        'my-other-skill',
        'my-unique-skill',
      ]);
      await createPlugin(join(testDir, 'plugin-b'), 'plugin-b', ['my-skill', 'my-other-skill']);

      await createWorkspaceConfig(['./plugin-a', './plugin-b']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();

      // Unique skill keeps original name
      expect(skills).toContain('my-unique-skill');

      // Conflicting skills are qualified
      expect(skills).toContain('plugin-a_my-skill');
      expect(skills).toContain('plugin-b_my-skill');
      expect(skills).toContain('plugin-a_my-other-skill');
      expect(skills).toContain('plugin-b_my-other-skill');
    });

    it('should handle empty skills directory gracefully', async () => {
      // Setup: Plugin with skills directory but no skills
      const pluginDir = join(testDir, 'empty-plugin');
      await mkdir(join(pluginDir, 'skills'), { recursive: true });
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'empty-plugin', version: '1.0.0', description: 'Empty' }),
      );

      // Another plugin with actual skills
      await createPlugin(join(testDir, 'real-plugin'), 'real-plugin', ['coding']);

      await createWorkspaceConfig(['./empty-plugin', './real-plugin']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      const skills = await getSyncedSkills();
      expect(skills).toContain('coding');
      expect(skills).toHaveLength(1);
    });

    it('should handle plugin with no skills directory', async () => {
      // Setup: Plugin with commands but no skills
      const pluginDir = join(testDir, 'commands-only');
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({ name: 'commands-only', version: '1.0.0', description: 'Commands' }),
      );
      await writeFile(join(pluginDir, 'commands', 'my-command.md'), '# My Command');

      await createWorkspaceConfig(['./commands-only']);

      // Sync
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);

      // Verify command was copied but no skills directory created
      expect(existsSync(join(testDir, '.claude', 'commands', 'my-command.md'))).toBe(true);
      // Skills directory may or may not exist depending on implementation
      const skills = await getSyncedSkills();
      expect(skills).toHaveLength(0);
    });
  });
});
