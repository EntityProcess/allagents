import { existsSync } from 'node:fs';
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
import { copyPluginToWorkspace, type CopyResult } from './transform.js';
import {
  isPluginSpec,
  resolvePluginSpec,
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
 * Sync all plugins to workspace for all configured clients
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

  // Process all plugins in parallel for better performance
  const pluginResults = await Promise.all(
    config.plugins.map((pluginSource) =>
      syncPlugin(pluginSource, workspacePath, config.clients, {
        force,
        dryRun,
      }),
    ),
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
  };
}

/**
 * Sync a single plugin to workspace
 * Supports three formats:
 * 1. plugin@marketplace (e.g., "code-review@claude-plugins-official")
 * 2. GitHub URL (e.g., "https://github.com/owner/repo")
 * 3. Local path (e.g., "./my-plugin" or "/absolute/path")
 *
 * @param pluginSource - Plugin source
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param options - Sync options
 * @returns Plugin sync result
 */
async function syncPlugin(
  pluginSource: string,
  workspacePath: string,
  clients: string[],
  options: SyncOptions = {},
): Promise<PluginSyncResult> {
  const { force = false, dryRun = false } = options;
  const copyResults: CopyResult[] = [];

  // Resolve plugin path based on format
  let resolvedPath: string;

  // Check for plugin@marketplace format first
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, force);
    if (!resolved.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        copyResults,
        error: resolved.error || 'Unknown error',
      };
    }
    resolvedPath = resolved.path ?? '';
  } else if (isGitHubUrl(pluginSource)) {
    // Fetch remote plugin (with force option)
    const fetchResult = await fetchPlugin(pluginSource, { force });
    if (!fetchResult.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        copyResults,
        ...(fetchResult.error && { error: fetchResult.error }),
      };
    }
    // Handle subpath in GitHub URL (e.g., /tree/main/plugins/name)
    const parsed = parseGitHubUrl(pluginSource);
    resolvedPath = parsed?.subpath
      ? join(fetchResult.cachePath, parsed.subpath)
      : fetchResult.cachePath;
  } else {
    // Local plugin
    resolvedPath = resolve(workspacePath, pluginSource);
    if (!existsSync(resolvedPath)) {
      return {
        plugin: pluginSource,
        resolved: resolvedPath,
        success: false,
        copyResults,
        error: `Plugin not found at ${resolvedPath}`,
      };
    }
  }

  // Copy plugin content for each client
  for (const client of clients) {
    const results = await copyPluginToWorkspace(
      resolvedPath,
      workspacePath,
      client as ClientType,
      { dryRun },
    );
    copyResults.push(...results);
  }

  const hasFailures = copyResults.some((r) => r.action === 'failed');

  return {
    plugin: pluginSource,
    resolved: resolvedPath,
    success: !hasFailures,
    copyResults,
  };
}

/**
 * Resolve a plugin@marketplace spec with auto-registration support
 *
 * Auto-registration rules:
 * 1. Well-known marketplace name → auto-register from known GitHub repo
 * 2. plugin@owner/repo format → auto-register owner/repo as marketplace
 * 3. Unknown short name → error with helpful message
 */
async function resolvePluginSpecWithAutoRegister(
  spec: string,
  _force = false,
): Promise<{ success: boolean; path?: string; error?: string }> {
  // Parse plugin@marketplace
  const atIndex = spec.lastIndexOf('@');
  const pluginName = spec.slice(0, atIndex);
  const marketplaceName = spec.slice(atIndex + 1);

  if (!pluginName || !marketplaceName) {
    return {
      success: false,
      error: `Invalid plugin spec format: ${spec}\n  Expected: plugin@marketplace`,
    };
  }

  // Check if marketplace is already registered
  let marketplace = await getMarketplace(marketplaceName);

  // If not registered, try auto-registration
  if (!marketplace) {
    const autoRegResult = await autoRegisterMarketplace(marketplaceName);
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

  // Now resolve the plugin within the marketplace
  const resolved = await resolvePluginSpec(spec);
  if (!resolved) {
    return {
      success: false,
      error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${marketplace.path}/plugins/${pluginName}/`,
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
