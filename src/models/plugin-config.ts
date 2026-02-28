import { z } from 'zod';

/**
 * Plugin manifest schema (plugin.json)
 */
export const PluginManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  /**
   * Glob patterns of files to exclude when syncing to consumer workspaces.
   * Paths are relative to the plugin root (e.g., ".github/instructions/file.md",
   * "commands/internal-cmd.md", "skills/dev-only", "hooks/debug").
   */
  exclude: z.array(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
