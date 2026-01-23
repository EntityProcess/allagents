import { existsSync } from 'fs';
import { join, resolve } from 'path';
import simpleGit from 'simple-git';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import { parsePluginSource, isGitHubUrl, parseGitHubUrl } from '../utils/plugin-path.js';
import { fetchPlugin } from './plugin.js';
import { copyPluginToWorkspace, type CopyResult } from './transform.js';

/**
 * Result of a sync operation
 */
export interface SyncResult {
  success: boolean;
  pluginResults: PluginSyncResult[];
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
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
  options: SyncOptions = {}
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
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  // Parse workspace config
  let config;
  try {
    config = await parseWorkspaceConfig(configPath);
  } catch (error) {
    return {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      error: error instanceof Error ? error.message : 'Failed to parse workspace.yaml',
    };
  }

  // Process all plugins in parallel for better performance
  const pluginResults = await Promise.all(
    config.plugins.map((pluginSource) =>
      syncPlugin(pluginSource, workspacePath, config.clients, { force, dryRun })
    )
  );

  // Count results
  let totalCopied = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

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
  };
}

/**
 * Sync a single plugin to workspace
 * @param pluginSource - Plugin source (local path or GitHub URL)
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param options - Sync options
 * @returns Plugin sync result
 */
async function syncPlugin(
  pluginSource: string,
  workspacePath: string,
  clients: string[],
  options: SyncOptions = {}
): Promise<PluginSyncResult> {
  const { force = false, dryRun = false } = options;
  const copyResults: CopyResult[] = [];

  // Resolve plugin path
  let resolvedPath: string;

  if (isGitHubUrl(pluginSource)) {
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
    const results = await copyPluginToWorkspace(resolvedPath, workspacePath, client as any, { dryRun });
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
