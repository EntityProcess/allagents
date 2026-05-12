import { ClientTypeSchema, type ClientType } from './workspace-config.js';

/**
 * Client-specific path and file configuration
 */
export interface ClientMapping {
  /** Path for commands (Claude, OpenCode) */
  commandsPath?: string;
  skillsPath: string;
  agentsPath?: string;
  agentFile: string;
  agentFileFallback?: string;
  hooksPath?: string;
  /** Path for GitHub-specific content (prompts, copilot-instructions.md) */
  githubPath?: string;
}

/**
 * Single source of truth for every supported AI client/agent host.
 *
 * Each entry pairs a project-scope mapping (paths relative to the project root)
 * with a user-scope mapping (paths relative to ~). Most hosts use identical
 * paths in both scopes; a few — notably `copilot`, `windsurf`, and `vscode` —
 * intentionally diverge. Keeping both maps on one entry surfaces those
 * differences at a glance instead of forcing reviewers to diff two ~130-line
 * records.
 *
 * The legacy `CLIENT_MAPPINGS` and `USER_CLIENT_MAPPINGS` records below are
 * derived from this array so existing call sites keep working while
 * `getMapping(id, scope)` becomes the preferred accessor going forward.
 *
 * Pattern is modelled after `cli/cli`'s `internal/skills/registry/registry.go`.
 */
export interface AgentHost {
  id: ClientType;
  /** Display name used in help / sync output (e.g. "Windsurf"). */
  name: string;
  project: ClientMapping;
  user: ClientMapping;
}

export const AGENT_HOSTS: readonly AgentHost[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    project: {
      commandsPath: '.claude/commands/',
      skillsPath: '.claude/skills/',
      agentsPath: '.claude/agents/',
      agentFile: 'CLAUDE.md',
      agentFileFallback: 'AGENTS.md',
      hooksPath: '.claude/hooks/',
    },
    user: {
      commandsPath: '.claude/commands/',
      skillsPath: '.claude/skills/',
      agentsPath: '.claude/agents/',
      agentFile: 'CLAUDE.md',
      agentFileFallback: 'AGENTS.md',
      hooksPath: '.claude/hooks/',
    },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    project: {
      skillsPath: '.github/skills/',
      agentsPath: '.github/agents/',
      hooksPath: '.github/hooks/',
      agentFile: 'AGENTS.md',
      githubPath: '.github/',
    },
    user: {
      // User-scope Copilot stores under `.copilot/` because `.github/` is
      // owned by individual repositories.
      skillsPath: '.copilot/skills/',
      agentsPath: '.copilot/agents/',
      hooksPath: '.copilot/hooks/',
      agentFile: 'AGENTS.md',
      githubPath: '.copilot/',
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    project: { skillsPath: '.codex/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.codex/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    project: { skillsPath: '.cursor/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.cursor/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    project: {
      commandsPath: '.opencode/commands/',
      skillsPath: '.opencode/skills/',
      agentFile: 'AGENTS.md',
    },
    user: {
      commandsPath: '.opencode/commands/',
      skillsPath: '.opencode/skills/',
      agentFile: 'AGENTS.md',
    },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    project: {
      skillsPath: '.gemini/skills/',
      agentFile: 'GEMINI.md',
      agentFileFallback: 'AGENTS.md',
    },
    user: {
      skillsPath: '.gemini/skills/',
      agentFile: 'GEMINI.md',
      agentFileFallback: 'AGENTS.md',
    },
  },
  {
    id: 'factory',
    name: 'Factory',
    project: {
      skillsPath: '.factory/skills/',
      agentFile: 'AGENTS.md',
      hooksPath: '.factory/hooks/',
    },
    user: {
      skillsPath: '.factory/skills/',
      agentFile: 'AGENTS.md',
      hooksPath: '.factory/hooks/',
    },
  },
  {
    id: 'ampcode',
    name: 'AmpCode',
    project: { skillsPath: '.ampcode/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.ampcode/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    // Defaults to the canonical universal location at both scopes. The
    // copilot-sibling override is applied dynamically by resolveClientMappings.
    project: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    project: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    project: { skillsPath: '.windsurf/skills/', agentFile: 'AGENTS.md' },
    // Windsurf's user-scope home is the Codeium parent dir, not `.windsurf/`.
    // Surfaced explicitly so the divergence is obvious in code review.
    user: { skillsPath: '.codeium/windsurf/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'cline',
    name: 'Cline',
    project: { skillsPath: '.cline/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.cline/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'continue',
    name: 'Continue',
    project: { skillsPath: '.continue/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.continue/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'roo',
    name: 'Roo Code',
    project: { skillsPath: '.roo/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.roo/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    project: { skillsPath: '.kilocode/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kilocode/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'trae',
    name: 'Trae',
    project: { skillsPath: '.trae/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.trae/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'augment',
    name: 'Augment',
    project: { skillsPath: '.augment/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.augment/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'zencoder',
    name: 'Zencoder',
    project: { skillsPath: '.zencoder/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.zencoder/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'junie',
    name: 'Junie',
    project: { skillsPath: '.junie/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.junie/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    project: { skillsPath: '.openhands/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.openhands/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    project: { skillsPath: '.kiro/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kiro/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'replit',
    name: 'Replit',
    project: { skillsPath: '.replit/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.replit/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    project: { skillsPath: '.kimi/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kimi/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'universal',
    name: 'Universal',
    project: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
  },
] as const;

/**
 * Look up an agent host by ClientType id.
 *
 * Returns the canonical entry; callers wanting the legacy `CLIENT_MAPPINGS`
 * shape should use `getMapping(id, scope)` instead.
 */
export function findHostById(id: ClientType): AgentHost | undefined {
  return AGENT_HOSTS.find((h) => h.id === id);
}

/**
 * Resolve the `ClientMapping` for a given (client, scope) pair.
 *
 * Falls back to throwing rather than returning undefined: every ClientType
 * value is guaranteed to have a host entry (enforced by
 * `client-mapping.test.ts`). Returning undefined would silently mask the
 * "added to enum but not registered" bug we just removed.
 */
export function getMapping(
  id: ClientType,
  scope: 'project' | 'user',
): ClientMapping {
  const host = findHostById(id);
  if (!host) {
    throw new Error(`Unknown agent host: ${id} (no entry in AGENT_HOSTS)`);
  }
  return scope === 'user' ? host.user : host.project;
}

/**
 * The set of distinct skills paths used at project scope. Useful for the
 * dedup logic that the symlink-mode sync runs against `.agents/skills/`.
 */
export function uniqueProjectSkillsPaths(): string[] {
  return Array.from(new Set(AGENT_HOSTS.map((h) => h.project.skillsPath)));
}

/**
 * Render an agent help list: `"<id> — <name>"` per host, alphabetised.
 * Used by user-facing help output.
 */
export function agentHelpList(): string {
  return [...AGENT_HOSTS]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((h) => `${h.id} — ${h.name}`)
    .join('\n');
}

/**
 * Project-level client path mappings for all supported AI clients.
 * Paths are relative to the project root directory.
 *
 * Derived from `AGENT_HOSTS` so it can never drift from the user-scope record.
 * Kept as a separate export for backward compatibility with existing call sites.
 */
export const CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = Object.freeze(
  Object.fromEntries(AGENT_HOSTS.map((h) => [h.id, h.project])),
) as Record<ClientType, ClientMapping>;

/**
 * User-level client path mappings for all supported AI clients.
 * Paths are relative to the user's home directory (~/).
 *
 * Derived from `AGENT_HOSTS`. See note on `CLIENT_MAPPINGS`.
 */
export const USER_CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = Object.freeze(
  Object.fromEntries(AGENT_HOSTS.map((h) => [h.id, h.user])),
) as Record<ClientType, ClientMapping>;

/**
 * The canonical skills path used by the universal client.
 * When universal is in the clients list, skills are copied here first,
 * then symlinked from non-universal client paths.
 */
export const CANONICAL_SKILLS_PATH = '.agents/skills/';

/**
 * Check if a client is the universal client (uses .agents/skills/).
 * Only the 'universal' client type returns true.
 */
export function isUniversalClient(client: ClientType): boolean {
  return client === 'universal';
}

/**
 * Resolve vscode client mapping based on sibling clients.
 * When copilot is present, vscode follows copilot's paths.
 * When copilot is absent, vscode defaults to .agents/ (universal behavior).
 *
 * Returns baseMappings unchanged if vscode is not in the clients list.
 */
export function resolveClientMappings(
  clients: ClientType[],
  baseMappings: Record<ClientType, ClientMapping>,
): Record<ClientType, ClientMapping> {
  if (!clients.includes('vscode')) return baseMappings;
  if (!clients.includes('copilot')) return baseMappings;

  // vscode follows copilot's mapping
  return {
    ...baseMappings,
    vscode: { ...baseMappings.copilot },
  };
}

/**
 * Display name aliases for CLI output.
 * vscode is displayed as copilot for artifact counts since VS Code's AI features
 * are delivered through GitHub Copilot and they share skill paths.
 */
export const CLIENT_DISPLAY_ALIASES: Partial<Record<ClientType, string>> = {
  vscode: 'copilot',
};

/**
 * Get the display name for a client type.
 * Applies CLIENT_DISPLAY_ALIASES so aliased clients (e.g. vscode → copilot)
 * show their canonical display name.
 */
export function getDisplayName(client: string): string {
  return CLIENT_DISPLAY_ALIASES[client as ClientType] ?? client;
}

// Compile-time sanity: every ClientType value must have exactly one host entry.
// Runtime coverage is verified by `client-mapping.test.ts`.
type _HostsCoverEveryClient = Exclude<
  ClientType,
  (typeof AGENT_HOSTS)[number]['id']
> extends never
  ? true
  : never;
const _check: _HostsCoverEveryClient = true;
void _check;
void ClientTypeSchema;
