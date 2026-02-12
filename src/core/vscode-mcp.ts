import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import JSON5 from 'json5';
import { modify, applyEdits } from 'jsonc-parser';
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
 * Uses jsonc-parser for surgical edits that preserve comments, formatting,
 * and all other content in the file. Only the new server entries are touched.
 *
 * Plugin .mcp.json uses "mcpServers" key (standard MCP format).
 * VS Code's mcp.json uses "servers" key (VS Code-specific format).
 *
 * - New server names are added under "servers"
 * - Existing server names are skipped (non-destructive)
 * - Comments, formatting, and other keys are fully preserved
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

  // Read existing file content as raw text (preserves comments/formatting)
  let fileContent = '{}';
  if (existsSync(configPath)) {
    fileContent = readFileSync(configPath, 'utf-8');
  }

  // Parse with JSON5 to check which server names already exist
  let existingServers: Record<string, unknown> = {};
  try {
    const parsed = JSON5.parse(fileContent);
    if (parsed?.servers && typeof parsed.servers === 'object') {
      existingServers = parsed.servers as Record<string, unknown>;
    }
  } catch {
    // If unparseable, start fresh but warn
    result.warnings.push(`Could not parse existing ${configPath}, starting fresh`);
    fileContent = '{}';
  }

  // Determine which servers to add vs skip
  const serversToAdd: [string, unknown][] = [];
  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      result.skipped++;
      result.skippedServers.push(name);
    } else {
      serversToAdd.push([name, config]);
      result.added++;
      result.addedServers.push(name);
    }
  }

  // Apply surgical edits using jsonc-parser (preserves comments and formatting)
  if (serversToAdd.length > 0 && !dryRun) {
    let content = fileContent;
    const formattingOptions = { tabSize: 2, insertSpaces: true };

    for (const [name, config] of serversToAdd) {
      const edits = modify(content, ['servers', name], config, { formattingOptions });
      content = applyEdits(content, edits);
    }

    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, content, 'utf-8');
  }

  return result;
}
