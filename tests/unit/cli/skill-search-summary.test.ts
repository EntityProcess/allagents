import { describe, expect, it } from 'bun:test';
import { formatSkillSearchSummary } from '../../../src/cli/commands/plugin-skills.js';

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
