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
});

export type SyncState = z.infer<typeof SyncStateSchema>;
