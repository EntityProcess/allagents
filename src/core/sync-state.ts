import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../constants.js';
import { SyncStateSchema, type SyncState } from '../models/sync-state.js';
import type { ClientType } from '../models/workspace-config.js';

/** MCP scope identifier (e.g., "vscode" for user-level mcp.json) */
export type McpScope = 'vscode';

/**
 * Data structure for saving sync state with optional MCP servers
 */
export interface SyncStateData {
  files: Partial<Record<ClientType, string[]>>;
  mcpServers?: Partial<Record<McpScope, string[]>>;
}

/**
 * Get the path to the sync state file
 * @param workspacePath - Path to workspace directory
 * @returns Path to .allagents/sync-state.json
 */
export function getSyncStatePath(workspacePath: string): string {
  return join(workspacePath, CONFIG_DIR, SYNC_STATE_FILE);
}

/**
 * Load sync state from disk
 * Returns null if file doesn't exist or is corrupted (safe behavior)
 * @param workspacePath - Path to workspace directory
 * @returns Parsed sync state or null
 */
export async function loadSyncState(workspacePath: string): Promise<SyncState | null> {
  const statePath = getSyncStatePath(workspacePath);

  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(content);
    const result = SyncStateSchema.safeParse(parsed);

    if (!result.success) {
      // Corrupted state file - treat as no state (safe behavior)
      return null;
    }

    return result.data;
  } catch {
    // Read or parse error - treat as no state
    return null;
  }
}

/**
 * Save sync state to disk
 * @param workspacePath - Path to workspace directory
 * @param data - Sync state data including files and optional MCP servers
 */
export async function saveSyncState(
  workspacePath: string,
  data: SyncStateData | Partial<Record<ClientType, string[]>>,
): Promise<void> {
  const statePath = getSyncStatePath(workspacePath);

  // Support both old signature (just files) and new signature (SyncStateData)
  const normalizedData: SyncStateData = 'files' in data
    ? data as SyncStateData
    : { files: data as Partial<Record<ClientType, string[]>> };

  const state: SyncState = {
    version: 1,
    lastSync: new Date().toISOString(),
    files: normalizedData.files as Record<ClientType, string[]>,
    ...(normalizedData.mcpServers && { mcpServers: normalizedData.mcpServers }),
  };

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Get files that were previously synced for a specific client
 * @param state - Loaded sync state (or null)
 * @param client - Client type to get files for
 * @returns Array of file paths, empty if no state or no files for client
 */
export function getPreviouslySyncedFiles(
  state: SyncState | null,
  client: ClientType,
): string[] {
  if (!state) {
    return [];
  }

  return state.files[client] ?? [];
}

/**
 * Get MCP servers that were previously synced for a specific scope
 * @param state - Loaded sync state (or null)
 * @param scope - MCP scope to get servers for (e.g., "vscode")
 * @returns Array of server names, empty if no state or no servers for scope
 */
export function getPreviouslySyncedMcpServers(
  state: SyncState | null,
  scope: McpScope,
): string[] {
  if (!state?.mcpServers) {
    return [];
  }

  return state.mcpServers[scope] ?? [];
}
