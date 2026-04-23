import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { rm, unlink, rmdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import JSON5 from 'json5';
import {
  CONFIG_DIR,
  WORKSPACE_CONFIG_FILE,
  AGENT_FILES,
  getHomeDir,
} from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type {
  WorkspaceConfig,
  ClientType,
  PluginEntry,
  WorkspaceFile,
  SyncMode,
  PluginSkillsConfig,
} from '../models/workspace-config.js';
import {
  getPluginClients,
  getPluginSource,
  getPluginExclude,
  getClientTypes,
  normalizeClientEntry,
  resolveInstallMode,
  type ClientEntry,
} from '../models/workspace-config.js';
import {
  isGitHubUrl,
  parseGitHubUrl,
  parseFileSource,
} from '../utils/plugin-path.js';
import { fetchPlugin, getPluginName, seedFetchCache } from './plugin.js';
import {
  copyPluginToWorkspace,
  copyWorkspaceFiles,
  collectPluginSkills,
  type CopyResult,
} from './transform.js';
import { updateAgentFiles } from './workspace-repo.js';
import {
  discoverWorkspaceSkills,
  writeSkillsIndex,
  cleanupSkillsIndex,
  groupSkillsByRepo,
} from './repo-skills.js';
import {
  CLIENT_MAPPINGS,
  USER_CLIENT_MAPPINGS,
  CANONICAL_SKILLS_PATH,
  isUniversalClient,
  resolveClientMappings,
} from '../models/client-mapping.js';
import type { ClientMapping } from '../models/client-mapping.js';
import {
  resolveSkillNames,
  getSkillKey,
  type SkillEntry,
} from '../utils/skill-name-resolver.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
  ensureMarketplacesRegistered,
  parsePluginSpec,
  getMarketplaceOverrides,
  getRegistryPath,
  getProjectRegistryPath,
  getMarketplace,
} from './marketplace.js';
import {
  loadSyncState,
  saveSyncState,
  getPreviouslySyncedFiles,
  getPreviouslySyncedMcpServers,
  getPreviouslySyncedNativePlugins,
} from './sync-state.js';
import type { SyncState } from '../models/sync-state.js';
import {
  getUserWorkspaceConfig,
  migrateUserWorkspaceSkillsV1toV2,
} from './user-workspace.js';
import {
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  computeWorkspaceHash,
  reconcileVscodeWorkspaceFolders,
} from './vscode-workspace.js';
import {
  setRepositories,
  updateRepositories,
  migrateWorkspaceSkillsV1toV2,
} from './workspace-modify.js';
import { collectMcpServers, syncVscodeMcpConfig } from './vscode-mcp.js';
import type { McpMergeResult } from './vscode-mcp.js';
import { applyMcpProxy } from './mcp-proxy.js';
import { syncCodexMcpServers } from './codex-mcp.js';
import {
  syncClaudeMcpConfig,
  syncClaudeMcpServersViaCli,
} from './claude-mcp.js';
import { getCopilotMcpConfigPath } from './copilot-mcp.js';
import { syncMcpServers as runMcpSync } from './mcp-sync.js';
import {
  getNativeClient,
  mergeNativeSyncResults,
  type NativeSyncResult,
} from './native/index.js';
import { Stopwatch } from '../utils/stopwatch.js';
import { processManagedRepos } from './managed-repos.js';

/**
 * Result of deduplicating clients by skillsPath
 */
interface DeduplicatedClients {
  /** Representative client for each unique path (used for copying) */
  representativeClients: ClientType[];
  /** Map from representative client to all clients sharing that path */
  clientGroups: Map<ClientType, ClientType[]>;
}

/**
 * Deduplicate clients by their skillsPath to avoid copying skills multiple times
 * to the same directory when multiple clients share the same path.
 *
 * For example, copilot, codex, opencode, gemini, ampcode all use `.agents/skills/`,
 * so we only need to copy skills once but track files for all these clients.
 *
 * @param clients - List of clients to deduplicate
 * @param clientMappings - Client path mappings to use (defaults to CLIENT_MAPPINGS)
 * @returns Deduplicated result with representative clients and their groups
 */
export function deduplicateClientsByPath(
  clients: ClientType[],
  clientMappings: Record<string, ClientMapping> = CLIENT_MAPPINGS,
): DeduplicatedClients {
  // Group clients by their skillsPath
  const pathToClients = new Map<string, ClientType[]>();

  for (const client of clients) {
    const mapping = clientMappings[client];
    // Use skillsPath as the grouping key, or a unique key for clients without skillsPath
    const pathKey = mapping?.skillsPath || `__no_skills_${client}__`;

    const existing = pathToClients.get(pathKey) || [];
    existing.push(client);
    pathToClients.set(pathKey, existing);
  }

  // Build result: use first client in each group as representative
  const representativeClients: ClientType[] = [];
  const clientGroups = new Map<ClientType, ClientType[]>();

  for (const clientsInGroup of pathToClients.values()) {
    const representative = clientsInGroup[0];
    if (representative) {
      representativeClients.push(representative);
      clientGroups.set(representative, clientsInGroup);
    }
  }

  return { representativeClients, clientGroups };
}

/**
 * Result of a sync operation
 */
/**
 * A named artifact (skill, command, hook, or agent) that was deleted during sync
 * because it was no longer provided by any plugin.
 */
export interface DeletedArtifact {
  client: ClientType;
  type: 'skill' | 'command' | 'agent' | 'hook';
  name: string;
}

export interface SyncResult {
  success: boolean;
  pluginResults: PluginSyncResult[];
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
  totalGenerated: number;
  /** Paths that were/would be purged per client */
  purgedPaths?: PurgePaths[];
  /** Named artifacts that were deleted and not re-synced by any plugin */
  deletedArtifacts?: DeletedArtifact[];
  error?: string;
  /** Warnings for plugins that were skipped during sync */
  warnings?: string[];
  /** Informational messages (non-warning) */
  messages?: string[];
  /** Results of syncing MCP server configs, keyed by scope (e.g., 'vscode', 'codex') */
  mcpResults?: Record<string, McpMergeResult>;
  /** Result of native CLI plugin installations */
  nativeResult?: NativeSyncResult;
  /** Timing data for sync steps (when available) */
  timing?: {
    totalMs: number;
    steps: Array<{ label: string; durationMs: number; detail?: string }>;
  };
  /** Results of managed repository clone/pull operations */
  managedRepoResults?: import('./managed-repos.js').ManagedRepoResult[];
}

/**
 * Merge two SyncResult objects into one combined result.
 */
export function mergeSyncResults(a: SyncResult, b: SyncResult): SyncResult {
  const warnings = [...(a.warnings || []), ...(b.warnings || [])];
  const messages = [...(a.messages || []), ...(b.messages || [])];
  const purgedPaths = [...(a.purgedPaths || []), ...(b.purgedPaths || [])];
  const deletedArtifacts = [
    ...(a.deletedArtifacts || []),
    ...(b.deletedArtifacts || []),
  ];
  const mcpResults =
    a.mcpResults || b.mcpResults
      ? { ...a.mcpResults, ...b.mcpResults }
      : undefined;
  // Merge nativeResults when both scopes produce them
  const nativeResult =
    a.nativeResult && b.nativeResult
      ? {
          marketplacesAdded: [
            ...a.nativeResult.marketplacesAdded,
            ...b.nativeResult.marketplacesAdded,
          ],
          pluginsInstalled: [
            ...a.nativeResult.pluginsInstalled,
            ...b.nativeResult.pluginsInstalled,
          ],
          pluginsFailed: [
            ...a.nativeResult.pluginsFailed,
            ...b.nativeResult.pluginsFailed,
          ],
          skipped: [...a.nativeResult.skipped, ...b.nativeResult.skipped],
        }
      : (a.nativeResult ?? b.nativeResult);
  return {
    success: a.success && b.success,
    pluginResults: [...a.pluginResults, ...b.pluginResults],
    totalCopied: a.totalCopied + b.totalCopied,
    totalFailed: a.totalFailed + b.totalFailed,
    totalSkipped: a.totalSkipped + b.totalSkipped,
    totalGenerated: a.totalGenerated + b.totalGenerated,
    ...(warnings.length > 0 && { warnings }),
    ...(messages.length > 0 && { messages }),
    ...(purgedPaths.length > 0 && { purgedPaths }),
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(mcpResults && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    ...(() => {
      const managedRepoResults = [
        ...(a.managedRepoResults || []),
        ...(b.managedRepoResults || []),
      ];
      return managedRepoResults.length > 0 ? { managedRepoResults } : {};
    })(),
    ...mergeTiming(a.timing, b.timing),
  };
}

function mergeTiming(
  a?: SyncResult['timing'],
  b?: SyncResult['timing'],
): { timing: NonNullable<SyncResult['timing']> } | Record<string, never> {
  if (!a && !b) return {};
  const aSteps = (a?.steps ?? []).map((s) => ({
    ...s,
    label: `user:${s.label}`,
  }));
  const bSteps = (b?.steps ?? []).map((s) => ({
    ...s,
    label: `project:${s.label}`,
  }));
  return {
    timing: {
      totalMs: (a?.totalMs ?? 0) + (b?.totalMs ?? 0),
      steps: [...aSteps, ...bSteps],
    },
  };
}

/**
 * Result of syncing a single plugin
 */
export interface PluginSyncResult {
  plugin: string;
  resolved: string;
  success: boolean;
  copyResults: CopyResult[];
  error?: string;
  /** Whether this plugin was synced at project or user scope */
  scope?: 'project' | 'user';
}

/**
 * Options for workspace sync
 */
export interface SyncOptions {
  /** Skip fetching from remote and use cached version if available */
  offline?: boolean;
  /** Simulate sync without making changes */
  dryRun?: boolean;
  /**
   * Base path for resolving relative workspace.source paths.
   * Used during init to resolve paths relative to the --from source directory
   * instead of the target workspace. If not provided, defaults to workspacePath.
   */
  workspaceSourceBase?: string;
  /** Skip updating AGENTS.md and other generated agent files. Use for plugin-only updates. */
  skipAgentFiles?: boolean;
  /** Skip managed repository clone/pull operations */
  skipManaged?: boolean;
}

/**
 * Result of validating a plugin (resolving its path without copying)
 */
export interface ValidatedPlugin {
  plugin: string;
  resolved: string;
  success: boolean;
  clients: ClientType[];
  /** Clients that should use native install for this plugin */
  nativeClients: ClientType[];
  error?: string;
  /** Plugin name from marketplace manifest (overrides directory name) */
  pluginName?: string;
  /** Canonical marketplace name when it differs from the spec (e.g., manifest overrides repo name) */
  registeredAs?: string;
  /** GitHub marketplace source (owner/repo) for native CLI registration */
  marketplaceSource?: string;
  /** Glob patterns of files to exclude when syncing (from workspace.yaml) */
  exclude?: string[];
  /** Inline skill selection config from plugin entry (v2+) */
  pluginSkillsConfig?: PluginSkillsConfig;
}

export interface PluginSyncPlan {
  source: string;
  clients: ClientType[];
  /** Clients that should use native install for this plugin */
  nativeClients: ClientType[];
  /** Glob patterns of files to exclude when syncing (from workspace.yaml) */
  exclude?: string[];
  /** Inline skill selection config from plugin entry (v2+) */
  pluginSkillsConfig?: PluginSkillsConfig;
}

/**
 * Build a native-friendly plugin spec using the canonical marketplace name.
 * When a marketplace manifest overrides the repo name (e.g., repo "WTG.AI.Prompts"
 * → manifest name "wtg-ai-prompts"), the native CLI only knows the canonical name.
 *
 * Returns the canonical spec and, if applicable, the original owner/repo source
 * needed to pre-register the marketplace with the native CLI.
 */
function resolveNativePluginSource(vp: ValidatedPlugin): {
  spec: string;
  marketplaceSource?: string;
} {
  if (!vp.registeredAs) {
    return {
      spec: vp.plugin,
      ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
    };
  }

  const parsed = parsePluginSpec(vp.plugin);
  if (!parsed) {
    return {
      spec: vp.plugin,
      ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
    };
  }

  const canonicalSpec = `${parsed.plugin}@${vp.registeredAs}`;
  if (parsed.owner && parsed.repo) {
    return {
      spec: canonicalSpec,
      marketplaceSource: `${parsed.owner}/${parsed.repo}`,
    };
  }
  return {
    spec: canonicalSpec,
    ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
  };
}

/**
 * Collect native plugin specs and marketplace sources from validated plugins.
 * Resolves canonical marketplace names so native CLI operations use the correct spec.
 */
export function collectNativePluginSources(validPlugins: ValidatedPlugin[]): {
  pluginsByClient: Map<ClientType, string[]>;
  marketplaceSourcesByClient: Map<ClientType, Set<string>>;
} {
  const pluginsByClient = new Map<ClientType, string[]>();
  const marketplaceSourcesByClient = new Map<ClientType, Set<string>>();

  for (const vp of validPlugins) {
    for (const client of vp.nativeClients) {
      const existing = pluginsByClient.get(client) ?? [];
      const { spec, marketplaceSource } = resolveNativePluginSource(vp);
      existing.push(spec);
      pluginsByClient.set(client, existing);

      if (marketplaceSource) {
        const sources = marketplaceSourcesByClient.get(client) ?? new Set();
        sources.add(marketplaceSource);
        marketplaceSourcesByClient.set(client, sources);
      }
    }
  }

  return { pluginsByClient, marketplaceSourcesByClient };
}

function attachNativeClientContext(
  result: NativeSyncResult,
  clientType: ClientType,
): NativeSyncResult {
  return {
    ...result,
    pluginsInstalled: result.pluginsInstalled.map((installed) => ({
      ...installed,
      client: clientType,
    })),
    pluginsFailed: result.pluginsFailed.map((failure) => ({
      ...failure,
      client: clientType,
    })),
  };
}

export function collectSyncClients(
  clientEntries: ClientEntry[],
  plans: PluginSyncPlan[],
): ClientType[] {
  const workspaceClientTypes = getClientTypes(clientEntries);
  return [
    ...new Set([
      ...workspaceClientTypes,
      ...plans.flatMap((plan) => [...plan.clients, ...plan.nativeClients]),
    ]),
  ];
}

/**
 * Paths that would be purged for a client
 */
export interface PurgePaths {
  client: ClientType;
  paths: string[];
}

/**
 * Purge all managed directories for configured clients
 * This removes commands, skills, hooks directories and agent files
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to purge
 * @returns List of paths that were purged per client
 */
export async function purgeWorkspace(
  workspacePath: string,
  clients: ClientType[],
): Promise<PurgePaths[]> {
  const result: PurgePaths[] = [];

  for (const client of clients) {
    const mapping = CLIENT_MAPPINGS[client];
    const purgedPaths: string[] = [];

    // Purge commands directory
    if (mapping.commandsPath) {
      const commandsDir = join(workspacePath, mapping.commandsPath);
      await rm(commandsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.commandsPath);
    }

    // Purge skills directory
    if (mapping.skillsPath) {
      const skillsDir = join(workspacePath, mapping.skillsPath);
      await rm(skillsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.skillsPath);
    }

    // Purge hooks directory
    if (mapping.hooksPath) {
      const hooksDir = join(workspacePath, mapping.hooksPath);
      await rm(hooksDir, { recursive: true, force: true });
      purgedPaths.push(mapping.hooksPath);
    }

    // Purge agents directory
    if (mapping.agentsPath) {
      const agentsDir = join(workspacePath, mapping.agentsPath);
      await rm(agentsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.agentsPath);
    }

    // Purge agent file
    const agentPath = join(workspacePath, mapping.agentFile);
    if (existsSync(agentPath)) {
      await rm(agentPath);
      purgedPaths.push(mapping.agentFile);
    }

    result.push({ client, paths: purgedPaths });
  }

  return result;
}

/**
 * Get paths that would be purged without actually purging
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to check
 * @returns List of paths that would be purged per client
 */
export function getPurgePaths(
  workspacePath: string,
  clients: ClientType[],
): PurgePaths[] {
  const result: PurgePaths[] = [];

  for (const client of clients) {
    const mapping = CLIENT_MAPPINGS[client];
    const paths: string[] = [];

    // Check commands directory
    if (
      mapping.commandsPath &&
      existsSync(join(workspacePath, mapping.commandsPath))
    ) {
      paths.push(mapping.commandsPath);
    }

    // Check skills directory
    if (
      mapping.skillsPath &&
      existsSync(join(workspacePath, mapping.skillsPath))
    ) {
      paths.push(mapping.skillsPath);
    }

    // Check hooks directory
    if (
      mapping.hooksPath &&
      existsSync(join(workspacePath, mapping.hooksPath))
    ) {
      paths.push(mapping.hooksPath);
    }

    // Check agents directory
    if (
      mapping.agentsPath &&
      existsSync(join(workspacePath, mapping.agentsPath))
    ) {
      paths.push(mapping.agentsPath);
    }

    // Check agent file
    if (existsSync(join(workspacePath, mapping.agentFile))) {
      paths.push(mapping.agentFile);
    }

    if (paths.length > 0) {
      result.push({ client, paths });
    }
  }

  return result;
}

/**
 * Selectively purge only files that were previously synced
 * Non-destructive: preserves user-created files
 * @param workspacePath - Path to workspace directory
 * @param state - Previous sync state (if null, skips purge entirely)
 * @param clients - List of clients to purge files for
 * @returns List of paths that were purged per client
 */
export async function selectivePurgeWorkspace(
  workspacePath: string,
  state: SyncState | null,
  clients: ClientType[],
): Promise<PurgePaths[]> {
  // First sync - no state, skip purge entirely (safe overlay)
  if (!state) {
    return [];
  }

  const result: PurgePaths[] = [];

  // Get all clients that have files in the previous state
  const previousClients = Object.keys(state.files) as ClientType[];

  // Include both current clients AND clients that were removed from config.
  // Removed clients must be purged to avoid orphaned files on disk when a user
  // removes a client from workspace.yaml (e.g., removes 'copilot' from clients list).
  const clientsToProcess = [...new Set([...clients, ...previousClients])];

  for (const client of clientsToProcess) {
    const previousFiles = getPreviouslySyncedFiles(state, client);
    const purgedPaths: string[] = [];

    // Delete each previously synced file
    for (const filePath of previousFiles) {
      const fullPath = join(workspacePath, filePath);

      // Use lstatSync instead of existsSync — existsSync follows symlinks,
      // so broken symlinks (target already deleted) return false and get skipped.
      // Since we track synced files in state, if it's tracked we should remove it.
      // Strip trailing slash so lstatSync checks the symlink entry itself.
      const cleanPath = fullPath.replace(/\/$/, '');
      let stats: ReturnType<typeof lstatSync>;
      try {
        stats = lstatSync(cleanPath);
      } catch {
        continue;
      }

      try {
        // Check if it's a symlink - these need special handling
        // (rm with trailing slash on a symlink fails with ENOTDIR)
        if (stats.isSymbolicLink()) {
          // Remove symlink (works without trailing slash)
          await unlink(cleanPath);
        } else if (filePath.endsWith('/')) {
          // Regular directory - remove recursively
          await rm(fullPath, { recursive: true, force: true });
        } else {
          // Regular file
          await unlink(fullPath);
        }
        purgedPaths.push(filePath);

        // Clean up empty parent directories
        await cleanupEmptyParents(workspacePath, filePath);
      } catch {
        // Best effort - continue with other files
      }
    }

    if (purgedPaths.length > 0) {
      result.push({ client, paths: purgedPaths });
    }
  }

  return result;
}

/**
 * Clean up empty parent directories after file deletion
 * Stops at workspace root
 */
async function cleanupEmptyParents(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  let parentPath = dirname(filePath);

  while (parentPath && parentPath !== '.' && parentPath !== '/') {
    const fullParentPath = join(workspacePath, parentPath);

    if (!existsSync(fullParentPath)) {
      parentPath = dirname(parentPath);
      continue;
    }

    try {
      // rmdir only works on empty directories - will throw if not empty
      await rmdir(fullParentPath);
      parentPath = dirname(parentPath);
    } catch {
      // Directory not empty or other error - stop climbing
      break;
    }
  }
}

/**
 * Collected GitHub repository info for file sources
 */
interface GitHubRepoInfo {
  owner: string;
  repo: string;
  key: string; // "owner/repo" for deduplication
}

/**
 * Collect unique GitHub repositories from workspace file sources
 * @param files - Array of workspace file entries
 * @returns Array of unique GitHub repo info
 */
/**
 * Check if a source string is an explicit GitHub reference (for repo collection)
 * More conservative than isGitHubUrl - requires 3+ segments for shorthand format
 */
function isExplicitGitHubSourceForCollection(source: string): boolean {
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format, require at least 3 segments (owner/repo/path)
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    source.includes('/')
  ) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (
        parts[0] &&
        parts[1] &&
        validOwnerRepo.test(parts[0]) &&
        validOwnerRepo.test(parts[1])
      ) {
        return true;
      }
    }
  }

  return false;
}

function collectGitHubReposFromFiles(files: WorkspaceFile[]): GitHubRepoInfo[] {
  const repos = new Map<string, GitHubRepoInfo>();

  for (const file of files) {
    // Only object entries can have explicit GitHub sources
    if (typeof file === 'string') {
      continue;
    }

    // Check if the file has an explicit source that's a GitHub URL
    // Use conservative check to avoid treating local paths like "config/file.json" as GitHub
    if (file.source && isExplicitGitHubSourceForCollection(file.source)) {
      const parsed = parseFileSource(file.source);
      if (parsed.type === 'github' && parsed.owner && parsed.repo) {
        const key = `${parsed.owner}/${parsed.repo}`;
        if (!repos.has(key)) {
          repos.set(key, {
            owner: parsed.owner,
            repo: parsed.repo,
            key,
          });
        }
      }
    }
  }

  return Array.from(repos.values());
}

/**
 * Fetch GitHub repositories for file sources and build cache map
 * @param repos - Array of GitHub repo info to fetch
 * @returns Map from "owner/repo" to cache path, and any errors
 */
async function fetchFileSourceRepos(
  repos: GitHubRepoInfo[],
): Promise<{ cache: Map<string, string>; errors: string[] }> {
  const cache = new Map<string, string>();
  const errors: string[] = [];

  for (const repo of repos) {
    // File sources always pull latest (default behavior)
    const result = await fetchPlugin(`${repo.owner}/${repo.repo}`);

    if (result.success) {
      cache.set(repo.key, result.cachePath);
    } else {
      errors.push(
        `Failed to fetch ${repo.key}: ${result.error || 'Unknown error'}`,
      );
    }
  }

  return { cache, errors };
}

/**
 * Check if a source string is an explicit GitHub reference (for validation)
 * Matches the logic in transform.ts isExplicitGitHubSource
 */
function isExplicitGitHubSourceForValidation(source: string): boolean {
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format, require at least 3 segments (owner/repo/path)
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    source.includes('/')
  ) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (
        parts[0] &&
        parts[1] &&
        validOwnerRepo.test(parts[0]) &&
        validOwnerRepo.test(parts[1])
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validate that file sources exist (for GitHub sources, check path in cache)
 * @param files - Array of workspace file entries
 * @param defaultSourcePath - Default source path for files without explicit source
 * @param githubCache - Map of owner/repo to cache paths
 * @returns Array of validation errors
 */
function validateFileSources(
  files: WorkspaceFile[],
  defaultSourcePath: string | undefined,
  githubCache: Map<string, string>,
): string[] {
  const errors: string[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      // String entries are resolved relative to defaultSourcePath
      if (!defaultSourcePath) {
        errors.push(
          `Cannot resolve file '${file}' - no workspace.source configured`,
        );
        continue;
      }
      const fullPath = join(defaultSourcePath, file);
      if (!existsSync(fullPath)) {
        errors.push(`File source not found: ${fullPath}`);
      }
      continue;
    }

    // Object entry
    if (file.source) {
      // Has explicit source - check if it's GitHub or local
      if (isExplicitGitHubSourceForValidation(file.source)) {
        // GitHub source - validate path exists in cache
        const parsed = parseFileSource(file.source);
        if (!parsed.owner || !parsed.repo || !parsed.filePath) {
          errors.push(
            `Invalid GitHub file source: ${file.source}. Must include path to file.`,
          );
          continue;
        }
        const cacheKey = `${parsed.owner}/${parsed.repo}`;
        const cachePath = githubCache.get(cacheKey);
        if (!cachePath) {
          errors.push(`GitHub cache not found for ${cacheKey}`);
          continue;
        }
        const fullPath = join(cachePath, parsed.filePath);
        if (!existsSync(fullPath)) {
          errors.push(
            `Path not found in repository: ${cacheKey}/${parsed.filePath}`,
          );
        }
      } else {
        // Local path with explicit source
        let fullPath: string;
        if (file.source.startsWith('/')) {
          // Absolute path
          fullPath = file.source;
        } else if (file.source.startsWith('../')) {
          // Relative path going "up" - resolve from workspace root (cwd)
          fullPath = resolve(file.source);
        } else if (defaultSourcePath) {
          // Relative path within source - resolve from defaultSourcePath
          fullPath = join(defaultSourcePath, file.source);
        } else {
          // No defaultSourcePath - resolve from cwd
          fullPath = resolve(file.source);
        }
        if (!existsSync(fullPath)) {
          errors.push(`File source not found: ${fullPath}`);
        }
      }
    } else {
      // No explicit source - resolve relative to defaultSourcePath
      if (!defaultSourcePath) {
        errors.push(
          `Cannot resolve file '${file.dest}' - no workspace.source configured and no explicit source provided`,
        );
        continue;
      }
      const fullPath = join(defaultSourcePath, file.dest ?? '');
      if (!existsSync(fullPath)) {
        errors.push(`File source not found: ${fullPath}`);
      }
    }
  }

  return errors;
}

/**
 * Collect synced file paths from copy results, grouped by client
 *
 * When multiple clients share the same skillsPath (e.g., copilot, codex, opencode
 * all use `.agents/skills/`), the file is tracked for ALL clients that share that path.
 * This ensures proper cleanup when any of those clients is removed from the config.
 *
 * @param copyResults - Array of copy results from plugins
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to track
 * @param clientMappings - Optional client path mappings (defaults to CLIENT_MAPPINGS)
 * @returns Per-client file lists
 */
export function collectSyncedPaths(
  copyResults: CopyResult[],
  workspacePath: string,
  clients: ClientType[],
  clientMappings?: Record<string, ClientMapping>,
): Partial<Record<ClientType, string[]>> {
  const result: Partial<Record<ClientType, string[]>> = {};
  const mappings = clientMappings ?? CLIENT_MAPPINGS;

  // Initialize arrays for each client
  for (const client of clients) {
    result[client] = [];
  }

  for (const copyResult of copyResults) {
    if (copyResult.action !== 'copied' && copyResult.action !== 'generated') {
      continue;
    }

    // Get relative path from workspace (normalize to forward slashes for cross-platform consistency)
    const relativePath = relative(
      workspacePath,
      copyResult.destination,
    ).replace(/\\/g, '/');

    // Track file for ALL clients whose paths match (not just the first one)
    // This is important when multiple clients share the same skillsPath
    for (const client of clients) {
      const mapping = mappings[client];

      // Check if this is a skill directory (copy results for skills point to the dir)
      // e.g., relativePath = '.agents/skills/my-skill', skillsPath = '.agents/skills/'
      if (mapping.skillsPath && relativePath.startsWith(mapping.skillsPath)) {
        const skillName = relativePath.slice(mapping.skillsPath.length);
        // If skillName has no '/', this is a skill directory (not a file inside)
        if (!skillName.includes('/')) {
          // Track skill directory with trailing / for efficient rm -rf
          result[client]?.push(`${relativePath}/`);
          continue; // Don't break - check other clients too
        }
      }

      // Check if file belongs to this client's paths
      if (
        (mapping.commandsPath &&
          relativePath.startsWith(mapping.commandsPath)) ||
        (mapping.skillsPath && relativePath.startsWith(mapping.skillsPath)) ||
        (mapping.hooksPath && relativePath.startsWith(mapping.hooksPath)) ||
        (mapping.agentsPath && relativePath.startsWith(mapping.agentsPath)) ||
        relativePath === mapping.agentFile ||
        (mapping.agentFileFallback &&
          relativePath === mapping.agentFileFallback)
      ) {
        result[client]?.push(relativePath);
        // Don't break - continue checking other clients that might share this path
      }
    }
  }

  return result;
}

/**
 * Classify a single sync-state path into a named artifact for a given client.
 * Returns null for paths that are not top-level artifacts or not part of the
 * managed artifact directories (e.g. files nested inside a skill directory are
 * skipped – the skill directory entry itself is sufficient).
 */
function classifyDeletedPath(
  path: string,
  client: ClientType,
  mapping: ClientMapping,
): DeletedArtifact | null {
  // Skills are tracked as "<skillsPath><name>/" (trailing slash) by collectSyncedPaths.
  // Files inside a skill directory are also stored, but we skip them to avoid duplicates.
  if (mapping.skillsPath && path.startsWith(mapping.skillsPath)) {
    const rest = path.slice(mapping.skillsPath.length);
    if (rest.endsWith('/') && !rest.slice(0, -1).includes('/')) {
      return { client, type: 'skill', name: rest.slice(0, -1) };
    }
    return null;
  }

  if (mapping.commandsPath && path.startsWith(mapping.commandsPath)) {
    const rest = path.slice(mapping.commandsPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return { client, type: 'command', name: topLevel.replace(/\.md$/i, '') };
  }

  if (mapping.hooksPath && path.startsWith(mapping.hooksPath)) {
    const rest = path.slice(mapping.hooksPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return { client, type: 'hook', name: topLevel.replace(/\.md$/i, '') };
  }

  if (mapping.agentsPath && path.startsWith(mapping.agentsPath)) {
    const rest = path.slice(mapping.agentsPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return { client, type: 'agent', name: topLevel.replace(/\.md$/i, '') };
  }

  return null;
}

/**
 * Compute which named artifacts were deleted during sync by comparing the
 * previous sync state with the paths that were re-synced in this run.
 *
 * An artifact is considered deleted when it existed in the previous state but
 * is not present in the new state (i.e. no plugin re-provided it).
 *
 * Skills that are still available in installed plugins but just not synced
 * (disabled via --skill) are excluded — they are not truly deleted.
 */
export function computeDeletedArtifacts(
  previousState: SyncState | null,
  newStatePaths: Partial<Record<ClientType, string[]>>,
  clients: ClientType[],
  clientMappings: Record<string, ClientMapping>,
  availableSkillNames?: Set<string>,
): DeletedArtifact[] {
  if (!previousState) return [];

  const deleted: DeletedArtifact[] = [];
  const seen = new Set<string>();

  for (const client of clients) {
    const oldPaths = previousState.files[client] ?? [];
    const newPaths = new Set(newStatePaths[client] ?? []);
    const mapping = clientMappings[client];
    if (!mapping) continue;

    for (const path of oldPaths) {
      if (newPaths.has(path)) continue;

      const artifact = classifyDeletedPath(path, client, mapping);
      if (!artifact) continue;

      // Skip skills that still exist in installed plugins but are just disabled
      if (artifact.type === 'skill' && availableSkillNames?.has(artifact.name))
        continue;

      const key = `${client}:${artifact.type}:${artifact.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        deleted.push(artifact);
      }
    }
  }

  return deleted;
}

/**
 * Collect all skill folder names from installed plugins, regardless of
 * enabled/disabled state. Used by computeDeletedArtifacts to distinguish
 * truly deleted skills from ones that are just disabled.
 */
async function collectAvailableSkillNames(
  validPlugins: ValidatedPlugin[],
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const plugin of validPlugins) {
    const skills = await collectPluginSkills(plugin.resolved, plugin.plugin);
    for (const skill of skills) {
      names.add(skill.folderName);
    }
  }
  return names;
}

/**
 * Validate a single plugin by resolving its path without copying
 * @param workspacePath - Path to workspace directory
 * @param offline - Skip fetching from remote and use cached version
 * @returns Validation result with resolved path
 */
async function validatePlugin(
  pluginSource: string,
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin> {
  // Check for plugin@marketplace format first
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, {
      offline,
      workspacePath,
    });
    if (!resolved.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        clients: [],
        nativeClients: [],
        error: resolved.error || 'Unknown error',
      };
    }
    return {
      plugin: pluginSource,
      resolved: resolved.path ?? '',
      success: true,
      clients: [],
      nativeClients: [],
      ...(resolved.pluginName && { pluginName: resolved.pluginName }),
      ...(resolved.registeredAs && { registeredAs: resolved.registeredAs }),
      ...(resolved.marketplaceSource && {
        marketplaceSource: resolved.marketplaceSource,
      }),
    };
  }

  if (isGitHubUrl(pluginSource)) {
    // Parse URL to extract branch and subpath
    const parsed = parseGitHubUrl(pluginSource);

    // Fetch remote plugin (with offline option and branch if specified)
    const fetchResult = await fetchPlugin(pluginSource, {
      offline,
      ...(parsed?.branch && { branch: parsed.branch }),
    });
    if (!fetchResult.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        clients: [],
        nativeClients: [],
        ...(fetchResult.error && { error: fetchResult.error }),
      };
    }
    // Handle subpath in GitHub URL (e.g., /tree/main/plugins/name)
    const resolvedPath = parsed?.subpath
      ? join(fetchResult.cachePath, parsed.subpath)
      : fetchResult.cachePath;
    return {
      plugin: pluginSource,
      resolved: resolvedPath,
      success: true,
      clients: [],
      nativeClients: [],
    };
  }

  // Local plugin
  const resolvedPath = resolve(workspacePath, pluginSource);
  if (!existsSync(resolvedPath)) {
    return {
      plugin: pluginSource,
      resolved: resolvedPath,
      success: false,
      clients: [],
      nativeClients: [],
      error: `Plugin not found at ${resolvedPath}`,
    };
  }
  return {
    plugin: pluginSource,
    resolved: resolvedPath,
    success: true,
    clients: [],
    nativeClients: [],
  };
}

/**
 * Build plugin sync plans with effective clients per plugin.
 * Effective clients are plugin.clients when provided, otherwise workspace clients.
 */
export function buildPluginSyncPlans(
  plugins: PluginEntry[],
  clientEntries: ClientEntry[],
  scope: 'user' | 'project',
): { plans: PluginSyncPlan[]; warnings: string[] } {
  const warnings: string[] = [];
  const workspaceClientTypes = getClientTypes(clientEntries);

  const plans = plugins.map((plugin) => {
    const source = getPluginSource(plugin);
    const pluginClientTypes = getPluginClients(plugin) ?? workspaceClientTypes;

    if (pluginClientTypes.length === 0) {
      warnings.push(
        `${source} has no clients configured and was not synced. Add clients to workspace.yaml or specify clients on the plugin entry.`,
      );
    }

    const effectiveClients = pluginClientTypes;

    // Split into file and native clients based on resolved install mode
    const fileClients: ClientType[] = [];
    const nativeClients: ClientType[] = [];

    for (const client of effectiveClients) {
      const clientEntry = normalizeClientEntry(
        clientEntries.find(
          (e) => (typeof e === 'string' ? e : e.name) === client,
        ) ?? client,
      );
      const mode = resolveInstallMode(plugin, clientEntry);

      // Check if this client supports native install AND the plugin is marketplace-based for this client
      const nativeClient = mode === 'native' ? getNativeClient(client) : null;
      if (nativeClient && nativeClient.toPluginSpec(source) !== null) {
        if (nativeClient.supportsScope(scope)) {
          nativeClients.push(client);
        } else {
          fileClients.push(client);
          warnings.push(
            `${client} native install only supports user scope, falling back to file copy`,
          );
        }
      } else {
        fileClients.push(client);
      }
    }

    const exclude = getPluginExclude(plugin);
    const pluginSkillsConfig =
      typeof plugin === 'string' ? undefined : plugin.skills;
    return {
      source,
      clients: fileClients,
      nativeClients,
      ...(exclude && { exclude }),
      ...(pluginSkillsConfig !== undefined && { pluginSkillsConfig }),
    };
  });

  return { plans, warnings };
}

/**
 * Validate all plugins before any destructive action
 * @param plans - List of plugin sync plans
 * @param workspacePath - Path to workspace directory
 * @param offline - Skip fetching from remote and use cached version
 * @returns Array of validation results
 */
export async function validateAllPlugins(
  plans: PluginSyncPlan[],
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin[]> {
  return Promise.all(
    plans.map(
      async ({
        source,
        clients,
        nativeClients,
        exclude,
        pluginSkillsConfig,
      }) => {
        const validated = await validatePlugin(source, workspacePath, offline);
        const result: ValidatedPlugin = {
          ...validated,
          clients,
          nativeClients,
        };
        if (exclude) result.exclude = exclude;
        if (pluginSkillsConfig !== undefined)
          result.pluginSkillsConfig = pluginSkillsConfig;
        return result;
      },
    ),
  );
}

/**
 * Copy content from a validated plugin to workspace
 *
 * Uses deduplication to avoid copying skills multiple times when clients share
 * the same skillsPath. For example, if copilot, codex, and opencode all use
 * `.agents/skills/`, skills will only be copied once.
 *
 * When syncMode is 'symlink':
 * 1. First copy skills to canonical .agents/skills/ location
 * 2. For non-universal clients, create symlinks from their paths to canonical
 *
 * @param validatedPlugin - Already validated plugin with resolved path
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param dryRun - Simulate without making changes
 * @param skillNameMap - Optional map of skill folder names to resolved names
 * @param clientMappings - Optional client path mappings (defaults to CLIENT_MAPPINGS)
 * @param syncMode - Sync mode ('symlink' or 'copy', defaults to 'symlink')
 * @returns Plugin sync result
 */
async function copyValidatedPlugin(
  validatedPlugin: ValidatedPlugin,
  workspacePath: string,
  clients: ClientType[],
  dryRun: boolean,
  skillNameMap?: Map<string, string>,
  clientMappings?: Record<string, ClientMapping>,
  syncMode: SyncMode = 'symlink',
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];
  const mappings = resolveClientMappings(
    clients,
    clientMappings ?? CLIENT_MAPPINGS,
  );
  const clientList = clients;

  const exclude = validatedPlugin.exclude;

  const hasUniversalClient = clientList.some((c) => isUniversalClient(c));

  if (syncMode === 'symlink' && hasUniversalClient) {
    // Symlink mode with universal: copy to canonical .agents/skills/, symlink from client paths
    //
    // Phase 1: Copy skills to canonical location using deduplication
    // This ensures canonical is only copied once, and tracked under the universal client
    const { representativeClients } = deduplicateClientsByPath(
      clientList,
      mappings,
    );

    // Phase 2: Copy for each representative client
    for (const representative of representativeClients) {
      if (isUniversalClient(representative)) {
        // Universal client: copy directly to canonical .agents/skills/
        const results = await copyPluginToWorkspace(
          validatedPlugin.resolved,
          workspacePath,
          representative,
          {
            dryRun,
            ...(skillNameMap && { skillNameMap }),
            clientMappings: mappings,
            syncMode: 'copy',
            ...(exclude && { exclude }),
          },
        );
        copyResults.push(...results);
      } else {
        // Non-universal client: create symlinks to canonical
        const results = await copyPluginToWorkspace(
          validatedPlugin.resolved,
          workspacePath,
          representative,
          {
            dryRun,
            ...(skillNameMap && { skillNameMap }),
            clientMappings: mappings,
            syncMode: 'symlink',
            canonicalSkillsPath: CANONICAL_SKILLS_PATH,
            ...(exclude && { exclude }),
          },
        );
        copyResults.push(...results);
      }
    }
  } else {
    // No universal client or copy mode: copy directly to each client's path
    const { representativeClients } = deduplicateClientsByPath(
      clientList,
      mappings,
    );

    for (const client of representativeClients) {
      const results = await copyPluginToWorkspace(
        validatedPlugin.resolved,
        workspacePath,
        client,
        {
          dryRun,
          ...(skillNameMap && { skillNameMap }),
          clientMappings: mappings,
          syncMode: 'copy',
          ...(exclude && { exclude }),
        },
      );
      copyResults.push(...results);
    }
  }

  const hasFailures = copyResults.some((r) => r.action === 'failed');

  return {
    plugin: validatedPlugin.plugin,
    resolved: validatedPlugin.resolved,
    success: !hasFailures,
    copyResults,
  };
}

/**
 * Collected skill information with plugin context for name resolution
 */
interface CollectedSkillEntry {
  /** Skill folder name */
  folderName: string;
  /** Plugin name (directory name) */
  pluginName: string;
  /** Plugin source reference */
  pluginSource: string;
  /** Resolved plugin path */
  pluginPath: string;
}

/**
 * Collect all skills from all validated plugins
 * This is the first pass of two-pass name resolution
 * @param validatedPlugins - Array of validated plugins with resolved paths
 * @param disabledSkills - Optional set of disabled skill keys (v1 fallback)
 * @param enabledSkills - Optional set of enabled skill keys (v1 fallback)
 * @returns Array of collected skill entries
 */
async function collectAllSkills(
  validatedPlugins: ValidatedPlugin[],
  disabledSkills?: Set<string>,
  enabledSkills?: Set<string>,
): Promise<CollectedSkillEntry[]> {
  const allSkills: CollectedSkillEntry[] = [];

  for (const plugin of validatedPlugins) {
    const pluginName = plugin.pluginName ?? getPluginName(plugin.resolved);
    const skills = await collectPluginSkills(
      plugin.resolved,
      plugin.plugin,
      disabledSkills,
      pluginName,
      enabledSkills,
      plugin.pluginSkillsConfig,
    );

    for (const skill of skills) {
      allSkills.push({
        folderName: skill.folderName,
        pluginName,
        pluginSource: plugin.plugin,
        pluginPath: plugin.resolved,
      });
    }
  }

  return allSkills;
}

/**
 * Build skill name maps for each plugin based on resolved names
 * @param allSkills - Collected skills from all plugins
 * @returns Map from plugin path to skill name map (folder name -> resolved name)
 */
function buildPluginSkillNameMaps(
  allSkills: CollectedSkillEntry[],
): Map<string, Map<string, string>> {
  // Convert to SkillEntry format for resolver
  const skillEntries: SkillEntry[] = allSkills.map((skill) => ({
    folderName: skill.folderName,
    pluginName: skill.pluginName,
    pluginSource: skill.pluginSource,
  }));

  // Resolve names using the skill name resolver
  const resolution = resolveSkillNames(skillEntries);

  // Build per-plugin maps
  const pluginMaps = new Map<string, Map<string, string>>();

  for (let i = 0; i < allSkills.length; i++) {
    const skill = allSkills[i];
    const entry = skillEntries[i];
    if (!skill || !entry) continue;
    const resolvedName = resolution.nameMap.get(getSkillKey(entry));

    if (resolvedName) {
      let pluginMap = pluginMaps.get(skill.pluginPath);
      if (!pluginMap) {
        pluginMap = new Map<string, string>();
        pluginMaps.set(skill.pluginPath, pluginMap);
      }
      pluginMap.set(skill.folderName, resolvedName);
    }
  }

  return pluginMaps;
}

const VSCODE_TEMPLATE_FILE = 'template.code-workspace';

/**
 * Generate a VSCode .code-workspace file from workspace config.
 * Called automatically during sync when 'vscode' client is configured.
 */
function generateVscodeWorkspaceFile(
  workspacePath: string,
  config: WorkspaceConfig,
): string {
  const configDir = join(workspacePath, CONFIG_DIR);

  // Load template if it exists (supports JSON with comments via JSON5)
  const templatePath = join(configDir, VSCODE_TEMPLATE_FILE);
  let template: Record<string, unknown> | undefined;
  if (existsSync(templatePath)) {
    try {
      template = JSON5.parse(readFileSync(templatePath, 'utf-8'));
    } catch (error) {
      throw new Error(
        `Failed to parse ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const content = generateVscodeWorkspace({
    workspacePath,
    repositories: config.repositories,
    template,
  });

  const outputPath = getWorkspaceOutputPath(workspacePath, config.vscode);
  const contentStr = `${JSON.stringify(content, null, '\t')}\n`;
  writeFileSync(outputPath, contentStr, 'utf-8');
  return contentStr;
}

function failedSyncResult(
  error: string,
  overrides?: Partial<SyncResult>,
): SyncResult {
  return {
    success: false,
    pluginResults: [],
    totalCopied: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalGenerated: 0,
    error,
    ...overrides,
  };
}

function countCopyResults(
  pluginResults: PluginSyncResult[],
  workspaceFileResults: CopyResult[],
): {
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
  totalGenerated: number;
} {
  let totalCopied = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalGenerated = 0;

  for (const pluginResult of pluginResults) {
    for (const copyResult of pluginResult.copyResults) {
      switch (copyResult.action) {
        case 'copied':
          totalCopied++;
          break;
        case 'failed':
          totalFailed++;
          break;
        case 'skipped':
          totalSkipped++;
          break;
        case 'generated':
          totalGenerated++;
          break;
      }
    }
  }

  for (const result of workspaceFileResults) {
    switch (result.action) {
      case 'copied':
        totalCopied++;
        break;
      case 'failed':
        totalFailed++;
        break;
      case 'skipped':
        totalSkipped++;
        break;
    }
  }

  return { totalCopied, totalFailed, totalSkipped, totalGenerated };
}

async function syncNativePlugins(
  validPlugins: ValidatedPlugin[],
  previousState: SyncState | null,
  scope: 'project' | 'user',
  workspacePath: string,
  dryRun: boolean,
  warnings: string[],
  messages: string[],
): Promise<NativeSyncResult | undefined> {
  const {
    pluginsByClient: nativePluginsByClient,
    marketplaceSourcesByClient: nativeMarketplaceSources,
  } = collectNativePluginSources(validPlugins);

  const previousNativeClients = previousState?.nativePlugins
    ? (Object.keys(previousState.nativePlugins) as ClientType[]).filter(
        (c) => (previousState.nativePlugins?.[c]?.length ?? 0) > 0,
      )
    : [];
  const hasNativeWork =
    nativePluginsByClient.size > 0 || previousNativeClients.length > 0;

  if (hasNativeWork && !dryRun) {
    const allClients = new Set([
      ...nativePluginsByClient.keys(),
      ...previousNativeClients,
    ]);
    const perClientResults: NativeSyncResult[] = [];

    for (const clientType of allClients) {
      const nativeClient = getNativeClient(clientType);
      if (!nativeClient) {
        const sources = nativePluginsByClient.get(clientType);
        if (sources && sources.length > 0) {
          warnings.push(
            `Native install: no native client for ${clientType}, skipping`,
          );
        }
        continue;
      }

      const cliAvailable = await nativeClient.isAvailable();
      if (!cliAvailable) {
        const sources = nativePluginsByClient.get(clientType);
        if (sources && sources.length > 0) {
          messages.push(
            `Native install: ${clientType} CLI not found, skipping native plugin installation`,
          );
        }
        continue;
      }

      const marketplaceSources = nativeMarketplaceSources.get(clientType);
      if (marketplaceSources) {
        for (const source of marketplaceSources) {
          if (scope === 'project') {
            await nativeClient.addMarketplace(source, { cwd: workspacePath });
          } else {
            await nativeClient.addMarketplace(source);
          }
        }
      }

      const currentSources = nativePluginsByClient.get(clientType) ?? [];
      const currentSpecs = currentSources
        .map((s) => nativeClient.toPluginSpec(s))
        .filter((s): s is string => s !== null);
      const previousPlugins = getPreviouslySyncedNativePlugins(
        previousState,
        clientType,
      );
      const removed = previousPlugins.filter((p) => !currentSpecs.includes(p));
      for (const plugin of removed) {
        try {
          if (scope === 'project') {
            await nativeClient.uninstallPlugin(plugin, 'project', {
              cwd: workspacePath,
            });
          } else {
            await nativeClient.uninstallPlugin(plugin, 'user');
          }
        } catch (err) {
          warnings.push(
            `Native uninstall failed for ${plugin}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (currentSources.length > 0) {
        const syncOpts =
          scope === 'project' ? { cwd: workspacePath } : undefined;
        perClientResults.push(
          attachNativeClientContext(
            await nativeClient.syncPlugins(currentSources, scope, syncOpts),
            clientType,
          ),
        );
      }
    }

    if (perClientResults.length > 0) {
      return mergeNativeSyncResults(perClientResults);
    }
  } else if (nativePluginsByClient.size > 0 && dryRun) {
    const perClientResults: NativeSyncResult[] = [];
    for (const [clientType, sources] of nativePluginsByClient) {
      const nativeClient = getNativeClient(clientType);
      if (nativeClient && sources.length > 0) {
        const syncOpts =
          scope === 'project'
            ? { cwd: workspacePath, dryRun: true }
            : { dryRun: true };
        perClientResults.push(
          attachNativeClientContext(
            await nativeClient.syncPlugins(sources, scope, syncOpts),
            clientType,
          ),
        );
      }
    }
    if (perClientResults.length > 0) {
      return mergeNativeSyncResults(perClientResults);
    }
  }

  return undefined;
}

async function syncVscodeWorkspaceFile(
  workspacePath: string,
  config: WorkspaceConfig,
  configPath: string,
  previousState: SyncState | null,
  messages: string[],
): Promise<{ config: WorkspaceConfig; hash?: string; repos?: string[] }> {
  // Reconcile .code-workspace -> workspace.yaml if the file was externally modified
  let updatedConfig = config;
  if (
    previousState?.vscodeWorkspaceHash &&
    previousState?.vscodeWorkspaceRepos
  ) {
    const outputPath = getWorkspaceOutputPath(workspacePath, config.vscode);
    if (existsSync(outputPath)) {
      const existingContent = readFileSync(outputPath, 'utf-8');
      const currentHash = computeWorkspaceHash(existingContent);

      if (currentHash !== previousState.vscodeWorkspaceHash) {
        try {
          const existingWorkspace = JSON.parse(existingContent);
          const folders = Array.isArray(existingWorkspace.folders)
            ? existingWorkspace.folders
            : [];

          const reconciled = reconcileVscodeWorkspaceFolders(
            workspacePath,
            folders,
            previousState.vscodeWorkspaceRepos,
            config.repositories,
          );

          if (
            reconciled.added.length > 0 ||
            reconciled.removed.length > 0 ||
            reconciled.renamed.length > 0
          ) {
            const updateResult =
              reconciled.renamed.length > 0
                ? await setRepositories(reconciled.updatedRepos, workspacePath)
                : await updateRepositories(
                    {
                      remove: reconciled.removed,
                      add: reconciled.added.map((p) => ({ path: p })),
                    },
                    workspacePath,
                  );
            if (!updateResult.success) {
              throw new Error(
                updateResult.error ?? 'Failed to update repositories',
              );
            }
            updatedConfig = await parseWorkspaceConfig(configPath);

            if (reconciled.removed.length > 0) {
              messages.push(
                `Repositories removed (from .code-workspace): ${reconciled.removed.join(', ')}`,
              );
            }
            if (reconciled.added.length > 0) {
              messages.push(
                `Repositories added (from .code-workspace): ${reconciled.added.join(', ')}`,
              );
            }
            if (reconciled.renamed.length > 0) {
              messages.push(
                `Repository names updated (from .code-workspace): ${reconciled.renamed.join(', ')}`,
              );
            }
          }
        } catch {
          // If .code-workspace is malformed, skip reconciliation silently
        }
      }
    }
  }

  // Generate .code-workspace (always, even after reconciliation)
  const writtenContent = generateVscodeWorkspaceFile(
    workspacePath,
    updatedConfig,
  );
  const hash = computeWorkspaceHash(writtenContent);
  const repos = updatedConfig.repositories.map((r) =>
    resolve(workspacePath, r.path).replace(/\\/g, '/'),
  );

  return { config: updatedConfig, hash, repos };
}

async function persistSyncState(
  workspacePath: string,
  pluginResults: PluginSyncResult[],
  workspaceFileResults: CopyResult[],
  syncClients: ClientType[],
  nativePluginsByClient: Map<ClientType, string[]>,
  nativeResult: NativeSyncResult | undefined,
  extra?: {
    vscodeState?: { hash: string; repos: string[] };
    mcpTrackedServers?: Partial<Record<string, string[]>>;
    clientMappings?: Record<ClientType, ClientMapping>;
    skillsIndex?: string[];
  },
): Promise<void> {
  const allCopyResults: CopyResult[] = [
    ...pluginResults.flatMap((r) => r.copyResults),
    ...workspaceFileResults,
  ];

  const mappings = extra?.clientMappings ?? CLIENT_MAPPINGS;
  const resolvedMappings = resolveClientMappings(syncClients, mappings);
  const syncedFiles = collectSyncedPaths(
    allCopyResults,
    workspacePath,
    syncClients,
    resolvedMappings,
  );

  // Build native plugin tracking per-client
  const nativePluginsState: Partial<Record<ClientType, string[]>> = {};
  const installedSet = new Set(
    (nativeResult?.pluginsInstalled ?? []).map((p) => p.plugin),
  );
  for (const [client, sources] of nativePluginsByClient) {
    const nativeClient = getNativeClient(client);
    if (!nativeClient) continue;
    const clientSpecs = sources
      .map((s) => nativeClient.toPluginSpec(s))
      .filter((s): s is string => s !== null && installedSet.has(s));
    if (clientSpecs.length > 0) {
      nativePluginsState[client] = clientSpecs;
    }
  }

  await saveSyncState(workspacePath, {
    files: syncedFiles,
    ...(Object.keys(nativePluginsState).length > 0 && {
      nativePlugins: nativePluginsState,
    }),
    ...(extra?.vscodeState?.hash && {
      vscodeWorkspaceHash: extra.vscodeState.hash,
    }),
    ...(extra?.vscodeState?.repos && {
      vscodeWorkspaceRepos: extra.vscodeState.repos,
    }),
    ...(extra?.mcpTrackedServers && { mcpServers: extra.mcpTrackedServers }),
    ...(extra?.skillsIndex &&
      extra.skillsIndex.length > 0 && { skillsIndex: extra.skillsIndex }),
  });
}

/**
 * Sync all plugins to workspace for all configured clients
 *
 * Flow:
 * 1. Validate all plugins (fetch/resolve paths)
 * 2. If any validation fails, abort without changes
 * 3. Purge managed directories (declarative sync)
 * 4. Copy fresh from all validated plugins
 *
 * @param workspacePath - Path to workspace directory (defaults to current directory)
 * @param options - Sync options (offline, dryRun)
 * @returns Sync result
 */
export async function syncWorkspace(
  workspacePath: string = process.cwd(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  // MIGRATION: v1→v2 - remove after v3 release
  await migrateWorkspaceSkillsV1toV2(workspacePath);

  const {
    offline = false,
    dryRun = false,
    workspaceSourceBase,
    skipAgentFiles = false,
    skipManaged = false,
  } = options;
  const sw = new Stopwatch();
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);

  // Check .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return failedSyncResult(
      `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    );
  }

  // Parse workspace config
  let config: WorkspaceConfig;
  try {
    config = await parseWorkspaceConfig(configPath);
  } catch (error) {
    return failedSyncResult(
      error instanceof Error
        ? error.message
        : `Failed to parse ${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    );
  }

  // Check for marketplace overrides (project shadowing user)
  const overrides = await getMarketplaceOverrides(
    getRegistryPath(),
    getProjectRegistryPath(workspacePath),
  );
  for (const name of overrides) {
    console.warn(
      `Warning: Workspace marketplace '${name}' overrides user marketplace of the same name.`,
    );
  }

  // Step 0a: Process managed repositories (clone/pull) before anything else
  const managedRepoResults = await sw.measure('managed-repos', () =>
    processManagedRepos(config.repositories ?? [], workspacePath, {
      offline,
      skipManaged,
      dryRun,
    }),
  );
  const managedWarnings = managedRepoResults
    .filter((r) => r.error)
    .map((r) => `${r.repo}: ${r.error}`);

  // Check if repositories are configured — when empty/absent, skip agent file
  // creation and WORKSPACE-RULES injection (same pattern as initWorkspace)
  const hasRepositories = (config.repositories?.length ?? 0) > 0;

  const { plans: pluginPlans, warnings: planWarnings } = buildPluginSyncPlans(
    config.plugins,
    config.clients,
    'project',
  );
  const workspaceClients = config.clients;
  const filteredPlans = pluginPlans.filter(
    (plan) => plan.clients.length > 0 || plan.nativeClients.length > 0,
  );
  const syncClients = collectSyncClients(workspaceClients, filteredPlans);

  // Warn when no clients are configured — the sync will succeed but create no artifacts
  if (syncClients.length === 0) {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: [
        "No clients configured in workspace.yaml — no artifacts were synced. Add clients to workspace.yaml or run 'allagents workspace init' to configure.",
      ],
    };
  }

  // Step 0: Pre-register unique marketplaces to avoid race conditions during parallel validation
  const marketplaceResults = await sw.measure('marketplace-registration', () =>
    ensureMarketplacesRegistered(filteredPlans.map((plan) => plan.source)),
  );

  // Seed fetchCache with marketplace paths so fetchPlugin skips redundant git pulls
  await seedFetchCacheFromMarketplaces(marketplaceResults);

  // Step 1: Validate all plugins before any destructive action
  const validatedPlugins = await sw.measure(
    'plugin-validation',
    () => validateAllPlugins(filteredPlans, workspacePath, offline),
    `${filteredPlans.length} plugin(s)`,
  );

  // Step 1b: Validate workspace.source if defined
  // Use workspaceSourceBase if provided (during init with --from) to resolve
  // relative paths correctly relative to the source directory
  let validatedWorkspaceSource: ValidatedPlugin | null = null;
  const workspaceSourceWarnings: string[] = [];
  if (config.workspace?.source) {
    sw.start('workspace-source-validation');
    const sourceBasePath = workspaceSourceBase ?? workspacePath;
    const wsSourceResult = await validatePlugin(
      config.workspace.source,
      sourceBasePath,
      offline,
    );
    if (wsSourceResult.success) {
      validatedWorkspaceSource = wsSourceResult;
    } else {
      // Non-blocking: warn but continue syncing plugins
      workspaceSourceWarnings.push(`Workspace source: ${wsSourceResult.error}`);
    }
    sw.stop('workspace-source-validation');
  }

  // Separate valid and failed plugins
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  const validPlugins = validatedPlugins.filter((v) => v.success);
  const warnings = [
    ...managedWarnings,
    ...planWarnings,
    ...workspaceSourceWarnings,
    ...failedValidations.map((v) => `${v.plugin}: ${v.error} (skipped)`),
  ];
  const messages: string[] = [];

  // If ALL plugins failed, abort
  if (validPlugins.length === 0 && filteredPlans.length > 0) {
    return failedSyncResult(
      `All plugins failed validation (workspace unchanged):\n${failedValidations.map((v) => `  - ${v.plugin}: ${v.error}`).join('\n')}`,
      { totalFailed: failedValidations.length, warnings },
    );
  }

  // Step 2: Load previous sync state for selective purge
  const previousState = await loadSyncState(workspacePath);

  // Step 2b: Get paths that will be purged (for dry-run reporting)
  // In non-destructive mode, only show files from state (or nothing on first sync)
  const purgedPaths = previousState
    ? syncClients
        .map((client) => ({
          client,
          paths: getPreviouslySyncedFiles(previousState, client),
        }))
        .filter((p) => p.paths.length > 0)
    : [];

  // Step 3: Selective purge - only remove files we previously synced (skip in dry-run mode)
  if (!dryRun) {
    await sw.measure('selective-purge', () =>
      selectivePurgeWorkspace(workspacePath, previousState, syncClients),
    );
  }

  // Step 3b: Two-pass skill name resolution
  // Pass 1: Collect all skills from all plugins (excluding disabled/non-enabled skills)
  // v1 fallback: only use top-level disabledSkills/enabledSkills for configs that haven't migrated
  const isV1Fallback = config.version === undefined || config.version < 2;
  const disabledSkillsSet = isV1Fallback
    ? new Set(config.disabledSkills ?? [])
    : undefined;
  const enabledSkillsSet =
    isV1Fallback && config.enabledSkills
      ? new Set(config.enabledSkills)
      : undefined;
  const allSkills = await sw.measure('skill-collection', () =>
    collectAllSkills(validPlugins, disabledSkillsSet, enabledSkillsSet),
  );

  // Build per-plugin skill name maps (handles conflicts automatically)
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Step 4: Copy fresh from all validated plugins
  // Pass 2: Copy skills using resolved names
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await sw.measure(
    'plugin-copy',
    () =>
      Promise.all(
        validPlugins.map(async (validatedPlugin) => {
          const skillNameMap = pluginSkillMaps.get(validatedPlugin.resolved);
          const result = await copyValidatedPlugin(
            validatedPlugin,
            workspacePath,
            validatedPlugin.clients,
            dryRun,
            skillNameMap,
            undefined, // clientMappings
            syncMode,
          );
          return { ...result, scope: 'project' as const };
        }),
      ),
    `${validPlugins.length} plugin(s)`,
  );

  // Step 4b: Native CLI installations
  const nativeResult = await sw.measure('native-plugin-sync', () =>
    syncNativePlugins(
      validPlugins,
      previousState,
      'project',
      workspacePath,
      dryRun,
      warnings,
      messages,
    ),
  );

  // Step 5: Copy workspace files if configured
  // Supports both workspace.source (default base) and file-level sources
  // Skip when workspace.source was configured but validation failed (plugins still synced above)
  let workspaceFileResults: CopyResult[] = [];
  let writtenSkillsIndexFiles: string[] = [];
  const skipWorkspaceFiles =
    !!config.workspace?.source && !validatedWorkspaceSource;
  if (config.workspace && !skipWorkspaceFiles) {
    sw.start('workspace-files');
    const sourcePath = validatedWorkspaceSource?.resolved;
    const filesToCopy = [...config.workspace.files];

    // Auto-include agent files if they exist in source and aren't already listed.
    // Skip when repositories is empty — agent files contain WORKSPACE-RULES that
    // reference repository paths which don't exist yet.
    if (hasRepositories && sourcePath) {
      for (const agentFile of AGENT_FILES) {
        const agentPath = join(sourcePath, agentFile);
        if (existsSync(agentPath) && !filesToCopy.includes(agentFile)) {
          filesToCopy.push(agentFile);
        }
      }
    }

    // Step 5a: Collect and fetch GitHub repos from file sources
    const fileSourceRepos = collectGitHubReposFromFiles(filesToCopy);
    let githubCache = new Map<string, string>();

    if (fileSourceRepos.length > 0) {
      const { cache, errors } = await fetchFileSourceRepos(fileSourceRepos);
      if (errors.length > 0) {
        return failedSyncResult(
          `File source fetch failed (workspace unchanged):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
          { pluginResults, totalFailed: errors.length },
        );
      }
      githubCache = cache;
    }

    // Step 5b: Validate all file sources exist before copying
    const fileValidationErrors = validateFileSources(
      filesToCopy,
      sourcePath,
      githubCache,
    );
    if (fileValidationErrors.length > 0) {
      return failedSyncResult(
        `File source validation failed (workspace unchanged):\n${fileValidationErrors.map((e) => `  - ${e}`).join('\n')}`,
        { pluginResults, totalFailed: fileValidationErrors.length },
      );
    }

    // Step 5c: Discover skills from workspace repositories
    const repoSkills =
      hasRepositories && !dryRun
        ? await discoverWorkspaceSkills(
            workspacePath,
            config.repositories,
            syncClients as string[],
          )
        : [];

    // Step 5c.1: Write skills-index files and clean up stale ones
    let skillsIndexRefs: { repoName: string; indexPath: string }[] = [];
    if (!dryRun) {
      if (repoSkills.length > 0) {
        const grouped = groupSkillsByRepo(repoSkills, config.repositories);
        const result = writeSkillsIndex(workspacePath, grouped);
        writtenSkillsIndexFiles = result.writtenFiles;
        skillsIndexRefs = result.refs;
      }
      // Always clean up stale index files (handles case where all skills were removed)
      cleanupSkillsIndex(workspacePath, writtenSkillsIndexFiles);
    }

    // Step 5d: Copy workspace files with GitHub cache
    // Pass repositories and skillsIndexRefs so conditional links are embedded in WORKSPACE-RULES
    workspaceFileResults = await copyWorkspaceFiles(
      sourcePath,
      workspacePath,
      filesToCopy,
      {
        dryRun,
        githubCache,
        repositories: config.repositories,
        skillsIndexRefs,
      },
    );

    // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
    // Skip when repositories is empty (no agent files should be created)
    if (
      hasRepositories &&
      !dryRun &&
      syncClients.includes('claude') &&
      sourcePath
    ) {
      const claudePath = join(workspacePath, 'CLAUDE.md');
      const agentsPath = join(workspacePath, 'AGENTS.md');
      const claudeExistsInSource = existsSync(join(sourcePath, 'CLAUDE.md'));

      // Only copy if CLAUDE.md wasn't in source and AGENTS.md exists
      if (
        !claudeExistsInSource &&
        existsSync(agentsPath) &&
        !existsSync(claudePath)
      ) {
        await copyFile(agentsPath, claudePath);
      }
    }
    sw.stop('workspace-files');
  }

  // When repositories are configured but no workspace.source is set,
  // ensure WORKSPACE-RULES are injected into agent files directly.
  // This handles the case where a user has repositories but no workspace: section.
  // (When workspace.source exists, rules are injected via copyWorkspaceFiles above.)
  if (!config.workspace && !dryRun && !skipAgentFiles) {
    await updateAgentFiles(workspacePath);
  }

  // Step 5d: Reconcile and generate VSCode .code-workspace file
  let vscodeState: { hash: string; repos: string[] } | undefined;
  if (syncClients.includes('vscode') && !dryRun) {
    const result = await sw.measure('vscode-workspace-file', () =>
      syncVscodeWorkspaceFile(
        workspacePath,
        config,
        configPath,
        previousState,
        messages,
      ),
    );
    config = result.config;
    if (result.hash && result.repos) {
      vscodeState = { hash: result.hash, repos: result.repos };
    }
  }

  // Step 5e–h: Sync MCP server configs across all project-scoped clients.
  // Delegated to mcp-sync.ts so the same pipeline can be reused by the
  // standalone `allagents mcp update` command.
  sw.start('mcp-sync');
  const mcpSyncResult = runMcpSync(
    workspacePath,
    validPlugins,
    config,
    previousState,
    syncClients,
    { dryRun },
  );
  const mcpResults: Record<string, McpMergeResult> = {
    ...mcpSyncResult.mcpResults,
  };
  warnings.push(...mcpSyncResult.warnings);
  sw.stop('mcp-sync');

  // Count results
  const { totalCopied, totalFailed, totalSkipped, totalGenerated } =
    countCopyResults(pluginResults, workspaceFileResults);
  const hasFailures = pluginResults.some((r) => !r.success) || totalFailed > 0;

  // Compute deleted artifacts: compare previous state vs what was just synced
  // Collect all skill names from installed plugins (including disabled) so that
  // skills that are still available but just not synced are not reported as deleted.
  const availableSkillNames = await collectAvailableSkillNames(validPlugins);
  const allCopyResultsForState = [
    ...pluginResults.flatMap((r) => r.copyResults),
    ...workspaceFileResults,
  ];
  const resolvedMappings = resolveClientMappings(syncClients, CLIENT_MAPPINGS);
  const newStatePaths = collectSyncedPaths(
    allCopyResultsForState,
    workspacePath,
    syncClients,
    resolvedMappings,
  );
  const deletedArtifacts = computeDeletedArtifacts(
    previousState,
    newStatePaths,
    syncClients,
    resolvedMappings,
    availableSkillNames,
  );

  // Persist sync state (skip in dry-run mode)
  const { pluginsByClient: nativePluginsByClient } =
    collectNativePluginSources(validPlugins);
  if (!dryRun) {
    await sw.measure('persist-state', () =>
      persistSyncState(
        workspacePath,
        pluginResults,
        workspaceFileResults,
        syncClients,
        nativePluginsByClient,
        nativeResult,
        {
          ...(vscodeState && { vscodeState }),
          ...(Object.keys(mcpResults).length > 0 && {
            mcpTrackedServers: Object.fromEntries(
              Object.entries(mcpResults).map(([scope, r]) => [
                scope,
                r.trackedServers,
              ]),
            ),
          }),
          ...(writtenSkillsIndexFiles.length > 0 && {
            skillsIndex: writtenSkillsIndexFiles,
          }),
        },
      ),
    );
  }

  return {
    success: !hasFailures,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    purgedPaths,
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(warnings.length > 0 && { warnings }),
    ...(messages.length > 0 && { messages }),
    ...(Object.keys(mcpResults).length > 0 && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    ...(managedRepoResults.length > 0 && { managedRepoResults }),
    timing: sw.toJSON(),
  };
}

/**
 * Seed the fetchPlugin cache with paths from successfully registered marketplaces.
 * This prevents fetchPlugin from performing a redundant git pull for repos
 * that the marketplace has already cloned/pulled.
 */
export async function seedFetchCacheFromMarketplaces(
  results: Array<{ source: string; success: boolean; name?: string }>,
): Promise<void> {
  for (const result of results) {
    if (!result.success || !result.name) continue;

    const entry = await getMarketplace(result.name);
    if (!entry || entry.source.type !== 'github') continue;

    // Seed the bare key (owner/repo without branch)
    seedFetchCache(entry.source.location, entry.path);

    // Also seed the branch-qualified key so that callers using an explicit
    // branch (e.g. workspace.source URLs with /tree/main/) get a cache hit.
    // The marketplace repo content will be pulled fresh during validateAllPlugins
    // before any caller reads from this path.
    const branch = readGitBranch(entry.path);
    if (branch) {
      seedFetchCache(entry.source.location, entry.path, branch);
    }
  }
}

/**
 * Read the current branch from a git repo's HEAD file without spawning a process.
 * Returns null if the branch cannot be determined (detached HEAD, missing file, etc.).
 */
function readGitBranch(repoPath: string): string | null {
  try {
    const head = readFileSync(join(repoPath, '.git', 'HEAD'), 'utf-8').trim();
    const prefix = 'ref: refs/heads/';
    return head.startsWith(prefix) ? head.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

/**
 * Sync user-scoped plugins to user home directories using USER_CLIENT_MAPPINGS.
 * Reads config from ~/.allagents/workspace.yaml and syncs to paths relative to $HOME.
 *
 * @param options - Sync options (offline, dryRun)
 * @returns Sync result
 */
export async function syncUserWorkspace(
  options: { offline?: boolean; dryRun?: boolean; force?: boolean } = {},
): Promise<SyncResult> {
  // MIGRATION: v1→v2 - remove after v3 release
  await migrateUserWorkspaceSkillsV1toV2();

  const sw = new Stopwatch();
  const homeDir = resolve(getHomeDir());
  const config = await getUserWorkspaceConfig();

  if (!config) {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
  }

  const workspaceClients = config.clients;
  const { offline = false, dryRun = false, force = false } = options;

  const { plans: allPluginPlans, warnings: planWarnings } =
    buildPluginSyncPlans(config.plugins, workspaceClients, 'user');
  const pluginPlans = allPluginPlans.filter(
    (plan) => plan.clients.length > 0 || plan.nativeClients.length > 0,
  );
  const syncClients = collectSyncClients(workspaceClients, pluginPlans);

  // Pre-register unique marketplaces to avoid race conditions during parallel validation
  const marketplaceResults = await sw.measure('marketplace-registration', () =>
    ensureMarketplacesRegistered(pluginPlans.map((plan) => plan.source)),
  );

  // Seed fetchCache with marketplace paths so fetchPlugin skips redundant git pulls
  await seedFetchCacheFromMarketplaces(marketplaceResults);

  // Validate all plugins
  const validatedPlugins = await sw.measure(
    'plugin-validation',
    () => validateAllPlugins(pluginPlans, homeDir, offline),
    `${pluginPlans.length} plugin(s)`,
  );
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  const validPlugins = validatedPlugins.filter((v) => v.success);
  const warnings = [
    ...planWarnings,
    ...failedValidations.map((v) => `${v.plugin}: ${v.error} (skipped)`),
  ];
  const messages: string[] = [];

  // If ALL plugins failed, abort
  if (validPlugins.length === 0 && pluginPlans.length > 0) {
    return failedSyncResult(
      `All plugins failed validation:\n${failedValidations.map((v) => `  - ${v.plugin}: ${v.error}`).join('\n')}`,
      { totalFailed: failedValidations.length, warnings },
    );
  }

  // Load previous sync state (stored at ~/.allagents/sync-state.json)
  const previousState = await loadSyncState(homeDir);

  // Selective purge
  if (!dryRun) {
    await sw.measure('selective-purge', () =>
      selectivePurgeWorkspace(homeDir, previousState, syncClients),
    );
  }

  // Two-pass skill name resolution (excluding disabled/non-enabled skills)
  // v1 fallback: only use top-level disabledSkills/enabledSkills for configs that haven't migrated
  const isV1FallbackUser = config.version === undefined || config.version < 2;
  const disabledSkillsSet = isV1FallbackUser
    ? new Set(config.disabledSkills ?? [])
    : undefined;
  const enabledSkillsSet =
    isV1FallbackUser && config.enabledSkills
      ? new Set(config.enabledSkills)
      : undefined;
  const allSkills = await sw.measure('skill-collection', () =>
    collectAllSkills(validPlugins, disabledSkillsSet, enabledSkillsSet),
  );
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Copy plugins using USER_CLIENT_MAPPINGS
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await sw.measure(
    'plugin-copy',
    () =>
      Promise.all(
        validPlugins.map(async (vp) => {
          const skillNameMap = pluginSkillMaps.get(vp.resolved);
          const resolvedUserMappings = resolveClientMappings(
            vp.clients,
            USER_CLIENT_MAPPINGS,
          );
          const result = await copyValidatedPlugin(
            vp,
            homeDir,
            vp.clients,
            dryRun,
            skillNameMap,
            resolvedUserMappings,
            syncMode,
          );
          return { ...result, scope: 'user' as const };
        }),
      ),
    `${validPlugins.length} plugin(s)`,
  );

  // Count results
  const { totalCopied, totalFailed, totalSkipped, totalGenerated } =
    countCopyResults(pluginResults, []);

  // MCP Proxy: prepare transform if configured (user-scoped)
  const userMcpProxyConfig = config.mcpProxy;
  const userWorkspaceMcpServers = config.mcpServers;

  // Emit collection warnings once across all user-scoped client syncs.
  let userCollectWarningsEmitted = false;
  function getUserServersForClient(client: ClientType): Map<string, unknown> {
    const { servers, warnings: collectWarnings } = collectMcpServers(
      validPlugins,
      userWorkspaceMcpServers,
      client,
    );
    if (!userCollectWarningsEmitted) {
      warnings.push(...collectWarnings);
      userCollectWarningsEmitted = true;
    }
    if (userMcpProxyConfig) {
      return applyMcpProxy(servers, client, userMcpProxyConfig);
    }
    return servers;
  }

  // Sync MCP server configs to VS Code if vscode client is configured
  sw.start('mcp-sync');
  const mcpResults: Record<string, McpMergeResult> = {};
  if (syncClients.includes('vscode')) {
    const trackedMcpServers = getPreviouslySyncedMcpServers(
      previousState,
      'vscode',
    );
    const vscodeMcpOverrides = getUserServersForClient('vscode');
    const vscodeMcp = syncVscodeMcpConfig(validPlugins, {
      dryRun,
      force,
      trackedServers: trackedMcpServers,
      serverOverrides: vscodeMcpOverrides,
    });
    if (vscodeMcp.warnings.length > 0) {
      warnings.push(...vscodeMcp.warnings);
    }
    mcpResults.vscode = vscodeMcp;
  }

  // Sync MCP servers to Codex CLI if codex client is configured
  if (syncClients.includes('codex')) {
    const trackedMcpServers = getPreviouslySyncedMcpServers(
      previousState,
      'codex',
    );
    const codexMcpOverrides = getUserServersForClient('codex');
    const codexMcp = await syncCodexMcpServers(validPlugins, {
      dryRun,
      trackedServers: trackedMcpServers,
      ...(codexMcpOverrides && { serverOverrides: codexMcpOverrides }),
    });
    if (codexMcp.warnings.length > 0) {
      warnings.push(...codexMcp.warnings);
    }
    mcpResults.codex = codexMcp;
  }

  // Sync MCP servers to Claude Code via CLI if claude client is configured
  if (syncClients.includes('claude')) {
    const trackedMcpServers = getPreviouslySyncedMcpServers(
      previousState,
      'claude',
    );
    const claudeMcpOverrides = getUserServersForClient('claude');
    const claudeMcp = await syncClaudeMcpServersViaCli(validPlugins, {
      dryRun,
      trackedServers: trackedMcpServers,
      ...(claudeMcpOverrides && { serverOverrides: claudeMcpOverrides }),
    });
    if (claudeMcp.warnings.length > 0) {
      warnings.push(...claudeMcp.warnings);
    }
    mcpResults.claude = claudeMcp;
  }

  // Sync MCP servers to Copilot CLI config if copilot client is configured
  if (syncClients.includes('copilot')) {
    const trackedMcpServers = getPreviouslySyncedMcpServers(
      previousState,
      'copilot',
    );
    const copilotMcpPath = getCopilotMcpConfigPath();
    const copilotMcpOverrides = getUserServersForClient('copilot');
    const copilotMcp = syncClaudeMcpConfig(validPlugins, {
      dryRun,
      force,
      configPath: copilotMcpPath,
      trackedServers: trackedMcpServers,
      ...(copilotMcpOverrides && { serverOverrides: copilotMcpOverrides }),
    });
    if (copilotMcp.warnings.length > 0) {
      warnings.push(...copilotMcp.warnings);
    }
    mcpResults.copilot = copilotMcp;
  }

  sw.stop('mcp-sync');

  // Warn about clients that don't support user-scoped MCP sync
  const USER_MCP_CLIENTS = new Set([
    'claude',
    'codex',
    'vscode',
    'copilot',
    'universal',
  ]);
  const allUserMcpServers = collectMcpServers(
    validPlugins,
    userWorkspaceMcpServers,
  ).servers;
  if (allUserMcpServers.size > 0) {
    for (const client of syncClients) {
      if (!USER_MCP_CLIENTS.has(client)) {
        warnings.push(
          `MCP servers not synced for ${client} (not supported at user scope)`,
        );
      }
    }
  }

  // Run native CLI installations for user scope
  const nativeResult = await sw.measure('native-plugin-sync', () =>
    syncNativePlugins(
      validPlugins,
      previousState,
      'user',
      homeDir,
      dryRun,
      warnings,
      messages,
    ),
  );

  // Compute deleted artifacts: compare previous state vs what was just synced
  const availableUserSkillNames =
    await collectAvailableSkillNames(validPlugins);
  const allCopyResultsForState = pluginResults.flatMap((r) => r.copyResults);
  const resolvedUserMappings = resolveClientMappings(
    syncClients,
    USER_CLIENT_MAPPINGS,
  );
  const newStatePaths = collectSyncedPaths(
    allCopyResultsForState,
    homeDir,
    syncClients,
    resolvedUserMappings,
  );
  const deletedArtifacts = computeDeletedArtifacts(
    previousState,
    newStatePaths,
    syncClients,
    resolvedUserMappings,
    availableUserSkillNames,
  );

  // Save sync state (including MCP servers and native plugins)
  if (!dryRun) {
    const { pluginsByClient: nativePluginsByClient } =
      collectNativePluginSources(validPlugins);
    await sw.measure('persist-state', () =>
      persistSyncState(
        homeDir,
        pluginResults,
        [],
        syncClients,
        nativePluginsByClient,
        nativeResult,
        {
          clientMappings: USER_CLIENT_MAPPINGS,
          ...(Object.keys(mcpResults).length > 0 && {
            mcpTrackedServers: Object.fromEntries(
              Object.entries(mcpResults).map(([scope, r]) => [
                scope,
                r.trackedServers,
              ]),
            ),
          }),
        },
      ),
    );
  }

  return {
    success: totalFailed === 0,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(warnings.length > 0 && { warnings }),
    ...(messages.length > 0 && { messages }),
    ...(Object.keys(mcpResults).length > 0 && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    timing: sw.toJSON(),
  };
}
