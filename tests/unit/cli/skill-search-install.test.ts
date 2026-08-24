import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SelectedSkillSearchSource,
  installSelectedSkillSearchSources,
} from '../../../src/cli/commands/plugin-skills.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
} from '../../../src/core/skill-catalog.js';
import type { SyncResult } from '../../../src/core/sync.js';

const fixtures: string[] = [];

function sourceGroup(
  sourceId: string,
  selectors: string[],
): SelectedSkillSearchSource {
  const source = RECOMMENDED_SKILL_CATALOG.sources.find(
    (entry) => entry.sourceId === sourceId,
  );
  if (!source) {
    throw new Error(
      `Missing ${sourceId} source in the recommended catalog fixture.`,
    );
  }
  return {
    catalogIdentity: `recommended:${source.sourceId}@${source.effectiveRef}#${source.approvedRoot}`,
    installDescriptor: catalogInstallDescriptor(source),
    installSource: source.installSource,
    installPolicy: source.installPolicy,
    classification: source.classification,
    warnings: source.warnings,
    selectors,
  };
}

function successfulSync(): SyncResult {
  return {
    success: true,
    pluginResults: [],
    totalCopied: 2,
    totalFailed: 0,
    totalSkipped: 0,
    totalGenerated: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('installSelectedSkillSearchSources', () => {
  it('configures exact Hermes roots and invokes one final sync', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'catalog-install-'));
    fixtures.push(cache);
    await mkdir(join(cache, 'skills/research/wiki/references'), {
      recursive: true,
    });
    await mkdir(join(cache, 'optional-skills/browser/scripts'), {
      recursive: true,
    });
    await writeFile(join(cache, 'skills/research/wiki/SKILL.md'), '# wiki');
    await writeFile(
      join(cache, 'skills/research/wiki/references/source.md'),
      'asset',
    );
    await writeFile(
      join(cache, 'optional-skills/browser/SKILL.md'),
      '# browser',
    );
    await writeFile(
      join(cache, 'optional-skills/browser/scripts/run.sh'),
      'echo asset',
    );

    const upsert = mock(async () => ({ success: true as const }));
    const sync = mock(async () => successfulSync());
    const result = await installSelectedSkillSearchSources(
      [
        sourceGroup('hermes-core', ['research/wiki']),
        sourceGroup('hermes-optional', ['browser']),
      ],
      'project',
      '/workspace',
      {
        fetchPlugin: async (_source, options) => ({
          success: true,
          action: 'fetched',
          cachePath: cache,
          resolvedRef: options.branch,
          resolvedSha: 'shared-sha',
        }),
        upsertProjectAllowlist: upsert,
        syncWorkspace: sync,
      },
    );

    expect(result.success).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0]).toBe(
      'NousResearch/hermes-agent@main/skills',
    );
    expect(upsert.mock.calls[0]?.[1]).toEqual(['research/wiki']);
    expect(upsert.mock.calls[0]?.[3]?.catalogSource?.sourceId).toBe(
      'hermes-core',
    );
    expect(upsert.mock.calls[1]?.[0]).toBe(
      'NousResearch/hermes-agent@main/optional-skills',
    );
    expect(upsert.mock.calls[1]?.[3]?.catalogSource?.sourceId).toBe(
      'hermes-optional',
    );
  });

  it('rejects search-only and external selections before mutation', async () => {
    const add = mock(async () => ({ success: true as const }));
    const sync = mock(async () => successfulSync());
    for (const sourceId of ['gstack', 'composio-awesome-claude-skills']) {
      const result = await installSelectedSkillSearchSources(
        [sourceGroup(sourceId, ['selected'])],
        'project',
        '/workspace',
        { addPlugin: add, syncWorkspace: sync },
      );
      expect(result.success).toBe(false);
    }
    expect(add).toHaveBeenCalledTimes(0);
    expect(sync).toHaveBeenCalledTimes(0);
  });

  it('rejects a mismatched catalog identity before fetching or mutation', async () => {
    const fetchPlugin = mock(async () => ({
      success: true as const,
      action: 'fetched' as const,
      cachePath: '/unused',
    }));
    const group = sourceGroup('hermes-core', ['research/wiki']);
    group.catalogIdentity = 'recommended:hermes-optional@main#optional-skills';

    await expect(
      installSelectedSkillSearchSources([group], 'project', '/workspace', {
        fetchPlugin,
      }),
    ).rejects.toThrow('descriptor drift');
    expect(fetchPlugin).toHaveBeenCalledTimes(0);
  });

  it('rejects spoofed catalog policy metadata before fetching or mutation', async () => {
    const fetchPlugin = mock(async () => ({
      success: true as const,
      action: 'fetched' as const,
      cachePath: '/unused',
    }));
    const group = sourceGroup('mattpocock-skills', ['typescript']);
    group.installPolicy = 'direct-selective';

    await expect(
      installSelectedSkillSearchSources([group], 'project', '/workspace', {
        fetchPlugin,
      }),
    ).rejects.toThrow('descriptor drift');
    expect(fetchPlugin).toHaveBeenCalledTimes(0);
  });

  it('resolves marketplace selectors through the authoritative local manifest', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'catalog-marketplace-'));
    fixtures.push(cache);
    await mkdir(join(cache, '.claude-plugin'), { recursive: true });
    await mkdir(join(cache, 'skills/typescript/references'), {
      recursive: true,
    });
    await writeFile(join(cache, 'skills/typescript/SKILL.md'), '# TypeScript');
    await mkdir(join(cache, 'skills/other'), { recursive: true });
    await writeFile(join(cache, 'skills/other/SKILL.md'), '# Other');
    await writeFile(
      join(cache, 'skills/typescript/references/guide.md'),
      'asset',
    );
    await writeFile(
      join(cache, '.claude-plugin/marketplace.json'),
      JSON.stringify({
        name: 'fixture-marketplace',
        description: 'Fixture marketplace',
        plugins: [
          {
            name: 'remote-plugin',
            description: 'Independent distribution',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/example/remote.git',
              path: 'plugin',
              ref: 'main',
            },
          },
          {
            name: 'fixture-plugin',
            description: 'Fixture plugin',
            source: '.',
            skills: 'skills/typescript',
          },
          {
            name: 'other-plugin',
            description: 'Another root plugin',
            source: '.',
            skills: 'skills/other',
          },
        ],
      }),
    );

    const upsert = mock(async () => ({ success: true as const }));
    const sync = mock(async () => successfulSync());
    const addMarketplace = mock(async () => ({
      success: true as const,
      marketplace: {
        name: 'fixture-marketplace',
        source: { type: 'github' as const, location: 'mattpocock/skills' },
        path: cache,
      },
    }));
    const result = await installSelectedSkillSearchSources(
      [sourceGroup('mattpocock-skills', ['typescript'])],
      'project',
      '/workspace',
      {
        fetchPlugin: async (_source, options) => ({
          success: true,
          action: 'fetched',
          cachePath: cache,
          resolvedRef: options.branch,
          resolvedSha: 'marketplace-sha',
        }),
        findMarketplaceRegistration: async () => undefined,
        addMarketplace,
        upsertProjectAllowlist: upsert,
        syncWorkspace: sync,
      },
    );

    expect(result.success).toBe(true);
    expect(addMarketplace.mock.calls[0]?.slice(0, 3)).toEqual([
      'mattpocock/skills',
      'mattpocock-skills',
      'main',
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]?.[0]).toBe(
      'fixture-plugin@fixture-marketplace',
    );
    expect(upsert.mock.calls[0]?.[1]).toEqual(['typescript']);
    expect(upsert.mock.calls[0]?.[3]?.catalogSource?.sourceId).toBe(
      'mattpocock-skills',
    );
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
