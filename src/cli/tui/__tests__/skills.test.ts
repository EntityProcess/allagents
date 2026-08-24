import { describe, expect, it } from 'bun:test';
import {
  collectSelectedSkillSearchSources,
  skillSearchSelectionKey,
} from '../../commands/plugin-skills.js';
import { buildOnlineSkillSearchOptions } from '../actions/skills.js';
import { findSkillSearchSelection } from '../../skill-search-presentation.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
  catalogSourceIdentity,
} from '../../../core/skill-catalog.js';
import type {
  InteractiveSkillSearchResult,
  SkillSearchItem,
} from '../../../core/skill-search.js';

function globalItem(repo: string, path: string): SkillSearchItem {
  const name = path.split('/').at(-2) ?? 'skill';
  return {
    name,
    namespace: '',
    repo,
    path,
    description: `${name} description`,
    sha: `${repo}:${path}`,
    stars: 0,
    installSource: repo,
    installSelector: name,
    installation: { policy: 'repository-install', reasonCodes: [] },
  };
}

function recommendedItem(): SkillSearchItem {
  const source = RECOMMENDED_SKILL_CATALOG.sources.find(
    (entry) => entry.sourceId === 'hermes-core',
  );
  if (!source) {
    throw new Error(
      'Missing hermes-core source in the recommended catalog fixture.',
    );
  }
  const path = 'skills/research/wiki/SKILL.md';
  const identity = catalogSourceIdentity({
    catalog: 'recommended',
    sourceId: source.sourceId,
    effectiveRef: source.effectiveRef,
    approvedRoot: source.approvedRoot,
  });
  return {
    ...globalItem(source.repo, path),
    name: 'wiki',
    namespace: 'research',
    installSource: source.installSource,
    installSelector: 'research/wiki',
    installation: { policy: source.installPolicy, reasonCodes: [] },
    catalog: {
      name: 'recommended',
      label: 'Recommended',
      version: 1,
      identity,
      sourceId: source.sourceId,
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

describe('online skill search TUI model', () => {
  it('renders stable ordered headings and maps selections across both groups', () => {
    const recommended = recommendedItem();
    const github = globalItem('other/skills', 'skills/wiki/SKILL.md');
    const result: InteractiveSkillSearchResult = {
      query: 'wiki',
      sections: [
        {
          id: 'recommended',
          label: 'Recommended',
          items: [recommended],
          truncated: false,
        },
        {
          id: 'github',
          label: 'All GitHub',
          items: [github],
          truncated: false,
        },
      ],
    };

    const options = buildOnlineSkillSearchOptions(result);
    expect(options.map((option) => option.label)).toEqual([
      '── Recommended ──',
      'research/wiki  NousResearch/hermes-agent',
      '── All GitHub ──',
      'wiki  other/skills',
    ]);
    expect(options[0]?.disabled).toBe(true);
    expect(options[2]?.disabled).toBe(true);
    expect(
      findSkillSearchSelection(result, skillSearchSelectionKey(recommended)),
    ).toBe(recommended);
    expect(
      findSkillSearchSelection(result, skillSearchSelectionKey(github)),
    ).toBe(github);
  });

  it('preserves the selected Recommended subtree descriptor', () => {
    const recommended = recommendedItem();
    const result: InteractiveSkillSearchResult = {
      query: 'wiki',
      sections: [
        {
          id: 'recommended',
          label: 'Recommended',
          items: [recommended],
          truncated: false,
        },
      ],
    };
    const selected = findSkillSearchSelection(
      result,
      skillSearchSelectionKey(recommended),
    );
    expect(selected).toBe(recommended);

    const groups = collectSelectedSkillSearchSources(
      [recommended],
      [skillSearchSelectionKey(recommended)],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.installSource).toBe(
      'NousResearch/hermes-agent@main/skills',
    );
    expect(groups[0]?.selectors).toEqual(['research/wiki']);
    expect(groups[0]?.installDescriptor).toEqual(
      recommended.catalog?.installDescriptor,
    );
  });
});
