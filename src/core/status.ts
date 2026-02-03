import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import {
  parsePluginSource,
  getPluginCachePath,
  type ParsedPluginSource,
} from '../utils/plugin-path.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import { getUserWorkspaceConfig } from './user-workspace.js';

/**
 * Status of a single plugin
 */
export interface PluginStatus {
  source: string;
  type: 'local' | 'github' | 'marketplace';
  available: boolean;
  path: string;
  owner?: string;
  repo?: string;
}

/**
 * Result of workspace status check
 */
export interface WorkspaceStatusResult {
  success: boolean;
  error?: string;
  plugins: PluginStatus[];
  /** User-level plugins from ~/.allagents/workspace.yaml */
  userPlugins?: PluginStatus[];
  clients: string[];
}

/**
 * Get status of workspace and its plugins
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Status result with plugin availability
 */
export async function getWorkspaceStatus(
  workspacePath: string = process.cwd(),
): Promise<WorkspaceStatusResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  // Check if .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
      plugins: [],
      clients: [],
    };
  }

  try {
    const config = await parseWorkspaceConfig(configPath);
    const plugins: PluginStatus[] = [];

    for (const pluginSource of config.plugins) {
      if (isPluginSpec(pluginSource)) {
        const status = await getMarketplacePluginStatus(pluginSource);
        plugins.push(status);
      } else {
        const parsed = parsePluginSource(pluginSource, workspacePath);
        const status = getPluginStatus(parsed);
        plugins.push(status);
      }
    }

    const userPlugins = await getUserPluginStatuses();

    return {
      success: true,
      plugins,
      userPlugins,
      clients: config.clients,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      plugins: [],
      clients: [],
    };
  }
}

/**
 * Get status of a single plugin
 */
function getPluginStatus(parsed: ParsedPluginSource): PluginStatus {
  if (parsed.type === 'github') {
    // Check if cached
    const cachePath =
      parsed.owner && parsed.repo
        ? getPluginCachePath(parsed.owner, parsed.repo)
        : '';
    const available = cachePath ? existsSync(cachePath) : false;

    return {
      source: parsed.original,
      type: 'github',
      available,
      path: cachePath,
      ...(parsed.owner && { owner: parsed.owner }),
      ...(parsed.repo && { repo: parsed.repo }),
    };
  }

  // Local plugin - check if path exists
  const available = existsSync(parsed.normalized);

  return {
    source: parsed.original,
    type: 'local',
    available,
    path: parsed.normalized,
  };
}

/**
 * Get statuses for all user-level plugins from ~/.allagents/workspace.yaml
 */
async function getUserPluginStatuses(): Promise<PluginStatus[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const statuses: PluginStatus[] = [];
  for (const pluginSource of config.plugins) {
    if (isPluginSpec(pluginSource)) {
      statuses.push(await getMarketplacePluginStatus(pluginSource));
    } else {
      const parsed = parsePluginSource(pluginSource, process.env.HOME || '~');
      statuses.push(getPluginStatus(parsed));
    }
  }
  return statuses;
}

/**
 * Get status of a plugin@marketplace spec
 */
async function getMarketplacePluginStatus(spec: string): Promise<PluginStatus> {
  const resolved = await resolvePluginSpecWithAutoRegister(spec);

  return {
    source: spec,
    type: 'marketplace',
    available: resolved.success,
    path: resolved.path ?? '',
  };
}
