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
 * Only the 'universal' client uses .agents/skills/.
 * All other clients use provider-specific directories.
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
    skillsPath: '.github/skills/',
    agentFile: 'AGENTS.md',
    githubPath: '.github/',
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
    skillsPath: '.copilot/skills/',
    agentFile: 'AGENTS.md',
    githubPath: '.copilot/',
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
