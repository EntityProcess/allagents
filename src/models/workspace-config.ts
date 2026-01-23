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
 * Workspace file entry - can be string shorthand or explicit source/dest mapping
 */
export const WorkspaceFileSchema = z.union([
  z.string(), // shorthand: "CLAUDE.md" (source and dest are the same)
  z.object({
    source: z.string(),
    dest: z.string().optional(), // defaults to basename of source
  }),
]);

export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/**
 * Workspace configuration for copying files to workspace root
 */
export const WorkspaceSchema = z.object({
  source: z.string(), // local path, GitHub URL, or plugin@marketplace
  files: z.array(WorkspaceFileSchema),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

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
  workspace: WorkspaceSchema.optional(),
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginSourceSchema),
  clients: z.array(ClientTypeSchema),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
