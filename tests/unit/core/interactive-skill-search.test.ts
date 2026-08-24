import { describe, expect, it } from 'bun:test';
import {
  SkillSearchError,
  searchInteractiveSkills,
  type SkillSearchItem,
  type SkillSearchOptions,
  type SkillSearchResult,
} from '../../../src/core/skill-search.js';

function item(
  repo: string,
  path: string,
  name: string = path.split('/').at(-2) ?? 'skill',
): SkillSearchItem {
  return {
    name,
    namespace: '',
    repo,
    path,
    description: '',
    sha: `${repo}:${path}`,
    stars: 0,
    installSource: repo,
    installSelector: path.replace(/\/SKILL\.md$/, ''),
    installation: { policy: 'repository-install', reasonCodes: [] },
  };
}

function result(query: string, items: SkillSearchItem[]): SkillSearchResult {
  return { query, items, total: items.length, truncated: false };
}

describe('searchInteractiveSkills', () => {
  it('orders Recommended first, lets it win exact duplicates, and retains same-name distinct identities', async () => {
    const recommended = item('Acme/skills', 'skills/testing/SKILL.md', 'testing');
    const duplicate = item('acme/skills', 'skills/testing/SKILL.md', 'testing');
    const sameNameDifferentPath = item(
      'acme/skills',
      'optional-skills/testing/SKILL.md',
      'testing',
    );
    const sameNameDifferentRepo = item(
      'Other/skills',
      'skills/testing/SKILL.md',
      'testing',
    );

    const combined = await searchInteractiveSkills('testing', {}, {
      search: async (_query, options) =>
        options.catalog
          ? result('testing', [recommended])
          : result('testing', [
              duplicate,
              sameNameDifferentPath,
              sameNameDifferentRepo,
            ]),
    });

    expect(combined.sections.map((section) => section.label)).toEqual([
      'Recommended',
      'All GitHub',
    ]);
    expect(combined.sections[0]?.items).toEqual([recommended]);
    expect(combined.sections[1]?.items).toEqual([
      sameNameDifferentPath,
      sameNameDifferentRepo,
    ]);
  });

  it('runs catalog-bounded and global searches concurrently with independent limits', async () => {
    const calls: SkillSearchOptions[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = searchInteractiveSkills('testing', { limit: 7 }, {
      search: async (_query, options) => {
        calls.push(options);
        await blocked;
        return result('testing', []);
      },
    });

    await Promise.resolve();
    expect(calls).toEqual([
      { limit: 7, catalog: 'recommended' },
      { limit: 7 },
    ]);
    release?.();
    await pending;
  });

  it('keeps explicit catalog search strict and Recommended-only', async () => {
    const calls: SkillSearchOptions[] = [];
    const strict = await searchInteractiveSkills(
      'testing',
      { catalog: 'recommended' },
      {
        search: async (_query, options) => {
          calls.push(options);
          return result('testing', []);
        },
      },
    );

    expect(calls).toEqual([{ catalog: 'recommended' }]);
    expect(strict.sections.map((section) => section.label)).toEqual([
      'Recommended',
    ]);
  });

  it('keeps owner-scoped search global-only', async () => {
    const calls: SkillSearchOptions[] = [];
    const scoped = await searchInteractiveSkills(
      'testing',
      { owner: 'acme' },
      {
        search: async (_query, options) => {
          calls.push(options);
          return result('testing', []);
        },
      },
    );

    expect(calls).toEqual([{ owner: 'acme' }]);
    expect(scoped.sections.map((section) => section.label)).toEqual([
      'All GitHub',
    ]);
  });

  it('shows global results and a visible Recommended failure when catalog search fails', async () => {
    const github = item('acme/skills', 'skills/testing/SKILL.md');
    const combined = await searchInteractiveSkills('testing', {}, {
      search: async (_query, options) => {
        if (options.catalog) {
          throw new SkillSearchError('catalog rate limit', 'rate-limit');
        }
        return result('testing', [github]);
      },
    });

    expect(combined.sections[0]?.items).toEqual([]);
    expect(combined.sections[0]?.error).toEqual({
      kind: 'rate-limit',
      message: 'catalog rate limit',
    });
    expect(combined.sections[1]?.items).toEqual([github]);
  });

  it('shows Recommended results and a visible global failure when GitHub search fails', async () => {
    const recommended = item('acme/skills', 'skills/testing/SKILL.md');
    const combined = await searchInteractiveSkills('testing', {}, {
      search: async (_query, options) => {
        if (!options.catalog) throw new SkillSearchError('GitHub down', 'api');
        return result('testing', [recommended]);
      },
    });

    expect(combined.sections[0]?.items).toEqual([recommended]);
    expect(combined.sections[1]?.items).toEqual([]);
    expect(combined.sections[1]?.error).toEqual({
      kind: 'api',
      message: 'GitHub down',
    });
  });

  it('does not broaden explicit catalog failures', async () => {
    let calls = 0;
    await expect(
      searchInteractiveSkills(
        'testing',
        { catalog: 'recommended' },
        {
          search: async () => {
            calls += 1;
            throw new SkillSearchError('catalog unavailable', 'api');
          },
        },
      ),
    ).rejects.toThrow('catalog unavailable');
    expect(calls).toBe(1);
  });
});
