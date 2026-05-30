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

  // skill-first: bare owner/repo (no selector, no subpath) → auto-install all skills
  it('auto-installs all skills for bare owner/repo with no selector', () => {
    expect(classifySkillAddPositional('ReScienceLab/opc-skills', undefined, false, false)).toEqual({
      shape: 'source-auto',
    });
  });

  it('auto-installs all skills for bare https://github.com/owner/repo with no selector', () => {
    expect(
      classifySkillAddPositional('https://github.com/owner/repo', undefined, false, false),
    ).toEqual({ shape: 'source-auto' });
  });

  it('auto-installs all skills for gh: shorthand with no selector', () => {
    expect(classifySkillAddPositional('gh:owner/repo', undefined, false, false)).toEqual({
      shape: 'source-auto',
    });
  });

  it('falls back to skill-name for owner/repo with subpath (legacy deep-URL form)', () => {
    // Subpath → handled by resolveSkillFromUrl as a specific skill install
    expect(
      classifySkillAddPositional('owner/repo/skills/my-skill', undefined, false, false),
    ).toEqual({ shape: 'skill-name' });
  });

  it('falls back to skill-name for full GitHub URL with subpath (legacy deep-URL form)', () => {
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
