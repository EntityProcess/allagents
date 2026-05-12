import { z } from 'zod';
import { ClientTypeSchema } from './workspace-config.js';

/**
 * Per-plugin source provenance.
 *
 * Identity for git-based plugins is `url + ref`. `resolvedSha` is the commit
 * SHA returned by `git rev-parse HEAD` after the fetch and is what actually
 * uniquely identifies the installed content; `resolvedRef` is the symbolic
 * name (branch/tag) that was asked for. `pinnedRef` records the user's
 * explicit pin (via `@<ref>` or `--pin`), distinct from whatever the resolver
 * settled on.
 *
 * Per-skill content hashing was removed in #388 — `git rev-parse HEAD`
 * already gives content identity for free, and recomputing per-skill
 * sha256 trees on every sync was overhead without practical benefit.
 */
export const SyncStateSourceSchema = z.object({
  pluginSpec: z.string(),
  resolvedRef: z.string(),
  resolvedSha: z.string(),
  pinnedRef: z.string().optional(),
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
  // Per-source resolved ref + SHA + optional pin.
  sources: z.record(z.string(), SyncStateSourceSchema).optional(),
});

export type SyncState = z.infer<typeof SyncStateSchema>;
