import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { loadSyncState } from '../../core/sync-state.js';
import { getUserWorkspaceConfig } from '../../core/user-workspace.js';
import { listMarketplaces } from '../../core/marketplace.js';

/**
 * Workspace context detected at TUI startup and after each action.
 * Pure state detection — no menu/UI decisions here.
 */
export interface TuiContext {
  hasWorkspace: boolean;
  workspacePath: string | null;
  projectPluginCount: number;
  userPluginCount: number;
  needsSync: boolean;
  hasUserConfig: boolean;
  marketplaceCount: number;
}

/**
 * Detect workspace state for the interactive TUI.
 * @param cwd - Working directory to check (defaults to process.cwd())
 */
export async function getTuiContext(
  cwd: string = process.cwd(),
): Promise<TuiContext> {
  const configPath = join(cwd, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  const hasWorkspace = existsSync(configPath);

  // Project-level plugin count
  let projectPluginCount = 0;
  if (hasWorkspace) {
    const status = await getWorkspaceStatus(cwd);
    projectPluginCount = status.plugins.length;
  }

  // User-level config and plugin count
  const userConfig = await getUserWorkspaceConfig();
  const hasUserConfig = userConfig !== null;
  const userPluginCount = userConfig?.plugins.length ?? 0;

  // Sync state detection
  const needsSync = await detectNeedsSync(
    cwd,
    hasWorkspace,
    projectPluginCount,
  );

  // Marketplace count
  const marketplaces = await listMarketplaces();
  const marketplaceCount = marketplaces.length;

  return {
    hasWorkspace,
    workspacePath: hasWorkspace ? cwd : null,
    projectPluginCount,
    userPluginCount,
    needsSync,
    hasUserConfig,
    marketplaceCount,
  };
}

/**
 * Check if sync is needed.
 * Sync is needed when:
 * - Workspace exists with plugins but no sync state recorded
 * - Sync state exists but has no files recorded
 */
async function detectNeedsSync(
  cwd: string,
  hasWorkspace: boolean,
  pluginCount: number,
): Promise<boolean> {
  if (!hasWorkspace) {
    return false;
  }

  const syncState = await loadSyncState(cwd);

  // No sync state but plugins exist — needs sync
  if (syncState === null) {
    return pluginCount > 0;
  }

  // Sync state exists but has no files recorded — needs sync
  const totalFiles = Object.values(syncState.files).reduce(
    (sum, files) => sum + files.length,
    0,
  );

  return totalFiles === 0 && pluginCount > 0;
}
