import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../constants.js';
import {
  SyncStateSchema,
  type SyncState,
  type SyncStateSource,
  type SyncStateSkill,
} from '../models/sync-state.js';
import type { ClientType } from '../models/workspace-config.js';
import { ensureConfigGitignore } from './config-gitignore.js';

/** MCP scope identifier (e.g., "vscode" for user-level mcp.json) */
export type McpScope = 'vscode' | 'codex' | 'claude' | 'copilot';

/**
 * Data structure for saving sync state with optional MCP servers
 */
export interface SyncStateData {
  files: Partial<Record<ClientType, string[]>>;
  mcpServers?: Partial<Record<McpScope, string[]>>;
  nativePlugins?: Partial<Record<ClientType, string[]>>;
  vscodeWorkspaceHash?: string;
  vscodeWorkspaceRepos?: string[];
  skillsIndex?: string[];
  sources?: Record<string, SyncStateSource>;
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
    ...(normalizedData.nativePlugins && { nativePlugins: normalizedData.nativePlugins }),
    ...(normalizedData.vscodeWorkspaceHash && { vscodeWorkspaceHash: normalizedData.vscodeWorkspaceHash }),
    ...(normalizedData.vscodeWorkspaceRepos && { vscodeWorkspaceRepos: normalizedData.vscodeWorkspaceRepos }),
    ...(normalizedData.skillsIndex && normalizedData.skillsIndex.length > 0 && { skillsIndex: normalizedData.skillsIndex }),
    ...(normalizedData.sources &&
      Object.keys(normalizedData.sources).length > 0 && { sources: normalizedData.sources }),
  };

  await mkdir(dirname(statePath), { recursive: true });
  await ensureConfigGitignore(workspacePath);
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

/**
 * Get native plugins previously installed for a specific client
 * @param state - Loaded sync state (or null)
 * @param client - Client type to get native plugins for
 * @returns Array of plugin names, empty if no state or no plugins for client
 */
export function getPreviouslySyncedNativePlugins(
  state: SyncState | null,
  client: ClientType,
): string[] {
  if (!state?.nativePlugins) return [];
  return state.nativePlugins[client] ?? [];
}

/**
 * Compute a deterministic content hash of a skill folder.
 *
 * Algorithm: for every regular file under `skillDir` (recursive),
 * compute `sha256(content)`. Sort by relative path (POSIX-style slashes) and
 * fold each as `relPath + ":" + sha + "\n"` into a final sha256. The result is
 * `"sha256:<hex>"`.
 *
 * Excludes file mtimes / inode metadata so the hash is reproducible across
 * machines and re-clones.
 *
 * Returns null if the directory does not exist or is empty.
 */
export async function computeSkillFolderHash(skillDir: string): Promise<string | null> {
  if (!existsSync(skillDir)) return null;
  const entries: Array<{ rel: string; sha: string }> = [];

  async function walk(dir: string): Promise<void> {
    const dirEntries = await readdir(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        const sha = createHash('sha256').update(content).digest('hex');
        const rel = relative(skillDir, full).split(/[\\/]/).join('/');
        entries.push({ rel, sha });
      }
    }
  }

  await walk(skillDir);
  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const outer = createHash('sha256');
  for (const { rel, sha } of entries) {
    outer.update(`${rel}:${sha}\n`);
  }
  return `sha256:${outer.digest('hex')}`;
}

/**
 * Upsert a source provenance record into sync-state, preserving all other
 * fields. Use when recording the resolved ref/SHA after a fetch.
 */
export async function upsertSyncStateSource(
  workspacePath: string,
  key: string,
  source: SyncStateSource,
): Promise<void> {
  const existing = await loadSyncState(workspacePath);
  const sources = { ...(existing?.sources ?? {}), [key]: source };
  await persistMergedSyncState(workspacePath, existing, sources);
}

/**
 * Upsert per-skill provenance (contentHash + timestamps) under the given
 * source key. Creates the source entry if it doesn't exist yet (with
 * placeholder ref/sha — callers usually call upsertSyncStateSource first).
 */
export async function upsertSyncStateSkill(
  workspacePath: string,
  sourceKey: string,
  skillName: string,
  skill: SyncStateSkill,
): Promise<void> {
  const existing = await loadSyncState(workspacePath);
  const currentSources = { ...(existing?.sources ?? {}) };
  const currentSource: SyncStateSource = currentSources[sourceKey] ?? {
    pluginSpec: sourceKey,
    resolvedRef: 'HEAD',
    resolvedSha: '',
  };
  const updatedSkills = { ...(currentSource.skills ?? {}), [skillName]: skill };
  currentSources[sourceKey] = { ...currentSource, skills: updatedSkills };
  await persistMergedSyncState(workspacePath, existing, currentSources);
}

async function persistMergedSyncState(
  workspacePath: string,
  existing: SyncState | null,
  sources: Record<string, SyncStateSource>,
): Promise<void> {
  await saveSyncState(workspacePath, {
    files: (existing?.files ?? {}) as Partial<Record<ClientType, string[]>>,
    ...(existing?.mcpServers && {
      mcpServers: existing.mcpServers as Partial<Record<McpScope, string[]>>,
    }),
    ...(existing?.nativePlugins && {
      nativePlugins: existing.nativePlugins as Partial<Record<ClientType, string[]>>,
    }),
    ...(existing?.vscodeWorkspaceHash && {
      vscodeWorkspaceHash: existing.vscodeWorkspaceHash,
    }),
    ...(existing?.vscodeWorkspaceRepos && {
      vscodeWorkspaceRepos: existing.vscodeWorkspaceRepos,
    }),
    ...(existing?.skillsIndex && { skillsIndex: existing.skillsIndex }),
    sources,
  });
}
