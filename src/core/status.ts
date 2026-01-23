import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import {
  parsePluginSource,
  getPluginCachePath,
  type ParsedPluginSource,
} from '../utils/plugin-path.js';

/**
 * Status of a single plugin
 */
export interface PluginStatus {
  source: string;
  type: 'local' | 'github';
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
  const configPath = join(workspacePath, 'workspace.yaml');

  // Check if workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
      plugins: [],
      clients: [],
    };
  }

  try {
    const config = await parseWorkspaceConfig(configPath);
    const plugins: PluginStatus[] = [];

    for (const pluginSource of config.plugins) {
      const parsed = parsePluginSource(pluginSource, workspacePath);
      const status = getPluginStatus(parsed);
      plugins.push(status);
    }

    return {
      success: true,
      plugins,
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
