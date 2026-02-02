import type { ClientType } from './workspace-config.js';

/**
 * Client-specific path and file configuration
 */
export interface ClientMapping {
  /** Path for commands (Claude-specific feature) */
  commandsPath?: string;
  skillsPath: string;
  agentsPath?: string;
  agentFile: string;
  agentFileFallback?: string;
  hooksPath?: string;
}

/**
 * Client path mappings for all supported AI clients
 */
/**
 * Project-level client path mappings for all supported AI clients.
 * Paths are relative to the project root directory.
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
    skillsPath: '',
    agentFile: 'AGENTS.md',
  },
};

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
    skillsPath: '.config/opencode/skills/',
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
    skillsPath: '.config/amp/skills/',
    agentFile: 'AGENTS.md',
  },
};
