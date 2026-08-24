import { describe, expect, it } from 'bun:test';
import {
  type CatalogHealthDependencies,
  checkSkillCatalogHealth,
  validateSkillCatalog,
} from '../../../src/core/skill-catalog-health.js';
import { RECOMMENDED_SKILL_CATALOG } from '../../../src/core/skill-catalog.js';
import type { SkillCatalog } from '../../../src/models/skill-catalog.js';

const marketplaceCatalog: SkillCatalog = {
  schemaVersion: 1,
  name: 'recommended',
  label: 'Recommended',
  sources: [
    RECOMMENDED_SKILL_CATALOG.sources.find(
      (source) => source.sourceId === 'mattpocock-skills',
    )!,
  ],
};

function healthDependencies(overrides: Partial<CatalogHealthDependencies> = {}) {
  const calls: string[] = [];
  const deps: CatalogHealthDependencies = {
    async getRepository(repo) {
      calls.push(`repo:${repo}`);
      return {
        fullName: 'mattpocock/skills',
        defaultBranch: 'main',
        headSha: 'abc123',
      };
    },
    async getTree(repo, ref) {
      calls.push(`tree:${repo}@${ref}`);
      return [
        { path: '.claude-plugin/marketplace.json', type: 'blob' },
        { path: 'skills', type: 'tree' },
        { path: 'skills/typescript', type: 'tree' },
        { path: 'skills/typescript/SKILL.md', type: 'blob' },
      ];
    },
    async getTextFile(repo, ref, path) {
      calls.push(`file:${repo}@${ref}:${path}`);
      return JSON.stringify({
        name: 'fixture',
        plugins: [
          {
            name: 'fixture',
            description: 'Fixture plugin',
            source: './',
            skills: 'skills/typescript',
          },
        ],
      });
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('validateSkillCatalog', () => {
  it('rejects duplicate identities, invalid metadata, and policy combinations', () => {
    const source = marketplaceCatalog.sources[0]!;
    const invalid = {
      ...marketplaceCatalog,
      sources: [
        {
          ...source,
          homepage: '',
          spdxLicense: 'not a valid SPDX expression!',
          bulkPolicy: 'allowed' as const,
          installPolicy: 'search-only' as const,
          manifestBoundary: 'none' as const,
          warnings: [],
        },
        source,
      ],
    } satisfies SkillCatalog;
    const codes = validateSkillCatalog(invalid).map((issue) => issue.code);
    expect(codes).toContain('duplicate-source-id');
    expect(codes).toContain('duplicate-identity');
    expect(codes).toContain('missing-metadata');
    expect(codes).toContain('invalid-spdx');
    expect(codes).toContain('invalid-non-installable-bulk-policy');
    expect(codes).toContain('missing-common-warning');
  });
});

describe('checkSkillCatalogHealth', () => {
  it('validates a local authoritative manifest with GET-only dependencies', async () => {
    const { deps, calls } = healthDependencies();
    const report = await checkSkillCatalogHealth(marketplaceCatalog, deps);
    expect(report.sources).toEqual([
      {
        sourceId: 'mattpocock-skills',
        identity: 'recommended:mattpocock-skills@main#.',
        status: 'healthy',
        reasonCodes: [],
        repositoryHeadSha: 'abc123',
      },
    ]);
    expect(calls).toEqual([
      'repo:mattpocock/skills',
      'tree:mattpocock/skills@main',
      'file:mattpocock/skills@main:.claude-plugin/marketplace.json',
    ]);
    expect(Object.keys(deps).sort()).toEqual([
      'getRepository',
      'getTextFile',
      'getTree',
    ]);
  });

  it('reports ref drift and manifest traversal without mutation', async () => {
    const { deps } = healthDependencies({
      async getRepository() {
        return {
          fullName: 'mattpocock/skills',
          defaultBranch: 'next',
          headSha: 'def456',
        };
      },
      async getTextFile() {
        return JSON.stringify({
          name: 'fixture',
          description: 'Fixture marketplace',
          plugins: [
            {
              name: 'escape',
              description: 'Escaping source',
              source: '../outside',
            },
          ],
        });
      },
    });
    const report = await checkSkillCatalogHealth(marketplaceCatalog, deps);
    expect(report.sources[0]?.status).toBe('drifted');
    expect(report.sources[0]?.reasonCodes).toContain('default-ref-drift');
    expect(report.sources[0]?.reasonCodes).toContain('manifest-source-escape');
  });

  it('rejects symlinked skill paths in an authoritative manifest', async () => {
    const { deps } = healthDependencies({
      async getTree() {
        return [
          { path: '.claude-plugin/marketplace.json', type: 'blob' },
          { path: 'skills', type: 'tree' },
          {
            path: 'skills/typescript',
            type: 'blob',
            mode: '120000',
          },
          { path: 'skills/typescript/SKILL.md', type: 'blob' },
        ];
      },
    });
    const report = await checkSkillCatalogHealth(marketplaceCatalog, deps);
    expect(report.sources[0]?.status).toBe('drifted');
    expect(report.sources[0]?.reasonCodes).toContain('manifest-skill-invalid');
  });

  it('reports unavailable repositories without falling through', async () => {
    const { deps } = healthDependencies({
      async getRepository() {
        throw new Error('unavailable');
      },
    });
    const report = await checkSkillCatalogHealth(marketplaceCatalog, deps);
    expect(report.sources[0]?.status).toBe('unreachable');
    expect(report.sources[0]?.reasonCodes).toEqual(['repository-unreachable']);
  });
});
