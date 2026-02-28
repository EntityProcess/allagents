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
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
