import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import simpleGit from 'simple-git';
import {
  buildSkillUpdateInventory,
  inspectSkillUpdateUnit,
  normalizeSkillUpdateScopes,
  resolveNonInteractiveSkillUpdateDecisions,
  skillUpdateExitCode,
  skillUpdateSummary,
} from '../../../src/cli/skill-update.js';
import {
  executeSkillUpdatePlan,
  type SkillUpdatePreflight,
} from '../../../src/core/skill-update.js';
import { getPluginCachePath } from '../../../src/utils/plugin-path.js';

const originalTestHome = process.env.ALLAGENTS_TEST_HOME;

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
});

async function initCheckout(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const git = simpleGit(path);
  await git.init();
  await git.addConfig('user.name', 'Skill Update Test');
  await git.addConfig('user.email', 'skill-update@example.test');
  await git.add('.');
  await git.commit('fixture');
}

describe('skill update command adapters', () => {
  test('normalizes project, user, and all scopes', () => {
    expect(normalizeSkillUpdateScopes('project')).toEqual(['project']);
    expect(normalizeSkillUpdateScopes('user')).toEqual(['user']);
    expect(normalizeSkillUpdateScopes('all')).toEqual([
      'project',
      'user',
    ]);
    expect(normalizeSkillUpdateScopes(undefined)).toEqual(['project']);
  });

  test('retains deletion units in every non-interactive mode, including --yes', () => {
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'deleted-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: [
            {
              name: 'gone',
              subpath: 'gone',
              enabled: true,
              installationId: 'project:0',
              scope: 'project',
              pluginName: 'skills',
              source: 'acme/skills',
            },
          ],
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
        {
          id: 'healthy-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: [],
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;

    expect(resolveNonInteractiveSkillUpdateDecisions(plan)).toEqual({
      'deleted-cache': 'retain',
    });
    expect(resolveNonInteractiveSkillUpdateDecisions(plan)).toEqual({
      'deleted-cache': 'retain',
    });
  });

  test('summarizes skill impacts while retaining physical-unit status details', async () => {
    const skills = Array.from({ length: 7 }, (_, index) => ({
      name: `skill-${index + 1}`,
      subpath: `skill-${index + 1}`,
      enabled: true,
    }));
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'seven-skill-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: skills.slice(5).map((skill) => ({
            ...skill,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          survivors: skills.slice(0, 5).map((skill) => ({
            ...skill,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;
    const result = await executeSkillUpdatePlan(
      plan,
      { 'seven-skill-cache': 'remove' },
      {
        advanceNode: async () => {},
        restoreNode: async () => {},
        reconcileUnit: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        syncScope: async () => ({ success: true }),
      },
    );

    expect(result.units).toEqual([
      {
        id: 'seven-skill-cache',
        status: 'removed',
        skillCounts: { updated: 5, removed: 2, retained: 0 },
      },
    ]);
    expect(skillUpdateSummary(result)).toEqual({
      updated: 5,
      removed: 2,
      retained: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  test('reports retained skill and skipped-source totals for non-interactive deletion safety', async () => {
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'deleted-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: ['gone-a', 'gone-b'].map((subpath) => ({
            name: subpath,
            subpath,
            enabled: true,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;
    const result = await executeSkillUpdatePlan(
      plan,
      resolveNonInteractiveSkillUpdateDecisions(plan),
      {
        advanceNode: async () => {
          throw new Error('retained sources must not advance');
        },
        restoreNode: async () => {},
        reconcileUnit: async () => {
          throw new Error('retained sources must not reconcile');
        },
        syncScope: async () => ({ success: true }),
      },
    );

    expect(skillUpdateSummary(result)).toMatchObject({
      retained: 2,
      skipped: 1,
    });
  });

  test('maps cancellation to success false with exit zero', () => {
    expect(
      skillUpdateExitCode({
        success: false,
        cancelled: true,
        units: [],
        syncedScopes: [],
      }),
    ).toBe(0);
    expect(
      skillUpdateExitCode({
        success: false,
        cancelled: false,
        units: [],
        syncedScopes: [],
      }),
    ).toBe(1);
  });

  test('builds one connected marketplace graph for embedded and external plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-inventory-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const marketplace = join(home, '.allagents/plugins/marketplaces/catalog');
    process.env.ALLAGENTS_TEST_HOME = home;

    try {
      const external = getPluginCachePath('acme', 'external-skills');
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await mkdir(join(home, '.allagents'), { recursive: true });
      await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
      await mkdir(join(marketplace, 'plugins/embedded/skills/inside'), {
        recursive: true,
      });
      await mkdir(join(external, 'skills/outside'), { recursive: true });
      await writeFile(
        join(marketplace, 'plugins/embedded/skills/inside/SKILL.md'),
        '---\nname: inside\ndescription: embedded\n---\n',
      );
      await writeFile(
        join(external, 'skills/outside/SKILL.md'),
        '---\nname: outside\ndescription: external\n---\n',
      );
      await writeFile(
        join(marketplace, '.claude-plugin/marketplace.json'),
        JSON.stringify({
          name: 'catalog',
          description: 'test catalog',
          plugins: [
            {
              name: 'embedded',
              description: 'embedded plugin',
              source: './plugins/embedded',
            },
            {
              name: 'external',
              description: 'external plugin',
              source: {
                source: 'url',
                url: 'https://github.com/acme/external-skills',
              },
            },
          ],
        }),
      );
      await initCheckout(marketplace);
      await initCheckout(external);
      await writeFile(
        join(home, '.allagents/marketplaces.json'),
        JSON.stringify({
          version: 1,
          marketplaces: {
            catalog: {
              name: 'catalog',
              source: { type: 'github', location: 'acme/catalog' },
              path: marketplace,
            },
          },
        }),
      );
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['embedded@catalog', 'external@catalog'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace);

      expect(inventory.installations).toHaveLength(2);
      const embedded = inventory.installations.find(
        (entry) => entry.pluginName === 'embedded',
      );
      const externalEntry = inventory.installations.find(
        (entry) => entry.pluginName === 'external',
      );
      expect(embedded?.nodes.map((node) => node.id)).toEqual([marketplace]);
      expect(externalEntry?.nodes.map((node) => node.id)).toEqual([
        external,
        marketplace,
      ]);
      expect(externalEntry?.nodes[0]?.role).toBe('dependency');
      expect(embedded?.marketplace?.nodeId).toBe(marketplace);
      expect(externalEntry?.marketplace?.nodeId).toBe(marketplace);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('classifies a plugin absent from a valid inspected marketplace as removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-removed-'));
    try {
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(root, '.claude-plugin/marketplace.json'),
        JSON.stringify({
          name: 'catalog',
          description: 'test catalog',
          plugins: [],
        }),
      );
      await initCheckout(root);
      const sha = (await simpleGit(root).revparse(['HEAD'])).trim();
      const result = await inspectSkillUpdateUnit({
        id: root,
        nodes: [
          {
            id: root,
            cachePath: root,
            remoteUrl: root,
            role: 'root',
            currentSha: sha,
          },
        ],
        installations: [
          {
            id: 'project:0',
            scope: 'project',
            configIndex: 0,
            rawSource: 'gone@catalog',
            effectiveSource: 'gone@catalog',
            pluginName: 'gone',
            rootNodeId: root,
            rootSubpath: 'plugins/gone',
            nodes: [],
            skills: [{ name: 'gone', subpath: 'gone', enabled: true }],
            marketplace: { nodeId: root, pluginName: 'gone' },
          },
        ],
      });

      expect(result.outcome).toBe('resolved');
      expect(result.installations).toEqual([
        { installationId: 'project:0', outcome: 'plugin-removed' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ignores an unrelated broken user cache during a project-only inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-scope-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      const projectCache = getPluginCachePath('acme', 'project-skills');
      await mkdir(join(projectCache, 'skills/keep'), { recursive: true });
      await writeFile(
        join(projectCache, 'skills/keep/SKILL.md'),
        '---\nname: keep\ndescription: keep\n---\n',
      );
      await initCheckout(projectCache);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await mkdir(join(home, '.allagents'), { recursive: true });
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['acme/project-skills'],
        }),
      );
      await writeFile(
        join(home, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['codex'],
          plugins: ['unrelated/missing-skills'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, [
        'project',
      ]);

      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]?.scope).toBe('project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('inventories a direct GitHub source with an inline ref instead of treating it as a marketplace spec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-ref-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      const cache = getPluginCachePath('acme', 'ref-skills', 'v2');
      await mkdir(join(cache, 'skills/keep'), { recursive: true });
      await writeFile(
        join(cache, 'skills/keep/SKILL.md'),
        '---\nname: keep\ndescription: keep\n---\n',
      );
      await initCheckout(cache);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['acme/ref-skills@v2'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, [
        'project',
      ]);

      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]?.rawSource).toBe(
        'acme/ref-skills@v2',
      );
      expect(inventory.installations[0]?.nodes[0]?.ref).toBe('v2');
      expect(inventory.installations[0]?.marketplace).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
