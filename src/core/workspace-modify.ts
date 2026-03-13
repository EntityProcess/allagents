import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  ClientEntry,
  PluginEntry,
  Repository,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import { getPluginSource } from '../models/workspace-config.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import {
  isGitHubUrl,
  parseGitHubUrl,
  validatePluginSource,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import {
  getMarketplace,
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';

/**
 * Default clients for auto-created project workspace.yaml.
 * Matches the template at src/templates/default/.allagents/workspace.yaml.
 */
const DEFAULT_PROJECT_CLIENTS: ClientEntry[] = ['universal'];

/**
 * Result of add/remove operations
 */
export interface ModifyResult {
  success: boolean;
  error?: string;
  autoRegistered?: string; // marketplace name if auto-registered
  normalizedPlugin?: string; // plugin spec after normalization (e.g., plugin@manifest-name)
  replaced?: boolean; // true if an existing plugin was replaced with --force
}

/**
 * Update the clients list in .allagents/workspace.yaml
 * @param clients - New list of client types
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function setClients(
  clients: ClientEntry[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  try {
    await ensureWorkspace(workspacePath);
    const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
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
 * Ensure .allagents/workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureWorkspace(
  workspacePath: string,
  clients?: ClientEntry[],
): Promise<void> {
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);
  if (existsSync(configPath)) return;

  const defaultConfig: WorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: clients ?? [...DEFAULT_PROJECT_CLIENTS],
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, dump(defaultConfig, { lineWidth: -1 }), 'utf-8');
}

/**
 * Add a plugin to .allagents/workspace.yaml
 * Supports three formats:
 * 1. plugin@marketplace (e.g., "code-review@claude-plugins-official")
 * 2. GitHub URL (e.g., "https://github.com/owner/repo")
 * 3. Local path (e.g., "./my-plugin")
 *
 * For plugin@marketplace format, will auto-register the marketplace if:
 * - It's a well-known name (e.g., "claude-plugins-official")
 * - It's in owner/repo format (e.g., "plugin@obra/superpowers")
 *
 * @param plugin - Plugin source
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @param force - If true, replace existing plugin with same source
 * @returns Result with success status
 */
export async function addPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
  force?: boolean,
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  // Auto-create .allagents/workspace.yaml with defaults if missing
  await ensureWorkspace(workspacePath);

  // Handle plugin@marketplace format
  if (isPluginSpec(plugin)) {
    const resolved = await resolvePluginSpecWithAutoRegister(plugin);
    if (!resolved.success) {
      return {
        success: false,
        error: resolved.error || 'Unknown error',
      };
    }

    // Add to .allagents/workspace.yaml (use the original spec or normalized one with registered name)
    return await addPluginToConfig(
      resolved.registeredAs
        ? plugin.replace(/@[^@]+$/, `@${resolved.registeredAs}`)
        : plugin,
      configPath,
      resolved.registeredAs,
      force,
    );
  }

  // Handle GitHub URL or local path (legacy formats)
  if (isGitHubUrl(plugin)) {
    // GitHub URL - validate format
    const validation = validatePluginSource(plugin);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || 'Invalid GitHub URL',
      };
    }

    // Verify the GitHub URL actually exists
    const verifyResult = await verifyGitHubUrlExists(plugin);
    if (!verifyResult.exists) {
      return {
        success: false,
        error: verifyResult.error || `GitHub URL not found: ${plugin}`,
      };
    }
  } else {
    // Local path - verify it exists
    const fullPath = join(workspacePath, plugin);
    if (!existsSync(fullPath) && !existsSync(plugin)) {
      return {
        success: false,
        error: `Plugin not found at ${plugin}`,
      };
    }
  }

  return await addPluginToConfig(plugin, configPath, undefined, force);
}

/**
 * Add plugin to .allagents/workspace.yaml config file
 */
async function addPluginToConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
  force?: boolean,
): Promise<ModifyResult> {
  try {
    // Read current config
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Check if plugin already exists (exact match)
    const existingExactIndex = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === plugin,
    );
    if (existingExactIndex !== -1) {
      if (!force) {
        return {
          success: false,
          error: `Plugin already exists in .allagents/workspace.yaml: ${plugin}`,
        };
      }
      // With force, we'll remove and re-add below
    }

    // Check for semantic duplicates (only if not forcing)
    if (!force) {
      const newIdentity = await resolveGitHubIdentity(plugin);
      if (newIdentity) {
        for (const existing of config.plugins) {
          const existingSource = getPluginSource(existing);
          const existingIdentity = await resolveGitHubIdentity(existingSource);
          if (existingIdentity === newIdentity) {
            return {
              success: false,
              error: `Plugin duplicates existing entry '${existingSource}': both resolve to ${newIdentity}`,
            };
          }
        }
      }
    }

    // Remove existing entry if force and found
    const wasReplaced = force && existingExactIndex !== -1;
    if (wasReplaced) {
      config.plugins.splice(existingExactIndex, 1);
    }

    // Add plugin
    config.plugins.push(plugin);

    // Write back
    const newContent = dump(config, { lineWidth: -1 });
    await writeFile(configPath, newContent, 'utf-8');

    const result: ModifyResult = {
      success: true,
      normalizedPlugin: plugin,
    };
    if (autoRegistered) {
      result.autoRegistered = autoRegistered;
    }
    if (wasReplaced) {
      result.replaced = true;
    }
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if a plugin exists in .allagents/workspace.yaml (project scope)
 * @param plugin - Plugin source to find (exact match or partial match)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns true if the plugin is found
 */
export async function hasPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<boolean> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return false;

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Exact match first
    if (config.plugins.some((entry) => getPluginSource(entry) === plugin))
      return true;

    // Partial match
    if (!isPluginSpec(plugin)) {
      return config.plugins.some((entry) => {
        const source = getPluginSource(entry);
        return source.startsWith(`${plugin}@`) || source === plugin;
      });
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Remove a plugin from .allagents/workspace.yaml
 * @param plugin - Plugin source to remove (exact match or partial match)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Result with success status
 */
export async function removePlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  // Check if .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  try {
    // Read current config
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Find plugin - exact match first
    let index = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === plugin,
    );

    // If not found, try partial match (e.g., "code-review" matches "code-review@claude-plugins-official")
    if (index === -1 && isPluginSpec(plugin) === false) {
      index = config.plugins.findIndex((entry) => {
        const source = getPluginSource(entry);
        return source.startsWith(`${plugin}@`) || source === plugin;
      });
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
        error: `Plugin not found in .allagents/workspace.yaml: ${plugin}`,
      };
    }

    // Remove plugin and clean up its disabled skills
    const removedEntry = getPluginSource(config.plugins[index] as PluginEntry);
    config.plugins.splice(index, 1);
    pruneDisabledSkillsForPlugin(config, removedEntry);
    pruneEnabledSkillsForPlugin(config, removedEntry);

    // Write back
    const newContent = dump(config, { lineWidth: -1 });
    await writeFile(configPath, newContent, 'utf-8');

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
 * Exported for reuse by user-workspace.ts.
 */
export function pruneDisabledSkillsForPlugin(
  config: WorkspaceConfig,
  pluginEntry: string,
): void {
  if (!config.disabledSkills?.length) return;

  const names = extractPluginNames(pluginEntry);
  if (names.length === 0) return;

  const prefixes = names.map((n) => `${n}:`);
  config.disabledSkills = config.disabledSkills.filter(
    (s) => !prefixes.some((p) => s.startsWith(p)),
  );
  if (config.disabledSkills.length === 0) {
    config.disabledSkills = undefined;
  }
}

/**
 * Extract possible plugin names from a plugin source string.
 * Returns all candidate names that might be used as the plugin name prefix
 * in skill keys (e.g., "pluginName:" in "pluginName:skillName").
 *
 * For plugin specs (plugin@marketplace), skill keys may use either the
 * plugin component or the marketplace name (when the marketplace root
 * IS the plugin directory).
 *
 * Exported for reuse by user-workspace.ts.
 */
export function extractPluginNames(pluginSource: string): string[] {
  if (isPluginSpec(pluginSource)) {
    const parsed = parsePluginSpec(pluginSource);
    if (!parsed) return [];
    const names = [parsed.plugin];
    if (parsed.marketplaceName && parsed.marketplaceName !== parsed.plugin) {
      names.push(parsed.marketplaceName);
    }
    return names;
  }
  // Split on both / and \ to handle local paths, URLs, and Windows paths
  const parts = pluginSource.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return [];
  return [last.replace(/\.git$/, '')];
}

/**
 * Find the index of a plugin entry whose candidate names include pluginName.
 * Exported for reuse by user-workspace.ts.
 */
export function findPluginEntryByName(
  config: WorkspaceConfig,
  pluginName: string,
): number {
  return config.plugins.findIndex((entry) =>
    extractPluginNames(getPluginSource(entry)).includes(pluginName),
  );
}

/**
 * Ensure the plugin entry at config.plugins[index] is in object form.
 * Converts a string shorthand to { source } if needed and returns the mutable object.
 * Exported for reuse by user-workspace.ts.
 */
export function ensureObjectPluginEntry(
  config: WorkspaceConfig,
  index: number,
): Exclude<PluginEntry, string> {
  const entry = config.plugins[index];
  if (entry === undefined) throw new Error(`Plugin entry at index ${index} not found`);
  if (typeof entry === 'string') {
    const objectEntry: Exclude<PluginEntry, string> = { source: entry };
    config.plugins[index] = objectEntry;
    return objectEntry;
  }
  return entry;
}

/** Parse "pluginName:skillName" into its two parts, or return null on bad format. */
function parseSkillKey(
  skillKey: string,
): { pluginName: string; skillName: string } | null {
  const colonIdx = skillKey.indexOf(':');
  if (colonIdx === -1) return null;
  return {
    pluginName: skillKey.slice(0, colonIdx),
    skillName: skillKey.slice(colonIdx + 1),
  };
}

/**
 * Get disabled skills from workspace config.
 * Reads from inline plugin entry `skills.exclude` arrays (blocklist mode).
 * Also includes legacy top-level `disabledSkills` for backward compatibility.
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Array of disabled skill keys (plugin:skill format)
 */
export async function getDisabledSkills(
  workspacePath: string = process.cwd(),
): Promise<string[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const result: string[] = [];

    for (const entry of config.plugins) {
      if (
        typeof entry === 'string' ||
        !entry.skills ||
        Array.isArray(entry.skills)
      )
        continue;
      const pluginName = extractPluginNames(getPluginSource(entry))[0];
      if (!pluginName) continue;
      for (const skillName of entry.skills.exclude) {
        result.push(`${pluginName}:${skillName}`);
      }
    }

    // Include legacy top-level disabledSkills
    for (const s of config.disabledSkills ?? []) {
      if (!result.includes(s)) result.push(s);
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Add a skill to the plugin entry's `skills.exclude` list (blocklist mode).
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function addDisabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in allowlist mode; use removeEnabledSkill to disable a skill`,
      };
    }

    const existing = entry.skills?.exclude ?? [];
    if (existing.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    entry.skills = { exclude: [...existing, skillName] };
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
 * Remove a skill from the plugin entry's `skills.exclude` list (blocklist mode).
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function removeDisabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return { success: false, error: `Plugin '${pluginName}' not found in workspace config` };
    }
    if (
      typeof entry === 'string' ||
      !entry.skills ||
      Array.isArray(entry.skills)
    ) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    if (!entry.skills.exclude.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    const newExclude = entry.skills.exclude.filter((s) => s !== skillName);
    entry.skills = newExclude.length > 0 ? { exclude: newExclude } : undefined;

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
 * Get enabled skills from workspace config.
 * Reads from inline plugin entry `skills` arrays (allowlist mode).
 * Also includes legacy top-level `enabledSkills` for backward compatibility.
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function getEnabledSkills(
  workspacePath: string = process.cwd(),
): Promise<string[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];
  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const result: string[] = [];

    for (const entry of config.plugins) {
      if (typeof entry === 'string' || !Array.isArray(entry.skills)) continue;
      const pluginName = extractPluginNames(getPluginSource(entry))[0];
      if (!pluginName) continue;
      for (const skillName of entry.skills) {
        result.push(`${pluginName}:${skillName}`);
      }
    }

    // Include legacy top-level enabledSkills
    for (const s of config.enabledSkills ?? []) {
      if (!result.includes(s)) result.push(s);
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Add a skill to the plugin entry's `skills` allowlist.
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function addEnabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (entry.skills && !Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in blocklist mode; use removeDisabledSkill to enable a skill`,
      };
    }

    const existing = (entry.skills as string[] | undefined) ?? [];
    if (existing.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    entry.skills = [...existing, skillName];
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
 * Remove a skill from the plugin entry's `skills` allowlist.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function removeEnabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return { success: false, error: `Plugin '${pluginName}' not found in workspace config` };
    }
    if (
      typeof entry === 'string' ||
      !entry.skills ||
      !Array.isArray(entry.skills)
    ) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    if (!entry.skills.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    const newSkills = entry.skills.filter((s) => s !== skillName);
    entry.skills = newSkills.length > 0 ? newSkills : undefined;

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
 * Remove enabledSkills entries whose plugin name matches the removed plugin entry.
 * Exported for reuse by user-workspace.ts.
 */
export function pruneEnabledSkillsForPlugin(
  config: WorkspaceConfig,
  pluginEntry: string,
): void {
  if (!config.enabledSkills?.length) return;
  const names = extractPluginNames(pluginEntry);
  if (names.length === 0) return;
  const prefixes = names.map((n) => `${n}:`);
  config.enabledSkills = config.enabledSkills.filter(
    (s) => !prefixes.some((p) => s.startsWith(p)),
  );
  if (config.enabledSkills.length === 0) {
    config.enabledSkills = undefined;
  }
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

// MIGRATION: v1→v2 skill schema. Remove this block after v3 is released.
/**
 * Migrate a project workspace config from v1 skill schema to v2.
 *
 * v1: top-level `enabledSkills`/`disabledSkills` arrays of "pluginName:skillName" strings.
 * v2: per-plugin `skills` field (allowlist array or `{ exclude: [...] }` blocklist).
 *
 * Idempotent: if `version >= 2`, returns immediately without touching the file.
 * Also upgrades configs that have neither field (first-time users) by setting version:2.
 */
export async function migrateWorkspaceSkillsV1toV2(
  workspacePath: string,
): Promise<void> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  let config: WorkspaceConfig;
  try {
    const content = await readFile(configPath, 'utf-8');
    config = load(content) as WorkspaceConfig;
  } catch {
    return;
  }

  if (!config || (config.version !== undefined && config.version >= 2)) return;

  const enabledSkills: string[] = config.enabledSkills ?? [];
  const disabledSkills: string[] = config.disabledSkills ?? [];

  // Group enabledSkills by pluginName
  const enabledByPlugin = new Map<string, string[]>();
  for (const skillKey of enabledSkills) {
    const parsed = parseSkillKey(skillKey);
    if (!parsed) continue;
    const list = enabledByPlugin.get(parsed.pluginName) ?? [];
    list.push(parsed.skillName);
    enabledByPlugin.set(parsed.pluginName, list);
  }

  // Group disabledSkills by pluginName
  const disabledByPlugin = new Map<string, string[]>();
  for (const skillKey of disabledSkills) {
    const parsed = parseSkillKey(skillKey);
    if (!parsed) continue;
    const list = disabledByPlugin.get(parsed.pluginName) ?? [];
    list.push(parsed.skillName);
    disabledByPlugin.set(parsed.pluginName, list);
  }

  // Apply enabledSkills → plugin entry allowlist
  for (const [pluginName, skillNames] of enabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    entry.skills = skillNames;
  }

  // Apply disabledSkills → plugin entry blocklist
  for (const [pluginName, skillNames] of disabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    // If an allowlist was already set from enabledSkills, prefer it (ignore disabled for same plugin)
    if (!Array.isArray(entry.skills)) {
      entry.skills = { exclude: skillNames };
    }
  }

  config.enabledSkills = undefined;
  config.disabledSkills = undefined;
  config.version = 2;

  try {
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
  } catch (error) {
    console.warn(
      `[migrate v1→v2] Failed to write migrated config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Update repositories in workspace.yaml: remove specified paths and add new entries.
 * Used by .code-workspace reconciliation to sync folder changes back.
 */
export async function updateRepositories(
  changes: { remove: string[]; add: Repository[] },
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  if (changes.remove.length === 0 && changes.add.length === 0) {
    return { success: true };
  }

  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const removeSet = new Set(changes.remove);
    config.repositories = config.repositories.filter(
      (repo) => !removeSet.has(repo.path),
    );
    config.repositories.push(...changes.add);

    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
