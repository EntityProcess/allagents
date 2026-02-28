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
   * Glob patterns of files to exclude from .github/ content syncing.
   * Paths are relative to the plugin root (e.g., ".github/instructions/file.md").
   * Only applies to .github/ directory content; other plugin content types
   * (commands, skills, hooks, agents) are not affected.
   */
  exclude: z.array(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
