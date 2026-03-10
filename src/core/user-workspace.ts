import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  ClientEntry,
  PluginEntry,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import { getPluginSource } from '../models/workspace-config.js';
import {
  isGitHubUrl,
  parseGitHubUrl,
  validatePluginSource,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import { getAllagentsDir } from './marketplace.js';
import {
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import {
  type ModifyResult,
  pruneDisabledSkillsForPlugin,
  pruneEnabledSkillsForPlugin,
  resolveGitHubIdentity,
} from './workspace-modify.js';

/**
 * Default clients for user-scope installations.
 * Note: 'claude' is excluded because user-scope plugins should not modify
 * project-level Claude config. Claude is only included for project-scoped
 * (.allagents) installations.
 */
const DEFAULT_USER_CLIENTS: ClientEntry[] = [
  'copilot',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'factory',
  'ampcode',
  'vscode',
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
  const projectConfigPath = join(
    workspacePath,
    CONFIG_DIR,
    WORKSPACE_CONFIG_FILE,
  );
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
    clients: [...DEFAULT_USER_CLIENTS],
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
export async function addUserPlugin(plugin: string, force?: boolean): Promise<ModifyResult> {
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
    return addPluginToUserConfig(
      normalizedPlugin,
      configPath,
      resolved.registeredAs,
      force,
    );
  }

  // Handle GitHub URL
  if (isGitHubUrl(plugin)) {
    const validation = validatePluginSource(plugin);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || 'Invalid GitHub URL',
      };
    }
    const verifyResult = await verifyGitHubUrlExists(plugin);
    if (!verifyResult.exists) {
      return {
        success: false,
        error: verifyResult.error || `GitHub URL not found: ${plugin}`,
      };
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

  return addPluginToUserConfig(plugin, configPath, undefined, force);
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
  if (config.plugins.some((entry) => getPluginSource(entry) === plugin)) return true;

  // Partial match
  return config.plugins.some((entry) => {
    const source = getPluginSource(entry);
    return source.startsWith(`${plugin}@`) || source === plugin;
  });
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
    let index = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === plugin,
    );

    // Partial match: plugin name without marketplace suffix
    if (index === -1) {
      index = config.plugins.findIndex(
        (entry) => {
          const source = getPluginSource(entry);
          return source.startsWith(`${plugin}@`) || source === plugin;
        },
      );
    }

    // Semantic match: same GitHub repo under a different format
    if (index === -1) {
      const identity = await resolveGitHubIdentity(plugin);
      if (identity) {
        for (let i = 0; i < config.plugins.length; i++) {
          const p = config.plugins[i];
          if (!p) continue;
          const existing = await resolveGitHubIdentity(getPluginSource(p));
          if (existing === identity) {
            index = i;
            break;
          }
        }
      }
    }

    if (index === -1) {
      return {
        success: false,
        error: `Plugin not found in user config: ${plugin}`,
      };
    }

    const removedEntry = getPluginSource(config.plugins[index] as PluginEntry);
    config.plugins.splice(index, 1);
    pruneDisabledSkillsForPlugin(config, removedEntry);
    pruneEnabledSkillsForPlugin(config, removedEntry);
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
export async function getUserPluginsForMarketplace(
  marketplaceName: string,
): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];
  return config.plugins
    .map((entry) => getPluginSource(entry))
    .filter((source) => {
      const parsed = parsePluginSpec(source);
      return parsed?.marketplaceName === marketplaceName;
    });
}

/**
 * Remove all user plugins that reference a given marketplace name.
 * Returns the list of removed plugin specs.
 */
export async function removeUserPluginsForMarketplace(
  marketplaceName: string,
): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const matching = config.plugins.filter((entry) => {
    const parsed = parsePluginSpec(getPluginSource(entry));
    return parsed?.marketplaceName === marketplaceName;
  });

  if (matching.length === 0) return [];

  const configPath = getUserWorkspaceConfigPath();
  config.plugins = config.plugins.filter((entry) => !matching.includes(entry));
  await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
  return matching.map((entry) => getPluginSource(entry));
}

/**
 * Add plugin entry to the user-level config file.
 */
async function addPluginToUserConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
  force?: boolean,
): Promise<ModifyResult> {
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Check for exact match
    const exactIndex = config.plugins.findIndex((entry) => getPluginSource(entry) === plugin);
    if (exactIndex !== -1) {
      if (!force) {
        return {
          success: false,
          error: `Plugin already exists in user config: ${plugin}`,
        };
      }
      // Force: remove the old one before adding the new one
      config.plugins.splice(exactIndex, 1);
    }

    // Check for semantic duplicates (different strings resolving to same repo)
    const newIdentity = await resolveGitHubIdentity(plugin);
    if (newIdentity) {
      let semanticIndex = -1;
      for (let i = 0; i < config.plugins.length; i++) {
        const existing = config.plugins[i];
        if (!existing) continue;
        const existingSource = getPluginSource(existing);
        const existingIdentity = await resolveGitHubIdentity(existingSource);
        if (existingIdentity === newIdentity) {
          semanticIndex = i;
          break;
        }
      }
      if (semanticIndex !== -1) {
        if (!force) {
          const existingSource = getPluginSource(config.plugins[semanticIndex] as PluginEntry);
          return {
            success: false,
            error: `Plugin duplicates existing entry '${existingSource}': both resolve to ${newIdentity}`,
          };
        }
        // Force: remove the semantic duplicate
        config.plugins.splice(semanticIndex, 1);
      }
    }

    config.plugins.push(plugin);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return {
      success: true,
      ...(autoRegistered && { autoRegistered }),
      normalizedPlugin: plugin,
      ...(force && { replaced: exactIndex !== -1 }),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Set clients in user-level workspace config.
 * Creates the config file if it doesn't exist.
 */
export async function setUserClients(
  clients: ClientEntry[],
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    config.clients = clients;
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
 * Get disabled skills from user workspace config
 * @returns Array of disabled skill keys (plugin:skill format)
 */
export async function getUserDisabledSkills(): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  return config?.disabledSkills ?? [];
}

/**
 * Add a skill to disabledSkills in user workspace config
 * @param skillKey - Skill key in plugin:skill format
 */
export async function addUserDisabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const disabledSkills = config.disabledSkills ?? [];

    if (disabledSkills.includes(skillKey)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    config.disabledSkills = [...disabledSkills, skillKey];
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
 * Remove a skill from disabledSkills in user workspace config
 * @param skillKey - Skill key in plugin:skill format
 */
export async function removeUserDisabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const disabledSkills = config.disabledSkills ?? [];

    if (!disabledSkills.includes(skillKey)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    config.disabledSkills = disabledSkills.filter((s) => s !== skillKey);
    if (config.disabledSkills.length === 0) {
      config.disabledSkills = undefined;
    }
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
 * Get enabled skills from user workspace config
 * @returns Array of enabled skill keys (plugin:skill format)
 */
export async function getUserEnabledSkills(): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  return config?.enabledSkills ?? [];
}

/**
 * Add a skill to enabledSkills in user workspace config
 * @param skillKey - Skill key in plugin:skill format
 */
export async function addUserEnabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const enabledSkills = config.enabledSkills ?? [];

    if (enabledSkills.includes(skillKey)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    config.enabledSkills = [...enabledSkills, skillKey];
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
 * Remove a skill from enabledSkills in user workspace config
 * @param skillKey - Skill key in plugin:skill format
 */
export async function removeUserEnabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const enabledSkills = config.enabledSkills ?? [];

    if (!enabledSkills.includes(skillKey)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    config.enabledSkills = enabledSkills.filter((s) => s !== skillKey);
    if (config.enabledSkills.length === 0) {
      config.enabledSkills = undefined;
    }
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
 * Scope where a plugin is installed
 */
export type PluginScope = 'user' | 'project';

/**
 * Information about an installed plugin
 */
export interface InstalledPluginInfo {
  /** Full plugin spec (e.g., "plugin@marketplace") */
  spec: string;
  /** Plugin name */
  name: string;
  /** Marketplace name */
  marketplace: string;
  /** Installation scope */
  scope: PluginScope;
}

/**
 * Convert a plugin source string to InstalledPluginInfo.
 * Handles plugin@marketplace, GitHub URLs, and local paths.
 */
function pluginSourceToInfo(
  plugin: string,
  scope: PluginScope,
): InstalledPluginInfo {
  // plugin@marketplace format
  const parsed = parsePluginSpec(plugin);
  if (parsed) {
    return {
      spec: plugin,
      name: parsed.plugin,
      marketplace: parsed.marketplaceName,
      scope,
    };
  }

  // GitHub URL format
  if (isGitHubUrl(plugin)) {
    const ghParsed = parseGitHubUrl(plugin);
    return {
      spec: plugin,
      name: ghParsed?.repo ?? basename(plugin),
      marketplace: '',
      scope,
    };
  }

  // Local path or other format
  return {
    spec: plugin,
    name: basename(plugin),
    marketplace: '',
    scope,
  };
}

/**
 * Get all installed plugins from user workspace config.
 */
export async function getInstalledUserPlugins(): Promise<
  InstalledPluginInfo[]
> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const result: InstalledPluginInfo[] = [];
  for (const pluginEntry of config.plugins) {
    const plugin = getPluginSource(pluginEntry);
    result.push(pluginSourceToInfo(plugin, 'user'));
  }
  return result;
}

/**
 * Get all installed plugins from project workspace config.
 */
export async function getInstalledProjectPlugins(
  workspacePath: string,
): Promise<InstalledPluginInfo[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    if (!config?.plugins) return [];

    const result: InstalledPluginInfo[] = [];
    for (const pluginEntry of config.plugins) {
      const plugin = getPluginSource(pluginEntry);
      result.push(pluginSourceToInfo(plugin, 'project'));
    }
    return result;
  } catch {
    return [];
  }
}
