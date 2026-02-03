import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';
import { getWorkspaceStatus } from '../../core/status.js';
import { loadSyncState } from '../../core/sync-state.js';
import { getUserWorkspaceConfig } from '../../core/user-workspace.js';
import { listMarketplaces } from '../../core/marketplace.js';
import type { TuiCache } from './cache.js';

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
  cache?: TuiCache,
): Promise<TuiContext> {
  // Return cached context if available
  if (cache?.hasCachedContext()) {
    return cache.getContext()!;
  }
  const configPath = join(cwd, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  const hasWorkspace = existsSync(configPath);

  // Project-level plugin count
  let projectPluginCount = 0;
  if (hasWorkspace) {
    try {
      const status = await getWorkspaceStatus(cwd);
      projectPluginCount = status.plugins.length;
    } catch {
      // Workspace config malformed or unreadable -- degrade gracefully
    }
  }

  // User-level config and plugin count
  let userPluginCount = 0;
  let hasUserConfig = false;
  try {
    const userConfig = await getUserWorkspaceConfig();
    hasUserConfig = userConfig !== null;
    userPluginCount = userConfig?.plugins.length ?? 0;
  } catch {
    // User config unavailable -- degrade gracefully
  }

  // Sync state detection
  let needsSync = false;
  try {
    needsSync = await detectNeedsSync(
      cwd,
      hasWorkspace,
      projectPluginCount,
    );
  } catch {
    // Sync state detection failed -- degrade gracefully
  }

  // Marketplace count
  let marketplaceCount = 0;
  try {
    const marketplaces = await listMarketplaces();
    marketplaceCount = marketplaces.length;
  } catch {
    // Marketplace listing failed -- degrade gracefully
  }

  const context: TuiContext = {
    hasWorkspace,
    workspacePath: hasWorkspace ? cwd : null,
    projectPluginCount,
    userPluginCount,
    needsSync,
    hasUserConfig,
    marketplaceCount,
  };

  cache?.setContext(context);
  return context;
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

  try {
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
  } catch {
    // Sync state loading failed -- assume no sync needed
    return false;
  }
}
