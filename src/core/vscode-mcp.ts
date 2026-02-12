import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import JSON5 from 'json5';
import { getHomeDir } from '../constants.js';
import type { ValidatedPlugin } from './sync.js';

/**
 * Result of merging MCP server configs into VS Code
 */
export interface McpMergeResult {
  added: number;
  skipped: number;
  warnings: string[];
  addedServers: string[];
  skippedServers: string[];
}

/**
 * Get the cross-platform path to VS Code's user-level mcp.json
 */
export function getVscodeMcpConfigPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA environment variable not set');
    }
    return join(appData, 'Code', 'User', 'mcp.json');
  }
  const home = getHomeDir();
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  }
  // Linux
  return join(home, '.config', 'Code', 'User', 'mcp.json');
}

/**
 * Read .mcp.json from a plugin root directory.
 * Returns the mcpServers object or null if absent/invalid.
 */
export function readPluginMcpConfig(pluginPath: string): Record<string, unknown> | null {
  const mcpPath = join(pluginPath, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return null;
  }
  try {
    const content = readFileSync(mcpPath, 'utf-8');
    const parsed = JSON5.parse(content);
    if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      return parsed.mcpServers as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Collect MCP servers from all validated plugins.
 * First-plugin-wins for duplicate server names.
 */
export function collectMcpServers(
  validatedPlugins: ValidatedPlugin[],
): { servers: Map<string, unknown>; warnings: string[] } {
  const servers = new Map<string, unknown>();
  const warnings: string[] = [];

  for (const plugin of validatedPlugins) {
    const mcpServers = readPluginMcpConfig(plugin.resolved);
    if (!mcpServers) continue;

    for (const [name, config] of Object.entries(mcpServers)) {
      if (servers.has(name)) {
        warnings.push(`MCP server '${name}' from ${plugin.plugin} conflicts with earlier plugin (skipped)`);
      } else {
        servers.set(name, config);
      }
    }
  }

  return { servers, warnings };
}

/**
 * Sync MCP server configs from plugins into VS Code's user-level mcp.json.
 *
 * - New server names are added
 * - Existing server names are skipped (non-destructive)
 * - Other keys in mcp.json are preserved
 */
export function syncVscodeMcpConfig(
  validatedPlugins: ValidatedPlugin[],
  options?: { dryRun?: boolean; configPath?: string },
): McpMergeResult {
  const dryRun = options?.dryRun ?? false;
  const configPath = options?.configPath ?? getVscodeMcpConfigPath();

  // Collect servers from all plugins
  const { servers: pluginServers, warnings } = collectMcpServers(validatedPlugins);

  const result: McpMergeResult = {
    added: 0,
    skipped: 0,
    warnings: [...warnings],
    addedServers: [],
    skippedServers: [],
  };

  if (pluginServers.size === 0) {
    return result;
  }

  // Read existing VS Code mcp.json (or start fresh)
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      existingConfig = JSON5.parse(content);
    } catch {
      // If invalid, start fresh but warn
      result.warnings.push(`Could not parse existing ${configPath}, starting fresh`);
      existingConfig = {};
    }
  }

  // Get or create the servers object (VS Code uses "servers" key)
  const existingServers = (existingConfig.servers as Record<string, unknown>) ?? {};

  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      result.skipped++;
      result.skippedServers.push(name);
    } else {
      existingServers[name] = config;
      result.added++;
      result.addedServers.push(name);
    }
  }

  // Write back if there were changes and not dry-run
  if (result.added > 0 && !dryRun) {
    existingConfig.servers = existingServers;
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf-8');
  }

  return result;
}
