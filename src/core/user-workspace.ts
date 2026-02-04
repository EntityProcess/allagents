import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type { WorkspaceConfig, ClientType } from '../models/workspace-config.js';
import { getAllagentsDir } from './marketplace.js';
import {
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import {
  validatePluginSource,
  isGitHubUrl,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import type { ModifyResult } from './workspace-modify.js';

/**
 * All supported client types for user-scope installations.
 */
const ALL_CLIENTS: ClientType[] = [
  'claude', 'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode',
];

/**
 * Get path to user-level workspace config: ~/.allagents/workspace.yaml
 */
export function getUserWorkspaceConfigPath(): string {
  return join(getAllagentsDir(), WORKSPACE_CONFIG_FILE);
}

/**
 * Check if a workspace path's config resolves to the user-level config.
 * This happens when cwd is the user's home directory, causing the project
 * config path (cwd/.allagents/workspace.yaml) to be the same file as the
 * user config (~/.allagents/workspace.yaml).
 */
export function isUserConfigPath(workspacePath: string): boolean {
  const projectConfigPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  const userConfigPath = getUserWorkspaceConfigPath();
  return resolve(projectConfigPath) === resolve(userConfigPath);
}

/**
 * Ensure user-level workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureUserWorkspace(): Promise<void> {
  const configPath = getUserWorkspaceConfigPath();
  if (existsSync(configPath)) return;

  const defaultConfig: WorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: [...ALL_CLIENTS],
  };

  await mkdir(getAllagentsDir(), { recursive: true });
  await writeFile(configPath, dump(defaultConfig, { lineWidth: -1 }), 'utf-8');
}

/**
 * Read user-level workspace config. Returns null if not found.
 */
export async function getUserWorkspaceConfig(): Promise<WorkspaceConfig | null> {
  const configPath = getUserWorkspaceConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const content = await readFile(configPath, 'utf-8');
    return load(content) as WorkspaceConfig;
  } catch {
    return null;
  }
}

/**
 * Add a plugin to the user-level workspace config.
 * Creates the config file if it doesn't exist.
 *
 * Supports three formats:
 * 1. plugin@marketplace (e.g., "code-review@claude-plugins-official")
 * 2. GitHub URL (e.g., "https://github.com/owner/repo")
 * 3. Local path (e.g., "/home/user/my-plugin")
 */
export async function addUserPlugin(plugin: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  // Handle plugin@marketplace format
  if (isPluginSpec(plugin)) {
    const resolved = await resolvePluginSpecWithAutoRegister(plugin);
    if (!resolved.success) {
      return { success: false, error: resolved.error || 'Unknown error' };
    }
    const normalizedPlugin = resolved.registeredAs
      ? plugin.replace(/@[^@]+$/, `@${resolved.registeredAs}`)
      : plugin;
    return addPluginToUserConfig(normalizedPlugin, configPath, resolved.registeredAs);
  }

  // Handle GitHub URL
  if (isGitHubUrl(plugin)) {
    const validation = validatePluginSource(plugin);
    if (!validation.valid) {
      return { success: false, error: validation.error || 'Invalid GitHub URL' };
    }
    const verifyResult = await verifyGitHubUrlExists(plugin);
    if (!verifyResult.exists) {
      return { success: false, error: verifyResult.error || `GitHub URL not found: ${plugin}` };
    }
  } else {
    // Local path - verify it exists
    if (!existsSync(plugin)) {
      return {
        success: false,
        error: `Plugin not found at ${plugin}`,
      };
    }
  }

  return addPluginToUserConfig(plugin, configPath);
}

/**
 * Check if a plugin exists in the user-level workspace config.
 * @param plugin - Plugin source to find (exact match or partial match)
 * @returns true if the plugin is found
 */
export async function hasUserPlugin(plugin: string): Promise<boolean> {
  const config = await getUserWorkspaceConfig();
  if (!config) return false;

  // Exact match first
  if (config.plugins.indexOf(plugin) !== -1) return true;

  // Partial match
  return config.plugins.some(
    (p) => p.startsWith(`${plugin}@`) || p === plugin,
  );
}

/**
 * Remove a plugin from the user-level workspace config.
 */
export async function removeUserPlugin(plugin: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Exact match first
    let index = config.plugins.indexOf(plugin);

    // Partial match: plugin name without marketplace suffix
    if (index === -1) {
      index = config.plugins.findIndex(
        (p) => p.startsWith(`${plugin}@`) || p === plugin,
      );
    }

    if (index === -1) {
      return { success: false, error: `Plugin not found in user config: ${plugin}` };
    }

    config.plugins.splice(index, 1);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get user plugins that reference a given marketplace name.
 * Matches plugins with `@marketplace-name` suffix.
 */
export async function getUserPluginsForMarketplace(marketplaceName: string): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];
  return config.plugins.filter((p) => {
    const parsed = parsePluginSpec(p);
    return parsed?.marketplaceName === marketplaceName;
  });
}

/**
 * Remove all user plugins that reference a given marketplace name.
 * Returns the list of removed plugin specs.
 */
export async function removeUserPluginsForMarketplace(marketplaceName: string): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const matching = config.plugins.filter((p) => {
    const parsed = parsePluginSpec(p);
    return parsed?.marketplaceName === marketplaceName;
  });

  if (matching.length === 0) return [];

  const configPath = getUserWorkspaceConfigPath();
  config.plugins = config.plugins.filter((p) => !matching.includes(p));
  await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
  return matching;
}

/**
 * Add plugin entry to the user-level config file.
 */
async function addPluginToUserConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
): Promise<ModifyResult> {
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    if (config.plugins.includes(plugin)) {
      return { success: false, error: `Plugin already exists in user config: ${plugin}` };
    }

    config.plugins.push(plugin);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true, ...(autoRegistered && { autoRegistered }) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
