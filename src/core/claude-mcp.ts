import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import JSON5 from 'json5';
import { getHomeDir } from '../constants.js';
import { collectMcpServers } from './vscode-mcp.js';
import type { McpMergeResult } from './vscode-mcp.js';
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
 * Get the path to Claude Code's user-level settings.json
 */
export function getClaudeSettingsPath(): string {
  return join(getHomeDir(), '.claude', 'settings.json');
}

/**
 * Sync MCP server configs from plugins into Claude Code's settings.json.
 *
 * Claude Code stores MCP servers under the "mcpServers" key in settings.json,
 * unlike VS Code which uses "servers" inside mcp.json.
 *
 * With tracking enabled:
 * - Tracked servers with changed configs are updated (not skipped)
 * - Tracked servers no longer in plugins are removed
 * - User-managed servers (not tracked) are preserved
 */
export function syncClaudeMcpConfig(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    configPath?: string;
    force?: boolean;
    trackedServers?: string[];
  },
): McpMergeResult {
  const dryRun = options?.dryRun ?? false;
  const force = options?.force ?? false;
  const configPath = options?.configPath ?? getClaudeSettingsPath();
  const previouslyTracked = new Set(options?.trackedServers ?? []);
  const hasTracking = options?.trackedServers !== undefined;

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

  // Read existing Claude settings.json (or start fresh)
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      existingConfig = JSON5.parse(content);
    } catch {
      result.warnings.push(`Could not parse existing ${configPath}, starting fresh`);
      existingConfig = {};
    }
  }

  // Claude Code uses "mcpServers" key (not "servers" like VS Code)
  const existingServers = (existingConfig.mcpServers as Record<string, unknown>) ?? {};

  // Process plugin servers: add new, update tracked, skip user-managed conflicts
  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      if (!deepEqual(existingServers[name], config)) {
        if (hasTracking && previouslyTracked.has(name)) {
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else if (force) {
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else {
          result.skipped++;
          result.skippedServers.push(name);
        }
      } else if (hasTracking && previouslyTracked.has(name)) {
        result.trackedServers.push(name);
      }
    } else {
      existingServers[name] = config;
      result.added++;
      result.addedServers.push(name);
      result.trackedServers.push(name);
    }
  }

  // Remove orphaned tracked servers
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
    existingConfig.mcpServers = existingServers;
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, `${JSON.stringify(existingConfig, null, 2)}\n`, 'utf-8');
    result.configPath = configPath;
  }

  // Handle edge case: no plugins have MCP servers but we need to clean up
  if (pluginServers.size === 0 && hasTracking && previouslyTracked.size > 0) {
    for (const trackedName of previouslyTracked) {
      if (trackedName in existingServers) {
        delete existingServers[trackedName];
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
    if (result.removed > 0 && !dryRun) {
      existingConfig.mcpServers = existingServers;
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
