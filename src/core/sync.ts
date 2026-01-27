import { existsSync } from 'node:fs';
import { rm, unlink, rmdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type {
  WorkspaceConfig,
  ClientType,
} from '../models/workspace-config.js';
import {
  isGitHubUrl,
  parseGitHubUrl,
} from '../utils/plugin-path.js';
import { fetchPlugin } from './plugin.js';
import { copyPluginToWorkspace, copyWorkspaceFiles, type CopyResult } from './transform.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
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
  /** Force re-fetch of remote plugins even if cached */
  force?: boolean;
  /** Simulate sync without making changes */
  dryRun?: boolean;
  /**
   * Base path for resolving relative workspace.source paths.
   * Used during init to resolve paths relative to the --from source directory
   * instead of the target workspace. If not provided, defaults to workspacePath.
   */
  workspaceSourceBase?: string;
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
): Promise<PurgePaths[]> {
  // First sync - no state, skip purge entirely (safe overlay)
  if (!state) {
    return [];
  }

  const result: PurgePaths[] = [];

  for (const client of clients) {
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
 * @param force - Force re-fetch of remote plugins
 * @returns Validation result with resolved path
 */
async function validatePlugin(
  pluginSource: string,
  workspacePath: string,
  force: boolean,
): Promise<ValidatedPlugin> {
  // Check for plugin@marketplace format first
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, force);
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
    // Fetch remote plugin (with force option)
    const fetchResult = await fetchPlugin(pluginSource, { force });
    if (!fetchResult.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        ...(fetchResult.error && { error: fetchResult.error }),
      };
    }
    // Handle subpath in GitHub URL (e.g., /tree/main/plugins/name)
    const parsed = parseGitHubUrl(pluginSource);
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
 * @param force - Force re-fetch of remote plugins
 * @returns Array of validation results
 */
async function validateAllPlugins(
  plugins: string[],
  workspacePath: string,
  force: boolean,
): Promise<ValidatedPlugin[]> {
  return Promise.all(
    plugins.map((plugin) => validatePlugin(plugin, workspacePath, force)),
  );
}

/**
 * Copy content from a validated plugin to workspace
 * @param validatedPlugin - Already validated plugin with resolved path
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param dryRun - Simulate without making changes
 * @returns Plugin sync result
 */
async function copyValidatedPlugin(
  validatedPlugin: ValidatedPlugin,
  workspacePath: string,
  clients: string[],
  dryRun: boolean,
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];

  // Copy plugin content for each client
  for (const client of clients) {
    const results = await copyPluginToWorkspace(
      validatedPlugin.resolved,
      workspacePath,
      client as ClientType,
      { dryRun },
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
 * Sync all plugins to workspace for all configured clients
 *
 * Flow:
 * 1. Validate all plugins (fetch/resolve paths)
 * 2. If any validation fails, abort without changes
 * 3. Purge managed directories (declarative sync)
 * 4. Copy fresh from all validated plugins
 *
 * @param workspacePath - Path to workspace directory (defaults to current directory)
 * @param options - Sync options (force, dryRun)
 * @returns Sync result
 */
export async function syncWorkspace(
  workspacePath: string = process.cwd(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  const { force = false, dryRun = false, workspaceSourceBase } = options;
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

  // Step 1: Validate all plugins before any destructive action
  const validatedPlugins = await validateAllPlugins(
    config.plugins,
    workspacePath,
    force,
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
      force,
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
    ? config.clients
        .map((client) => ({
          client,
          paths: getPreviouslySyncedFiles(previousState, client),
        }))
        .filter((p) => p.paths.length > 0)
    : [];

  // Step 3: Selective purge - only remove files we previously synced (skip in dry-run mode)
  if (!dryRun) {
    await selectivePurgeWorkspace(workspacePath, previousState, config.clients);
  }

  // Step 4: Copy fresh from all validated plugins
  const pluginResults = await Promise.all(
    validatedPlugins.map((validatedPlugin) =>
      copyValidatedPlugin(validatedPlugin, workspacePath, config.clients, dryRun),
    ),
  );

  // Step 5: Copy workspace files if configured
  // Auto-include agent files (AGENTS.md, CLAUDE.md) that exist in source
  let workspaceFileResults: CopyResult[] = [];
  if (config.workspace && validatedWorkspaceSource) {
    const sourcePath = validatedWorkspaceSource.resolved;
    const filesToCopy = [...config.workspace.files];

    // Auto-include agent files if they exist and aren't already listed
    for (const agentFile of AGENT_FILES) {
      const agentPath = join(sourcePath, agentFile);
      if (existsSync(agentPath) && !filesToCopy.includes(agentFile)) {
        filesToCopy.push(agentFile);
      }
    }

    workspaceFileResults = await copyWorkspaceFiles(
      sourcePath,
      workspacePath,
      filesToCopy,
      { dryRun },
    );
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
  if (!hasFailures && !dryRun) {
    // Collect all copy results
    const allCopyResults: CopyResult[] = [
      ...pluginResults.flatMap((r) => r.copyResults),
      ...workspaceFileResults,
    ];

    // Group by client and save state
    const syncedFiles = collectSyncedPaths(allCopyResults, workspacePath, config.clients);
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
  _force = false,
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
