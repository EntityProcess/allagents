import { z } from 'zod';

/**
 * Repository definition in workspace.yaml
 */
export const RepositorySchema = z.object({
  path: z.string(),
  name: z.string().optional(),
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
  'universal',
  'claude',
  'copilot',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'factory',
  'ampcode',
  'vscode',
  'openclaw',
  'windsurf',
  'cline',
  'continue',
  'roo',
  'kilo',
  'trae',
  'augment',
  'zencoder',
  'junie',
  'openhands',
  'kiro',
  'replit',
  'kimi',
]);

export type ClientType = z.infer<typeof ClientTypeSchema>;

/**
 * Installation mode for plugins
 * - 'file': Copy plugin files to client directories (default)
 * - 'native': Use client's native CLI to install (e.g., `claude plugin install`)
 */
export const InstallModeSchema = z.enum(['file', 'native']);
export type InstallMode = z.infer<typeof InstallModeSchema>;

/**
 * Client entry — string shorthand, colon shorthand, or object with install mode.
 *
 * "claude"        → bare client, install defaults to "file"
 * "claude:native" → colon shorthand, parsed to { name: "claude", install: "native" }
 * { name, install } → explicit object form
 */
export const ClientEntrySchema = z.union([
  z
    .string()
    .transform((s, ctx) => {
      const colonIdx = s.indexOf(':');
      if (colonIdx === -1) {
        // Bare string — validate as client type
        const result = ClientTypeSchema.safeParse(s);
        if (!result.success) {
          for (const issue of result.error.issues) ctx.addIssue(issue);
          return z.NEVER;
        }
        return result.data;
      }
      // Colon shorthand — split on first colon
      const name = s.slice(0, colonIdx);
      const mode = s.slice(colonIdx + 1);
      const nameResult = ClientTypeSchema.safeParse(name);
      if (!nameResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid client type: '${name}'`,
        });
        return z.NEVER;
      }
      const modeResult = InstallModeSchema.safeParse(mode);
      if (!modeResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid install mode: '${mode}'. Valid modes: ${InstallModeSchema.options.join(', ')}`,
        });
        return z.NEVER;
      }
      return { name: nameResult.data, install: modeResult.data };
    }),
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);
export type ClientEntry = z.infer<typeof ClientEntrySchema>;

/**
 * Skill selection config for a plugin entry.
 * - Array: allowlist — only these skills are enabled.
 * - Object with `exclude`: blocklist — all skills except these are enabled.
 */
export const PluginSkillsConfigSchema = z.union([
  z.array(z.string()),
  z.object({ exclude: z.array(z.string()) }),
]);

export type PluginSkillsConfig = z.infer<typeof PluginSkillsConfigSchema>;

/**
 * Plugin entry in workspace.yaml
 * Supports string shorthand and object form with optional client override.
 */
export const PluginEntrySchema = z.union([
  PluginSourceSchema,
  z.object({
    source: PluginSourceSchema,
    clients: z.array(ClientTypeSchema).optional(),
    install: InstallModeSchema.optional(),
    exclude: z.array(z.string()).optional(),
    skills: PluginSkillsConfigSchema.optional(),
  }),
]);

export type PluginEntry = z.infer<typeof PluginEntrySchema>;

/**
 * Resolve plugin source from plugin entry (string or object form)
 */
export function getPluginSource(plugin: PluginEntry): string {
  return typeof plugin === 'string' ? plugin : plugin.source;
}

/**
 * Resolve optional plugin-level clients from plugin entry
 */
export function getPluginClients(plugin: PluginEntry): ClientType[] | undefined {
  return typeof plugin === 'string' ? undefined : plugin.clients;
}

/**
 * Get plugin-level install mode override (if any)
 */
export function getPluginInstallMode(plugin: PluginEntry): InstallMode | undefined {
  return typeof plugin === 'string' ? undefined : plugin.install;
}

/**
 * Get plugin-level file exclusion patterns (if any).
 * Glob patterns are relative to the plugin root.
 */
export function getPluginExclude(plugin: PluginEntry): string[] | undefined {
  return typeof plugin === 'string' ? undefined : plugin.exclude;
}

/**
 * Normalize a client entry to { name, install } form.
 */
export function normalizeClientEntry(entry: ClientEntry): { name: ClientType; install: InstallMode } {
  if (typeof entry === 'string') {
    return { name: entry, install: 'file' };
  }
  return { name: entry.name, install: entry.install ?? 'file' };
}

/**
 * Extract ClientType values from client entries.
 */
export function getClientTypes(entries: ClientEntry[]): ClientType[] {
  return entries.map((e) => (typeof e === 'string' ? e : e.name));
}

/**
 * Get install mode for a specific client from entries.
 * Returns 'file' if client not found.
 */
export function getClientInstallMode(entries: ClientEntry[], client: ClientType): InstallMode {
  for (const entry of entries) {
    const normalized = normalizeClientEntry(entry);
    if (normalized.name === client) return normalized.install;
  }
  return 'file';
}

/**
 * Resolve effective install mode for a (plugin, client) pair.
 * Priority: plugin-level > client-level > 'file' default.
 */
export function resolveInstallMode(
  pluginEntry: PluginEntry,
  clientEntry: { name: ClientType; install: InstallMode },
): InstallMode {
  const pluginMode = getPluginInstallMode(pluginEntry);
  if (pluginMode) return pluginMode;
  return clientEntry.install;
}

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
  version: z.number().optional(),
  workspace: WorkspaceSchema.optional(),
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginEntrySchema),
  clients: z.array(ClientEntrySchema),
  vscode: VscodeConfigSchema.optional(),
  syncMode: SyncModeSchema.optional(),
  /** @deprecated Use inline skills field on plugin entry instead. Will be removed in v3. */
  disabledSkills: z.array(z.string()).optional(),
  /** @deprecated Use inline skills field on plugin entry instead. Will be removed in v3. */
  enabledSkills: z.array(z.string()).optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
