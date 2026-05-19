import { describe, expect, it } from 'bun:test';
import {
  collectSelectedSkillSearchRepos,
  formatSkillSearchHint,
  formatSkillSearchSummary,
} from '../../../src/cli/commands/plugin-skills.js';

describe('formatSkillSearchSummary', () => {
  it('uses singular skill wording for one match', () => {
    expect(formatSkillSearchSummary(1, 'skill-source-mapping', false)).toBe(
      'Showing 1 skill matching "skill-source-mapping"',
    );
  });

  it('uses plural skills wording for multiple matches', () => {
    expect(formatSkillSearchSummary(2, 'mapping', false)).toBe(
      'Showing 2 skills matching "mapping"',
    );
  });

  it('includes truncated marker when applicable', () => {
    expect(formatSkillSearchSummary(15, 'mapping', true)).toBe(
      'Showing 15 skills matching "mapping" (truncated)',
    );
  });
});

describe('formatSkillSearchHint', () => {
  it('includes a space between the star icon and count', () => {
    expect(formatSkillSearchHint({
      stars: 1,
      description: 'Locate source repositories for AI skills.',
    })).toBe('★ 1  Locate source repositories for AI skills.');
  });

  it('omits the star section when the repo has no stars', () => {
    expect(formatSkillSearchHint({
      stars: 0,
      description: 'Locate source repositories for AI skills.',
    })).toBe('Locate source repositories for AI skills.');
  });
});

describe('collectSelectedSkillSearchRepos', () => {
  it('deduplicates repos when multiple selected skills come from the same plugin', () => {
    expect(collectSelectedSkillSearchRepos([
      { path: 'skills/development/pr-search/SKILL.md', repo: 'WiseTechGlobal/WTG.AI.Prompts' },
      { path: 'skills/pr-search/SKILL.md', repo: 'WiseTechGlobal/PM-Workspaces' },
      { path: 'skills/other-pr-search/SKILL.md', repo: 'WiseTechGlobal/WTG.AI.Prompts' },
    ], [
      'skills/development/pr-search/SKILL.md',
      'skills/other-pr-search/SKILL.md',
      'skills/pr-search/SKILL.md',
    ])).toEqual([
      'WiseTechGlobal/WTG.AI.Prompts',
      'WiseTechGlobal/PM-Workspaces',
    ]);
  });

  it('preserves search result order for the selected repos', () => {
    expect(collectSelectedSkillSearchRepos([
      { path: 'skills/a/SKILL.md', repo: 'org/first' },
      { path: 'skills/b/SKILL.md', repo: 'org/second' },
      { path: 'skills/c/SKILL.md', repo: 'org/third' },
    ], [
      'skills/c/SKILL.md',
      'skills/a/SKILL.md',
    ])).toEqual([
      'org/first',
      'org/third',
    ]);
  });
});
