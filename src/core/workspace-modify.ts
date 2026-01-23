import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { validatePluginSource } from '../utils/plugin-path.js';
import type { WorkspaceConfig } from '../models/workspace-config.js';

/**
 * Add a plugin to workspace.yaml
 * @param plugin - Plugin source (local path or GitHub URL)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Result with success status
 */
export async function addPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<{ success: boolean; error?: string }> {
  const configPath = join(workspacePath, 'workspace.yaml');

  // Check if workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  // Validate plugin source
  const validation = validatePluginSource(plugin);
  if (!validation.valid) {
    return {
      success: false,
      ...(validation.error && { error: validation.error }),
    };
  }

  try {
    // Read current config
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Check if plugin already exists
    if (config.plugins.includes(plugin)) {
      return {
        success: false,
        error: `Plugin already exists in workspace.yaml: ${plugin}`,
      };
    }

    // Add plugin
    config.plugins.push(plugin);

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
 * Remove a plugin from workspace.yaml
 * @param plugin - Plugin source to remove
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Result with success status
 */
export async function removePlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<{ success: boolean; error?: string }> {
  const configPath = join(workspacePath, 'workspace.yaml');

  // Check if workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  try {
    // Read current config
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Find plugin index
    const index = config.plugins.indexOf(plugin);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin not found in workspace.yaml: ${plugin}`,
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
