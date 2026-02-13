import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import JSON5 from 'json5';
import { getHomeDir } from '../constants.js';
import type { ValidatedPlugin } from './sync.js';

/**
 * Deep equality check for MCP server configs.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

/**
 * Result of merging MCP server configs into VS Code
 */
export interface McpMergeResult {
  added: number;
  skipped: number;
  overwritten: number;
  removed: number;
  warnings: string[];
  addedServers: string[];
  skippedServers: string[];
  overwrittenServers: string[];
  removedServers: string[];
  /** All servers that are now tracked (for saving to sync state) */
  trackedServers: string[];
  /** Path to the config file that was modified (set when changes are written) */
  configPath?: string;
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
 * With tracking enabled:
 * - Tracked servers with changed configs are updated (not skipped)
 * - Tracked servers no longer in plugins are removed
 * - User-managed servers (not tracked) are preserved
 *
 * Without tracking (trackedServers not provided):
 * - Falls back to legacy behavior (skip conflicts unless force=true)
 */
export function syncVscodeMcpConfig(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    configPath?: string;
    force?: boolean;
    /** Previously tracked server names (enables update/remove behavior) */
    trackedServers?: string[];
  },
): McpMergeResult {
  const dryRun = options?.dryRun ?? false;
  const force = options?.force ?? false;
  const configPath = options?.configPath ?? getVscodeMcpConfigPath();
  const previouslyTracked = new Set(options?.trackedServers ?? []);
  const hasTracking = options?.trackedServers !== undefined;

  // Collect servers from all plugins
  const { servers: pluginServers, warnings } = collectMcpServers(validatedPlugins);

  const result: McpMergeResult = {
    added: 0,
    skipped: 0,
    overwritten: 0,
    removed: 0,
    warnings: [...warnings],
    addedServers: [],
    skippedServers: [],
    overwrittenServers: [],
    removedServers: [],
    trackedServers: [],
  };

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

  // Process plugin servers: add new, update tracked, skip user-managed conflicts
  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      if (!deepEqual(existingServers[name], config)) {
        // Config differs - decide based on tracking
        if (hasTracking && previouslyTracked.has(name)) {
          // We own this server - update it
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else if (force) {
          // Force mode - overwrite even user-managed
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else {
          // User-managed server with conflict - skip (do not track)
          result.skipped++;
          result.skippedServers.push(name);
        }
      } else if (hasTracking && previouslyTracked.has(name)) {
        // Configs are equal and we previously owned it - keep tracking
        result.trackedServers.push(name);
      }
      // If configs are equal but not previously tracked, it's user-managed - don't track
    } else {
      // New server - add it
      existingServers[name] = config;
      result.added++;
      result.addedServers.push(name);
      result.trackedServers.push(name);
    }
  }

  // Remove orphaned tracked servers (previously tracked but no longer in plugins)
  if (hasTracking) {
    const currentServerNames = new Set(pluginServers.keys());
    for (const trackedName of previouslyTracked) {
      if (!currentServerNames.has(trackedName) && trackedName in existingServers) {
        delete existingServers[trackedName];
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
  }

  // Write back if there were changes and not dry-run
  const hasChanges = result.added > 0 || result.overwritten > 0 || result.removed > 0;
  if (hasChanges && !dryRun) {
    existingConfig.servers = existingServers;
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf-8');
    result.configPath = configPath;
  }

  // Handle edge case: no plugins have MCP servers but we need to clean up
  if (pluginServers.size === 0 && hasTracking && previouslyTracked.size > 0) {
    // Re-check for removals when no current servers
    for (const trackedName of previouslyTracked) {
      if (trackedName in existingServers) {
        delete existingServers[trackedName];
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
    if (result.removed > 0 && !dryRun) {
      existingConfig.servers = existingServers;
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf-8');
      result.configPath = configPath;
    }
  }

  return result;
}
