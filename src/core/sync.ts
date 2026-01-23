import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import type {
  WorkspaceConfig,
  ClientType,
} from '../models/workspace-config.js';
import {
  parsePluginSource,
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
        error: fetchResult.error,
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
  const { force = false, dryRun = false } = options;
  const configPath = join(workspacePath, 'workspace.yaml');

  // Check workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
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
          : 'Failed to parse workspace.yaml',
    };
  }

  // Step 1: Validate all plugins before any destructive action
  const validatedPlugins = await validateAllPlugins(
    config.plugins,
    workspacePath,
    force,
  );

  // Step 1b: Validate workspace.source if defined
  let validatedWorkspaceSource: ValidatedPlugin | null = null;
  if (config.workspace?.source) {
    validatedWorkspaceSource = await validatePlugin(
      config.workspace.source,
      workspacePath,
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
        error: v.error,
      })),
      totalCopied: 0,
      totalFailed: failedValidations.length,
      totalSkipped: 0,
      totalGenerated: 0,
      error: `Plugin validation failed (workspace unchanged):\n${errors}`,
    };
  }

  // Step 2: Get paths that will be purged (for dry-run reporting)
  const purgedPaths = getPurgePaths(workspacePath, config.clients);

  // Step 3: Purge managed directories (skip in dry-run mode)
  if (!dryRun) {
    await purgeWorkspace(workspacePath, config.clients);
  }

  // Step 4: Copy fresh from all validated plugins
  const pluginResults = await Promise.all(
    validatedPlugins.map((validatedPlugin) =>
      copyValidatedPlugin(validatedPlugin, workspacePath, config.clients, dryRun),
    ),
  );

  // Step 5: Copy workspace files if configured
  let workspaceFileResults: CopyResult[] = [];
  if (config.workspace && validatedWorkspaceSource) {
    workspaceFileResults = await copyWorkspaceFiles(
      validatedWorkspaceSource.resolved,
      workspacePath,
      config.workspace.files,
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

  // Create git commit if successful (skip in dry-run mode)
  if (!hasFailures && !dryRun) {
    try {
      const git = simpleGit(workspacePath);
      await git.add('.');

      // Check if there are changes to commit
      const status = await git.status();
      if (status.files.length > 0) {
        const timestamp = new Date().toISOString();
        const pluginNames = config.plugins.map((p) => {
          // Handle plugin@marketplace format
          if (isPluginSpec(p)) {
            return p;
          }
          // Handle GitHub URLs
          const parsed = parsePluginSource(p);
          if (parsed.type === 'github' && parsed.owner && parsed.repo) {
            return `${parsed.owner}/${parsed.repo}`;
          }
          return p;
        });

        await git.commit(`sync: Update workspace from plugins

Synced plugins:
${pluginNames.map((p) => `- ${p}`).join('\n')}

Timestamp: ${timestamp}`);
      }
    } catch {
      // Git commit is optional, don't fail sync
    }
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
  const resolved = await resolvePluginSpec(spec, { subpath });
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
