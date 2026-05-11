import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkillsWithMetadata } from '../../../src/cli/commands/plugin-skills.js';

describe('discoverSkillsWithMetadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-discover-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns skills with descriptions from standard skills/ layout', async () => {
    await mkdir(join(tmpDir, 'skills/alpha'), { recursive: true });
    await mkdir(join(tmpDir, 'skills/beta'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/alpha/SKILL.md'),
      '---\nname: alpha\ndescription: First skill\n---\n# Alpha\n',
    );
    await writeFile(
      join(tmpDir, 'skills/beta/SKILL.md'),
      '---\nname: beta\ndescription: Second skill\n---\n# Beta\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(2);
    const alpha = result.find((s) => s.name === 'alpha');
    const beta = result.find((s) => s.name === 'beta');
    expect(alpha?.description).toBe('First skill');
    expect(beta?.description).toBe('Second skill');
  });

  it('returns skills from flat layout (no skills/ dir)', async () => {
    await mkdir(join(tmpDir, 'gamma'), { recursive: true });
    await writeFile(
      join(tmpDir, 'gamma/SKILL.md'),
      '---\nname: gamma\ndescription: Flat skill\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('gamma');
    expect(result[0]?.description).toBe('Flat skill');
  });

  it('returns empty description when SKILL.md frontmatter is missing description', async () => {
    await mkdir(join(tmpDir, 'skills/delta'), { recursive: true });
    await writeFile(join(tmpDir, 'skills/delta/SKILL.md'), '# Just a heading, no frontmatter\n');

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('delta');
    expect(result[0]?.description).toBe('');
  });

  it('attaches pluginName when provided', async () => {
    await mkdir(join(tmpDir, 'skills/epsilon'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/epsilon/SKILL.md'),
      '---\nname: epsilon\ndescription: Skill in plugin\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir, 'my-plugin');
    expect(result[0]?.pluginName).toBe('my-plugin');
  });

  it('returns an empty array for an empty directory', async () => {
    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toEqual([]);
  });
});
