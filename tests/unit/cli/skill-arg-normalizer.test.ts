import { describe, expect, test } from 'bun:test';
import {
  normalizeSkillAlias,
  normalizeSkillArgs,
  normalizeSkillHelpArgs,
} from '../../../src/cli/skill-arg-normalizer.js';

describe('normalizeSkillAlias', () => {
  test('normalizes the plural skills alias', () => {
    expect(normalizeSkillAlias(['skills', 'list'])).toEqual(['skill', 'list']);
  });
});

describe('normalizeSkillHelpArgs', () => {
  test('maps bare hyphenated skill queries to skill search help', () => {
    expect(normalizeSkillHelpArgs(['skill', 'pr-search'])).toEqual(['skill', 'search']);
  });

  test('maps bare split skill queries to skill search help', () => {
    expect(normalizeSkillHelpArgs(['skill', 'pr', 'search'])).toEqual(['skill', 'search']);
  });

  test('keeps single bare words unchanged so typos still fail help lookup', () => {
    expect(normalizeSkillHelpArgs(['skill', 'searh'])).toEqual(['skill', 'searh']);
  });
});

describe('normalizeSkillArgs', () => {
  test('keeps non-skill commands unchanged', () => {
    expect(normalizeSkillArgs(['plugin', 'install', 'foo'])).toEqual(['plugin', 'install', 'foo']);
  });

  test('normalizes the plural skills alias before dispatch', () => {
    expect(normalizeSkillArgs(['skills', 'list'])).toEqual(['skill', 'list']);
  });

  test('rewrites a hyphenated bare skill query to search', () => {
    expect(normalizeSkillArgs(['skill', 'pr-search'])).toEqual(['skill', 'search', 'pr-search']);
  });

  test('rewrites a split multi-word bare skill query to search', () => {
    expect(normalizeSkillArgs(['skill', 'pr', 'search'])).toEqual(['skill', 'search', 'pr', 'search']);
  });

  test('rewrites a quoted multi-word bare skill query to search', () => {
    expect(normalizeSkillArgs(['skill', 'pr search'])).toEqual(['skill', 'search', 'pr search']);
  });

  test('preserves explicit skill subcommands', () => {
    expect(normalizeSkillArgs(['skill', 'search', 'pr-search'])).toEqual(['skill', 'search', 'pr-search']);
  });

  test('keeps a single unknown bare word unchanged', () => {
    expect(normalizeSkillArgs(['skill', 'searh'])).toEqual(['skill', 'searh']);
  });
});
