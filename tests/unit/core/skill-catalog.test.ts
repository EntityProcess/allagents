import { describe, expect, it } from 'bun:test';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
  catalogSourceIdentity,
  isCatalogSkillPath,
  matchCatalogSource,
  pathWithinCatalogRoot,
} from '../../../src/core/skill-catalog.js';
import { validateSkillCatalog } from '../../../src/core/skill-catalog-health.js';

const EXPECTED_SOURCES = [
  ['gstack', 'garrytan/gstack', 'main', '.', '.', 'external-lifecycle', 'external-lifecycle', 'external-installer', 'forbidden', 'MIT'],
  ['paperclip-companies', 'paperclipai/companies', 'main', '.', '.', 'optional', 'repository', 'direct-selective', 'explicit-only', null],
  ['mattpocock-skills', 'mattpocock/skills', 'main', '.', '.', 'recommended', 'marketplace', 'marketplace-selective', 'allowed', 'MIT'],
  ['composio-awesome-claude-skills', 'ComposioHQ/awesome-claude-skills', 'master', '.', '.', 'optional', 'repository', 'search-only', 'forbidden', null],
  ['hermes-core', 'NousResearch/hermes-agent', 'main', 'skills', 'skills', 'recommended', 'subtree', 'direct-selective', 'allowed', 'MIT'],
  ['hermes-optional', 'NousResearch/hermes-agent', 'main', 'optional-skills', 'optional-skills', 'optional', 'subtree', 'direct-selective', 'explicit-only', 'MIT'],
  ['anthropic-skills', 'anthropics/skills', 'main', 'skills', '.', 'recommended', 'marketplace', 'marketplace-selective', 'allowed', null],
  ['addyosmani-agent-skills', 'addyosmani/agent-skills', 'main', 'skills', 'skills', 'recommended', 'subtree', 'direct-selective', 'allowed', 'MIT'],
  ['obra-superpowers', 'obra/superpowers', 'main', 'skills', 'skills', 'recommended', 'subtree', 'direct-selective', 'allowed', 'MIT'],
  ['context-engineering-skills', 'muratcankoylan/Agent-Skills-for-Context-Engineering', 'main', 'skills', '.', 'recommended', 'repository', 'direct-selective', 'allowed', 'MIT'],
  ['elastic-docs-skills', 'elastic/elastic-docs-skills', 'main', 'skills', '.', 'recommended', 'repository', 'direct-selective', 'allowed', 'Apache-2.0'],
  ['anthropic-knowledge-work', 'anthropics/knowledge-work-plugins', 'main', '.', '.', 'recommended', 'marketplace', 'marketplace-selective', 'allowed', 'Apache-2.0'],
] as const;

describe('recommended skill catalog', () => {
  it('contains the audited source set in stable order', () => {
    expect(RECOMMENDED_SKILL_CATALOG.schemaVersion).toBe(1);
    expect(RECOMMENDED_SKILL_CATALOG.label).toBe('Recommended');
    expect(
      RECOMMENDED_SKILL_CATALOG.sources.map((source) => [
        source.sourceId,
        source.repo,
        source.effectiveRef,
        source.approvedRoot,
        source.installRoot,
        source.classification,
        source.sourceKind,
        source.installPolicy,
        source.bulkPolicy,
        source.spdxLicense,
      ]),
    ).toEqual(EXPECTED_SOURCES);
    expect(validateSkillCatalog(RECOMMENDED_SKILL_CATALOG)).toEqual([]);
    for (const source of RECOMMENDED_SKILL_CATALOG.sources) {
      expect(source.warnings[0]?.code).toBe('not-security-reviewed');
      expect(source.homepage).toStartWith('http');
      expect(source.author.url).toStartWith('http');
      expect(catalogInstallDescriptor(source).installSource).toBe(
        source.installSource,
      );
    }
  });

  it('keeps the two Hermes identities and boundaries distinct', () => {
    const core = matchCatalogSource(
      'nousresearch/HERMES-agent',
      'skills/research/SKILL.md',
    );
    const optional = matchCatalogSource(
      'NousResearch/hermes-agent',
      'optional-skills/browser/SKILL.md',
    );
    expect(core?.sourceId).toBe('hermes-core');
    expect(optional?.sourceId).toBe('hermes-optional');
    expect(
      catalogSourceIdentity({
        catalog: 'recommended',
        sourceId: core?.sourceId ?? '',
        effectiveRef: core?.effectiveRef ?? '',
        approvedRoot: core?.approvedRoot ?? '.',
      }),
    ).toBe('recommended:hermes-core@main#skills');
    expect(
      catalogSourceIdentity({
        catalog: 'recommended',
        sourceId: optional?.sourceId ?? '',
        effectiveRef: optional?.effectiveRef ?? '',
        approvedRoot: optional?.approvedRoot ?? '.',
      }),
    ).toBe('recommended:hermes-optional@main#optional-skills');

    for (const path of [
      'optional-skills-old/x/SKILL.md',
      'skills-old/x/SKILL.md',
      'docs/x/SKILL.md',
    ]) {
      expect(matchCatalogSource('NousResearch/hermes-agent', path)).toBeUndefined();
    }
    expect(pathWithinCatalogRoot('skills/x/SKILL.md', 'skills')).toBe(true);
    expect(pathWithinCatalogRoot('Skills/x/SKILL.md', 'skills')).toBe(false);
  });

  it('rejects malformed Git paths before matching', () => {
    for (const path of [
      '/skills/x/SKILL.md',
      'skills/../x/SKILL.md',
      'skills\\x\\SKILL.md',
      'skills/x/skill.md',
      'skills//x/SKILL.md',
    ]) {
      expect(isCatalogSkillPath(path)).toBe(false);
      expect(matchCatalogSource('NousResearch/hermes-agent', path)).toBeUndefined();
    }
  });

  it('classifies Paperclip, Composio, and gstack honestly', () => {
    const paperclip = RECOMMENDED_SKILL_CATALOG.sources.find(
      (source) => source.sourceId === 'paperclip-companies',
    );
    const composio = RECOMMENDED_SKILL_CATALOG.sources.find(
      (source) => source.sourceId === 'composio-awesome-claude-skills',
    );
    const gstack = RECOMMENDED_SKILL_CATALOG.sources.find(
      (source) => source.sourceId === 'gstack',
    );
    expect(paperclip?.installableSubpath).toBe('skills');
    expect(paperclip?.warnings.map((warning) => warning.code)).toContain(
      'license-ambiguous',
    );
    expect(composio?.installPolicy).toBe('search-only');
    expect(gstack?.installPolicy).toBe('external-installer');
  });
});
