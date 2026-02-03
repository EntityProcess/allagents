import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { isPluginSpec, parsePluginSpec, getMarketplace } from './marketplace.js';
import { getUserWorkspaceConfig, getUserWorkspaceConfigPath } from './user-workspace.js';
import type { WorkspaceConfig } from '../models/workspace-config.js';

export interface PruneScopeResult {
  removed: string[];
  kept: string[];
}

export interface PruneResult {
  project: PruneScopeResult;
  user: PruneScopeResult;
}

/**
 * Check if a marketplace plugin is orphaned (marketplace not in registry)
 */
async function isOrphanedPlugin(pluginSpec: string): Promise<boolean> {
  if (!isPluginSpec(pluginSpec)) return false;
  const parsed = parsePluginSpec(pluginSpec);
  if (!parsed) return false;
  const marketplace = await getMarketplace(parsed.marketplaceName);
  return marketplace === null;
}

/**
 * Prune orphaned plugins from a config, returning removed and kept lists
 */
async function prunePlugins(plugins: string[]): Promise<PruneScopeResult> {
  const removed: string[] = [];
  const kept: string[] = [];

  for (const plugin of plugins) {
    if (await isOrphanedPlugin(plugin)) {
      removed.push(plugin);
    } else {
      kept.push(plugin);
    }
  }

  return { removed, kept };
}

/**
 * Prune orphaned plugin references from both project and user workspace configs.
 * An orphaned plugin is a marketplace plugin whose marketplace is no longer registered.
 *
 * @param workspacePath - Path to project workspace directory
 * @returns Results showing what was removed from each scope
 */
export async function pruneOrphanedPlugins(
  workspacePath: string,
): Promise<PruneResult> {
  // Prune project-level plugins
  let projectResult: PruneScopeResult = { removed: [], kept: [] };
  const projectConfigPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (existsSync(projectConfigPath)) {
    const content = await readFile(projectConfigPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    projectResult = await prunePlugins(config.plugins);

    if (projectResult.removed.length > 0) {
      config.plugins = projectResult.kept;
      await writeFile(projectConfigPath, dump(config, { lineWidth: -1 }), 'utf-8');
    }
  }

  // Prune user-level plugins
  let userResult: PruneScopeResult = { removed: [], kept: [] };
  const userConfig = await getUserWorkspaceConfig();

  if (userConfig) {
    userResult = await prunePlugins(userConfig.plugins);

    if (userResult.removed.length > 0) {
      userConfig.plugins = userResult.kept;
      const userConfigPath = getUserWorkspaceConfigPath();
      await writeFile(userConfigPath, dump(userConfig, { lineWidth: -1 }), 'utf-8');
    }
  }

  return {
    project: projectResult,
    user: userResult,
  };
}
