import { existsSync } from 'fs';
import { join, resolve } from 'path';
import simpleGit from 'simple-git';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import { parsePluginSource, isGitHubUrl } from '../utils/plugin-path.js';
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
 * Sync all plugins to workspace for all configured clients
 * @param workspacePath - Path to workspace directory (defaults to current directory)
 * @returns Sync result
 */
export async function syncWorkspace(workspacePath: string = process.cwd()): Promise<SyncResult> {
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

  const pluginResults: PluginSyncResult[] = [];
  let totalCopied = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  // Process each plugin
  for (const pluginSource of config.plugins) {
    const pluginResult = await syncPlugin(pluginSource, workspacePath, config.clients);
    pluginResults.push(pluginResult);

    // Count results
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

  // Create git commit if successful
  if (!hasFailures) {
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
 * @returns Plugin sync result
 */
async function syncPlugin(
  pluginSource: string,
  workspacePath: string,
  clients: string[]
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];

  // Resolve plugin path
  let resolvedPath: string;

  if (isGitHubUrl(pluginSource)) {
    // Fetch remote plugin
    const fetchResult = await fetchPlugin(pluginSource);
    if (!fetchResult.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        copyResults,
        ...(fetchResult.error && { error: fetchResult.error }),
      };
    }
    resolvedPath = fetchResult.cachePath;
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
    const results = await copyPluginToWorkspace(resolvedPath, workspacePath, client as any);
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
