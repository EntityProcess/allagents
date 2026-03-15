import { describe, it, expect, mock } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkillFromUrl } from '../../../src/cli/commands/plugin-skills.js';

describe('resolveSkillFromUrl', () => {
  it('returns null for non-URL skill names', () => {
    expect(resolveSkillFromUrl('my-skill')).toBeNull();
  });

  it('extracts skill name from URL with subpath', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
    );
    expect(result).toEqual({
      skill: 'skill-creator',
      from: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
      parsed: expect.objectContaining({ owner: 'anthropics', repo: 'skills', subpath: 'skills/skill-creator' }),
    });
  });

  it('extracts skill name from URL with deep subpath', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/org/repo/tree/main/plugins/my-plugin/skills/cool-skill',
    );
    expect(result?.skill).toBe('cool-skill');
  });

  it('falls back to repo name for URL without subpath', () => {
    const result = resolveSkillFromUrl('https://github.com/owner/my-skill-repo');
    expect(result).toEqual({
      skill: 'my-skill-repo',
      from: 'https://github.com/owner/my-skill-repo',
      parsed: expect.objectContaining({ owner: 'owner', repo: 'my-skill-repo' }),
    });
  });

  it('works with owner/repo/subpath shorthand', () => {
    const result = resolveSkillFromUrl('anthropics/skills/skills/skill-creator');
    expect(result?.skill).toBe('skill-creator');
    expect(result?.from).toBe('anthropics/skills/skills/skill-creator');
  });

  it('falls back to repo name for gh: shorthand without tree path', () => {
    const result = resolveSkillFromUrl('gh:owner/my-skill-repo');
    expect(result?.skill).toBe('my-skill-repo');
    expect(result?.from).toBe('gh:owner/my-skill-repo');
  });
});

describe('resolveSkillNameFromRepo', () => {
  it('returns frontmatter name when SKILL.md exists with name', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
    try {
      await writeFile(
        join(tmpDir, 'SKILL.md'),
        '---\nname: my-awesome-skill\ndescription: A test skill\n---\n# Skill\n',
      );

      mock.module('../../../src/core/plugin.js', () => ({
        fetchPlugin: async () => ({ success: true, action: 'fetched' as const, cachePath: tmpDir }),
        getPluginName: () => 'test-plugin',
      }));

      const { resolveSkillNameFromRepo } = await import('../../../src/cli/commands/plugin-skills.js');
      const result = await resolveSkillNameFromRepo(
        'https://github.com/owner/repo',
        { owner: 'owner', repo: 'repo' },
        'fallback-name',
      );
      expect(result).toBe('my-awesome-skill');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns fallback name when SKILL.md does not exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
    try {
      mock.module('../../../src/core/plugin.js', () => ({
        fetchPlugin: async () => ({ success: true, action: 'fetched' as const, cachePath: tmpDir }),
        getPluginName: () => 'test-plugin',
      }));

      const { resolveSkillNameFromRepo } = await import('../../../src/cli/commands/plugin-skills.js');
      const result = await resolveSkillNameFromRepo(
        'https://github.com/owner/repo',
        { owner: 'owner', repo: 'repo' },
        'fallback-name',
      );
      expect(result).toBe('fallback-name');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns fallback name when fetchPlugin fails', async () => {
    mock.module('../../../src/core/plugin.js', () => ({
      fetchPlugin: async () => ({ success: false, action: 'skipped' as const, cachePath: '', error: 'network error' }),
      getPluginName: () => 'test-plugin',
    }));

    const { resolveSkillNameFromRepo } = await import('../../../src/cli/commands/plugin-skills.js');
    const result = await resolveSkillNameFromRepo(
      'https://github.com/owner/repo',
      { owner: 'owner', repo: 'repo' },
      'fallback-name',
    );
    expect(result).toBe('fallback-name');
  });
});
