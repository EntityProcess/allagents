import { z } from 'zod';
import { ClientTypeSchema } from './workspace-config.js';

/**
 * Per-skill content provenance: deterministic hash of the skill folder
 * contents at install time, plus install/update timestamps.
 *
 * `contentHash` is `"sha256:<hex>"` where <hex> is sha256 over a sorted list
 * of per-file `sha256(content)` digests. Excludes file mtimes so the value is
 * reproducible across machines and clones.
 *
 * Field name `contentHash` is intentionally a strict subset of gh-skill's
 * `skillFolderHash` so a future migration to `.skill-lock.json` is mechanical.
 */
export const SyncStateSkillSchema = z.object({
  contentHash: z.string(),
  installedAt: z.string(),
  updatedAt: z.string(),
});

export type SyncStateSkill = z.infer<typeof SyncStateSkillSchema>;

/**
 * Per-plugin source provenance: which ref was resolved when the plugin was
 * installed, optional explicit pin, and a map of per-skill content hashes.
 * Keys are indexed by canonical plugin spec (e.g., "owner/repo").
 *
 * Field names are a strict subset of the gh-skill lockfile so a future
 * migration to `.skill-lock.json` is mechanical.
 */
export const SyncStateSourceSchema = z.object({
  pluginSpec: z.string(),
  resolvedRef: z.string(),
  resolvedSha: z.string(),
  pinnedRef: z.string().optional(),
  skills: z.record(z.string(), SyncStateSkillSchema).optional(),
});

export type SyncStateSource = z.infer<typeof SyncStateSourceSchema>;

/**
 * Sync state schema - tracks which files were synced per client
 * Used for non-destructive sync (only purge files we previously created)
 */
export const SyncStateSchema = z.object({
  version: z.literal(1),
  lastSync: z.string(), // ISO timestamp
  files: z.record(ClientTypeSchema, z.array(z.string())),
  // MCP servers tracked per scope (e.g., "vscode" for user-level mcp.json)
  mcpServers: z.record(z.string(), z.array(z.string())).optional(),
  // Native plugins tracked per client type (e.g., "claude" for claude plugin install)
  nativePlugins: z.record(ClientTypeSchema, z.array(z.string())).optional(),
  // Hash of last-written .code-workspace file content (for change detection)
  vscodeWorkspaceHash: z.string().optional(),
  // Repository paths at last sync (for detecting added/removed repos)
  vscodeWorkspaceRepos: z.array(z.string()).optional(),
  // Skills-index files tracked for cleanup (relative to .allagents/)
  skillsIndex: z.array(z.string()).optional(),
  // Per-source resolved ref + SHA + optional pin + per-skill content hashes.
  sources: z.record(z.string(), SyncStateSourceSchema).optional(),
});

export type SyncState = z.infer<typeof SyncStateSchema>;
