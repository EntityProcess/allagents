import { describe, expect, it } from 'bun:test';
import {
  SkillSearchError,
  buildSearchQueries,
  couldBeOwner,
  qualifiedName,
  searchSkills,
  validateSkillSearchArgs,
} from '../../../src/core/skill-search.js';

/**
 * Helper: build a fake `fetch` that dispatches per Code Search query.
 *
 * Each handler is matched by substring against the `q=` querystring value.
 * The first matching handler wins; unmatched queries return an empty page.
 * Pass a single string → returns the canned items for every query (legacy
 * helper, used by tests that don't care about per-query behaviour).
 */
function makeFakeFetch(
  handlers:
    | Array<{
        match: (q: string) => boolean;
        items: Array<{
          path: string;
          sha: string;
          repository: { full_name: string; description?: string };
        }>;
        totalCount?: number;
        incompleteResults?: boolean;
        status?: number;
        message?: string;
      }>
    | Array<{
        path: string;
        sha: string;
        repository: { full_name: string; description?: string };
      }>,
  fallback?: { status: number; message: string },
): typeof fetch {
  // Detect the "single items array, applied to every query" form.
  const isFlat =
    Array.isArray(handlers) &&
    handlers.length > 0 &&
    'path' in (handlers[0] as object);

  const fn = (async (url: string) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') ?? '';

    if (isFlat) {
      const items = handlers as Array<{
        path: string;
        sha: string;
        repository: { full_name: string; description?: string };
      }>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: items.length,
          incomplete_results: false,
          items,
        }),
      };
    }

    const cases = handlers as Array<{
      match: (q: string) => boolean;
      items: Array<{
        path: string;
        sha: string;
        repository: { full_name: string; description?: string };
      }>;
      totalCount?: number;
      incompleteResults?: boolean;
      status?: number;
      message?: string;
    }>;

    for (const handler of cases) {
      if (!handler.match(q)) continue;
      if (handler.status && handler.status >= 400) {
        return {
          ok: false,
          status: handler.status,
          json: async () => ({ message: handler.message ?? '' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total_count: handler.totalCount ?? handler.items.length,
          incomplete_results: handler.incompleteResults ?? false,
          items: handler.items,
        }),
      };
    }

    if (fallback) {
      return {
        ok: false,
        status: fallback.status,
        json: async () => ({ message: fallback.message }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, incomplete_results: false, items: [] }),
    };
  }) as unknown as typeof fetch;
  return fn;
}

const silentLogger = () => {};

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

describe('couldBeOwner', () => {
  it('accepts plain logins', () => {
    expect(couldBeOwner('octocat')).toBe(true);
    expect(couldBeOwner('WiseTechGlobal')).toBe(true);
    expect(couldBeOwner('a')).toBe(true);
  });

  it('accepts logins with internal hyphens', () => {
    expect(couldBeOwner('the-owner')).toBe(true);
  });

  it('rejects logins with leading or trailing hyphens', () => {
    expect(couldBeOwner('-bad')).toBe(false);
    expect(couldBeOwner('bad-')).toBe(false);
  });

  it('rejects logins containing slashes, spaces, or other punctuation', () => {
    expect(couldBeOwner('owner/repo')).toBe(false);
    expect(couldBeOwner('the owner')).toBe(false);
    expect(couldBeOwner('owner.name')).toBe(false);
  });

  it('rejects logins longer than 39 chars', () => {
    expect(couldBeOwner('a'.repeat(40))).toBe(false);
    expect(couldBeOwner('a'.repeat(39))).toBe(true);
  });
});

describe('buildSearchQueries', () => {
  it('emits path (P1) + primary (P4) for a single-word query without owner', () => {
    const queries = buildSearchQueries('cargowise', undefined);
    expect(queries.map((q) => q.label)).toEqual(['path', 'owner', 'primary']);
    const labels = new Map(queries.map((q) => [q.label, q.q]));
    expect(labels.get('path')).toContain('filename:SKILL.md');
    expect(labels.get('path')).toContain('path:cargowise');
    expect(labels.get('primary')).toBe('filename:SKILL.md cargowise');
  });

  it('threads --owner onto path and primary, but skips the query-as-owner (P3) query', () => {
    const queries = buildSearchQueries('cargowise', 'WiseTechGlobal');
    expect(queries.map((q) => q.label)).toEqual(['path', 'primary']);
    expect(queries.find((q) => q.label === 'path')?.q).toBe(
      'filename:SKILL.md path:cargowise user:WiseTechGlobal',
    );
    expect(queries.find((q) => q.label === 'primary')?.q).toBe(
      'filename:SKILL.md cargowise user:WiseTechGlobal',
    );
  });

  it('adds the hyphen (P2) query when the query has spaces', () => {
    const queries = buildSearchQueries('build worker', undefined);
    const path = queries.find((q) => q.label === 'path');
    const hyphen = queries.find((q) => q.label === 'hyphen');
    expect(path?.q).toContain('path:build-worker');
    expect(hyphen?.q).toBe('filename:SKILL.md build-worker');
  });

  it('skips P3 when --owner is explicitly set', () => {
    const queries = buildSearchQueries('cargowise', 'WiseTechGlobal');
    expect(queries.find((q) => q.label === 'owner')).toBeUndefined();
  });

  it('skips P3 when the query is not a valid GitHub login', () => {
    const queries = buildSearchQueries('kynan/commit', undefined);
    expect(queries.find((q) => q.label === 'owner')).toBeUndefined();
  });

  it('includes P3 when no owner is set and the query could be an owner', () => {
    const queries = buildSearchQueries('octocat', undefined);
    const owner = queries.find((q) => q.label === 'owner');
    expect(owner?.q).toBe('filename:SKILL.md user:octocat');
  });

  it('orders queries by priority ascending', () => {
    const queries = buildSearchQueries('build worker', undefined);
    const priorities = queries.map((q) => q.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });
});

describe('searchSkills error mapping', () => {
  it('maps 403 rate-limit on the primary query to a SkillSearchError with kind "rate-limit"', async () => {
    const fakeFetch = makeFakeFetch(
      [
        // Every query returns 403 with rate-limit body.
        { match: () => true, items: [], status: 403, message: 'API rate limit exceeded for ...' },
      ],
    );

    try {
      await searchSkills('docs', {}, { fetch: fakeFetch, logger: silentLogger });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillSearchError);
      expect((error as SkillSearchError).kind).toBe('rate-limit');
      expect((error as SkillSearchError).message).toContain('rate limit');
      expect((error as SkillSearchError).message).toContain('GITHUB_TOKEN');
    }
  });

  it('maps 422 on the primary query to a SkillSearchError with kind "api"', async () => {
    const fakeFetch = makeFakeFetch([
      { match: () => true, items: [], status: 422, message: 'Validation Failed' },
    ]);

    try {
      await searchSkills('docs', {}, { fetch: fakeFetch, logger: silentLogger });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillSearchError);
      expect((error as SkillSearchError).kind).toBe('api');
    }
  });

  it('logs and continues when a non-primary query fails but the primary succeeds', async () => {
    const messages: string[] = [];
    const fakeFetch = makeFakeFetch([
      // Path query (P1) fails with 422.
      {
        match: (q) => q.includes('path:'),
        items: [],
        status: 422,
        message: 'Path query rejected',
      },
      // Owner query (P3) returns nothing.
      {
        match: (q) => q.startsWith('filename:SKILL.md user:'),
        items: [],
      },
      // Primary query succeeds with one hit.
      {
        match: () => true,
        items: [
          {
            path: 'skills/docs-writer/SKILL.md',
            sha: 'p1',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
    ]);

    const result = await searchSkills('docs', {}, {
      fetch: fakeFetch,
      logger: (msg) => messages.push(msg),
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.name).toBe('docs-writer');
    expect(messages.some((m) => m.includes('path') && m.includes('failed'))).toBe(true);
  });

  it('returns normalized items on a successful response (all buckets identical)', async () => {
    const fakeFetch = makeFakeFetch([
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
    ]);

    const result = await searchSkills('docs', { limit: 5 }, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(2);
    expect(result.items.map((i) => i.name)).toContain('docs-writer');
    expect(result.items.map((i) => i.name)).toContain('api-docs');
    for (const item of result.items) {
      expect(item.namespace).toBe('');
    }
  });
});

describe('namespace extraction', () => {
  it('parses skills/<ns>/<name>/SKILL.md into namespace + name', async () => {
    const fakeFetch = makeFakeFetch([
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
    ]);

    const result = await searchSkills('commit', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(2);
    const byKey = new Map(result.items.map((i) => [`${i.namespace}/${i.name}`, i]));
    expect(byKey.has('kynan/commit')).toBe(true);
    expect(byKey.has('will/commit')).toBe(true);
  });

  it('parses non-namespaced skills/<name>/SKILL.md with empty namespace', async () => {
    const fakeFetch = makeFakeFetch([
      {
        path: 'skills/brainstorming/SKILL.md',
        sha: 'cc',
        repository: { full_name: 'obra/superpowers', description: '' },
      },
    ]);

    const result = await searchSkills('brainstorming', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items[0]?.namespace).toBe('');
    expect(result.items[0]?.name).toBe('brainstorming');
  });

  it('parses nested plugin layouts like plugins/foo/skills/<ns>/<name>/SKILL.md', async () => {
    const fakeFetch = makeFakeFetch([
      {
        path: 'plugins/foo/skills/team-a/deploy/SKILL.md',
        sha: 'cc',
        repository: { full_name: 'org/repo', description: '' },
      },
    ]);

    const result = await searchSkills('deploy', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items[0]?.namespace).toBe('team-a');
    expect(result.items[0]?.name).toBe('deploy');
  });
});

describe('multi-query merge + dedup', () => {
  it('returns a path-only hit even when content has no mention of the query (cargowise case)', async () => {
    const fakeFetch = makeFakeFetch([
      // P1 path query: finds CargoWise skill at plugins/cargowise/skills/...
      {
        match: (q) => q.includes('path:cargowise'),
        items: [
          {
            path: 'plugins/cargowise/skills/cw-deploy/SKILL.md',
            sha: 'p1-hit',
            repository: { full_name: 'WiseTechGlobal/skills', description: '' },
          },
        ],
      },
      // P4 primary content: returns nothing because SKILL.md doesn't mention "cargowise"
      { match: () => true, items: [] },
    ]);

    const result = await searchSkills('cargowise', { owner: 'WiseTechGlobal' }, {
      fetch: fakeFetch,
      logger: silentLogger,
    });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.path).toBe('plugins/cargowise/skills/cw-deploy/SKILL.md');
  });

  it('merges in priority order — path (P1) ahead of primary (P4) when both match', async () => {
    const fakeFetch = makeFakeFetch([
      // Path query → only the kynan/commit folder (path contains the literal "kynan/commit").
      {
        match: (q) => q.includes('path:kynan/commit'),
        items: [
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'path-hit',
            repository: { full_name: 'org/skills' },
          },
        ],
      },
      // Primary content query → both folders mention "kynan/commit" in their content.
      {
        match: () => true,
        items: [
          {
            path: 'skills/will/commit-helper/SKILL.md',
            sha: 'content-hit-a',
            repository: { full_name: 'org/skills' },
          },
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'content-hit-b',
            repository: { full_name: 'org/skills' },
          },
        ],
      },
    ]);

    const result = await searchSkills('kynan/commit', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.namespace).toBe('kynan');
    expect(result.items[0]?.name).toBe('commit');
    // Dedup keeps the higher-priority (path) bucket's occurrence.
    expect(result.items[0]?.sha).toBe('path-hit');
    expect(result.items[1]?.name).toBe('commit-helper');
  });

  it('deduplicates hits across buckets by repo + qualifiedName', async () => {
    const fakeFetch = makeFakeFetch([
      // Both buckets return the same skill — should collapse to one.
      {
        match: () => true,
        items: [
          {
            path: 'skills/kynan/commit/SKILL.md',
            sha: 'same',
            repository: { full_name: 'org/skills' },
          },
        ],
      },
    ]);

    const result = await searchSkills('commit', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(1);
  });

  it('keeps same-name skills in different repos as separate hits', async () => {
    const fakeFetch = makeFakeFetch([
      {
        path: 'skills/commit/SKILL.md',
        sha: 'r1',
        repository: { full_name: 'orgA/repo' },
      },
      {
        path: 'skills/commit/SKILL.md',
        sha: 'r2',
        repository: { full_name: 'orgB/repo' },
      },
    ]);

    const result = await searchSkills('commit', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(2);
    expect(new Set(result.items.map((i) => i.repo)).size).toBe(2);
  });

  it('places the hyphen (P2) bucket between path (P1) and primary (P4) for multi-word queries', async () => {
    const fakeFetch = makeFakeFetch([
      // P1 path query (`path:build-worker`) → path-only hit
      {
        match: (q) => q.includes('path:build-worker'),
        items: [
          {
            path: 'plugins/build-worker/skills/run/SKILL.md',
            sha: 'p1',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
      // P2 hyphen content query (`build-worker`) → distinct hit
      {
        match: (q) => q.includes('build-worker') && !q.includes('path:'),
        items: [
          {
            path: 'skills/build-worker-utils/SKILL.md',
            sha: 'p2',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
      // P4 primary content (`build worker` with space) → another distinct hit
      {
        match: (q) => q.includes('build worker'),
        items: [
          {
            path: 'skills/spaced/SKILL.md',
            sha: 'p4',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
    ]);

    const result = await searchSkills('build worker', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.map((i) => i.sha)).toEqual(['p1', 'p2', 'p4']);
  });
});
