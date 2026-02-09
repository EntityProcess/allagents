import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { syncWorkspace } from '../../src/core/sync.js';
import { getAllSkillsFromPlugins, findSkillByName } from '../../src/core/skills.js';
import { addDisabledSkill, removeDisabledSkill } from '../../src/core/workspace-modify.js';

describe('plugin skills e2e', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-skills-'));
    pluginDir = join(tmpDir, 'test-plugin');

    // Create mock plugin with valid skills
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(join(pluginDir, 'skills/skill-a/SKILL.md'), `---
name: skill-a
description: Test skill A
---
# Skill A
`);
    await writeFile(join(pluginDir, 'skills/skill-b/SKILL.md'), `---
name: skill-b
description: Test skill B
---
# Skill B
`);
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'test-plugin' }));

    // Create workspace
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lists skills from installed plugins', async () => {
    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toContain('skill-a');
    expect(skills.map((s) => s.name)).toContain('skill-b');
    expect(skills.every((s) => s.disabled === false)).toBe(true);
  });

  it('finds skill by name', async () => {
    const matches = await findSkillByName('skill-a', tmpDir);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('skill-a');
    expect(matches[0]?.pluginName).toBe('test-plugin');
  });

  it('disables and enables a skill', async () => {
    // Initial sync
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Disable skill-a
    const disableResult = await addDisabledSkill('test-plugin:skill-a', tmpDir);
    expect(disableResult.success).toBe(true);

    // Sync again - skill-a should be removed
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(false);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Verify skill-a shows as disabled in listing
    const skillsAfterDisable = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skillsAfterDisable.find((s) => s.name === 'skill-a');
    expect(skillA?.disabled).toBe(true);

    // Re-enable skill-a
    const enableResult = await removeDisabledSkill('test-plugin:skill-a', tmpDir);
    expect(enableResult.success).toBe(true);

    // Sync again - skill-a should be restored
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Verify skill-a shows as enabled in listing
    const skillsAfterEnable = await getAllSkillsFromPlugins(tmpDir);
    const skillAEnabled = skillsAfterEnable.find((s) => s.name === 'skill-a');
    expect(skillAEnabled?.disabled).toBe(false);
  });

  it('handles non-existent skill gracefully', async () => {
    const matches = await findSkillByName('non-existent-skill', tmpDir);
    expect(matches).toHaveLength(0);
  });
});
