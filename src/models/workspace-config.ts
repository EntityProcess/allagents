import { z } from 'zod';

/**
 * Repository definition in workspace.yaml
 */
export const RepositorySchema = z.object({
  path: z.string(),
  source: z.string().optional(),
  repo: z.string().optional(),
  description: z.string().optional(),
});

export type Repository = z.infer<typeof RepositorySchema>;

/**
 * Workspace file entry - can be string shorthand or explicit source/dest mapping
 *
 * String shorthand: "CLAUDE.md" (source and dest are the same, resolved from workspace.source)
 * Object form:
 *   - source: optional, can be local path, GitHub URL, or shorthand (owner/repo/path)
 *   - dest: optional, defaults to basename of source
 *
 * Valid combinations:
 * 1. { source: "path/file.md" } → dest defaults to "file.md"
 * 2. { source: "path/file.md", dest: "renamed.md" } → explicit mapping
 * 3. { dest: "file.md", source: "owner/repo/path/file.md" } → GitHub source
 * 4. { dest: "file.md" } → uses dest as source path relative to workspace.source
 *
 * At least one of source or dest must be provided.
 */
export const WorkspaceFileSchema = z.union([
  z.string(), // shorthand: "CLAUDE.md" (source and dest are the same)
  z.object({
    source: z.string().optional(), // local path, GitHub URL, or shorthand
    dest: z.string().optional(), // destination filename in workspace root (defaults to basename of source)
  }),
]);

export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/**
 * Workspace configuration for copying files to workspace root
 *
 * source: optional default base for resolving file entries without explicit source
 * files: array of file entries to sync
 *
 * If workspace.source is not provided, all file entries must have explicit source.
 */
export const WorkspaceSchema = z.object({
  source: z.string().optional(), // optional default base for file resolution
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
  'vscode',
]);

export type ClientType = z.infer<typeof ClientTypeSchema>;

/**
 * VSCode workspace generation configuration
 */
export const VscodeConfigSchema = z.object({
  output: z.string().optional(),
});

export type VscodeConfig = z.infer<typeof VscodeConfigSchema>;

/**
 * Sync mode for skills
 * - 'symlink': Copy to canonical .agents/skills/, symlink from client paths (default)
 * - 'copy': Copy directly to each client path (fallback for environments without symlink support)
 */
export const SyncModeSchema = z.enum(['symlink', 'copy']);

export type SyncMode = z.infer<typeof SyncModeSchema>;

/**
 * Complete workspace configuration (workspace.yaml)
 */
export const WorkspaceConfigSchema = z.object({
  workspace: WorkspaceSchema.optional(),
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginSourceSchema),
  clients: z.array(ClientTypeSchema),
  vscode: VscodeConfigSchema.optional(),
  syncMode: SyncModeSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
