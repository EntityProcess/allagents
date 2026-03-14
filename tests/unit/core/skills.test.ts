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

  it('marks skills correctly in enabledSkills (allowlist) mode', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      enabledSkills: ['test-plugin:skill-a'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skills.find((s) => s.name === 'skill-a');
    const skillB = skills.find((s) => s.name === 'skill-b');

    // skill-a is in the allowlist -> enabled (disabled: false)
    expect(skillA?.disabled).toBe(false);
    // skill-b is NOT in the allowlist -> disabled (disabled: true)
    expect(skillB?.disabled).toBe(true);
  });

  it('discovers root-level SKILL.md with frontmatter name', async () => {
    const rootSkillPlugin = join(tmpDir, 'root-skill-plugin');
    await mkdir(rootSkillPlugin, { recursive: true });
    await writeFile(
      join(rootSkillPlugin, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\n# My Skill',
    );

    const config = {
      repositories: [],
      plugins: [rootSkillPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('my-skill');
    expect(skills[0]!.pluginName).toBe('root-skill-plugin');
    expect(skills[0]!.path).toBe(rootSkillPlugin);
  });

  it('falls back to directory name when root SKILL.md has no frontmatter name', async () => {
    const rootSkillPlugin = join(tmpDir, 'fallback-name-plugin');
    await mkdir(rootSkillPlugin, { recursive: true });
    await writeFile(join(rootSkillPlugin, 'SKILL.md'), '# Just content, no frontmatter');

    const config = {
      repositories: [],
      plugins: [rootSkillPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('fallback-name-plugin');
  });

  it('prefers flat layout over root-level SKILL.md', async () => {
    const mixedPlugin = join(tmpDir, 'mixed-plugin');
    await mkdir(join(mixedPlugin, 'sub-skill'), { recursive: true });
    await writeFile(join(mixedPlugin, 'SKILL.md'), '---\nname: root\ndescription: root\n---\n');
    await writeFile(join(mixedPlugin, 'sub-skill/SKILL.md'), '# Sub skill');

    const config = {
      repositories: [],
      plugins: [mixedPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('sub-skill');
  });
});
