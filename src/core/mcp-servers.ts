import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  ClientType,
  McpServerConfig,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import { McpServerConfigSchema } from '../models/workspace-config.js';
import { ensureWorkspace } from './workspace-modify.js';

/**
 * Result of add/remove/update operations on workspace mcpServers.
 */
export interface McpServerModifyResult {
  success: boolean;
  error?: string;
  /** Normalized server config that was written (for add/update) */
  config?: McpServerConfig;
}

function getConfigPath(workspacePath: string): string {
  return join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
}

async function readConfig(configPath: string): Promise<WorkspaceConfig> {
  const content = await readFile(configPath, 'utf-8');
  return load(content) as WorkspaceConfig;
}

async function writeConfig(configPath: string, config: WorkspaceConfig): Promise<void> {
  await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
}

/**
 * Validate a server config via the McpServerConfigSchema. Returns a
 * user-friendly error on failure.
 */
function validateServerConfig(
  config: unknown,
): { valid: true; data: McpServerConfig } | { valid: false; error: string } {
  const result = McpServerConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    return { valid: false, error: `Invalid MCP server config:\n${issues.join('\n')}` };
  }
  return { valid: true, data: result.data };
}

/**
 * Add a new MCP server entry to workspace.yaml. Fails if a server with the
 * given name already exists (unless `force` is set).
 */
export async function addWorkspaceMcpServer(
  name: string,
  config: McpServerConfig,
  workspacePath: string = process.cwd(),
  force = false,
): Promise<McpServerModifyResult> {
  const validation = validateServerConfig(config);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  try {
    await ensureWorkspace(workspacePath);
    const configPath = getConfigPath(workspacePath);
    const workspaceConfig = await readConfig(configPath);
    workspaceConfig.mcpServers ??= {};

    if (workspaceConfig.mcpServers[name] && !force) {
      return {
        success: false,
        error: `MCP server '${name}' already exists in workspace.yaml. Pass --force to replace it.`,
      };
    }

    workspaceConfig.mcpServers[name] = validation.data;
    await writeConfig(configPath, workspaceConfig);
    return { success: true, config: validation.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove an MCP server entry from workspace.yaml. Returns success: false if
 * the server is not defined in workspace.yaml (it may still exist in a plugin).
 */
export async function removeWorkspaceMcpServer(
  name: string,
  workspacePath: string = process.cwd(),
): Promise<McpServerModifyResult> {
  const configPath = getConfigPath(workspacePath);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  try {
    const workspaceConfig = await readConfig(configPath);
    if (!workspaceConfig.mcpServers || !(name in workspaceConfig.mcpServers)) {
      return {
        success: false,
        error: `MCP server '${name}' not found in workspace.yaml`,
      };
    }

    delete workspaceConfig.mcpServers[name];
    if (Object.keys(workspaceConfig.mcpServers).length === 0) {
      workspaceConfig.mcpServers = undefined;
    }

    await writeConfig(configPath, workspaceConfig);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read an MCP server entry from workspace.yaml. Returns null if it is not
 * defined there (it may still be defined by a plugin).
 */
export async function getWorkspaceMcpServer(
  name: string,
  workspacePath: string = process.cwd(),
): Promise<McpServerConfig | null> {
  const configPath = getConfigPath(workspacePath);
  if (!existsSync(configPath)) return null;
  const workspaceConfig = await readConfig(configPath);
  return workspaceConfig.mcpServers?.[name] ?? null;
}

/**
 * List all MCP servers defined in workspace.yaml.
 */
export async function listWorkspaceMcpServers(
  workspacePath: string = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  const configPath = getConfigPath(workspacePath);
  if (!existsSync(configPath)) return {};
  const workspaceConfig = await readConfig(configPath);
  return workspaceConfig.mcpServers ?? {};
}

/**
 * Build an McpServerConfig from CLI flags. Transport defaults:
 * - If commandOrUrl starts with http(s)://, treat as HTTP
 * - Otherwise treat as stdio command
 */
export function buildMcpServerConfigFromFlags(options: {
  commandOrUrl: string;
  transport?: 'http' | 'stdio';
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  clients?: ClientType[];
}): { config: McpServerConfig } | { error: string } {
  const { commandOrUrl, args, env, headers, clients } = options;
  const transport =
    options.transport ?? (/^https?:\/\//i.test(commandOrUrl) ? 'http' : 'stdio');

  if (transport === 'http') {
    if (!/^https?:\/\//i.test(commandOrUrl)) {
      return {
        error: `HTTP transport requires a URL starting with http:// or https:// (got '${commandOrUrl}')`,
      };
    }
    if (args && args.length > 0) {
      return { error: '--arg is not supported for HTTP transport' };
    }
    if (env && Object.keys(env).length > 0) {
      return { error: '-e/--env is not supported for HTTP transport' };
    }
    const config: McpServerConfig = {
      type: 'http',
      url: commandOrUrl,
      ...(headers && Object.keys(headers).length > 0 && { headers }),
      ...(clients && clients.length > 0 && { clients }),
    };
    return { config };
  }

  if (options.transport === 'stdio' && /^https?:\/\//i.test(commandOrUrl)) {
    return {
      error: `stdio transport requires a command, not a URL (got '${commandOrUrl}')`,
    };
  }
  if (headers && Object.keys(headers).length > 0) {
    return { error: '--header is not supported for stdio transport' };
  }
  const config: McpServerConfig = {
    type: 'stdio',
    command: commandOrUrl,
    ...(args && args.length > 0 && { args }),
    ...(env && Object.keys(env).length > 0 && { env }),
    ...(clients && clients.length > 0 && { clients }),
  };
  return { config };
}

/**
 * Parse KEY=VALUE strings into a record. Returns an error if any entry is
 * malformed.
 */
export function parseKeyValuePairs(
  pairs: string[],
  flagName: string,
): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) {
      return { error: `Invalid ${flagName}: '${pair}' (expected KEY=VALUE)` };
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    values[key] = value;
  }
  return { values };
}
