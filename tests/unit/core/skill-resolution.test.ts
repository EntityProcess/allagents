import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { collectPluginSkills } from '../../../src/core/transform.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('collectPluginSkills', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-skill-collect-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should collect skills from a plugin directory', async () => {
    // Setup: Create a plugin with skills
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(join(pluginDir, 'skills', 'skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills', 'skill-b'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills', 'skill-a', 'SKILL.md'),
      `---
name: skill-a
description: Skill A
---

# Skill A`,
    );
    await writeFile(
      join(pluginDir, 'skills', 'skill-b', 'SKILL.md'),
      `---
name: skill-b
description: Skill B
---

# Skill B`,
    );

    const skills = await collectPluginSkills(pluginDir, 'test-source');

    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.folderName).sort()).toEqual(['skill-a', 'skill-b']);
    expect(skills[0]?.pluginPath).toBe(pluginDir);
    expect(skills[0]?.pluginSource).toBe('test-source');
  });

  it('should return empty array when no skills directory', async () => {
    const pluginDir = join(testDir, 'empty-plugin');
    await mkdir(pluginDir, { recursive: true });

    const skills = await collectPluginSkills(pluginDir, 'test-source');

    expect(skills).toHaveLength(0);
  });

  it('should ignore files in skills directory (only dirs)', async () => {
    const pluginDir = join(testDir, 'plugin-with-files');
    await mkdir(join(pluginDir, 'skills', 'real-skill'), { recursive: true });
    await writeFile(join(pluginDir, 'skills', 'README.md'), '# Skills');
    await writeFile(
      join(pluginDir, 'skills', 'real-skill', 'SKILL.md'),
      `---
name: real-skill
description: Real Skill
---`,
    );

    const skills = await collectPluginSkills(pluginDir, 'test-source');

    expect(skills).toHaveLength(1);
    expect(skills[0]?.folderName).toBe('real-skill');
  });
});

describe('skill name resolution in sync', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-skill-sync-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should use folder names when no conflicts', async () => {
    // Setup: Create a plugin with a skill
    const pluginDir = join(testDir, 'my-plugin');
    const skillDir = join(pluginDir, 'skills', 'unique-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: unique-skill
description: A unique skill
---

# Unique Skill`,
    );

    // Setup: Create workspace config
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./my-plugin
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Skill should be copied with original folder name
    expect(existsSync(join(testDir, '.claude', 'skills', 'unique-skill'))).toBe(true);
  });

  it('should qualify skill names when folder names conflict across plugins', async () => {
    // Setup: Create two plugins with same skill folder name but different plugin names
    const plugin1Dir = join(testDir, 'plugin-alpha');
    const plugin2Dir = join(testDir, 'plugin-beta');

    // Plugin 1 with plugin.json
    await mkdir(join(plugin1Dir, 'skills', 'common-skill'), { recursive: true });
    await writeFile(
      join(plugin1Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-alpha', version: '1.0.0', description: 'Plugin Alpha' }),
    );
    await writeFile(
      join(plugin1Dir, 'skills', 'common-skill', 'SKILL.md'),
      `---
name: common-skill
description: Common skill from alpha
---

# Alpha's Common Skill`,
    );

    // Plugin 2 with plugin.json
    await mkdir(join(plugin2Dir, 'skills', 'common-skill'), { recursive: true });
    await writeFile(
      join(plugin2Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-beta', version: '1.0.0', description: 'Plugin Beta' }),
    );
    await writeFile(
      join(plugin2Dir, 'skills', 'common-skill', 'SKILL.md'),
      `---
name: common-skill
description: Common skill from beta
---

# Beta's Common Skill`,
    );

    // Setup: Create workspace config
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-alpha
  - ./plugin-beta
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Skills should be qualified with plugin name
    const skillsDir = join(testDir, '.claude', 'skills');
    const skills = await readdir(skillsDir);

    expect(skills).toContain('plugin-alpha_common-skill');
    expect(skills).toContain('plugin-beta_common-skill');
  });

  it('should mix renamed and non-renamed skills', async () => {
    // Setup: Create two plugins - one with unique skill, one with common skill
    const plugin1Dir = join(testDir, 'plugin-one');
    const plugin2Dir = join(testDir, 'plugin-two');

    // Plugin 1 with unique and common skill
    await mkdir(join(plugin1Dir, 'skills', 'unique-to-one'), { recursive: true });
    await mkdir(join(plugin1Dir, 'skills', 'shared'), { recursive: true });
    await writeFile(
      join(plugin1Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-one', version: '1.0.0', description: 'Plugin One' }),
    );
    await writeFile(
      join(plugin1Dir, 'skills', 'unique-to-one', 'SKILL.md'),
      `---
name: unique-to-one
description: Unique skill
---`,
    );
    await writeFile(
      join(plugin1Dir, 'skills', 'shared', 'SKILL.md'),
      `---
name: shared
description: Shared skill from one
---`,
    );

    // Plugin 2 with common skill only
    await mkdir(join(plugin2Dir, 'skills', 'shared'), { recursive: true });
    await writeFile(
      join(plugin2Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-two', version: '1.0.0', description: 'Plugin Two' }),
    );
    await writeFile(
      join(plugin2Dir, 'skills', 'shared', 'SKILL.md'),
      `---
name: shared
description: Shared skill from two
---`,
    );

    // Setup: Create workspace config
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-one
  - ./plugin-two
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    const skillsDir = join(testDir, '.claude', 'skills');
    const skills = await readdir(skillsDir);

    // Unique skill should keep original name
    expect(skills).toContain('unique-to-one');

    // Shared skills should be qualified
    expect(skills).toContain('plugin-one_shared');
    expect(skills).toContain('plugin-two_shared');
  });

  it('should track renamed skills in sync state', async () => {
    // Setup: Create a plugin with skill
    const pluginDir = join(testDir, 'my-plugin');
    const skillDir = join(pluginDir, 'skills', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: A skill
---`,
    );

    // Setup: Create workspace config
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./my-plugin
clients:
  - claude
`,
    );

    // First sync
    await syncWorkspace(testDir);

    // Verify state file has correct skill path
    const { readFile } = await import('node:fs/promises');
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const stateContent = await readFile(statePath, 'utf-8');
    const state = JSON.parse(stateContent);

    expect(state.files.claude).toContain('.claude/skills/my-skill/');
  });

  it('should correctly purge renamed skills on second sync', async () => {
    // Setup: Create two plugins with conflicting skills
    const plugin1Dir = join(testDir, 'plugin-alpha');
    const plugin2Dir = join(testDir, 'plugin-beta');

    await mkdir(join(plugin1Dir, 'skills', 'common'), { recursive: true });
    await mkdir(join(plugin2Dir, 'skills', 'common'), { recursive: true });
    await writeFile(
      join(plugin1Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-alpha', version: '1.0.0', description: 'Alpha' }),
    );
    await writeFile(
      join(plugin2Dir, 'plugin.json'),
      JSON.stringify({ name: 'plugin-beta', version: '1.0.0', description: 'Beta' }),
    );
    await writeFile(
      join(plugin1Dir, 'skills', 'common', 'SKILL.md'),
      `---
name: common
description: Common skill
---`,
    );
    await writeFile(
      join(plugin2Dir, 'skills', 'common', 'SKILL.md'),
      `---
name: common
description: Common skill
---`,
    );

    // Setup: Create workspace config with both plugins
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-alpha
  - ./plugin-beta
clients:
  - claude
`,
    );

    // First sync
    await syncWorkspace(testDir);

    // Verify both qualified skills exist
    expect(existsSync(join(testDir, '.claude', 'skills', 'plugin-alpha_common'))).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'plugin-beta_common'))).toBe(true);

    // Remove one plugin
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-alpha
clients:
  - claude
`,
    );

    // Second sync
    await syncWorkspace(testDir);

    // Now only one plugin, so skill should revert to original name
    const skillsDir = join(testDir, '.claude', 'skills');
    const skills = await readdir(skillsDir);

    // Beta's skill should be gone
    expect(skills).not.toContain('plugin-beta_common');
    // Alpha's skill should now be unqualified (no conflict)
    expect(skills).toContain('common');
    expect(skills).not.toContain('plugin-alpha_common');
  });
});
