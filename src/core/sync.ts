import { existsSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { rm, unlink, rmdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import JSON5 from 'json5';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES, getHomeDir } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type {
  WorkspaceConfig,
  ClientType,
  WorkspaceFile,
  SyncMode,
} from '../models/workspace-config.js';
import {
  isGitHubUrl,
  parseGitHubUrl,
  parseFileSource,
} from '../utils/plugin-path.js';
import { fetchPlugin, getPluginName } from './plugin.js';
import {
  copyPluginToWorkspace,
  copyWorkspaceFiles,
  collectPluginSkills,
  type CopyResult,
} from './transform.js';
import { updateAgentFiles } from './workspace-repo.js';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS, CANONICAL_SKILLS_PATH, isUniversalClient } from '../models/client-mapping.js';
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
} from './marketplace.js';
import {
  loadSyncState,
  saveSyncState,
  getPreviouslySyncedFiles,
} from './sync-state.js';
import type { SyncState } from '../models/sync-state.js';
import { getUserWorkspaceConfig } from './user-workspace.js';
import {
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
} from './vscode-workspace.js';
import { syncVscodeMcpConfig } from './vscode-mcp.js';
import type { McpMergeResult } from './vscode-mcp.js';

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
export interface SyncResult {
  success: boolean;
  pluginResults: PluginSyncResult[];
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
  totalGenerated: number;
  /** Paths that were/would be purged per client */
  purgedPaths?: PurgePaths[];
  error?: string;
  /** Warnings for plugins that were skipped during sync */
  warnings?: string[];
  /** Result of syncing MCP server configs to VS Code */
  mcpResult?: McpMergeResult;
}

/**
 * Merge two SyncResult objects into one combined result.
 */
export function mergeSyncResults(a: SyncResult, b: SyncResult): SyncResult {
  const warnings = [...(a.warnings || []), ...(b.warnings || [])];
  const purgedPaths = [...(a.purgedPaths || []), ...(b.purgedPaths || [])];
  // Use whichever mcpResult is present (only user-scope sync produces one)
  const mcpResult = a.mcpResult ?? b.mcpResult;
  return {
    success: a.success && b.success,
    pluginResults: [...a.pluginResults, ...b.pluginResults],
    totalCopied: a.totalCopied + b.totalCopied,
    totalFailed: a.totalFailed + b.totalFailed,
    totalSkipped: a.totalSkipped + b.totalSkipped,
    totalGenerated: a.totalGenerated + b.totalGenerated,
    ...(warnings.length > 0 && { warnings }),
    ...(purgedPaths.length > 0 && { purgedPaths }),
    ...(mcpResult && { mcpResult }),
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
  /** Override which clients to sync. If provided, only these clients are synced instead of all configured clients. */
  clients?: string[];
  /** Skip updating AGENTS.md and other generated agent files. Use for plugin-only updates. */
  skipAgentFiles?: boolean;
}

/**
 * Result of validating a plugin (resolving its path without copying)
 */
export interface ValidatedPlugin {
  plugin: string;
  resolved: string;
  success: boolean;
  error?: string;
  /** Plugin name from marketplace manifest (overrides plugin.json / directory name) */
  pluginName?: string;
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
    if (mapping.commandsPath && existsSync(join(workspacePath, mapping.commandsPath))) {
      paths.push(mapping.commandsPath);
    }

    // Check skills directory
    if (mapping.skillsPath && existsSync(join(workspacePath, mapping.skillsPath))) {
      paths.push(mapping.skillsPath);
    }

    // Check hooks directory
    if (mapping.hooksPath && existsSync(join(workspacePath, mapping.hooksPath))) {
      paths.push(mapping.hooksPath);
    }

    // Check agents directory
    if (mapping.agentsPath && existsSync(join(workspacePath, mapping.agentsPath))) {
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
  options?: { partialSync?: boolean },
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
  // However, during partial sync (--client flag), only purge the targeted clients
  // to avoid removing files for clients that aren't being synced.
  const clientsToProcess = options?.partialSync
    ? clients
    : [...new Set([...clients, ...previousClients])];

  for (const client of clientsToProcess) {
    const previousFiles = getPreviouslySyncedFiles(state, client);
    const purgedPaths: string[] = [];

    // Delete each previously synced file
    for (const filePath of previousFiles) {
      const fullPath = join(workspacePath, filePath);

      if (!existsSync(fullPath)) {
        continue;
      }

      try {
        // Check if it's a symlink - these need special handling
        // (rm with trailing slash on a symlink fails with ENOTDIR)
        const stats = lstatSync(fullPath.replace(/\/$/, ''));
        if (stats.isSymbolicLink()) {
          // Remove symlink (works without trailing slash)
          await unlink(fullPath.replace(/\/$/, ''));
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
async function cleanupEmptyParents(workspacePath: string, filePath: string): Promise<void> {
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
  if (!source.startsWith('.') && !source.startsWith('/') && source.includes('/')) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (parts[0] && parts[1] && validOwnerRepo.test(parts[0]) && validOwnerRepo.test(parts[1])) {
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
      errors.push(`Failed to fetch ${repo.key}: ${result.error || 'Unknown error'}`);
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
  if (!source.startsWith('.') && !source.startsWith('/') && source.includes('/')) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (parts[0] && parts[1] && validOwnerRepo.test(parts[0]) && validOwnerRepo.test(parts[1])) {
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
        errors.push(`Cannot resolve file '${file}' - no workspace.source configured`);
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
          errors.push(`Invalid GitHub file source: ${file.source}. Must include path to file.`);
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
          errors.push(`Path not found in repository: ${cacheKey}/${parsed.filePath}`);
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
        errors.push(`Cannot resolve file '${file.dest}' - no workspace.source configured and no explicit source provided`);
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
    const relativePath = relative(workspacePath, copyResult.destination).replace(/\\/g, '/');

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
        (mapping.commandsPath && relativePath.startsWith(mapping.commandsPath)) ||
        (mapping.skillsPath && relativePath.startsWith(mapping.skillsPath)) ||
        (mapping.hooksPath && relativePath.startsWith(mapping.hooksPath)) ||
        (mapping.agentsPath && relativePath.startsWith(mapping.agentsPath)) ||
        relativePath === mapping.agentFile ||
        (mapping.agentFileFallback && relativePath === mapping.agentFileFallback)
      ) {
        result[client]?.push(relativePath);
        // Don't break - continue checking other clients that might share this path
      }
    }
  }

  return result;
}

/**
 * Validate a single plugin by resolving its path without copying
 * @param pluginSource - Plugin source
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
    });
    if (!resolved.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        error: resolved.error || 'Unknown error',
      };
    }
    return {
      plugin: pluginSource,
      resolved: resolved.path ?? '',
      success: true,
      ...(resolved.pluginName && { pluginName: resolved.pluginName }),
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
    };
  }

  // Local plugin
  const resolvedPath = resolve(workspacePath, pluginSource);
  if (!existsSync(resolvedPath)) {
    return {
      plugin: pluginSource,
      resolved: resolvedPath,
      success: false,
      error: `Plugin not found at ${resolvedPath}`,
    };
  }
  return {
    plugin: pluginSource,
    resolved: resolvedPath,
    success: true,
  };
}

/**
 * Validate all plugins before any destructive action
 * @param plugins - List of plugin sources
 * @param workspacePath - Path to workspace directory
 * @param offline - Skip fetching from remote and use cached version
 * @returns Array of validation results
 */
async function validateAllPlugins(
  plugins: string[],
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin[]> {
  return Promise.all(
    plugins.map((plugin) => validatePlugin(plugin, workspacePath, offline)),
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
  clients: string[],
  dryRun: boolean,
  skillNameMap?: Map<string, string>,
  clientMappings?: Record<string, ClientMapping>,
  syncMode: SyncMode = 'symlink',
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];
  const mappings = clientMappings ?? CLIENT_MAPPINGS;
  const clientList = clients as ClientType[];

  if (syncMode === 'symlink') {
    // Symlink mode: copy to canonical .agents/skills/, symlink from client paths
    //
    // Phase 1: Copy skills to canonical location using deduplication
    // This ensures canonical is only copied once, and tracked under universal clients
    const { representativeClients } = deduplicateClientsByPath(clientList, mappings);

    // Find which representative handles canonical (.agents/skills/)
    const canonicalRepresentative = representativeClients.find(
      (c) => mappings[c]?.skillsPath === CANONICAL_SKILLS_PATH,
    );

    // If no configured client uses canonical directly, we need to add one
    // to ensure canonical gets copied and tracked
    const needsCanonicalCopy = !canonicalRepresentative;
    const nonUniversalClients = clientList.filter((c) => !isUniversalClient(c));

    // Copy to canonical using representative or 'copilot' if needed
    if (needsCanonicalCopy && nonUniversalClients.length > 0) {
      const canonicalResults = await copyPluginToWorkspace(
        validatedPlugin.resolved,
        workspacePath,
        'copilot', // Use copilot as canonical representative
        {
          dryRun,
          ...(skillNameMap && { skillNameMap }),
          // Don't pass clientMappings - use default CLIENT_MAPPINGS for copilot
          syncMode: 'copy',
        },
      );
      // Filter to only skill results and add to copyResults
      // These get tracked for ALL non-universal clients
      const skillResults = canonicalResults.filter(
        (r) => r.destination.includes(CANONICAL_SKILLS_PATH) && r.action === 'copied',
      );
      copyResults.push(...skillResults);
    }

    // Phase 2: Copy for each representative client
    for (const representative of representativeClients) {
      if (isUniversalClient(representative)) {
        // Universal client: copy directly to canonical
        const results = await copyPluginToWorkspace(
          validatedPlugin.resolved,
          workspacePath,
          representative,
          {
            dryRun,
            ...(skillNameMap && { skillNameMap }),
            ...(clientMappings && { clientMappings }),
            syncMode: 'copy',
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
            ...(clientMappings && { clientMappings }),
            syncMode: 'symlink',
            canonicalSkillsPath: CANONICAL_SKILLS_PATH,
          },
        );
        copyResults.push(...results);
      }
    }
  } else {
    // Legacy copy mode: deduplicate and copy directly
    const { representativeClients } = deduplicateClientsByPath(clientList, mappings);

    for (const client of representativeClients) {
      const results = await copyPluginToWorkspace(
        validatedPlugin.resolved,
        workspacePath,
        client,
        {
          dryRun,
          ...(skillNameMap && { skillNameMap }),
          ...(clientMappings && { clientMappings }),
          syncMode: 'copy',
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
  /** Plugin name (from plugin.json or directory name) */
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
 * @param disabledSkills - Optional set of disabled skill keys
 * @returns Array of collected skill entries
 */
async function collectAllSkills(
  validatedPlugins: ValidatedPlugin[],
  disabledSkills?: Set<string>,
): Promise<CollectedSkillEntry[]> {
  const allSkills: CollectedSkillEntry[] = [];

  for (const plugin of validatedPlugins) {
    const pluginName = plugin.pluginName ?? await getPluginName(plugin.resolved);
    const skills = await collectPluginSkills(
      plugin.resolved,
      plugin.plugin,
      disabledSkills,
      pluginName,
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
): void {
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
  writeFileSync(outputPath, `${JSON.stringify(content, null, '\t')}\n`, 'utf-8');
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
  const { offline = false, dryRun = false, workspaceSourceBase, skipAgentFiles = false } = options;
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);

  // Check .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  // Parse workspace config
  let config: WorkspaceConfig;
  try {
    config = await parseWorkspaceConfig(configPath);
  } catch (error) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      error:
        error instanceof Error
          ? error.message
          : `Failed to parse ${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    };
  }

  // Check if repositories are configured — when empty/absent, skip agent file
  // creation and WORKSPACE-RULES injection (same pattern as initWorkspace)
  const hasRepositories = (config.repositories?.length ?? 0) > 0;

  // Filter clients if override provided
  const clients = options.clients
    ? config.clients.filter((c) => options.clients?.includes(c))
    : config.clients;

  // Validate requested clients are in config
  if (options.clients) {
    const invalidClients = options.clients.filter(
      (c) => !config.clients.includes(c as ClientType),
    );
    if (invalidClients.length > 0) {
      return {
        success: false,
        pluginResults: [],
        totalCopied: 0,
        totalFailed: 0,
        totalSkipped: 0,
        totalGenerated: 0,
        error: `Client(s) not configured in workspace.yaml: ${invalidClients.join(', ')}\n  Configured clients: ${config.clients.join(', ')}`,
      };
    }
  }

  // Step 0: Pre-register unique marketplaces to avoid race conditions during parallel validation
  await ensureMarketplacesRegistered(config.plugins);

  // Step 1: Validate all plugins before any destructive action
  const validatedPlugins = await validateAllPlugins(
    config.plugins,
    workspacePath,
    offline,
  );

  // Step 1b: Validate workspace.source if defined
  // Use workspaceSourceBase if provided (during init with --from) to resolve
  // relative paths correctly relative to the source directory
  let validatedWorkspaceSource: ValidatedPlugin | null = null;
  if (config.workspace?.source) {
    const sourceBasePath = workspaceSourceBase ?? workspacePath;
    validatedWorkspaceSource = await validatePlugin(
      config.workspace.source,
      sourceBasePath,
      offline,
    );
    if (!validatedWorkspaceSource.success) {
      return {
        success: false,
        pluginResults: [],
        totalCopied: 0,
        totalFailed: 1,
        totalSkipped: 0,
        totalGenerated: 0,
        error: `Workspace source validation failed: ${validatedWorkspaceSource.error}`,
      };
    }
  }

  // Separate valid and failed plugins
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  const validPlugins = validatedPlugins.filter((v) => v.success);
  const warnings = failedValidations.map(
    (v) => `${v.plugin}: ${v.error} (skipped)`,
  );

  // If ALL plugins failed, abort
  if (validPlugins.length === 0 && config.plugins.length > 0) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: failedValidations.length,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings,
      error: `All plugins failed validation (workspace unchanged):\n${failedValidations.map((v) => `  - ${v.plugin}: ${v.error}`).join('\n')}`,
    };
  }

  // Step 2: Load previous sync state for selective purge
  const previousState = await loadSyncState(workspacePath);

  // Step 2b: Get paths that will be purged (for dry-run reporting)
  // In non-destructive mode, only show files from state (or nothing on first sync)
  const purgedPaths = previousState
    ? clients
        .map((client) => ({
          client,
          paths: getPreviouslySyncedFiles(previousState, client),
        }))
        .filter((p) => p.paths.length > 0)
    : [];

  // Step 3: Selective purge - only remove files we previously synced (skip in dry-run mode)
  if (!dryRun) {
    await selectivePurgeWorkspace(workspacePath, previousState, clients, {
      partialSync: !!options.clients,
    });
  }

  // Step 3b: Two-pass skill name resolution
  // Pass 1: Collect all skills from all plugins (excluding disabled skills)
  const disabledSkillsSet = new Set(config.disabledSkills ?? []);
  const allSkills = await collectAllSkills(validPlugins, disabledSkillsSet);

  // Build per-plugin skill name maps (handles conflicts automatically)
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Step 4: Copy fresh from all validated plugins
  // Pass 2: Copy skills using resolved names
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await Promise.all(
    validPlugins.map((validatedPlugin) => {
      const skillNameMap = pluginSkillMaps.get(validatedPlugin.resolved);
      return copyValidatedPlugin(
        validatedPlugin,
        workspacePath,
        clients,
        dryRun,
        skillNameMap,
        undefined, // clientMappings
        syncMode,
      );
    }),
  );

  // Step 5: Copy workspace files if configured
  // Supports both workspace.source (default base) and file-level sources
  let workspaceFileResults: CopyResult[] = [];
  if (config.workspace) {
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
        return {
          success: false,
          pluginResults,
          totalCopied: 0,
          totalFailed: errors.length,
          totalSkipped: 0,
          totalGenerated: 0,
          error: `File source fetch failed (workspace unchanged):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
        };
      }
      githubCache = cache;
    }

    // Step 5b: Validate all file sources exist before copying
    const fileValidationErrors = validateFileSources(filesToCopy, sourcePath, githubCache);
    if (fileValidationErrors.length > 0) {
      return {
        success: false,
        pluginResults,
        totalCopied: 0,
        totalFailed: fileValidationErrors.length,
        totalSkipped: 0,
        totalGenerated: 0,
        error: `File source validation failed (workspace unchanged):\n${fileValidationErrors.map((e) => `  - ${e}`).join('\n')}`,
      };
    }

    // Step 5c: Copy workspace files with GitHub cache
    // Pass repositories so paths are embedded directly in WORKSPACE-RULES
    workspaceFileResults = await copyWorkspaceFiles(
      sourcePath,
      workspacePath,
      filesToCopy,
      { dryRun, githubCache, repositories: config.repositories },
    );

    // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
    // Skip when repositories is empty (no agent files should be created)
    if (hasRepositories && !dryRun && clients.includes('claude') && sourcePath) {
      const claudePath = join(workspacePath, 'CLAUDE.md');
      const agentsPath = join(workspacePath, 'AGENTS.md');
      const claudeExistsInSource = existsSync(join(sourcePath, 'CLAUDE.md'));

      // Only copy if CLAUDE.md wasn't in source and AGENTS.md exists
      if (!claudeExistsInSource && existsSync(agentsPath) && !existsSync(claudePath)) {
        await copyFile(agentsPath, claudePath);
      }
    }
  }

  // When repositories are configured but no workspace.source is set,
  // ensure WORKSPACE-RULES are injected into agent files directly.
  // This handles the case where a user has repositories but no workspace: section.
  // (When workspace.source exists, rules are injected via copyWorkspaceFiles above.)
  if (!config.workspace && !dryRun && !skipAgentFiles) {
    await updateAgentFiles(workspacePath);
  }

  // Step 5d: Generate VSCode .code-workspace file if vscode client is configured
  if (clients.includes('vscode') && !dryRun) {
    generateVscodeWorkspaceFile(workspacePath, config);
  }

  // Count results from plugins
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

  // Count results from workspace files
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

  const hasFailures = pluginResults.some((r) => !r.success) || totalFailed > 0;

  // Step 6: Save sync state with all copied files (skip in dry-run mode)
  // Always save state after sync (even with partial failures) so state reflects disk reality.
  // The purge has already happened, so we need to track what was actually copied.
  if (!dryRun) {
    // Collect all copy results
    const allCopyResults: CopyResult[] = [
      ...pluginResults.flatMap((r) => r.copyResults),
      ...workspaceFileResults,
    ];

    // Group by client and save state
    const syncedFiles = collectSyncedPaths(allCopyResults, workspacePath, clients);

    // When syncing a subset of clients, merge with existing state for non-targeted clients
    if (options.clients && previousState) {
      for (const [client, files] of Object.entries(previousState.files)) {
        if (!clients.includes(client as ClientType)) {
          syncedFiles[client as ClientType] = files;
        }
      }
    }

    await saveSyncState(workspacePath, syncedFiles);
  }

  return {
    success: !hasFailures,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    purgedPaths,
    ...(warnings.length > 0 && { warnings }),
  };
}

/**
 * Sync user-scoped plugins to user home directories using USER_CLIENT_MAPPINGS.
 * Reads config from ~/.allagents/workspace.yaml and syncs to paths relative to $HOME.
 *
 * @param options - Sync options (offline, dryRun)
 * @returns Sync result
 */
export async function syncUserWorkspace(
  options: { offline?: boolean; dryRun?: boolean } = {},
): Promise<SyncResult> {
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

  const clients = config.clients;
  const { offline = false, dryRun = false } = options;

  // Pre-register unique marketplaces to avoid race conditions during parallel validation
  await ensureMarketplacesRegistered(config.plugins);

  // Validate all plugins
  const validatedPlugins = await validateAllPlugins(config.plugins, homeDir, offline);
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  const validPlugins = validatedPlugins.filter((v) => v.success);
  const warnings = failedValidations.map(
    (v) => `${v.plugin}: ${v.error} (skipped)`,
  );

  // If ALL plugins failed, abort
  if (validPlugins.length === 0 && config.plugins.length > 0) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: failedValidations.length,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings,
      error: `All plugins failed validation:\n${failedValidations.map((v) => `  - ${v.plugin}: ${v.error}`).join('\n')}`,
    };
  }

  // Load previous sync state (stored at ~/.allagents/sync-state.json)
  const previousState = await loadSyncState(homeDir);

  // Selective purge
  if (!dryRun) {
    await selectivePurgeWorkspace(homeDir, previousState, clients);
  }

  // Two-pass skill name resolution (excluding disabled skills)
  const disabledSkillsSet = new Set(config.disabledSkills ?? []);
  const allSkills = await collectAllSkills(validPlugins, disabledSkillsSet);
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Copy plugins using USER_CLIENT_MAPPINGS
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await Promise.all(
    validPlugins.map((vp) => {
      const skillNameMap = pluginSkillMaps.get(vp.resolved);
      return copyValidatedPlugin(vp, homeDir, clients, dryRun, skillNameMap, USER_CLIENT_MAPPINGS, syncMode);
    }),
  );

  // Count results
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

  // Save sync state
  if (!dryRun) {
    const allCopyResults = pluginResults.flatMap((r) => r.copyResults);
    const syncedFiles = collectSyncedPaths(allCopyResults, homeDir, clients as ClientType[], USER_CLIENT_MAPPINGS);
    await saveSyncState(homeDir, syncedFiles);
  }

  // Sync MCP server configs to VS Code if vscode client is configured
  let mcpResult: McpMergeResult | undefined;
  if (clients.includes('vscode') && validPlugins.length > 0) {
    mcpResult = syncVscodeMcpConfig(validPlugins, { dryRun });
    if (mcpResult.warnings.length > 0) {
      warnings.push(...mcpResult.warnings);
    }
  }

  return {
    success: totalFailed === 0,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    ...(warnings.length > 0 && { warnings }),
    ...(mcpResult && { mcpResult }),
  };
}

