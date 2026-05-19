import { describe, expect, it } from 'bun:test';
import {
  SkillSearchError,
  buildSearchQueries,
  couldBeOwner,
  qualifiedName,
  resolveGhToken,
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

    // Repo star-fetch calls go to /repos/{owner}/{repo} — return 0 stars by default
    // so existing tests that don't care about stars continue to work unchanged.
    if (u.pathname.startsWith('/repos/') && !u.pathname.includes('/search/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ stargazers_count: 0, full_name: u.pathname.slice('/repos/'.length) }),
      };
    }

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
  it('always emits path (P1) and primary (P4) for a single-word query without owner', () => {
    const queries = buildSearchQueries('cargowise', undefined);
    // cargowise looks like a valid GitHub owner, so P3 is also emitted.
    expect(queries.map((q) => q.label)).toEqual(['path', 'owner', 'primary']);
    const labels = new Map(queries.map((q) => [q.label, q.q]));
    expect(labels.get('path')).toBe('filename:SKILL.md path:cargowise');
    expect(labels.get('primary')).toBe('filename:SKILL.md cargowise');
  });

  it('uses path: qualifier (not in:path) for the path query', () => {
    const queries = buildSearchQueries('cargowise', undefined);
    for (const q of queries) {
      expect(q.q).not.toContain('in:path');
    }
    const pathQuery = queries.find((q) => q.label === 'path');
    expect(pathQuery?.q).toContain('path:cargowise');
  });

  it('threads --owner onto path and primary, but skips the query-as-owner (P3) query', () => {
    const queries = buildSearchQueries('cargowise', 'WiseTechGlobal');
    expect(queries.map((q) => q.label)).toEqual(['path', 'primary']);
    const labels = new Map(queries.map((q) => [q.label, q.q]));
    expect(labels.get('path')).toBe('filename:SKILL.md path:cargowise user:WiseTechGlobal');
    expect(labels.get('primary')).toBe('filename:SKILL.md cargowise user:WiseTechGlobal');
  });

  it('adds the hyphen (P2) query when the query has spaces', () => {
    const queries = buildSearchQueries('build worker', undefined);
    const hyphen = queries.find((q) => q.label === 'hyphen');
    expect(hyphen?.q).toBe('filename:SKILL.md build-worker');
    expect(queries.find((q) => q.label === 'primary')?.q).toBe('filename:SKILL.md build worker');
    // Path query uses hyphenated form too.
    expect(queries.find((q) => q.label === 'path')?.q).toBe('filename:SKILL.md path:build-worker');
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
      // Owner query (P3) fails with 422.
      {
        match: (q) => q.startsWith('filename:SKILL.md user:'),
        items: [],
        status: 422,
        message: 'Owner query rejected',
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
    expect(messages.some((m) => m.includes('owner') && m.includes('failed'))).toBe(true);
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

describe('searchSkills description enrichment', () => {
  it('prefers SKILL.md frontmatter description over the repository description', async () => {
    const fakeFetch = (async (url: string) => {
      const u = new URL(url);

      if (u.pathname === '/search/code') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                path: 'plugins/wzg/skills/skill-source-mapping/SKILL.md',
                sha: 'blob-sha',
                repository: {
                  full_name: 'WiseTechGlobal/WZG.Playbook.Content',
                  description: 'Walter Zhang\'s personal engineering playbook',
                },
              },
            ],
          }),
        };
      }

      if (u.pathname === '/repos/WiseTechGlobal/WZG.Playbook.Content') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ stargazers_count: 1 }),
        };
      }

      if (u.pathname === '/repos/WiseTechGlobal/WZG.Playbook.Content/git/blobs/blob-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from(
              '---\nname: skill-source-mapping\ndescription: Locate source repositories for AI skills.\n---\n',
            ).toString('base64'),
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchSkills(
      'skill-source-mapping',
      {},
      { fetch: fakeFetch, logger: silentLogger },
    );

    expect(result.items[0]?.description).toBe('Locate source repositories for AI skills.');
  });

  it('falls back to the repository description when SKILL.md metadata cannot be parsed', async () => {
    const fakeFetch = (async (url: string) => {
      const u = new URL(url);

      if (u.pathname === '/search/code') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                path: 'skills/docs-writer/SKILL.md',
                sha: 'blob-sha',
                repository: {
                  full_name: 'org/repo',
                  description: 'Repository description fallback',
                },
              },
            ],
          }),
        };
      }

      if (u.pathname === '/repos/org/repo') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ stargazers_count: 0 }),
        };
      }

      if (u.pathname === '/repos/org/repo/git/blobs/blob-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('# No frontmatter here\n').toString('base64'),
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchSkills('docs', {}, { fetch: fakeFetch, logger: silentLogger });

    expect(result.items[0]?.description).toBe('Repository description fallback');
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

  it('extracts namespace from segment before `skills` for plugins/<ns>/skills/<name>/SKILL.md', async () => {
    // This is the WTG.AI.Prompts layout: plugins/cargowise/skills/cw-deploy/SKILL.md
    // where `cargowise` is the plugin namespace, not a namespace inside `skills`.
    const fakeFetch = makeFakeFetch([
      {
        path: 'plugins/cargowise/skills/cw-deploy/SKILL.md',
        sha: 'cw',
        repository: { full_name: 'WiseTechGlobal/WTG.AI.Prompts', description: '' },
      },
    ]);

    const result = await searchSkills('cw-deploy', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items[0]?.namespace).toBe('cargowise');
    expect(result.items[0]?.name).toBe('cw-deploy');
  });

  it('does not use hidden output dir name as namespace for .agents/skills/<name>/SKILL.md', async () => {
    const fakeFetch = makeFakeFetch([
      {
        path: 'plugins/cargowise/skills/cw-deploy/SKILL.md',
        sha: 'cw',
        repository: { full_name: 'WiseTechGlobal/WTG.AI.Prompts', description: '' },
      },
      // Workspace-synced copy — should be filtered out entirely.
      {
        path: '.agents/skills/cw-deploy/SKILL.md',
        sha: 'ws',
        repository: { full_name: 'WiseTechGlobal/SomeWorkspace', description: '' },
      },
    ]);

    const result = await searchSkills('cw-deploy', {}, { fetch: fakeFetch, logger: silentLogger });
    // The workspace repo entry must be filtered out.
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.repo).toBe('WiseTechGlobal/WTG.AI.Prompts');
    expect(result.items[0]?.namespace).toBe('cargowise');
  });

  it('filters out .copilot/skills/ paths (workspace-synced output dirs)', async () => {
    const fakeFetch = makeFakeFetch([
      {
        path: '.copilot/skills/cw-deploy/SKILL.md',
        sha: 'cp',
        repository: { full_name: 'WiseTechGlobal/SomeWorkspace', description: '' },
      },
    ]);

    const result = await searchSkills('cw-deploy', {}, { fetch: fakeFetch, logger: silentLogger });
    expect(result.items.length).toBe(0);
  });
});

describe('multi-query merge + dedup', () => {
  it('deduplicates hits across buckets by repo + qualifiedName', async () => {
    const fakeFetch = makeFakeFetch([
      // Both buckets (primary + hyphen) return the same skill — should collapse to one.
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

  it('merges path (P1) and primary (P4) buckets for multi-word queries', async () => {
    const fakeFetch = makeFakeFetch([
      // P4 primary content query (`build worker` with space) → unique hit
      {
        match: (q) => q.includes('build worker'),
        items: [
          {
            path: 'skills/spaced/SKILL.md',
            sha: 'primary-sha',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
      // P1 path + P2 hyphen both match `build-worker` → same distinct hit; path wins dedup
      {
        match: (q) => q.includes('build-worker'),
        items: [
          {
            path: 'skills/build-worker-utils/SKILL.md',
            sha: 'path-sha',
            repository: { full_name: 'org/repo' },
          },
        ],
      },
    ]);

    const result = await searchSkills('build worker', {}, { fetch: fakeFetch, logger: silentLogger });
    // The path hit survives because it matches the query in the skill name.
    // The broad primary hit is filtered out after relevance enrichment.
    expect(result.items.map((i) => i.sha)).toEqual(['path-sha']);
  });
});

describe('search relevance', () => {
  it('filters noisy broad matches that do not mention the query after enrichment', async () => {
    const fakeFetch = (async (url: string) => {
      const u = new URL(url);

      if (u.pathname === '/search/code') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 3,
            incomplete_results: false,
            items: [
              {
                path: 'skills/docs-writer/SKILL.md',
                sha: 'docs-sha',
                repository: { full_name: 'org/docs-skill', description: 'General repo' },
              },
              {
                path: 'SKILL.md',
                sha: 'noise-sha',
                repository: { full_name: 'org/noise-repo', description: 'General repo' },
              },
              {
                path: 'skills/api-docs/SKILL.md',
                sha: 'api-sha',
                repository: { full_name: 'org/api-repo', description: 'General repo' },
              },
            ],
          }),
        };
      }

      if (u.pathname === '/repos/org/docs-skill') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 1 }) };
      }
      if (u.pathname === '/repos/org/noise-repo') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 5000 }) };
      }
      if (u.pathname === '/repos/org/api-repo') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 2 }) };
      }

      if (u.pathname === '/repos/org/docs-skill/git/blobs/docs-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: docs-writer\ndescription: Write docs for developer workflows.\n---\n').toString('base64'),
          }),
        };
      }
      if (u.pathname === '/repos/org/noise-repo/git/blobs/noise-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: paper\ndescription: Completely unrelated writing helper.\n---\n').toString('base64'),
          }),
        };
      }
      if (u.pathname === '/repos/org/api-repo/git/blobs/api-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: api-docs\ndescription: Generate API docs from code.\n---\n').toString('base64'),
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchSkills('docs', {}, { fetch: fakeFetch, logger: silentLogger });

    expect(result.items.map((item) => item.name)).toEqual(['api-docs', 'docs-writer']);
  });

  it('ranks exact and partial name matches ahead of description-only matches even with fewer stars', async () => {
    const fakeFetch = (async (url: string) => {
      const u = new URL(url);

      if (u.pathname === '/search/code') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            total_count: 3,
            incomplete_results: false,
            items: [
              {
                path: 'skills/terraform/SKILL.md',
                sha: 'exact-sha',
                repository: { full_name: 'org/exact', description: '' },
              },
              {
                path: 'skills/terraform-plan/SKILL.md',
                sha: 'partial-sha',
                repository: { full_name: 'org/partial', description: '' },
              },
              {
                path: 'skills/iac-helper/SKILL.md',
                sha: 'desc-sha',
                repository: { full_name: 'org/desc', description: '' },
              },
            ],
          }),
        };
      }

      if (u.pathname === '/repos/org/exact') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 1 }) };
      }
      if (u.pathname === '/repos/org/partial') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 10 }) };
      }
      if (u.pathname === '/repos/org/desc') {
        return { ok: true, status: 200, json: async () => ({ stargazers_count: 900 }) };
      }

      if (u.pathname === '/repos/org/exact/git/blobs/exact-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: terraform\ndescription: Core Terraform skill.\n---\n').toString('base64'),
          }),
        };
      }
      if (u.pathname === '/repos/org/partial/git/blobs/partial-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: terraform-plan\ndescription: Plan Terraform changes safely.\n---\n').toString('base64'),
          }),
        };
      }
      if (u.pathname === '/repos/org/desc/git/blobs/desc-sha') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: 'base64',
            content: Buffer.from('---\nname: iac-helper\ndescription: Review terraform changes and summarize impact.\n---\n').toString('base64'),
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    const result = await searchSkills('terraform', {}, { fetch: fakeFetch, logger: silentLogger });

    expect(result.items.map((item) => item.name)).toEqual([
      'terraform',
      'terraform-plan',
      'iac-helper',
    ]);
  });
});

describe('token resolution', () => {
  it('sends Authorization header from injected tokenResolver', async () => {
    let capturedAuth: string | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await searchSkills('docs', {}, {
      fetch: capturingFetch,
      logger: silentLogger,
      tokenResolver: async () => 'test-token-xyz',
    });

    expect(capturedAuth).toBe('token test-token-xyz');
  });

  it('omits Authorization header when tokenResolver returns undefined', async () => {
    let capturedAuth: string | undefined;
    const capturingFetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await searchSkills('docs', {}, {
      fetch: capturingFetch,
      logger: silentLogger,
      tokenResolver: async () => undefined,
    });

    expect(capturedAuth).toBeUndefined();
  });
});

describe('resolveGhToken', () => {
  it('returns GITHUB_TOKEN env var when set', async () => {
    const orig = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_fromenv';
    try {
      expect(await resolveGhToken()).toBe('ghp_fromenv');
    } finally {
      if (orig === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = orig;
    }
  });

  it('returns GH_TOKEN env var when GITHUB_TOKEN is absent', async () => {
    const origG = process.env.GITHUB_TOKEN;
    const origGH = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'ghp_fromgh';
    try {
      expect(await resolveGhToken()).toBe('ghp_fromgh');
    } finally {
      if (origG === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = origG;
      if (origGH === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = origGH;
    }
  });
});

describe('searchSkills 401 error', () => {
  it('maps 401 on the primary query to a SkillSearchError with kind "api"', async () => {
    const fakeFetch = makeFakeFetch([
      { match: () => true, items: [], status: 401, message: 'Requires authentication' },
    ]);

    try {
      await searchSkills('docs', {}, { fetch: fakeFetch, logger: silentLogger, tokenResolver: async () => undefined });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SkillSearchError);
      expect((error as SkillSearchError).kind).toBe('api');
      expect((error as SkillSearchError).message).toContain('gh auth login');
    }
  });
});
