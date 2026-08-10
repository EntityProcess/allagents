import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginEntry } from '../models/workspace-config.js';
import {
  getPluginSource,
  getEffectivePluginSource as resolveEffectivePluginSource,
} from '../models/workspace-config.js';
import { getPluginCachePath, parseGitHubUrl } from '../utils/plugin-path.js';
import { cleanupTempDir, cloneToTemp, gitHubUrl } from './git.js';
import { discoverSkillEntriesFromPluginRoot } from './skills.js';

export type SkillUpdateScope = 'project' | 'user';
export type CheckoutNodeRole = 'dependency' | 'root';

export interface CheckoutNode {
  /** Stable physical identity. Cache paths are preferred because aliases share them. */
  id: string;
  cachePath: string;
  remoteUrl: string;
  ref?: string;
  role: CheckoutNodeRole;
  /** Revision present before update, used for transaction rollback. */
  currentSha: string;
}

export interface InstalledSkill {
  name: string;
  subpath: string;
  /** Exact config selector, retained to disambiguate duplicate leaf names. */
  selector?: string;
  enabled: boolean;
}

export interface SkillUpdateInstallation {
  id: string;
  scope: SkillUpdateScope;
  configIndex: number;
  rawSource: string;
  effectiveSource: string;
  pluginName: string;
  rootNodeId: string;
  rootSubpath: string;
  nodes: CheckoutNode[];
  skills: InstalledSkill[];
  /** Marketplace lookup metadata used to resolve the new plugin root from the inspected manifest. */
  marketplace?: {
    nodeId: string;
    pluginName: string;
  };
  /** True only when inventory proved this config entry owns skills and nothing else. */
  standaloneSkillSource?: boolean;
}

export interface DiscoveredSkill {
  name: string;
  subpath: string;
}

export type InstallationInspection =
  | {
      installationId: string;
      outcome: 'resolved';
      skills: DiscoveredSkill[];
    }
  | {
      installationId: string;
      outcome: 'plugin-removed';
      skills?: DiscoveredSkill[];
    }
  | {
      installationId: string;
      outcome: 'local';
      skills?: DiscoveredSkill[];
    }
  | {
      installationId: string;
      outcome: 'failed';
      skills?: DiscoveredSkill[];
      error: string;
    };

export interface InspectedNodeRevision {
  nodeId: string;
  sha: string;
}

export type UnitInspection = {
  outcome: 'resolved' | 'plugin-removed' | 'local' | 'failed';
  nodes: InspectedNodeRevision[];
  installations: InstallationInspection[];
  error?: string;
};

export interface SkillUpdateUnitInput {
  id: string;
  nodes: CheckoutNode[];
  installations: SkillUpdateInstallation[];
}

export interface SkillUpdateSkillImpact extends InstalledSkill {
  installationId: string;
  scope: SkillUpdateScope;
  pluginName: string;
  source: string;
}

export interface SkillUpdateUnit extends SkillUpdateUnitInput {
  outcome: UnitInspection['outcome'];
  inspectedNodes: InspectedNodeRevision[];
  deleted: SkillUpdateSkillImpact[];
  survivors: SkillUpdateSkillImpact[];
  /** Installations whose marketplace entry was authoritatively removed upstream. */
  removedInstallationIds: string[];
  blockedByOutOfScope: boolean;
  error?: string;
}

export interface SkillUpdatePreflight {
  selectedScopes: SkillUpdateScope[];
  units: SkillUpdateUnit[];
}

export interface BuildSkillUpdatePreflightInput {
  installations: SkillUpdateInstallation[];
  selectedScopes: SkillUpdateScope[];
  filters?: string[];
}

export interface BuildSkillUpdatePreflightDeps {
  inspectUnit: (unit: SkillUpdateUnitInput) => Promise<UnitInspection>;
}

export interface CreateGitHubSkillUpdateInstallationInput {
  scope: SkillUpdateScope;
  configIndex: number;
  plugin: PluginEntry;
  pluginName: string;
  currentSha: string;
  skills: InstalledSkill[];
  standaloneSkillSource?: boolean;
}

export interface InspectRemoteSkillUpdateDeps {
  cloneNode?: (node: CheckoutNode) => Promise<string>;
  getRevision?: (checkoutPath: string) => Promise<string>;
  pathExists?: (path: string) => boolean;
  discoverPluginSkills?: (pluginRoot: string) => Promise<DiscoveredSkill[]>;
  cleanup?: (checkoutPath: string) => Promise<void>;
}

export type SkillUpdateDecision = 'remove' | 'retain' | 'cancel';

export interface PreparedUnitReconciliation {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

export interface ExecuteSkillUpdateDeps {
  advanceNode: (node: CheckoutNode, sha: string) => Promise<void>;
  restoreNode: (node: CheckoutNode, sha: string) => Promise<void>;
  reconcileUnit: (unit: SkillUpdateUnit) => Promise<PreparedUnitReconciliation>;
  syncScope: (
    scope: SkillUpdateScope,
    options: { offline: true },
  ) => Promise<{ success: boolean; error?: string }>;
}

export type SkillUpdateExecutionStatus =
  | 'updated'
  | 'removed'
  | 'retained'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface SkillUpdateSkillCounts {
  updated: number;
  removed: number;
  retained: number;
}

export interface SkillUpdateUnitExecution {
  id: string;
  status: SkillUpdateExecutionStatus;
  /** Per-skill impacts; status remains the physical refresh-unit outcome. */
  skillCounts: SkillUpdateSkillCounts;
  error?: string;
}

export interface SkillUpdateExecutionResult {
  success: boolean;
  cancelled: boolean;
  units: SkillUpdateUnitExecution[];
  syncedScopes: SkillUpdateScope[];
}

/** Re-exported here so update inventory and sync share one effective identity. */
export const getEffectivePluginSource = (plugin: PluginEntry): string =>
  resolveEffectivePluginSource(plugin);

/**
 * Convert a direct GitHub config entry plus its pre-update skill snapshot into
 * the canonical physical-cache inventory consumed by preflight.
 */
export function createGitHubSkillUpdateInstallation(
  input: CreateGitHubSkillUpdateInstallationInput,
): SkillUpdateInstallation | null {
  const rawSource = getPluginSource(input.plugin);
  const effectiveSource = resolveEffectivePluginSource(input.plugin);
  const parsed = parseGitHubUrl(effectiveSource);
  if (!parsed) return null;

  const cachePath = getPluginCachePath(
    parsed.owner,
    parsed.repo,
    parsed.branch,
  );
  const node: CheckoutNode = {
    id: cachePath,
    cachePath,
    remoteUrl: gitHubUrl(parsed.owner, parsed.repo),
    role: 'root',
    currentSha: input.currentSha,
    ...(parsed.branch && { ref: parsed.branch }),
  };

  return {
    id: `${input.scope}:${input.configIndex}`,
    scope: input.scope,
    configIndex: input.configIndex,
    rawSource,
    effectiveSource,
    pluginName: input.pluginName,
    rootNodeId: node.id,
    rootSubpath: parsed.subpath ?? '',
    nodes: [node],
    skills: input.skills,
    ...(input.standaloneSkillSource && { standaloneSkillSource: true }),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

/**
 * Build connected components of installations joined by any checkout node.
 * This makes the physical cache graph—not config spelling—the decision boundary.
 */
export function buildPhysicalRefreshUnits(
  installations: SkillUpdateInstallation[],
): SkillUpdateUnitInput[] {
  const remaining = new Set(installations.map((entry) => entry.id));
  const byId = new Map(installations.map((entry) => [entry.id, entry]));
  const nodeConsumers = new Map<string, Set<string>>();

  for (const entry of installations) {
    for (const node of entry.nodes) {
      const consumers = nodeConsumers.get(node.id) ?? new Set<string>();
      consumers.add(entry.id);
      nodeConsumers.set(node.id, consumers);
    }
  }

  const units: SkillUpdateUnitInput[] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as string;
    const queue = [first];
    const component: SkillUpdateInstallation[] = [];

    while (queue.length > 0) {
      const id = queue.shift();
      if (!id || !remaining.delete(id)) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      component.push(entry);
      for (const node of entry.nodes) {
        for (const consumer of nodeConsumers.get(node.id) ?? []) {
          if (remaining.has(consumer)) queue.push(consumer);
        }
      }
    }

    const nodes = uniqueById(component.flatMap((entry) => entry.nodes));
    const id = nodes
      .map((node) => node.id)
      .sort((a, b) => a.localeCompare(b))
      .join('::');
    units.push({ id, nodes, installations: component });
  }

  return units;
}

/**
 * Inspect a direct or already-resolved multi-checkout unit in disposable clones.
 * Missing declared roots and unreadable discovery are typed failures, whereas an
 * existing root containing no skills is an authoritative empty result.
 */
export async function inspectRemoteSkillUpdateUnit(
  unit: SkillUpdateUnitInput,
  deps: InspectRemoteSkillUpdateDeps = {},
): Promise<UnitInspection> {
  const cloneNode =
    deps.cloneNode ??
    (async (node: CheckoutNode) => {
      const url =
        node.remoteUrl ||
        (() => {
          throw new Error(`Missing remote URL for ${node.id}`);
        })();
      return cloneToTemp(url, node.ref);
    });
  const getRevision =
    deps.getRevision ??
    (async (checkoutPath: string) => {
      const { default: simpleGit } = await import('simple-git');
      const sha = (await simpleGit(checkoutPath).revparse(['HEAD'])).trim();
      if (!sha)
        throw new Error(
          `Could not resolve inspected revision for ${checkoutPath}`,
        );
      return sha;
    });
  const pathExists = deps.pathExists ?? existsSync;
  const discoverPluginSkills =
    deps.discoverPluginSkills ??
    (async (pluginRoot: string) => {
      const warnings: string[] = [];
      const skills = await discoverSkillEntriesFromPluginRoot(
        pluginRoot,
        warnings,
      );
      if (warnings.length > 0) throw new Error(warnings.join('\n'));
      return skills.map(({ name, subpath }) => ({ name, subpath }));
    });
  const cleanup = deps.cleanup ?? cleanupTempDir;
  const checkoutPaths = new Map<string, string>();

  try {
    const nodes: InspectedNodeRevision[] = [];
    for (const node of unit.nodes) {
      const checkoutPath = await cloneNode(node);
      checkoutPaths.set(node.id, checkoutPath);
      nodes.push({ nodeId: node.id, sha: await getRevision(checkoutPath) });
    }

    const installations: InstallationInspection[] = [];
    for (const installation of unit.installations) {
      const checkoutPath = checkoutPaths.get(installation.rootNodeId);
      if (!checkoutPath) {
        throw new Error(
          `Inspected checkout missing for ${installation.rootNodeId}`,
        );
      }
      const pluginRoot = installation.rootSubpath
        ? join(checkoutPath, installation.rootSubpath)
        : checkoutPath;
      if (!pathExists(pluginRoot)) {
        throw new Error(
          `Configured plugin declared root '${installation.rootSubpath || '.'}' no longer exists in ${installation.effectiveSource}`,
        );
      }
      installations.push({
        installationId: installation.id,
        outcome: 'resolved',
        skills: await discoverPluginSkills(pluginRoot),
      });
    }

    return { outcome: 'resolved', nodes, installations };
  } catch (error) {
    return {
      outcome: 'failed',
      nodes: [],
      installations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all(
      [...checkoutPaths.values()].map((checkoutPath) =>
        cleanup(checkoutPath).catch(() => {}),
      ),
    );
  }
}

function matchesFilter(
  installation: SkillUpdateInstallation,
  filter: string,
): boolean {
  const expected = filter.toLocaleLowerCase();
  return installation.skills.some(
    (skill) =>
      skill.enabled &&
      (skill.name.toLocaleLowerCase() === expected ||
        skill.subpath.toLocaleLowerCase() === expected ||
        `${installation.pluginName}:${skill.subpath}`.toLocaleLowerCase() ===
          expected),
  );
}

function impact(
  installation: SkillUpdateInstallation,
  skill: InstalledSkill,
): SkillUpdateSkillImpact {
  return {
    ...skill,
    installationId: installation.id,
    scope: installation.scope,
    pluginName: installation.pluginName,
    source: installation.rawSource,
  };
}

/**
 * Inspect every selected physical unit without mutating persistent state.
 * Filters choose units; once chosen, every enabled sibling consumer is checked.
 */
export async function buildSkillUpdatePreflight(
  input: BuildSkillUpdatePreflightInput,
  deps: BuildSkillUpdatePreflightDeps,
): Promise<SkillUpdatePreflight> {
  const selectedScopes = new Set(input.selectedScopes);
  const filters = input.filters?.filter(Boolean) ?? [];
  const physicalUnits = buildPhysicalRefreshUnits(input.installations).filter(
    (unit) =>
      unit.installations.some(
        (entry) =>
          selectedScopes.has(entry.scope) &&
          entry.nodes.length > 0 &&
          (filters.length === 0 ||
            filters.some((filter) => matchesFilter(entry, filter))),
      ),
  );

  const units: SkillUpdateUnit[] = [];
  for (const unit of physicalUnits) {
    let inspection: UnitInspection;
    try {
      inspection = await deps.inspectUnit(unit);
    } catch (error) {
      inspection = {
        outcome: 'failed',
        nodes: [],
        installations: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const deleted: SkillUpdateSkillImpact[] = [];
    const survivors: SkillUpdateSkillImpact[] = [];

    if (inspection.outcome !== 'failed') {
      const inspectedByInstallation = new Map(
        inspection.installations.map((entry) => [entry.installationId, entry]),
      );
      for (const entry of unit.installations) {
        const installed = entry.skills.filter((skill) => skill.enabled);
        const inspected = inspectedByInstallation.get(entry.id);
        if (!inspected || inspected.outcome === 'failed') continue;
        if (inspected.outcome === 'plugin-removed') {
          deleted.push(...installed.map((skill) => impact(entry, skill)));
          continue;
        }
        if (inspected.outcome === 'local') {
          survivors.push(...installed.map((skill) => impact(entry, skill)));
          continue;
        }

        const available = new Set(
          inspected.skills.map((skill) => skill.subpath),
        );
        for (const skill of installed) {
          (available.has(skill.subpath) ? survivors : deleted).push(
            impact(entry, skill),
          );
        }
      }
    }

    const failedInstallation = inspection.installations.find(
      (entry) => entry.outcome === 'failed',
    );
    const removedInstallationIds = inspection.installations
      .filter((entry) => entry.outcome === 'plugin-removed')
      .map((entry) => entry.installationId);
    const outcome = failedInstallation ? 'failed' : inspection.outcome;
    const error =
      inspection.error ??
      (failedInstallation?.outcome === 'failed'
        ? failedInstallation.error
        : undefined);
    const blockedByOutOfScope = deleted.some(
      (skill) => !selectedScopes.has(skill.scope),
    );

    units.push({
      ...unit,
      outcome,
      inspectedNodes: inspection.nodes,
      deleted: outcome === 'failed' ? [] : deleted,
      survivors: outcome === 'failed' ? [] : survivors,
      removedInstallationIds:
        outcome === 'failed' ? [] : removedInstallationIds,
      blockedByOutOfScope,
      ...(error && { error }),
    });
  }

  return { selectedScopes: input.selectedScopes, units };
}

function execution(
  unit: SkillUpdateUnit,
  status: SkillUpdateExecutionStatus,
  error?: string,
): SkillUpdateUnitExecution {
  const skillCounts: SkillUpdateSkillCounts = {
    updated:
      status === 'updated' || status === 'removed'
        ? unit.survivors.length
        : 0,
    removed: status === 'removed' ? unit.deleted.length : 0,
    retained: status === 'retained' ? unit.deleted.length : 0,
  };
  return { id: unit.id, status, skillCounts, ...(error && { error }) };
}

/**
 * Execute a fully inspected plan. The caller must collect interactive decisions
 * first; any cancellation aborts this function before the first mutation.
 */
export async function executeSkillUpdatePlan(
  plan: SkillUpdatePreflight,
  decisions: Record<string, SkillUpdateDecision>,
  deps: ExecuteSkillUpdateDeps,
): Promise<SkillUpdateExecutionResult> {
  if (Object.values(decisions).includes('cancel')) {
    return {
      success: false,
      cancelled: true,
      units: plan.units.map((unit) => execution(unit, 'cancelled')),
      syncedScopes: [],
    };
  }

  const results: SkillUpdateUnitExecution[] = [];
  const scopesToSync = new Set<SkillUpdateScope>();

  for (const unit of plan.units) {
    if (unit.outcome === 'failed') {
      results.push(execution(unit, 'failed', unit.error));
      continue;
    }
    if (unit.outcome === 'local') {
      results.push(execution(unit, 'skipped'));
      continue;
    }

    if (unit.deleted.length > 0) {
      const decision = decisions[unit.id] ?? 'retain';
      if (unit.blockedByOutOfScope || decision !== 'remove') {
        results.push(execution(unit, 'retained'));
        continue;
      }
    }

    const revisionByNode = new Map(
      unit.inspectedNodes.map((entry) => [entry.nodeId, entry.sha]),
    );
    const orderedNodes = [...unit.nodes].sort((left, right) => {
      if (left.role === right.role) return left.id.localeCompare(right.id);
      return left.role === 'dependency' ? -1 : 1;
    });
    const changedNodes: CheckoutNode[] = [];
    let prepared: PreparedUnitReconciliation | undefined;

    try {
      prepared = await deps.reconcileUnit(unit);
      for (const node of orderedNodes) {
        const sha = revisionByNode.get(node.id);
        if (!sha) throw new Error(`Missing inspected revision for ${node.id}`);
        await deps.advanceNode(node, sha);
        changedNodes.push(node);
      }
      await prepared.commit();

      for (const installation of unit.installations) {
        if (plan.selectedScopes.includes(installation.scope)) {
          scopesToSync.add(installation.scope);
        }
      }
      results.push(
        execution(unit, unit.deleted.length > 0 ? 'removed' : 'updated'),
      );
    } catch (error) {
      await prepared?.rollback().catch(() => {});
      for (const node of changedNodes.reverse()) {
        await deps.restoreNode(node, node.currentSha).catch(() => {});
      }
      results.push(
        execution(
          unit,
          'failed',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  const syncedScopes: SkillUpdateScope[] = [];
  for (const scope of plan.selectedScopes) {
    if (!scopesToSync.has(scope)) continue;
    const syncResult = await deps.syncScope(scope, { offline: true });
    if (syncResult.success) {
      syncedScopes.push(scope);
    } else {
      results.push({
        id: `sync:${scope}`,
        status: 'failed',
        skillCounts: { updated: 0, removed: 0, retained: 0 },
        ...(syncResult.error && { error: syncResult.error }),
      });
    }
  }

  return {
    success: results.every((result) => result.status !== 'failed'),
    cancelled: false,
    units: results,
    syncedScopes,
  };
}
