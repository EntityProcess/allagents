import { z } from 'zod';

/**
 * Repository definition in workspace.yaml
 */
export const RepositorySchema = z.object({
  path: z.string(),
  owner: z.string(),
  repo: z.string(),
  description: z.string(),
});

export type Repository = z.infer<typeof RepositorySchema>;

/**
 * Plugin source - can be local path or GitHub URL
 */
export const PluginSourceSchema = z.string();

export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * Supported AI client types
 */
export const ClientTypeSchema = z.enum([
  'claude',
  'copilot',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'factory',
  'ampcode',
]);

export type ClientType = z.infer<typeof ClientTypeSchema>;

/**
 * Complete workspace configuration (workspace.yaml)
 */
export const WorkspaceConfigSchema = z.object({
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginSourceSchema),
  clients: z.array(ClientTypeSchema),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
