import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  validatePluginSource,
  isGitHubUrl,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import type { WorkspaceConfig, ClientType } from '../models/workspace-config.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';

/**
 * Default clients for auto-created project workspace.yaml.
 * Matches the template at src/templates/default/.allagents/workspace.yaml.
 */
const DEFAULT_PROJECT_CLIENTS: ClientType[] = [
  'claude', 'copilot', 'codex', 'opencode',
];

/**
 * Result of add/remove operations
 */
export interface ModifyResult {
  success: boolean;
  error?: string;
  autoRegistered?: string; // marketplace name if auto-registered
  normalizedPlugin?: string; // plugin spec after normalization (e.g., plugin@manifest-name)
}

/**
 * Update the clients list in .allagents/workspace.yaml
 * @param clients - New list of client types
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function setClients(
  clients: ClientType[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

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
 * Ensure .allagents/workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureWorkspace(workspacePath: string): Promise<void> {
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);
  if (existsSync(configPath)) return;

  const defaultConfig: WorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: [...DEFAULT_PROJECT_CLIENTS],
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
 * @returns Result with success status
 */
export async function addPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
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

  return await addPluginToConfig(plugin, configPath);
}

/**
 * Add plugin to .allagents/workspace.yaml config file
 */
async function addPluginToConfig(
  plugin: string,
  configPath: string,
  autoRegistered?: string,
): Promise<ModifyResult> {
  try {
    // Read current config
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Check if plugin already exists
    if (config.plugins.includes(plugin)) {
      return {
        success: false,
        error: `Plugin already exists in .allagents/workspace.yaml: ${plugin}`,
      };
    }

    // Add plugin
    config.plugins.push(plugin);

    // Write back
    const newContent = dump(config, { lineWidth: -1 });
    await writeFile(configPath, newContent, 'utf-8');

    return {
      success: true,
      ...(autoRegistered && { autoRegistered }),
      normalizedPlugin: plugin,
    };
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
    if (config.plugins.indexOf(plugin) !== -1) return true;

    // Partial match
    if (!isPluginSpec(plugin)) {
      return config.plugins.some(
        (p) => p.startsWith(`${plugin}@`) || p === plugin,
      );
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
    let index = config.plugins.indexOf(plugin);

    // If not found, try partial match (e.g., "code-review" matches "code-review@claude-plugins-official")
    if (index === -1 && isPluginSpec(plugin) === false) {
      index = config.plugins.findIndex(
        (p) => p.startsWith(`${plugin}@`) || p === plugin,
      );
    }

    if (index === -1) {
      return {
        success: false,
        error: `Plugin not found in .allagents/workspace.yaml: ${plugin}`,
      };
    }

    // Remove plugin
    config.plugins.splice(index, 1);

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
 * Get disabled skills from workspace config
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
    return config.disabledSkills ?? [];
  } catch {
    return [];
  }
}

/**
 * Add a skill to disabledSkills in workspace config
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
 * Remove a skill from disabledSkills in workspace config
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
    // Remove empty array from config
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
