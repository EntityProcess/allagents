import { z } from 'zod';
import { ClientTypeSchema } from './workspace-config.js';

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
});

export type SyncState = z.infer<typeof SyncStateSchema>;
