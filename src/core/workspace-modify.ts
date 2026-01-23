import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { validatePluginSource, isGitHubUrl } from '../utils/plugin-path.js';
import type { WorkspaceConfig } from '../models/workspace-config.js';
import {
  isPluginSpec,
  getMarketplace,
  addMarketplace,
  getWellKnownMarketplaces,
  resolvePluginSpec,
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
 * Add a plugin to workspace.yaml
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
  const configPath = join(workspacePath, 'workspace.yaml');

  // Check if workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `workspace.yaml not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  // Handle plugin@marketplace format
  if (isPluginSpec(plugin)) {
    const autoRegResult = await ensureMarketplaceRegistered(plugin);
    if (!autoRegResult.success) {
      return {
        success: false,
        error: autoRegResult.error || 'Unknown error',
      };
    }

    // Verify the plugin exists in the marketplace
    const resolved = await resolvePluginSpec(plugin);
    if (!resolved) {
      const atIndex = plugin.lastIndexOf('@');
      const pluginName = plugin.slice(0, atIndex);
      const marketplaceName = plugin.slice(atIndex + 1);
      const marketplace = await getMarketplace(
        autoRegResult.registeredAs || marketplaceName,
      );

      return {
        success: false,
        error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${marketplace?.path ?? `~/.allagents/marketplaces/${marketplaceName}`}/plugins/${pluginName}/`,
      };
    }

    // Add to workspace.yaml (use the original spec or the resolved one)
    return await addPluginToConfig(
      autoRegResult.registeredAs
        ? plugin.replace(/@[^@]+$/, `@${autoRegResult.registeredAs}`)
        : plugin,
      configPath,
      autoRegResult.registeredAs,
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
 * Ensure marketplace is registered, auto-registering if needed
 */
async function ensureMarketplaceRegistered(
  spec: string,
): Promise<{ success: boolean; error?: string; registeredAs?: string }> {
  const atIndex = spec.lastIndexOf('@');
  const marketplaceName = spec.slice(atIndex + 1);

  if (!marketplaceName) {
    return {
      success: false,
      error: `Invalid plugin spec: ${spec}`,
    };
  }

  // Check if already registered
  const existing = await getMarketplace(marketplaceName);
  if (existing) {
    return { success: true };
  }

  // Try to auto-register
  const wellKnown = getWellKnownMarketplaces();

  // Well-known marketplace name
  if (wellKnown[marketplaceName]) {
    console.log(`Auto-registering well-known marketplace: ${marketplaceName}`);
    const result = await addMarketplace(marketplaceName);
    if (!result.success) {
      return { success: false, error: result.error || 'Unknown error' };
    }
    return { success: true, registeredAs: marketplaceName };
  }

  // owner/repo format
  if (marketplaceName.includes('/') && !marketplaceName.includes('://')) {
    const parts = marketplaceName.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      console.log(`Auto-registering GitHub marketplace: ${marketplaceName}`);
      const repoName = parts[1];
      const result = await addMarketplace(marketplaceName, repoName);
      if (!result.success) {
        return { success: false, error: result.error || 'Unknown error' };
      }
      return { success: true, registeredAs: repoName };
    }
  }

  // Unknown marketplace
  return {
    success: false,
    error: `Marketplace '${marketplaceName}' not found.\n  Options:\n  1. Use fully qualified name: plugin@owner/repo\n  2. Register first: allagents plugin marketplace add <source>\n  3. Well-known marketplaces: ${Object.keys(wellKnown).join(', ')}`,
  };
}

/**
 * Add plugin to workspace.yaml config file
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
        error: `Plugin already exists in workspace.yaml: ${plugin}`,
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
 * Remove a plugin from workspace.yaml
 * @param plugin - Plugin source to remove (exact match or partial match)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Result with success status
 */
export async function removePlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
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
