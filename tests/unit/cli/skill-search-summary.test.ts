import { describe, expect, it } from 'bun:test';
import {
  collectSelectedSkillSearchSources,
  formatSkillSearchHint,
  formatSkillSearchSummary,
  shouldUseInteractiveSkillSearch,
  skillSearchSelectionKey,
} from '../../../src/cli/commands/plugin-skills.js';
import type { SkillSearchItem } from '../../../src/core/skill-search.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
  catalogSourceIdentity,
} from '../../../src/core/skill-catalog.js';

function globalItem(path: string, repo: string): SkillSearchItem {
  const name = path.split('/').at(-2) ?? 'skill';
  return {
    name,
    namespace: '',
    repo,
    path,
    description: '',
    sha: `${repo}:${path}`,
    stars: 0,
    installSource: repo,
    installSelector: name,
    installation: { policy: 'repository-install', reasonCodes: [] },
  };
}

function catalogItem(
  sourceId: 'hermes-core' | 'hermes-optional' | 'paperclip-companies',
  options: {
    selector?: string;
    path?: string;
    policy?: SkillSearchItem['installation']['policy'];
  } = {},
): SkillSearchItem {
  const source = RECOMMENDED_SKILL_CATALOG.sources.find(
    (entry) => entry.sourceId === sourceId,
  )!;
  const selector =
    options.selector ??
    (sourceId === 'hermes-core'
      ? 'research/wiki'
      : sourceId === 'hermes-optional'
        ? 'browser'
        : 'company-creator');
  const path =
    options.path ?? `${source.approvedRoot}/${selector}/SKILL.md`;
  const identity = catalogSourceIdentity({
    catalog: 'recommended',
    sourceId,
    effectiveRef: source.effectiveRef,
    approvedRoot: source.approvedRoot,
  });
  return {
    ...globalItem(path, source.repo),
    installSource: source.installSource,
    installSelector: selector,
    installation: {
      policy: options.policy ?? source.installPolicy,
      reasonCodes: [],
    },
    catalog: {
      name: 'recommended',
      label: 'Recommended',
      version: 1,
      identity,
      sourceId,
      classification: source.classification,
      sourceKind: source.sourceKind,
      category: source.category,
      homepage: source.homepage,
      author: source.author,
      spdxLicense: source.spdxLicense,
      warnings: source.warnings,
      discovery: {
        catalogIdentity: identity,
        provider: 'github-code-search',
        repo: source.repo,
        effectiveRef: source.effectiveRef,
        catalogVersion: 1,
        approvedRoot: source.approvedRoot,
        repositoryHeadSha: 'head',
        skillPath: path,
        blobSha: 'blob',
      },
      installDescriptor: catalogInstallDescriptor(source),
    },
  };
}

describe('formatSkillSearchSummary', () => {
  it('uses singular and plural wording with truncation', () => {
    expect(formatSkillSearchSummary(1, 'skill-source-mapping', false)).toBe(
      'Showing 1 skill matching "skill-source-mapping"',
    );
    expect(formatSkillSearchSummary(2, 'mapping', false)).toBe(
      'Showing 2 skills matching "mapping"',
    );
    expect(formatSkillSearchSummary(15, 'mapping', true)).toBe(
      'Showing 15 skills matching "mapping" (truncated)',
    );
  });
});

describe('interactive search mode selection', () => {
  it('keeps JSON and non-TTY no-catalog output on the legacy provider', () => {
    expect(shouldUseInteractiveSkillSearch(true, true, true)).toBe(false);
    expect(shouldUseInteractiveSkillSearch(false, false, true)).toBe(false);
    expect(shouldUseInteractiveSkillSearch(false, true, false)).toBe(false);
    expect(shouldUseInteractiveSkillSearch(false, true, true)).toBe(true);
  });
});

describe('formatSkillSearchHint', () => {
  it('formats stars and descriptions for global results', () => {
    expect(
      formatSkillSearchHint({
        stars: 1,
        description: 'Locate source repositories for AI skills.',
      }),
    ).toBe('★ 1  Locate source repositories for AI skills.');
  });

  it('includes catalog policy and warnings', () => {
    const item = catalogItem('hermes-optional');
    expect(formatSkillSearchHint(item)).toContain('optional');
    expect(formatSkillSearchHint(item)).toContain(
      'Catalog inclusion is not a security review',
    );
  });
});

describe('collectSelectedSkillSearchSources', () => {
  it('groups global selections by normalized install source in result order', () => {
    const items = [
      globalItem(
        'skills/development/pr-search/SKILL.md',
        'WiseTechGlobal/WTG.AI.Prompts',
      ),
      globalItem('skills/pr-search/SKILL.md', 'WiseTechGlobal/PM-Workspaces'),
      globalItem(
        'skills/other-pr-search/SKILL.md',
        'WiseTechGlobal/WTG.AI.Prompts',
      ),
    ];
    const selected = items.map(skillSearchSelectionKey);
    expect(
      collectSelectedSkillSearchSources(items, selected).map(
        (source) => source.installSource,
      ),
    ).toEqual([
      'WiseTechGlobal/WTG.AI.Prompts',
      'WiseTechGlobal/PM-Workspaces',
    ]);
  });

  it('keeps Hermes core and optional identities separate', () => {
    const items = [catalogItem('hermes-core'), catalogItem('hermes-optional')];
    const groups = collectSelectedSkillSearchSources(
      items,
      items.map(skillSearchSelectionKey),
    );
    expect(groups.map((group) => group.catalogIdentity)).toEqual([
      'recommended:hermes-core@main#skills',
      'recommended:hermes-optional@main#optional-skills',
    ]);
    expect(groups.map((group) => group.selectors)).toEqual([
      ['research/wiki'],
      ['browser'],
    ]);
  });

  it('keeps result-specific non-installable policy separate within one source', () => {
    const installable = catalogItem('paperclip-companies', {
      path: 'skills/company-creator/SKILL.md',
    });
    const searchOnly = catalogItem('paperclip-companies', {
      selector: 'template-only',
      path: 'templates/template-only/SKILL.md',
      policy: 'search-only',
    });
    const groups = collectSelectedSkillSearchSources(
      [installable, searchOnly],
      [installable, searchOnly].map(skillSearchSelectionKey),
    );

    expect(groups.map((group) => group.installPolicy)).toEqual([
      'direct-selective',
      'search-only',
    ]);
  });

  it('rejects stale selection keys', () => {
    const item = globalItem('skills/a/SKILL.md', 'org/repo');
    expect(() =>
      collectSelectedSkillSearchSources([item], ['missing']),
    ).toThrow('not present in the current search result');
  });
});
