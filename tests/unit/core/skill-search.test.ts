import { describe, expect, it } from 'bun:test';
import {
  SkillSearchError,
  qualifiedName,
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

describe('qualifiedName', () => {
  it('returns `<namespace>/<name>` when a namespace is set', () => {
    expect(qualifiedName({ namespace: 'kynan', name: 'commit' })).toBe('kynan/commit');
  });

  it('returns just `<name>` when namespace is empty', () => {
    expect(qualifiedName({ namespace: '', name: 'commit' })).toBe('commit');
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
    // Non-namespaced paths get empty namespace strings.
    for (const item of result.items) {
      expect(item.namespace).toBe('');
    }
  });
});

describe('namespace extraction', () => {
  it('parses skills/<ns>/<name>/SKILL.md into namespace + name', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'a1',
            repository: { full_name: 'org/skills', description: '' },
          },
          {
            path: 'skills/will/commit/SKILL.md',
            sha: 'b2',
            repository: { full_name: 'org/skills', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('commit', {}, { fetch: fakeFetch });
    expect(result.items.length).toBe(2);
    const byKey = new Map(result.items.map((i) => [`${i.namespace}/${i.name}`, i]));
    expect(byKey.has('kynan/commit')).toBe(true);
    expect(byKey.has('will/commit')).toBe(true);
    expect(byKey.get('kynan/commit')?.namespace).toBe('kynan');
    expect(byKey.get('kynan/commit')?.name).toBe('commit');
  });

  it('parses non-namespaced skills/<name>/SKILL.md with empty namespace', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            path: 'skills/brainstorming/SKILL.md',
            sha: 'cc',
            repository: { full_name: 'obra/superpowers', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('brainstorming', {}, { fetch: fakeFetch });
    expect(result.items[0]?.namespace).toBe('');
    expect(result.items[0]?.name).toBe('brainstorming');
  });

  it('parses nested plugin layouts like plugins/foo/skills/<ns>/<name>/SKILL.md', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            path: 'plugins/foo/skills/team-a/deploy/SKILL.md',
            sha: 'cc',
            repository: { full_name: 'org/repo', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('deploy', {}, { fetch: fakeFetch });
    expect(result.items[0]?.namespace).toBe('team-a');
    expect(result.items[0]?.name).toBe('deploy');
  });
});

describe('dedup + ranking', () => {
  it('deduplicates hits by repo + qualifiedName', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 3,
        incomplete_results: false,
        items: [
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'first-match',
            repository: { full_name: 'org/skills', description: '' },
          },
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'duplicate-match',
            repository: { full_name: 'org/skills', description: '' },
          },
          {
            path: 'skills/will/commit/SKILL.md',
            sha: 'distinct',
            repository: { full_name: 'org/skills', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('commit', {}, { fetch: fakeFetch });
    expect(result.items.length).toBe(2);
    const qnames = result.items.map((i) => `${i.namespace}/${i.name}`);
    expect(qnames).toContain('kynan/commit');
    expect(qnames).toContain('will/commit');
    // First-occurrence preservation: the surviving kynan/commit entry has the
    // first match's sha.
    const kynan = result.items.find((i) => i.namespace === 'kynan' && i.name === 'commit');
    expect(kynan?.sha).toBe('first-match');
  });

  it('keeps same-name skills in different repos as separate hits', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            path: 'skills/commit/SKILL.md',
            sha: 'r1',
            repository: { full_name: 'orgA/repo', description: '' },
          },
          {
            path: 'skills/commit/SKILL.md',
            sha: 'r2',
            repository: { full_name: 'orgB/repo', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('commit', {}, { fetch: fakeFetch });
    expect(result.items.length).toBe(2);
    expect(new Set(result.items.map((i) => i.repo)).size).toBe(2);
  });

  it('ranks an exact qualified-name match above a substring match', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 2,
        incomplete_results: false,
        items: [
          // Substring match on the bare name.
          {
            path: 'skills/will/commit-helper/SKILL.md',
            sha: 's1',
            repository: { full_name: 'org/skills', description: '' },
          },
          // Exact match on the qualified name.
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 's2',
            repository: { full_name: 'org/skills', description: '' },
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const result = await searchSkills('kynan/commit', {}, { fetch: fakeFetch });
    expect(result.items[0]?.namespace).toBe('kynan');
    expect(result.items[0]?.name).toBe('commit');
  });
});
