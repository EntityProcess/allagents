import { describe, expect, it, mock } from 'bun:test';
import {
  buildPhysicalRefreshUnits,
  buildSkillUpdatePreflight,
  createGitHubSkillUpdateInstallation,
  executeSkillUpdatePlan,
  inspectRemoteSkillUpdateUnit,
  type CheckoutNode,
  type SkillUpdateInstallation,
  type UnitInspection,
} from '../../../src/core/skill-update.js';
import { getEffectivePluginSource } from '../../../src/models/workspace-config.js';

const projectNode: CheckoutNode = {
  id: '/cache/acme-skills',
  cachePath: '/cache/acme-skills',
  remoteUrl: 'https://github.com/acme/skills.git',
  role: 'root',
  currentSha: 'old-sha',
};

function installation(
  overrides: Partial<SkillUpdateInstallation> = {},
): SkillUpdateInstallation {
  return {
    id: 'project:0',
    scope: 'project',
    configIndex: 0,
    rawSource: 'acme/skills',
    effectiveSource: 'acme/skills',
    pluginName: 'skills',
    rootNodeId: projectNode.id,
    rootSubpath: '',
    nodes: [projectNode],
    skills: [
      { name: 'keep', subpath: 'keep', enabled: true },
      { name: 'deleted', subpath: 'deleted', enabled: true },
    ],
    ...overrides,
  };
}

function resolved(
  installationId: string,
  subpaths: string[],
): UnitInspection {
  return {
    outcome: 'resolved',
    nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
    installations: [
      {
        installationId,
        outcome: 'resolved',
        skills: subpaths.map((subpath) => ({
          name: subpath.split('/').at(-1) ?? subpath,
          subpath,
        })),
      },
    ],
  };
}

describe('getEffectivePluginSource', () => {
  it('applies object pins while preserving inline refs', () => {
    expect(
      getEffectivePluginSource({ source: 'acme/skills', pin: 'v2' }),
    ).toBe('acme/skills@v2');
    expect(
      getEffectivePluginSource({ source: 'acme/skills@v1', pin: 'v2' }),
    ).toBe('acme/skills@v1');
    expect(
      getEffectivePluginSource({
        source: 'https://github.com/acme/skills',
        pin: 'v2',
      }),
    ).toBe('acme/skills@v2');
    expect(
      getEffectivePluginSource({ source: './local/plugin', pin: 'v2' }),
    ).toBe('./local/plugin');
    expect(
      getEffectivePluginSource({
        source: 'plugin@acme/marketplace',
        pin: 'v2',
      }),
    ).toBe('plugin@acme/marketplace');
  });
});

describe('createGitHubSkillUpdateInstallation', () => {
  it('canonicalizes aliases to one cache node and separates pinned refs', () => {
    const shorthand = createGitHubSkillUpdateInstallation({
      scope: 'project',
      configIndex: 0,
      plugin: 'acme/skills',
      pluginName: 'skills',
      currentSha: 'old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const url = createGitHubSkillUpdateInstallation({
      scope: 'user',
      configIndex: 0,
      plugin: 'https://github.com/acme/skills',
      pluginName: 'skills',
      currentSha: 'old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const pinned = createGitHubSkillUpdateInstallation({
      scope: 'project',
      configIndex: 1,
      plugin: { source: 'acme/skills', pin: 'v2' },
      pluginName: 'skills',
      currentSha: 'v2-old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });

    expect(shorthand?.nodes[0]?.id).toBe(url?.nodes[0]?.id);
    expect(shorthand?.rootSubpath).toBe('');
    expect(pinned?.nodes[0]?.ref).toBe('v2');
    expect(pinned?.nodes[0]?.id).not.toBe(shorthand?.nodes[0]?.id);
  });

  it('groups direct-source siblings by physical checkout while keeping refs separate', () => {
    const sibling = installation({
      id: 'project:1',
      configIndex: 1,
      rawSource: 'acme/skills/plugins/sibling',
      effectiveSource: 'acme/skills/plugins/sibling',
      rootSubpath: 'plugins/sibling',
    });
    const pinnedNode: CheckoutNode = {
      ...projectNode,
      id: '/cache/acme-skills-v2',
      cachePath: '/cache/acme-skills-v2',
      ref: 'v2',
    };
    const pinned = installation({
      id: 'project:2',
      configIndex: 2,
      rawSource: 'acme/skills@v2',
      effectiveSource: 'acme/skills@v2',
      rootNodeId: pinnedNode.id,
      nodes: [pinnedNode],
    });

    const units = buildPhysicalRefreshUnits([
      installation(),
      sibling,
      pinned,
    ]);

    expect(units).toHaveLength(2);
    expect(
      units.find((unit) => unit.id === projectNode.id)?.installations.map(
        (entry) => entry.rawSource,
      ),
    ).toEqual(['acme/skills', 'acme/skills/plugins/sibling']);
  });
});

describe('buildSkillUpdatePreflight', () => {
  it('preflights every sibling in a touched cache and compares qualified paths', async () => {
    const inspectUnit = mock(async () =>
      resolved('project:0', ['keep', 'group-b/shared']),
    );
    const result = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            skills: [
              { name: 'keep', subpath: 'keep', enabled: true },
              { name: 'shared', subpath: 'group-a/shared', enabled: true },
              { name: 'shared', subpath: 'group-b/shared', enabled: true },
            ],
          }),
        ],
        selectedScopes: ['project'],
        filters: ['keep'],
      },
      { inspectUnit },
    );

    expect(inspectUnit).toHaveBeenCalledTimes(1);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.deleted.map((skill) => skill.subpath)).toEqual([
      'group-a/shared',
    ]);
    expect(result.units[0]?.survivors.map((skill) => skill.subpath)).toEqual([
      'keep',
      'group-b/shared',
    ]);
  });

  it('fails closed when discovery fails', async () => {
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation()],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'failed',
          nodes: [],
          installations: [],
          error: 'manifest is malformed',
        }),
      },
    );

    expect(result.units[0]?.outcome).toBe('failed');
    expect(result.units[0]?.deleted).toEqual([]);
    expect(result.units[0]?.error).toContain('malformed');
  });

  it('blocks a selected-scope update when a shared-cache deletion affects another scope', async () => {
    const user = installation({
      id: 'user:0',
      scope: 'user',
      configIndex: 0,
    });
    const inspectUnit = async (): Promise<UnitInspection> => ({
      outcome: 'resolved',
      nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
      installations: [
        { installationId: 'project:0', outcome: 'resolved', skills: [{ name: 'keep', subpath: 'keep' }] },
        { installationId: 'user:0', outcome: 'resolved', skills: [{ name: 'keep', subpath: 'keep' }] },
      ],
    });

    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation(), user],
        selectedScopes: ['project'],
      },
      { inspectUnit },
    );

    expect(result.units[0]?.blockedByOutOfScope).toBe(true);
    expect(result.units[0]?.deleted).toHaveLength(2);
  });

  it('retains the exact installation IDs authoritatively removed by a marketplace', async () => {
    const retained = installation({
      id: 'project:1',
      configIndex: 1,
      rawSource: 'keep@marketplace',
      effectiveSource: 'keep@marketplace',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation(), retained],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
          installations: [
            { installationId: 'project:0', outcome: 'plugin-removed' },
            {
              installationId: 'project:1',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );

    expect(result.units[0]?.removedInstallationIds).toEqual(['project:0']);
    expect(result.units[0]?.deleted.map((skill) => skill.installationId)).toEqual([
      'project:0',
      'project:0',
    ]);
    expect(result.units[0]?.survivors.map((skill) => skill.installationId)).toEqual([
      'project:1',
    ]);
  });
});

describe('inspectRemoteSkillUpdateUnit', () => {
  it('treats a valid empty plugin root as authoritative and always cleans up', async () => {
    const cleanup = mock(async () => {});
    const result = await inspectRemoteSkillUpdateUnit(
      {
        id: projectNode.id,
        nodes: [projectNode],
        installations: [installation()],
      },
      {
        cloneNode: async () => '/tmp/inspected',
        getRevision: async () => 'inspected-sha',
        pathExists: () => true,
        discoverPluginSkills: async () => [],
        cleanup,
      },
    );

    expect(result).toEqual({
      outcome: 'resolved',
      nodes: [{ nodeId: projectNode.id, sha: 'inspected-sha' }],
      installations: [
        { installationId: 'project:0', outcome: 'resolved', skills: [] },
      ],
    });
    expect(cleanup).toHaveBeenCalledWith('/tmp/inspected');
  });

  it('classifies a missing declared root as failure, never deletion', async () => {
    const cleanup = mock(async () => {});
    const result = await inspectRemoteSkillUpdateUnit(
      {
        id: projectNode.id,
        nodes: [projectNode],
        installations: [installation({ rootSubpath: 'plugins/missing' })],
      },
      {
        cloneNode: async () => '/tmp/inspected',
        getRevision: async () => 'inspected-sha',
        pathExists: () => false,
        discoverPluginSkills: async () => [],
        cleanup,
      },
    );

    expect(result.outcome).toBe('failed');
    expect(result.installations).toEqual([]);
    expect(result.error).toContain('declared root');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('executeSkillUpdatePlan', () => {
  it('collects decisions before mutation, leaves retained units untouched, and syncs offline once', async () => {
    const secondNode: CheckoutNode = {
      id: '/cache/healthy',
      cachePath: '/cache/healthy',
      remoteUrl: 'https://github.com/acme/healthy.git',
      role: 'root',
      currentSha: 'healthy-old',
    };
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [
          installation(),
          installation({
            id: 'project:1',
            configIndex: 1,
            rawSource: 'acme/healthy',
            effectiveSource: 'acme/healthy',
            nodes: [secondNode],
            rootNodeId: secondNode.id,
            skills: [{ name: 'healthy', subpath: 'healthy', enabled: true }],
          }),
        ],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async (unit) => {
          if (unit.nodes[0]?.id === projectNode.id) {
            return resolved('project:0', ['keep']);
          }
          return {
            outcome: 'resolved',
            nodes: [{ nodeId: secondNode.id, sha: 'healthy-new' }],
            installations: [
              {
                installationId: 'project:1',
                outcome: 'resolved',
                skills: [{ name: 'healthy', subpath: 'healthy' }],
              },
            ],
          };
        },
      },
    );
    const advanced: string[] = [];
    const syncScope = mock(async () => ({ success: true }));

    const result = await executeSkillUpdatePlan(
      plan,
      { [projectNode.id]: 'retain' },
      {
        advanceNode: async (node, sha) => advanced.push(`${node.id}:${sha}`),
        restoreNode: async () => {},
        reconcileUnit: async () => ({ commit: async () => {}, rollback: async () => {} }),
        syncScope,
      },
    );

    expect(advanced).toEqual(['/cache/healthy:healthy-new']);
    expect(syncScope).toHaveBeenCalledTimes(1);
    expect(syncScope).toHaveBeenCalledWith('project', { offline: true });
    expect(result.units.find((unit) => unit.id === projectNode.id)?.status).toBe(
      'retained',
    );
  });

  it('cancels before any mutation when a decision is cancelled', async () => {
    const plan = await buildSkillUpdatePreflight(
      { installations: [installation()], selectedScopes: ['project'] },
      { inspectUnit: async () => resolved('project:0', ['keep']) },
    );
    const advanceNode = mock(async () => {});
    const reconcileUnit = mock(async () => ({
      commit: async () => {},
      rollback: async () => {},
    }));

    const result = await executeSkillUpdatePlan(
      plan,
      { [projectNode.id]: 'cancel' },
      {
        advanceNode,
        restoreNode: async () => {},
        reconcileUnit,
        syncScope: async () => ({ success: true }),
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.units.every((unit) => unit.status === 'cancelled')).toBe(true);
    expect(advanceNode).not.toHaveBeenCalled();
    expect(reconcileUnit).not.toHaveBeenCalled();
  });

  it('restores already advanced dependency nodes when a later node fails', async () => {
    const dependency: CheckoutNode = {
      id: '/cache/dependency',
      cachePath: '/cache/dependency',
      remoteUrl: 'https://github.com/acme/dependency.git',
      role: 'dependency',
      currentSha: 'dependency-old',
    };
    const root: CheckoutNode = {
      ...projectNode,
      currentSha: 'root-old',
    };
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [installation({ nodes: [root, dependency] })],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [
            { nodeId: dependency.id, sha: 'dependency-new' },
            { nodeId: root.id, sha: 'root-new' },
          ],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [
                { name: 'keep', subpath: 'keep' },
                { name: 'deleted', subpath: 'deleted' },
              ],
            },
          ],
        }),
      },
    );
    const advanced: string[] = [];
    const restored: string[] = [];
    const rollback = mock(async () => {});
    const syncScope = mock(async () => ({ success: true }));

    const result = await executeSkillUpdatePlan(plan, {}, {
      advanceNode: async (node) => {
        advanced.push(node.id);
        if (node.role === 'root') throw new Error('root checkout failed');
      },
      restoreNode: async (node, sha) => restored.push(`${node.id}:${sha}`),
      reconcileUnit: async () => ({ commit: async () => {}, rollback }),
      syncScope,
    });

    expect(advanced).toEqual([dependency.id, root.id]);
    expect(restored).toEqual([`${dependency.id}:dependency-old`]);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(syncScope).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
