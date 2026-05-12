import { describe, expect, it } from 'bun:test';
import {
  SkillSearchError,
  searchSkills,
  validateSkillSearchArgs,
} from '../../../src/core/skill-search.js';

describe('validateSkillSearchArgs', () => {
  it('rejects queries under 2 chars', () => {
    expect(() => validateSkillSearchArgs('a', {})).toThrow(SkillSearchError);
  });

  it('rejects --page < 1', () => {
    expect(() => validateSkillSearchArgs('docs', { page: 0 })).toThrow(SkillSearchError);
  });

  it('rejects --limit < 1 or > 100', () => {
    expect(() => validateSkillSearchArgs('docs', { limit: 0 })).toThrow(SkillSearchError);
    expect(() => validateSkillSearchArgs('docs', { limit: 101 })).toThrow(SkillSearchError);
  });

  it('rejects malformed --owner', () => {
    expect(() => validateSkillSearchArgs('docs', { owner: 'with spaces' })).toThrow(SkillSearchError);
    expect(() => validateSkillSearchArgs('docs', { owner: 'owner/repo' })).toThrow(SkillSearchError);
  });

  it('accepts valid arguments', () => {
    expect(() => validateSkillSearchArgs('docs', { page: 2, limit: 50, owner: 'github' })).not.toThrow();
  });
});

describe('searchSkills error mapping', () => {
  it('maps 403 rate-limit to a SkillSearchError with kind "rate-limit"', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'API rate limit exceeded for ...' }),
    })) as unknown as typeof fetch;

    try {
      await searchSkills('docs', {}, { fetch: fakeFetch });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillSearchError);
      expect((error as SkillSearchError).kind).toBe('rate-limit');
      expect((error as SkillSearchError).message).toContain('rate limit');
      expect((error as SkillSearchError).message).toContain('GITHUB_TOKEN');
    }
  });

  it('maps 422 to a SkillSearchError with kind "api"', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 422,
      json: async () => ({ message: 'Validation Failed' }),
    })) as unknown as typeof fetch;

    try {
      await searchSkills('docs', {}, { fetch: fakeFetch });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillSearchError);
      expect((error as SkillSearchError).kind).toBe('api');
    }
  });

  it('returns normalized items on a successful response', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            path: 'skills/docs-writer/SKILL.md',
            sha: 'abc',
            repository: { full_name: 'org/repo', description: 'Some skills' },
          },
          {
            path: 'skills/api-docs/SKILL.md',
            sha: 'def',
            repository: { full_name: 'org2/repo2', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('docs', { limit: 5 }, { fetch: fakeFetch });
    expect(result.total).toBe(2);
    expect(result.items.length).toBe(2);
    expect(result.items.map((i) => i.name)).toContain('docs-writer');
    expect(result.items.map((i) => i.name)).toContain('api-docs');
  });
});
