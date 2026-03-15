import { describe, it, expect } from 'bun:test';
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
