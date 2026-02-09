import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { getAllSkillsFromPlugins, type SkillInfo } from '../../../src/core/skills.js';

describe('getAllSkillsFromPlugins', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skills-test-'));
    pluginDir = join(tmpDir, 'test-plugin');

    // Create a mock plugin with skills
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(join(pluginDir, 'skills/skill-a/SKILL.md'), '# Skill A');
    await writeFile(join(pluginDir, 'skills/skill-b/SKILL.md'), '# Skill B');
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'test-plugin' }));

    // Create workspace config
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lists all skills from installed plugins', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toContain('skill-a');
    expect(skills.map((s) => s.name)).toContain('skill-b');
    expect(skills.every((s) => s.pluginName === 'test-plugin')).toBe(true);
    expect(skills.every((s) => s.disabled === false)).toBe(true);
  });

  it('marks disabled skills correctly', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      disabledSkills: ['test-plugin:skill-a'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skills.find((s) => s.name === 'skill-a');
    const skillB = skills.find((s) => s.name === 'skill-b');

    expect(skillA?.disabled).toBe(true);
    expect(skillB?.disabled).toBe(false);
  });
});
