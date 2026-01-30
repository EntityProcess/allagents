import { existsSync } from 'node:fs';
import { rm, unlink, rmdir, copyFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type {
  WorkspaceConfig,
  ClientType,
  WorkspaceFile,
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
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import {
  resolveSkillNames,
  getSkillKey,
  type SkillEntry,
} from '../utils/skill-name-resolver.js';
import {
  isPluginSpec,
  resolvePluginSpec,
  parsePluginSpec,
  getMarketplace,
  addMarketplace,
  getWellKnownMarketplaces,
} from './marketplace.js';
import {
  loadSyncState,
  saveSyncState,
  getPreviouslySyncedFiles,
} from './sync-state.js';
import type { SyncState } from '../models/sync-state.js';

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
}

/**
 * Result of validating a plugin (resolving its path without copying)
 */
export interface ValidatedPlugin {
  plugin: string;
  resolved: string;
  success: boolean;
  error?: string;
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
        // Check if it's a directory (skill directories end with /)
        if (filePath.endsWith('/')) {
          await rm(fullPath, { recursive: true, force: true });
        } else {
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
 * @param copyResults - Array of copy results from plugins
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to track
 * @returns Per-client file lists
 */
export function collectSyncedPaths(
  copyResults: CopyResult[],
  workspacePath: string,
  clients: ClientType[],
): Partial<Record<ClientType, string[]>> {
  const result: Partial<Record<ClientType, string[]>> = {};

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

    // Determine which client this file belongs to
    for (const client of clients) {
      const mapping = CLIENT_MAPPINGS[client];

      // Check if this is a skill directory (copy results for skills point to the dir)
      // e.g., relativePath = '.claude/skills/my-skill', skillsPath = '.claude/skills/'
      if (mapping.skillsPath && relativePath.startsWith(mapping.skillsPath)) {
        const skillName = relativePath.slice(mapping.skillsPath.length);
        // If skillName has no '/', this is a skill directory (not a file inside)
        if (!skillName.includes('/')) {
          // Track skill directory with trailing / for efficient rm -rf
          result[client]?.push(`${relativePath}/`);
          break;
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
        break;
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
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, offline);
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
 * @param validatedPlugin - Already validated plugin with resolved path
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param dryRun - Simulate without making changes
 * @param skillNameMap - Optional map of skill folder names to resolved names
 * @returns Plugin sync result
 */
async function copyValidatedPlugin(
  validatedPlugin: ValidatedPlugin,
  workspacePath: string,
  clients: string[],
  dryRun: boolean,
  skillNameMap?: Map<string, string>,
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];

  // Copy plugin content for each client
  for (const client of clients) {
    const results = await copyPluginToWorkspace(
      validatedPlugin.resolved,
      workspacePath,
      client as ClientType,
      { dryRun, ...(skillNameMap && { skillNameMap }) },
    );
    copyResults.push(...results);
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
 * @returns Array of collected skill entries
 */
async function collectAllSkills(
  validatedPlugins: ValidatedPlugin[],
): Promise<CollectedSkillEntry[]> {
  const allSkills: CollectedSkillEntry[] = [];

  for (const plugin of validatedPlugins) {
    const pluginName = await getPluginName(plugin.resolved);
    const skills = await collectPluginSkills(plugin.resolved, plugin.plugin);

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
  const { offline = false, dryRun = false, workspaceSourceBase } = options;
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

  // Check if any plugin validation failed
  const failedValidations = validatedPlugins.filter((v) => !v.success);
  if (failedValidations.length > 0) {
    // Return early - workspace unchanged
    const errors = failedValidations
      .map((v) => `  - ${v.plugin}: ${v.error}`)
      .join('\n');
    return {
      success: false,
      pluginResults: failedValidations.map((v) => ({
        plugin: v.plugin,
        resolved: v.resolved,
        success: false,
        copyResults: [],
        ...(v.error && { error: v.error }),
      })),
      totalCopied: 0,
      totalFailed: failedValidations.length,
      totalSkipped: 0,
      totalGenerated: 0,
      error: `Plugin validation failed (workspace unchanged):\n${errors}`,
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
  // Pass 1: Collect all skills from all plugins
  const allSkills = await collectAllSkills(validatedPlugins);

  // Build per-plugin skill name maps (handles conflicts automatically)
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);

  // Step 4: Copy fresh from all validated plugins
  // Pass 2: Copy skills using resolved names
  const pluginResults = await Promise.all(
    validatedPlugins.map((validatedPlugin) => {
      const skillNameMap = pluginSkillMaps.get(validatedPlugin.resolved);
      return copyValidatedPlugin(
        validatedPlugin,
        workspacePath,
        clients,
        dryRun,
        skillNameMap,
      );
    }),
  );

  // Step 5: Copy workspace files if configured
  // Supports both workspace.source (default base) and file-level sources
  let workspaceFileResults: CopyResult[] = [];
  if (config.workspace) {
    const sourcePath = validatedWorkspaceSource?.resolved;
    const filesToCopy = [...config.workspace.files];

    // Auto-include agent files if they exist in source and aren't already listed
    if (sourcePath) {
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
    workspaceFileResults = await copyWorkspaceFiles(
      sourcePath,
      workspacePath,
      filesToCopy,
      { dryRun, githubCache },
    );

    // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
    if (!dryRun && clients.includes('claude') && sourcePath) {
      const claudePath = join(workspacePath, 'CLAUDE.md');
      const agentsPath = join(workspacePath, 'AGENTS.md');
      const claudeExistsInSource = existsSync(join(sourcePath, 'CLAUDE.md'));

      // Only copy if CLAUDE.md wasn't in source and AGENTS.md exists
      if (!claudeExistsInSource && existsSync(agentsPath) && !existsSync(claudePath)) {
        await copyFile(agentsPath, claudePath);
      }
    }
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
  };
}

/**
 * Resolve a plugin@marketplace spec with auto-registration support
 *
 * Auto-registration rules:
 * 1. Well-known marketplace name → auto-register from known GitHub repo
 * 2. plugin@owner/repo format → auto-register owner/repo as marketplace
 * 3. plugin@owner/repo/subpath → auto-register owner/repo, look in subpath/
 * 4. Unknown short name → error with helpful message
 */
async function resolvePluginSpecWithAutoRegister(
  spec: string,
  _offline = false,
): Promise<{ success: boolean; path?: string; error?: string }> {
  // Parse plugin@marketplace using the new parser
  const parsed = parsePluginSpec(spec);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid plugin spec format: ${spec}\n  Expected: plugin@marketplace or plugin@owner/repo[/subpath]`,
    };
  }

  const { plugin: pluginName, marketplaceName, owner, repo, subpath } = parsed;

  // Check if marketplace is already registered
  let marketplace = await getMarketplace(marketplaceName);

  // If not registered, try auto-registration
  if (!marketplace) {
    // For owner/repo format, pass the full owner/repo string
    const sourceToRegister = owner && repo ? `${owner}/${repo}` : marketplaceName;
    const autoRegResult = await autoRegisterMarketplace(sourceToRegister);
    if (!autoRegResult.success) {
      return {
        success: false,
        error: autoRegResult.error || 'Unknown error',
      };
    }
    marketplace = await getMarketplace(autoRegResult.name ?? marketplaceName);
  }

  if (!marketplace) {
    return {
      success: false,
      error: `Marketplace '${marketplaceName}' not found`,
    };
  }

  // Determine the expected subpath for error messages
  const expectedSubpath = subpath ?? 'plugins';

  // Now resolve the plugin within the marketplace (pass subpath if specified)
  const resolved = await resolvePluginSpec(spec, subpath ? { subpath } : {});
  if (!resolved) {
    return {
      success: false,
      error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${marketplace.path}/${expectedSubpath}/${pluginName}/`,
    };
  }

  return {
    success: true,
    path: resolved.path,
  };
}

/**
 * Auto-register a marketplace by name
 *
 * Supports:
 * 1. Well-known names (e.g., "claude-plugins-official" → anthropics/claude-plugins-official)
 * 2. owner/repo format (e.g., "obra/superpowers" → github.com/obra/superpowers)
 */
async function autoRegisterMarketplace(
  name: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  const wellKnown = getWellKnownMarketplaces();

  // Check if it's a well-known marketplace name
  if (wellKnown[name]) {
    console.log(`Auto-registering well-known marketplace: ${name}`);
    const result = await addMarketplace(name);
    if (!result.success) {
      return { success: false, error: result.error || 'Unknown error' };
    }
    return { success: true, name };
  }

  // Check if it's an owner/repo format
  if (name.includes('/') && !name.includes('://')) {
    const parts = name.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      console.log(`Auto-registering GitHub marketplace: ${name}`);
      const repoName = parts[1];
      const result = await addMarketplace(name, repoName);
      if (!result.success) {
        return { success: false, error: result.error || 'Unknown error' };
      }
      return { success: true, name: repoName };
    }
  }

  // Unknown marketplace name - provide helpful error
  return {
    success: false,
    error: `Marketplace '${name}' not found.\n  Options:\n  1. Use fully qualified name: plugin@owner/repo\n  2. Register first: allagents plugin marketplace add <source>\n  3. Well-known marketplaces: ${Object.keys(wellKnown).join(', ')}`,
  };
}
