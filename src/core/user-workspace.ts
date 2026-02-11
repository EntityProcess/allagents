import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type { WorkspaceConfig, ClientType } from '../models/workspace-config.js';
import { getAllagentsDir, getMarketplace } from './marketplace.js';
import {
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import {
  validatePluginSource,
  isGitHubUrl,
  parseGitHubUrl,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import type { ModifyResult } from './workspace-modify.js';

/**
 * Default clients for user-scope installations.
 * Note: 'claude' is excluded because user-scope plugins should not modify
 * project-level Claude config. Claude is only included for project-scoped
 * (.allagents) installations.
 */
const DEFAULT_USER_CLIENTS: ClientType[] = [
  'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode',
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

    // Semantic match: same GitHub repo under a different format
    if (index === -1) {
      const identity = await resolveGitHubIdentity(plugin);
      if (identity) {
        for (let i = 0; i < config.plugins.length; i++) {
          const p = config.plugins[i];
          if (!p) continue;
          const existing = await resolveGitHubIdentity(p);
          if (existing === identity) {
            index = i;
            break;
          }
        }
      }
    }

    if (index === -1) {
      return { success: false, error: `Plugin not found in user config: ${plugin}` };
    }

    const removedEntry = config.plugins[index]!;
    config.plugins.splice(index, 1);
    pruneUserDisabledSkillsForEntry(config, removedEntry);
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
 * Remove disabledSkills entries whose plugin name matches the removed plugin entry.
 */
function pruneUserDisabledSkillsForEntry(
  config: WorkspaceConfig,
  pluginEntry: string,
): void {
  if (!config.disabledSkills?.length) return;

  const pluginName = extractUserPluginName(pluginEntry);
  if (!pluginName) return;

  const prefix = `${pluginName}:`;
  config.disabledSkills = config.disabledSkills.filter((s) => !s.startsWith(prefix));
  if (config.disabledSkills.length === 0) {
    config.disabledSkills = undefined;
  }
}

/**
 * Extract the plugin name from a plugin source string.
 * For plugin@marketplace specs, returns the plugin component.
 * For bare names (no @), returns the name as-is.
 */
function extractUserPluginName(pluginSource: string): string | null {
  if (isPluginSpec(pluginSource)) {
    return parsePluginSpec(pluginSource)?.plugin ?? null;
  }
  if (!pluginSource.includes('/') && !pluginSource.includes('\\')) {
    return pluginSource;
  }
  return null;
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
 * Resolve a plugin source to its GitHub owner/repo identity, if it points to
 * a GitHub repo (directly or via a marketplace URL source). Returns null for
 * local-path plugins.
 */
export async function resolveGitHubIdentity(
  pluginSource: string,
): Promise<string | null> {
  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
  }

  if (isPluginSpec(pluginSource)) {
    const parsed = parsePluginSpec(pluginSource);
    if (!parsed) return null;

    const marketplace = await getMarketplace(parsed.marketplaceName);
    if (!marketplace) return null;

    const manifestResult = await parseMarketplaceManifest(marketplace.path);
    if (!manifestResult.success) return null;

    const entry = manifestResult.data.plugins.find(
      (p) => p.name === parsed.plugin,
    );
    if (!entry || typeof entry.source === 'string') return null;

    const parsedUrl = parseGitHubUrl(entry.source.url);
    return parsedUrl
      ? `${parsedUrl.owner}/${parsedUrl.repo}`.toLowerCase()
      : null;
  }

  return null;
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

    // Check for semantic duplicates (different strings resolving to same repo)
    const newIdentity = await resolveGitHubIdentity(plugin);
    if (newIdentity) {
      for (const existing of config.plugins) {
        const existingIdentity = await resolveGitHubIdentity(existing);
        if (existingIdentity === newIdentity) {
          return {
            success: false,
            error: `Plugin duplicates existing entry '${existing}': both resolve to ${newIdentity}`,
          };
        }
      }
    }

    config.plugins.push(plugin);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true, ...(autoRegistered && { autoRegistered }), normalizedPlugin: plugin };
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
export async function setUserClients(clients: ClientType[]): Promise<ModifyResult> {
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
export async function addUserDisabledSkill(skillKey: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const disabledSkills = config.disabledSkills ?? [];

    if (disabledSkills.includes(skillKey)) {
      return { success: false, error: `Skill '${skillKey}' is already disabled` };
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
export async function removeUserDisabledSkill(skillKey: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const disabledSkills = config.disabledSkills ?? [];

    if (!disabledSkills.includes(skillKey)) {
      return { success: false, error: `Skill '${skillKey}' is already enabled` };
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
 * Get all installed plugins from user workspace config.
 * Only returns plugin@marketplace format plugins.
 */
export async function getInstalledUserPlugins(): Promise<InstalledPluginInfo[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const result: InstalledPluginInfo[] = [];
  for (const plugin of config.plugins) {
    const parsed = parsePluginSpec(plugin);
    if (parsed) {
      result.push({
        spec: plugin,
        name: parsed.plugin,
        marketplace: parsed.marketplaceName,
        scope: 'user',
      });
    }
  }
  return result;
}

/**
 * Get all installed plugins from project workspace config.
 * Only returns plugin@marketplace format plugins.
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
    for (const plugin of config.plugins) {
      const parsed = parsePluginSpec(plugin);
      if (parsed) {
        result.push({
          spec: plugin,
          name: parsed.plugin,
          marketplace: parsed.marketplaceName,
          scope: 'project',
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}
