import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  type MarketplaceEntry,
  getProjectRegistryPath,
  getRegistryPath,
  loadMergedRegistries,
  loadRegistryFromPath,
  parseLocation,
  parsePluginSpec,
} from '../core/marketplace.js';
import { getPluginName, resetFetchCache } from '../core/plugin.js';
import {
  type CheckoutNode,
  type InstalledSkill,
  type SkillUpdateDecision,
  type SkillUpdateExecutionResult,
  type SkillUpdateInstallation,
  type SkillUpdatePreflight,
  type SkillUpdateScope,
  type SkillUpdateUnitInput,
  buildSkillUpdatePreflight,
  createGitHubSkillUpdateInstallation,
  executeSkillUpdatePlan,
  getEffectivePluginSource,
  type InstallationInspection,
  type UnitInspection,
} from '../core/skill-update.js';
import { discoverSkillEntriesFromPluginRoot } from '../core/skills.js';
import { syncUserWorkspace, syncWorkspace } from '../core/sync.js';
import { getUserWorkspaceConfigPath } from '../core/user-workspace.js';
import type {
  PluginEntry,
  PluginSkillsConfig,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import { getPluginSource, WorkspaceConfigSchema } from '../models/workspace-config.js';
import { cleanupTempDir, cloneToTemp, gitHubUrl } from '../core/git.js';
import {
  getPluginCachePath,
  isGitHubUrl,
  parseGitHubUrl,
} from '../utils/plugin-path.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import { createSkillUpdateReconciler } from './skill-removal.js';

export interface SkillUpdateInventory {
  installations: SkillUpdateInstallation[];
  skippedLocalSources: string[];
}

export interface PrepareSkillUpdateOptions {
  workspacePath: string;
  scopes: SkillUpdateScope[];
  filters?: string[];
}

export interface PreparedSkillUpdate {
  inventory: SkillUpdateInventory;
  plan: SkillUpdatePreflight;
}

/** Normalize the public scope flag after the caller has resolved its default. */
export function normalizeSkillUpdateScopes(
  scope: string | undefined,
  _workspacePath: string,
): SkillUpdateScope[] {
  switch (scope ?? 'project') {
    case 'project':
      return ['project'];
    case 'user':
      return ['user'];
    case 'all':
      return ['project', 'user'];
    default:
      throw new Error(
        `Invalid scope '${scope}'. Expected project, user, or all.`,
      );
  }
}

/** --yes suppresses questions; it intentionally never authorizes deletion. */
export function resolveNonInteractiveSkillUpdateDecisions(
  plan: SkillUpdatePreflight,
  _yes: boolean,
): Record<string, SkillUpdateDecision> {
  return Object.fromEntries(
    plan.units
      .filter((unit) => unit.deleted.length > 0)
      .map((unit) => [unit.id, 'retain' as const]),
  );
}

export function findUnmatchedSkillUpdateFilters(
  inventory: SkillUpdateInventory,
  scopes: SkillUpdateScope[],
  filters: string[],
): string[] {
  const selected = new Set(scopes);
  return filters.filter((filter) => {
    const expected = filter.toLocaleLowerCase();
    return !inventory.installations.some(
      (installation) =>
        selected.has(installation.scope) &&
        installation.skills.some(
          (skill) =>
            skill.enabled &&
            (skill.name.toLocaleLowerCase() === expected ||
              skill.subpath.toLocaleLowerCase() === expected ||
              `${installation.pluginName}:${skill.subpath}`.toLocaleLowerCase() ===
                expected),
        ),
    );
  });
}

function configPath(scope: SkillUpdateScope, workspacePath: string): string {
  return scope === 'project'
    ? join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE)
    : getUserWorkspaceConfigPath();
}

async function readConfig(
  scope: SkillUpdateScope,
  workspacePath: string,
): Promise<WorkspaceConfig | null> {
  const path = configPath(scope, workspacePath);
  if (!existsSync(path)) return null;
  const { load } = await import('js-yaml');
  const raw = load(await readFile(path, 'utf-8'));
  const parsed = WorkspaceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid workspace config at ${path}: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }
  return raw as WorkspaceConfig;
}

async function revision(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Checkout not found: ${path}`);
  const sha = (await simpleGit(path).revparse(['HEAD'])).trim();
  if (!sha) throw new Error(`Could not resolve checkout revision: ${path}`);
  return sha;
}

function posixPath(path: string): string {
  return path.split(/[\\/]/).join('/');
}

function enabledSkills(
  entries: Awaited<ReturnType<typeof discoverSkillEntriesFromPluginRoot>>,
  pluginName: string,
  config: WorkspaceConfig,
  pluginSkills: PluginSkillsConfig | undefined,
): InstalledSkill[] {
  const isV1 = config.version === undefined || config.version < 2;
  const topDisabled = new Set(config.disabledSkills ?? []);
  const topEnabled = config.enabledSkills
    ? new Set(config.enabledSkills)
    : undefined;
  const hasTopEnabled =
    isV1 &&
    topEnabled !== undefined &&
    [...topEnabled].some((value) => value.startsWith(`${pluginName}:`));

  return entries.map(({ name, subpath }) => {
    let enabled = true;
    let selector: string | undefined;
    if (Array.isArray(pluginSkills)) {
      selector = pluginSkills.includes(subpath)
        ? subpath
        : pluginSkills.includes(name)
          ? name
          : undefined;
      enabled = selector !== undefined;
    } else if (pluginSkills) {
      enabled =
        !pluginSkills.exclude.includes(subpath) &&
        !pluginSkills.exclude.includes(name);
    } else if (isV1) {
      const nameKey = `${pluginName}:${name}`;
      const pathKey = `${pluginName}:${subpath}`;
      enabled = hasTopEnabled
        ? (topEnabled?.has(nameKey) ?? false) ||
          (topEnabled?.has(pathKey) ?? false)
        : !topDisabled.has(nameKey) && !topDisabled.has(pathKey);
    }
    return {
      name,
      subpath,
      enabled,
      ...(selector && { selector }),
    };
  });
}

function pluginSkillsConfig(plugin: PluginEntry): PluginSkillsConfig | undefined {
  return typeof plugin === 'string' ? undefined : plugin.skills;
}

async function isStandaloneSkillRoot(
  root: string,
  entries: Awaited<ReturnType<typeof discoverSkillEntriesFromPluginRoot>>,
): Promise<boolean> {
  if (!existsSync(join(root, 'SKILL.md')) || entries.length !== 1) return false;
  return ![
    '.claude-plugin',
    '.github',
    '.mcp.json',
    'agents',
    'commands',
    'hooks',
    'mcp.json',
  ].some((artifact) => existsSync(join(root, artifact)));
}

function nodeForMarketplace(entry: MarketplaceEntry): CheckoutNode | null {
  if (entry.source.type === 'local') return null;
  if (entry.source.type === 'github') {
    const parsed = parseLocation(entry.source.location);
    return {
      id: entry.path,
      cachePath: entry.path,
      remoteUrl: gitHubUrl(parsed.owner, parsed.repo),
      role: 'root',
      currentSha: '',
      ...(parsed.branch && { ref: parsed.branch }),
    };
  }
  return {
    id: entry.path,
    cachePath: entry.path,
    remoteUrl: entry.source.location,
    role: 'root',
    currentSha: '',
  };
}

async function marketplaceForScope(
  name: string,
  scope: SkillUpdateScope,
  workspacePath: string,
  sourceLocation?: string,
): Promise<MarketplaceEntry | null> {
  const findEntry = (
    marketplaces: Record<string, MarketplaceEntry>,
  ): MarketplaceEntry | null =>
    marketplaces[name] ??
    (sourceLocation
      ? Object.values(marketplaces).find(
          (entry) => entry.source.location === sourceLocation,
        )
      : undefined) ??
    null;
  if (scope === 'user') {
    const registry = await loadRegistryFromPath(getRegistryPath());
    return findEntry(registry.marketplaces);
  }
  const { registry } = await loadMergedRegistries(
    getRegistryPath(),
    getProjectRegistryPath(workspacePath),
  );
  return findEntry(registry.marketplaces);
}

async function inventoryDirect(
  scope: SkillUpdateScope,
  configIndex: number,
  plugin: PluginEntry,
  config: WorkspaceConfig,
): Promise<SkillUpdateInstallation | null> {
  const effectiveSource = getEffectivePluginSource(plugin);
  const parsed = parseGitHubUrl(effectiveSource);
  if (!parsed) return null;
  const cachePath = getPluginCachePath(parsed.owner, parsed.repo, parsed.branch);
  const root = parsed.subpath ? join(cachePath, parsed.subpath) : cachePath;
  if (!existsSync(root)) {
    throw new Error(`Cached plugin root not found for ${effectiveSource}: ${root}`);
  }
  const discovered = await discoverSkillEntriesFromPluginRoot(root);
  const pluginName = getPluginName(root);
  const skills = enabledSkills(
    discovered,
    pluginName,
    config,
    pluginSkillsConfig(plugin),
  );
  if (!skills.some((skill) => skill.enabled)) return null;
  return createGitHubSkillUpdateInstallation({
    scope,
    configIndex,
    plugin,
    pluginName,
    currentSha: await revision(cachePath),
    skills,
    standaloneSkillSource: await isStandaloneSkillRoot(root, discovered),
  });
}

async function inventoryMarketplace(
  scope: SkillUpdateScope,
  configIndex: number,
  plugin: PluginEntry,
  config: WorkspaceConfig,
  workspacePath: string,
): Promise<SkillUpdateInstallation | null | 'local'> {
  const rawSource = getPluginSource(plugin);
  const spec = parsePluginSpec(rawSource);
  if (!spec) return null;
  const marketplace = await marketplaceForScope(
    spec.marketplaceName,
    scope,
    workspacePath,
    spec.owner && spec.repo ? `${spec.owner}/${spec.repo}` : undefined,
  );
  if (!marketplace) {
    throw new Error(
      `Marketplace '${spec.marketplaceName}' for ${rawSource} is not registered in ${scope} scope`,
    );
  }
  const marketplaceNode = nodeForMarketplace(marketplace);
  if (!marketplaceNode) return 'local';
  marketplaceNode.currentSha = await revision(marketplaceNode.cachePath);

  const manifest = await parseMarketplaceManifest(marketplace.path);
  if (!manifest.success) {
    throw new Error(
      `Could not inventory marketplace '${marketplace.name}': ${manifest.error}`,
    );
  }
  if (manifest.warnings.length > 0) {
    throw new Error(
      `Could not safely inventory marketplace '${marketplace.name}': ${manifest.warnings.join('; ')}`,
    );
  }
  const manifestPlugin = manifest.data.plugins.find(
    (entry) => entry.name === spec.plugin,
  );

  let root: string;
  let rootNode: CheckoutNode = marketplaceNode;
  const nodes: CheckoutNode[] = [marketplaceNode];
  if (manifestPlugin && typeof manifestPlugin.source === 'object') {
    const parsed = parseGitHubUrl(manifestPlugin.source.url);
    if (!parsed) {
      throw new Error(
        `External marketplace plugin '${rawSource}' is not backed by a supported GitHub source`,
      );
    }
    const cachePath = getPluginCachePath(parsed.owner, parsed.repo, parsed.branch);
    rootNode = {
      id: cachePath,
      cachePath,
      remoteUrl: gitHubUrl(parsed.owner, parsed.repo),
      role: 'dependency',
      currentSha: await revision(cachePath),
      ...(parsed.branch && { ref: parsed.branch }),
    };
    nodes.unshift(rootNode);
    root = parsed.subpath ? join(cachePath, parsed.subpath) : cachePath;
  } else {
    const source =
      manifestPlugin && typeof manifestPlugin.source === 'string'
        ? manifestPlugin.source
        : join(spec.subpath ?? 'plugins', spec.plugin);
    root = resolve(marketplace.path, source);
  }
  if (!existsSync(root)) {
    throw new Error(`Installed marketplace plugin root not found: ${root}`);
  }
  const discovered = await discoverSkillEntriesFromPluginRoot(root);
  const skills = enabledSkills(
    discovered,
    spec.plugin,
    config,
    pluginSkillsConfig(plugin),
  );
  if (!skills.some((skill) => skill.enabled)) return null;

  return {
    id: `${scope}:${configIndex}`,
    scope,
    configIndex,
    rawSource,
    effectiveSource: rawSource,
    pluginName: spec.plugin,
    rootNodeId: rootNode.id,
    rootSubpath:
      rootNode.id === marketplaceNode.id
        ? posixPath(relative(marketplace.path, root))
        : posixPath(relative(rootNode.cachePath, root)),
    nodes,
    skills,
    marketplace: {
      nodeId: marketplaceNode.id,
      pluginName: spec.plugin,
    },
  };
}

/** Snapshot raw config entries across both scopes before any remote checkout. */
export async function buildSkillUpdateInventory(
  workspacePath: string,
  selectedScopes: SkillUpdateScope[] = ['project', 'user'],
): Promise<SkillUpdateInventory> {
  const installations: SkillUpdateInstallation[] = [];
  const skippedLocalSources: string[] = [];
  const deferred: SkillUpdateInstallation[] = [];
  const deferredErrors: Array<{
    source: string;
    nodeIds: string[];
    error: unknown;
  }> = [];
  const selected = new Set(selectedScopes);

  const potentialNodeIds = async (
    source: string,
    plugin: PluginEntry,
    scope: SkillUpdateScope,
  ): Promise<string[]> => {
    const direct = parseGitHubUrl(getEffectivePluginSource(plugin));
    if (direct) {
      return [getPluginCachePath(direct.owner, direct.repo, direct.branch)];
    }
    const spec = parsePluginSpec(source);
    if (!spec) return [];
    const marketplace = await marketplaceForScope(
      spec.marketplaceName,
      scope,
      workspacePath,
      spec.owner && spec.repo ? `${spec.owner}/${spec.repo}` : undefined,
    );
    return marketplace ? [marketplace.path] : [];
  };

  // Inventory selected scopes first, then attach healthy consumers from the
  // other scope only when their physical checkout graph intersects. This keeps
  // an unrelated broken user plugin from blocking a project-only update while
  // still making shared caches a cross-scope safety boundary.
  for (const scope of ['project', 'user'] as const) {
    const config = await readConfig(scope, workspacePath);
    if (!config) continue;
    for (const [configIndex, plugin] of config.plugins.entries()) {
      const rawSource = getPluginSource(plugin);
      const effectiveSource = getEffectivePluginSource(plugin);
      let installation: SkillUpdateInstallation | null | 'local';
      try {
        // Inline Git refs also use `@` (owner/repo@ref). Direct GitHub
        // recognition must therefore take precedence over marketplace syntax.
        if (isGitHubUrl(effectiveSource)) {
          installation = await inventoryDirect(
            scope,
            configIndex,
            plugin,
            config,
          );
        } else if (parsePluginSpec(rawSource)) {
          installation = await inventoryMarketplace(
            scope,
            configIndex,
            plugin,
            config,
            workspacePath,
          );
        } else {
          installation = 'local';
        }
      } catch (error) {
        if (selected.has(scope)) throw error;
        deferredErrors.push({
          source: rawSource,
          nodeIds: await potentialNodeIds(rawSource, plugin, scope),
          error,
        });
        continue;
      }
      if (installation === 'local') {
        if (selected.has(scope)) {
          skippedLocalSources.push(`${scope}:${rawSource}`);
        }
      } else if (installation) {
        (selected.has(scope) ? installations : deferred).push(installation);
      }
    }
  }

  const touchedNodeIds = new Set(
    installations.flatMap((installation) =>
      installation.nodes.map((node) => node.id),
    ),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = deferred.length - 1; index >= 0; index--) {
      const installation = deferred[index];
      if (
        !installation?.nodes.some((node) => touchedNodeIds.has(node.id))
      ) {
        continue;
      }
      deferred.splice(index, 1);
      installations.push(installation);
      for (const node of installation.nodes) touchedNodeIds.add(node.id);
      changed = true;
    }
  }
  const sharedFailure = deferredErrors.find((candidate) =>
    candidate.nodeIds.some((nodeId) => touchedNodeIds.has(nodeId)),
  );
  if (sharedFailure) {
    throw new Error(
      `Could not safely inventory shared source ${sharedFailure.source}: ${sharedFailure.error instanceof Error ? sharedFailure.error.message : String(sharedFailure.error)}`,
    );
  }
  return { installations, skippedLocalSources };
}

async function inspectInstallation(
  installation: SkillUpdateInstallation,
  checkoutPaths: Map<string, string>,
): Promise<InstallationInspection> {
  let root: string;
  if (installation.marketplace) {
    const marketplaceCheckout = checkoutPaths.get(
      installation.marketplace.nodeId,
    );
    if (!marketplaceCheckout) {
      throw new Error(
        `Inspected marketplace checkout missing for ${installation.rawSource}`,
      );
    }
    const manifest = await parseMarketplaceManifest(marketplaceCheckout);
    if (!manifest.success) {
      return {
        installationId: installation.id,
        outcome: 'failed',
        error: manifest.error,
      };
    }
    if (manifest.warnings.length > 0) {
      return {
        installationId: installation.id,
        outcome: 'failed',
        error: manifest.warnings.join('; '),
      };
    }
    const entry = manifest.data.plugins.find(
      (candidate) => candidate.name === installation.marketplace?.pluginName,
    );
    if (!entry) {
      return { installationId: installation.id, outcome: 'plugin-removed' };
    }
    if (typeof entry.source === 'object') {
      const parsed = parseGitHubUrl(entry.source.url);
      if (!parsed) {
        return {
          installationId: installation.id,
          outcome: 'failed',
          error: `Unsupported external source for ${installation.rawSource}`,
        };
      }
      const expectedNode = getPluginCachePath(
        parsed.owner,
        parsed.repo,
        parsed.branch,
      );
      if (expectedNode !== installation.rootNodeId) {
        return {
          installationId: installation.id,
          outcome: 'failed',
          error: `External source for ${installation.rawSource} changed; run plugin update before skill update`,
        };
      }
      const checkout = checkoutPaths.get(expectedNode);
      if (!checkout) {
        throw new Error(`Inspected external checkout missing for ${expectedNode}`);
      }
      root = parsed.subpath ? join(checkout, parsed.subpath) : checkout;
    } else {
      root = resolve(marketplaceCheckout, entry.source);
    }
  } else {
    const checkout = checkoutPaths.get(installation.rootNodeId);
    if (!checkout) {
      throw new Error(`Inspected checkout missing for ${installation.rawSource}`);
    }
    root = installation.rootSubpath
      ? join(checkout, installation.rootSubpath)
      : checkout;
  }

  if (!existsSync(root)) {
    return {
      installationId: installation.id,
      outcome: 'failed',
      error: `Declared plugin root no longer exists for ${installation.rawSource}`,
    };
  }
  const warnings: string[] = [];
  const discovered = await discoverSkillEntriesFromPluginRoot(root, warnings);
  if (warnings.length > 0) {
    return {
      installationId: installation.id,
      outcome: 'failed',
      error: warnings.join('; '),
    };
  }
  return {
    installationId: installation.id,
    outcome: 'resolved',
    skills: discovered.map(({ name, subpath }) => ({ name, subpath })),
  };
}

/** Inspect direct, embedded-marketplace, and external-marketplace units in temp clones. */
export async function inspectSkillUpdateUnit(
  unit: SkillUpdateUnitInput,
): Promise<UnitInspection> {
  const checkoutPaths = new Map<string, string>();
  try {
    const nodes: UnitInspection['nodes'] = [];
    for (const node of unit.nodes) {
      const checkout = await cloneToTemp(node.remoteUrl, node.ref);
      checkoutPaths.set(node.id, checkout);
      nodes.push({ nodeId: node.id, sha: await revision(checkout) });
    }
    const installations: InstallationInspection[] = [];
    for (const installation of unit.installations) {
      installations.push(
        await inspectInstallation(installation, checkoutPaths),
      );
    }
    const failed = installations.find((entry) => entry.outcome === 'failed');
    return failed?.outcome === 'failed'
      ? {
          outcome: 'failed',
          nodes,
          installations,
          error: failed.error,
        }
      : { outcome: 'resolved', nodes, installations };
  } catch (error) {
    return {
      outcome: 'failed',
      nodes: [],
      installations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all(
      [...checkoutPaths.values()].map((path) =>
        cleanupTempDir(path).catch(() => {}),
      ),
    );
  }
}

export async function prepareSkillUpdate(
  options: PrepareSkillUpdateOptions,
): Promise<PreparedSkillUpdate> {
  const inventory = await buildSkillUpdateInventory(
    options.workspacePath,
    options.scopes,
  );
  const plan = await buildSkillUpdatePreflight(
    {
      installations: inventory.installations,
      selectedScopes: options.scopes,
      ...(options.filters && { filters: options.filters }),
    },
    { inspectUnit: inspectSkillUpdateUnit },
  );
  return { inventory, plan };
}

async function moveCheckout(node: CheckoutNode, sha: string): Promise<void> {
  const git = simpleGit(node.cachePath);
  await git.raw(['fetch', '--depth', '1', 'origin', node.ref ?? 'HEAD']);
  try {
    await git.raw(['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    // Some servers do not include the exact preflight commit in the shallow
    // ref fetch. Try the immutable SHA before declaring the transaction failed.
    await git.raw(['fetch', '--depth', '1', 'origin', sha]);
  }
  await git.reset(['--hard', sha]);
}

async function restoreCheckout(
  node: CheckoutNode,
  sha: string,
): Promise<void> {
  const git = simpleGit(node.cachePath);
  await git.raw(['cat-file', '-e', `${sha}^{commit}`]);
  await git.reset(['--hard', sha]);
}

export async function executePreparedSkillUpdate(
  prepared: PreparedSkillUpdate,
  decisions: Record<string, SkillUpdateDecision>,
  workspacePath: string,
): Promise<SkillUpdateExecutionResult> {
  const result = await executeSkillUpdatePlan(prepared.plan, decisions, {
    advanceNode: moveCheckout,
    restoreNode: restoreCheckout,
    reconcileUnit: createSkillUpdateReconciler({ workspacePath }),
    syncScope: async (scope) => {
      resetFetchCache();
      const syncResult =
        scope === 'project'
          ? await syncWorkspace(workspacePath, { offline: true })
          : await syncUserWorkspace({ offline: true });
      return syncResult.success
        ? { success: true }
        : { success: false, error: `Offline ${scope} sync failed` };
    },
  });
  return result;
}

export function hasProjectSkillConfig(workspacePath: string): boolean {
  return existsSync(join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE));
}

export function unitDisplayName(
  unit: SkillUpdatePreflight['units'][number],
): string {
  const sources = [
    ...new Set(unit.installations.map((entry) => entry.rawSource)),
  ];
  return sources.length > 0 ? sources.join(', ') : basename(unit.id);
}

export interface SkillUpdateSummary {
  updated: number;
  removed: number;
  retained: number;
  skipped: number;
  failed: number;
  cancelled: number;
}

export function skillUpdateSummary(
  result: SkillUpdateExecutionResult,
): SkillUpdateSummary {
  const summary: SkillUpdateSummary = {
    updated: 0,
    removed: 0,
    retained: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const unit of result.units) {
    summary.updated += unit.skillCounts.updated;
    summary.removed += unit.skillCounts.removed;
    summary.retained += unit.skillCounts.retained;
    if (unit.status === 'retained' || unit.status === 'skipped') {
      summary.skipped += 1;
    } else if (unit.status === 'failed') {
      summary.failed += 1;
    } else if (unit.status === 'cancelled') {
      summary.cancelled += 1;
    }
  }
  return summary;
}

/** Map an orchestration result to the documented process exit contract. */
export function skillUpdateExitCode(result: SkillUpdateExecutionResult): number {
  if (result.cancelled) return 0;
  return result.success ? 0 : 1;
}
