import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import {
  canonicalizeGitHubPluginSource,
  upsertGitHubPluginSourceAllowlist,
  upsertGitHubPluginSourceAllowlistInConfig,
} from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
} from '../../../src/core/skill-catalog.js';

describe('canonicalizeGitHubPluginSource', () => {
  it('promotes sibling standalone skills to their shared subtree', () => {
    const current =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki';
    const next =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/blogwatcher';

    expect(canonicalizeGitHubPluginSource(current, next)).toBe(
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
    );
  });

  it('promotes different subtrees to the next shared container', () => {
    const current =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research';
    const next =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/productivity/task-planner';

    expect(canonicalizeGitHubPluginSource(current, next)).toBe(
      'https://github.com/NousResearch/hermes-agent/tree/main/skills',
    );
  });
});

describe('upsertGitHubPluginSourceAllowlist', () => {
  it('rewrites the stored source instead of creating a duplicate entry', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skill-source-'));

    try {
      await mkdir(join(tmpDir, '.allagents'), { recursive: true });
      const config: WorkspaceConfig = {
        repositories: [],
        plugins: [{
          source: 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki',
          skills: ['llm-wiki'],
        }],
        clients: ['claude'],
        version: 2,
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

      const result = await upsertGitHubPluginSourceAllowlist(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/blogwatcher',
        ['llm-wiki', 'blogwatcher'],
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.normalizedPlugin).toBe(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
      );

      const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
      const updated = load(content) as WorkspaceConfig;
      expect(updated.plugins).toHaveLength(1);

      const plugin = updated.plugins[0];
      expect(typeof plugin).toBe('object');
      if (typeof plugin !== 'string') {
        expect(plugin.source).toBe(
          'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
        );
        expect(plugin.skills).toEqual(['llm-wiki', 'blogwatcher']);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('catalog-exact source identity', () => {
  const core = RECOMMENDED_SKILL_CATALOG.sources.find(
    (source) => source.sourceId === 'hermes-core',
  )!;
  const optional = RECOMMENDED_SKILL_CATALOG.sources.find(
    (source) => source.sourceId === 'hermes-optional',
  )!;

  for (const order of [
    [core, optional],
    [optional, core],
  ]) {
    it(`retains both Hermes roots when installed ${order.map((source) => source.sourceId).join(' then ')}`, async () => {
      const config: WorkspaceConfig = {
        version: 2,
        repositories: [],
        clients: ['universal'],
        plugins: [],
      };
      for (const source of order) {
        const result = await upsertGitHubPluginSourceAllowlistInConfig(
          config,
          source.installSource,
          [`${source.sourceId}/selected`],
          {
            identity: 'catalog-exact',
            catalogSource: catalogInstallDescriptor(source),
          },
        );
        expect(result.success).toBe(true);
      }
      expect(config.plugins).toHaveLength(2);
      expect(
        config.plugins.map((entry) =>
          typeof entry === 'string' ? entry : entry.source,
        ),
      ).toEqual(order.map((source) => source.installSource));
      expect(
        config.plugins.map((entry) =>
          typeof entry === 'string'
            ? undefined
            : entry.catalogSource?.sourceId,
        ),
      ).toEqual(order.map((source) => source.sourceId));
      expect(
        config.plugins.some(
          (entry) =>
            typeof entry !== 'string' &&
            entry.source === 'NousResearch/hermes-agent@main',
        ),
      ).toBe(false);
    });
  }

  it('merges only ordered selectors for an identical full descriptor', async () => {
    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['universal'],
      plugins: [],
    };
    const options = {
      identity: 'catalog-exact' as const,
      catalogSource: catalogInstallDescriptor(core),
    };
    await upsertGitHubPluginSourceAllowlistInConfig(
      config,
      core.installSource,
      ['research/llm-wiki'],
      options,
    );
    await upsertGitHubPluginSourceAllowlistInConfig(
      config,
      core.installSource,
      ['research/blogwatcher', 'research/llm-wiki'],
      options,
    );
    const entry = config.plugins[0];
    expect(typeof entry === 'string' ? undefined : entry?.skills).toEqual([
      'research/llm-wiki',
      'research/blogwatcher',
    ]);
  });
});
