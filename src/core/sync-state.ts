import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../constants.js';
import { SyncStateSchema, type SyncState } from '../models/sync-state.js';
import type { ClientType } from '../models/workspace-config.js';

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
 * @param files - Per-client file lists that were synced
 */
export async function saveSyncState(
  workspacePath: string,
  files: Partial<Record<ClientType, string[]>>,
): Promise<void> {
  const statePath = getSyncStatePath(workspacePath);

  const state: SyncState = {
    version: 1,
    lastSync: new Date().toISOString(),
    files: files as Record<ClientType, string[]>,
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
