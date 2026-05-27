import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, getHomeDir } from '../constants.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import { getPluginSource, getClientTypes } from '../models/workspace-config.js';
import {
  parsePluginSource,
  parseGitHubUrl,
  getPluginCachePath,
  type ParsedPluginSource,
} from '../utils/plugin-path.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import { getUserWorkspaceConfig, isUserConfigPath } from './user-workspace.js';

/**
 * Status of a single plugin
 */
export interface PluginStatus {
  source: string;
  type: 'local' | 'github' | 'marketplace';
  /**
   * 'skill' when the resolved path looks like a single-skill source (root
   * SKILL.md, no skills/ subdir — matches the auto-wrap layout from #232/#249).
   * 'plugin' otherwise, including when the path can't be inspected (not cached,
   * not synced, missing locally).
   */
  kind: 'skill' | 'plugin';
  available: boolean;
  path: string;
  owner?: string;
  repo?: string;
}

/**
 * Classify a resolved cache/local path as a standalone skill or a plugin
 * bundle. A "skill" has a SKILL.md at its root and no skills/ subdir; anything
 * else (including paths that don't exist) is treated as a plugin.
 */
function classifyKind(path: string): 'skill' | 'plugin' {
  if (!path) return 'plugin';
  try {
    if (
      existsSync(join(path, 'SKILL.md')) &&
      !existsSync(join(path, 'skills'))
    ) {
      return 'skill';
    }
  } catch {
    // ignore — default to plugin
  }
  return 'plugin';
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

  // If no project workspace.yaml, or project config IS the user config
  // (i.e. cwd is the home directory), return user-level plugins only
  if (!existsSync(configPath) || isUserConfigPath(workspacePath)) {
    const userPlugins = await getUserPluginStatuses();
    return {
      success: true,
      plugins: [],
      userPlugins,
      clients: [],
    };
  }

  try {
    const config = await parseWorkspaceConfig(configPath);
    const plugins: PluginStatus[] = [];

    for (const pluginEntry of config.plugins) {
      const pluginSource = getPluginSource(pluginEntry);
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
      clients: getClientTypes(config.clients),
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
        ? getPluginCachePath(parsed.owner, parsed.repo, parsed.branch)
        : '';
    const available = cachePath ? existsSync(cachePath) : false;

    // For GitHub plugins with a subpath, classify the resolved subdir rather
    // than the repo root — that's what users actually consume. ParsedPluginSource
    // drops the subpath, so re-parse the original URL to recover it.
    const subpath = parseGitHubUrl(parsed.original)?.subpath;
    const classifyPath =
      available && cachePath
        ? subpath
          ? join(cachePath, subpath)
          : cachePath
        : '';

    return {
      source: parsed.original,
      type: 'github',
      kind: classifyKind(classifyPath),
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
    kind: classifyKind(available ? parsed.normalized : ''),
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
  for (const pluginEntry of config.plugins) {
    const pluginSource = getPluginSource(pluginEntry);
    if (isPluginSpec(pluginSource)) {
      statuses.push(await getMarketplacePluginStatus(pluginSource));
    } else {
      const parsed = parsePluginSource(pluginSource, getHomeDir());
      statuses.push(getPluginStatus(parsed));
    }
  }
  return statuses;
}

/**
 * Get status of a plugin@marketplace spec
 */
async function getMarketplacePluginStatus(spec: string): Promise<PluginStatus> {
  const resolved = await resolvePluginSpecWithAutoRegister(spec, { offline: true });

  return {
    source: spec,
    type: 'marketplace',
    kind: classifyKind(resolved.success ? (resolved.path ?? '') : ''),
    available: resolved.success,
    path: resolved.path ?? '',
  };
}
