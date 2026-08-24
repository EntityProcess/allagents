import { describe, expect, it } from 'bun:test';
import {
  type ValidatedPlugin,
  buildSourcesProvenance,
} from '../../../src/core/sync.js';
import {
  RECOMMENDED_SKILL_CATALOG,
  catalogInstallDescriptor,
} from '../../../src/core/skill-catalog.js';
import type { PluginEntry } from '../../../src/models/workspace-config.js';
import type { FetchResult } from '../../../src/core/plugin.js';

const core = RECOMMENDED_SKILL_CATALOG.sources.find(
  (source) => source.sourceId === 'hermes-core',
)!;
const optional = RECOMMENDED_SKILL_CATALOG.sources.find(
  (source) => source.sourceId === 'hermes-optional',
)!;

describe('catalog source provenance', () => {
  for (const order of [
    [core, optional],
    [optional, core],
  ]) {
    it(`writes two Hermes identities when installed ${order.map((source) => source.sourceId).join(' then ')}`, async () => {
      const pluginEntries: PluginEntry[] = order.map((source) => ({
        source: source.installSource,
        skills: [`${source.sourceId}/selected`],
        catalogSource: catalogInstallDescriptor(source),
      }));
      const validatedPlugins: ValidatedPlugin[] = order.map((source) => ({
        plugin: source.installSource,
        resolved: `/cache/hermes-agent/${source.installRoot}`,
        success: true,
        clients: [],
        nativeClients: [],
      }));
      const physicalFetches = new Set<string>();
      const fetchPlugin = async (
        _source: string,
        options?: { branch?: string },
      ): Promise<FetchResult> => {
        physicalFetches.add(`NousResearch/hermes-agent@${options?.branch}`);
        return {
          success: true,
          action: 'fetched',
          cachePath: '/cache/hermes-agent',
          resolvedRef: 'main',
          resolvedSha: 'shared-hermes-sha',
        };
      };

      const sources = await buildSourcesProvenance(
        validatedPlugins,
        pluginEntries,
        { fetchPlugin },
      );

      expect(Object.keys(sources).sort()).toEqual([
        'recommended:hermes-core@main#skills',
        'recommended:hermes-optional@main#optional-skills',
      ]);
      expect(
        sources['recommended:hermes-core@main#skills']?.resolvedRoot,
      ).toBe('skills');
      expect(
        sources['recommended:hermes-optional@main#optional-skills']
          ?.resolvedRoot,
      ).toBe('optional-skills');
      expect(
        sources['recommended:hermes-core@main#skills']?.catalogSource
          ?.installSource,
      ).toBe('NousResearch/hermes-agent@main/skills');
      expect(
        sources['recommended:hermes-optional@main#optional-skills']
          ?.catalogSource?.installSource,
      ).toBe('NousResearch/hermes-agent@main/optional-skills');
      expect(physicalFetches).toEqual(
        new Set(['NousResearch/hermes-agent@main']),
      );
    });
  }
});
