import { describe, it, expect } from 'bun:test';
import { classifySkillAddPositional } from '../../../src/cli/commands/plugin-skills.js';

describe('classifySkillAddPositional', () => {
  it('returns none when no positional is provided', () => {
    expect(classifySkillAddPositional(undefined, undefined, false, false)).toEqual({ shape: 'none' });
  });

  it('treats a non-source positional as a skill name', () => {
    expect(classifySkillAddPositional('llm-wiki', undefined, false, false)).toEqual({ shape: 'skill-name' });
  });

  it('treats owner/repo + --skill as a source positional', () => {
    expect(classifySkillAddPositional('NousResearch/hermes-agent', 'llm-wiki', false, false)).toEqual({
      shape: 'source',
      skills: ['llm-wiki'],
    });
  });

  it('parses comma-separated --skill values', () => {
    const result = classifySkillAddPositional('owner/repo', 'foo, bar ,baz', false, false);
    expect(result).toEqual({ shape: 'source', skills: ['foo', 'bar', 'baz'] });
  });

  it('treats a full GitHub URL + --list as a source positional', () => {
    expect(
      classifySkillAddPositional('https://github.com/owner/repo', undefined, true, false),
    ).toEqual({ shape: 'source', skills: [] });
  });

  it('treats gh: prefix + --all as a source positional', () => {
    expect(classifySkillAddPositional('gh:owner/repo', undefined, false, true)).toEqual({
      shape: 'source',
      skills: [],
    });
  });

  it('falls back to skill-name for source-shaped positional with no selector (legacy deep-URL form)', () => {
    // `resolveSkillFromUrl` handles URL/owner-repo without selectors as legacy
    expect(
      classifySkillAddPositional(
        'https://github.com/owner/repo/blob/main/skills/foo',
        undefined,
        false,
        false,
      ),
    ).toEqual({ shape: 'skill-name' });
  });
});
