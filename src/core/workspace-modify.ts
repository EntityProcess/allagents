import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  validatePluginSource,
  isGitHubUrl,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import type { WorkspaceConfig } from '../models/workspace-config.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';

/**
 * Result of add/remove operations
 */
export interface ModifyResult {
  success: boolean;
  error?: string;
  autoRegistered?: string; // marketplace name if auto-registered
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

  // Check if .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

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
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
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
