import type { ClientType } from './workspace-config.js';

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
 * Client path mappings for all supported AI clients
 */
/**
 * Project-level client path mappings for all supported AI clients.
 * Paths are relative to the project root directory.
 *
 * The 'universal' and 'vscode' clients default to .agents/skills/.
 * When copilot is also configured, vscode follows copilot's paths
 * via resolveClientMappings().
 */
export const CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = {
  claude: {
    commandsPath: '.claude/commands/',
    skillsPath: '.claude/skills/',
    agentsPath: '.claude/agents/',
    agentFile: 'CLAUDE.md',
    agentFileFallback: 'AGENTS.md',
    hooksPath: '.claude/hooks/',
  },
  copilot: {
    skillsPath: '.github/skills/',
    agentsPath: '.github/agents/',
    hooksPath: '.github/hooks/',
    agentFile: 'AGENTS.md',
    githubPath: '.github/',
  },
  codex: {
    skillsPath: '.codex/skills/',
    agentFile: 'AGENTS.md',
  },
  cursor: {
    skillsPath: '.cursor/skills/',
    agentFile: 'AGENTS.md',
  },
  opencode: {
    commandsPath: '.opencode/commands/',
    skillsPath: '.opencode/skills/',
    agentFile: 'AGENTS.md',
  },
  gemini: {
    skillsPath: '.gemini/skills/',
    agentFile: 'GEMINI.md',
    agentFileFallback: 'AGENTS.md',
  },
  factory: {
    skillsPath: '.factory/skills/',
    agentFile: 'AGENTS.md',
    hooksPath: '.factory/hooks/',
  },
  ampcode: {
    skillsPath: '.ampcode/skills/',
    agentFile: 'AGENTS.md',
  },
  vscode: {
    skillsPath: '.agents/skills/',
    agentFile: 'AGENTS.md',
  },
    openclaw: {
    skillsPath: 'skills/',
    agentFile: 'AGENTS.md',
  },
  windsurf: {
    skillsPath: '.windsurf/skills/',
    agentFile: 'AGENTS.md',
  },
  cline: {
    skillsPath: '.cline/skills/',
    agentFile: 'AGENTS.md',
  },
  continue: {
    skillsPath: '.continue/skills/',
    agentFile: 'AGENTS.md',
  },
  roo: {
    skillsPath: '.roo/skills/',
    agentFile: 'AGENTS.md',
  },
  kilo: {
    skillsPath: '.kilocode/skills/',
    agentFile: 'AGENTS.md',
  },
  trae: {
    skillsPath: '.trae/skills/',
    agentFile: 'AGENTS.md',
  },
  augment: {
    skillsPath: '.augment/skills/',
    agentFile: 'AGENTS.md',
  },
  zencoder: {
    skillsPath: '.zencoder/skills/',
    agentFile: 'AGENTS.md',
  },
  junie: {
    skillsPath: '.junie/skills/',
    agentFile: 'AGENTS.md',
  },
  openhands: {
    skillsPath: '.openhands/skills/',
    agentFile: 'AGENTS.md',
  },
  kiro: {
    skillsPath: '.kiro/skills/',
    agentFile: 'AGENTS.md',
  },
  replit: {
    skillsPath: '.replit/skills/',
    agentFile: 'AGENTS.md',
  },
  kimi: {
    skillsPath: '.kimi/skills/',
    agentFile: 'AGENTS.md',
  },
  universal: {
    skillsPath: '.agents/skills/',
    agentFile: 'AGENTS.md',
  },
};

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
 * User-level client path mappings for all supported AI clients.
 * Paths are relative to the user's home directory (~/).
 * Used when plugins are installed with --scope user.
 */
export const USER_CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = {
  claude: {
    commandsPath: '.claude/commands/',
    skillsPath: '.claude/skills/',
    agentsPath: '.claude/agents/',
    agentFile: 'CLAUDE.md',
    agentFileFallback: 'AGENTS.md',
    hooksPath: '.claude/hooks/',
  },
  copilot: {
    skillsPath: '.copilot/skills/',
    agentsPath: '.copilot/agents/',
    hooksPath: '.copilot/hooks/',
    agentFile: 'AGENTS.md',
    githubPath: '.copilot/',
  },
  codex: {
    skillsPath: '.codex/skills/',
    agentFile: 'AGENTS.md',
  },
  cursor: {
    skillsPath: '.cursor/skills/',
    agentFile: 'AGENTS.md',
  },
  opencode: {
    commandsPath: '.opencode/commands/',
    skillsPath: '.opencode/skills/',
    agentFile: 'AGENTS.md',
  },
  gemini: {
    skillsPath: '.gemini/skills/',
    agentFile: 'GEMINI.md',
    agentFileFallback: 'AGENTS.md',
  },
  factory: {
    skillsPath: '.factory/skills/',
    agentFile: 'AGENTS.md',
    hooksPath: '.factory/hooks/',
  },
  ampcode: {
    skillsPath: '.ampcode/skills/',
    agentFile: 'AGENTS.md',
  },
  vscode: {
    skillsPath: '.agents/skills/',
    agentFile: 'AGENTS.md',
  },
    openclaw: {
    skillsPath: 'skills/',
    agentFile: 'AGENTS.md',
  },
  windsurf: {
    skillsPath: '.codeium/windsurf/skills/',
    agentFile: 'AGENTS.md',
  },
  cline: {
    skillsPath: '.cline/skills/',
    agentFile: 'AGENTS.md',
  },
  continue: {
    skillsPath: '.continue/skills/',
    agentFile: 'AGENTS.md',
  },
  roo: {
    skillsPath: '.roo/skills/',
    agentFile: 'AGENTS.md',
  },
  kilo: {
    skillsPath: '.kilocode/skills/',
    agentFile: 'AGENTS.md',
  },
  trae: {
    skillsPath: '.trae/skills/',
    agentFile: 'AGENTS.md',
  },
  augment: {
    skillsPath: '.augment/skills/',
    agentFile: 'AGENTS.md',
  },
  zencoder: {
    skillsPath: '.zencoder/skills/',
    agentFile: 'AGENTS.md',
  },
  junie: {
    skillsPath: '.junie/skills/',
    agentFile: 'AGENTS.md',
  },
  openhands: {
    skillsPath: '.openhands/skills/',
    agentFile: 'AGENTS.md',
  },
  kiro: {
    skillsPath: '.kiro/skills/',
    agentFile: 'AGENTS.md',
  },
  replit: {
    skillsPath: '.replit/skills/',
    agentFile: 'AGENTS.md',
  },
  kimi: {
    skillsPath: '.kimi/skills/',
    agentFile: 'AGENTS.md',
  },
  universal: {
    skillsPath: '.agents/skills/',
    agentFile: 'AGENTS.md',
  },
};

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
