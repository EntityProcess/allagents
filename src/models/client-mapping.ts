import type { ClientType } from './workspace-config.js';

/**
 * Client-specific path and file configuration
 */
export interface ClientMapping {
  commandsPath: string;
  commandsExt: string;
  skillsPath: string;
  agentsPath?: string;
  agentFile: string;
  agentFileFallback?: string;
  hooksPath?: string;
}

/**
 * Client path mappings for all supported AI clients
 */
export const CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = {
  claude: {
    commandsPath: '.claude/commands/',
    commandsExt: '.md',
    skillsPath: '.claude/skills/',
    agentsPath: '.claude/agents/',
    agentFile: 'CLAUDE.md',
    agentFileFallback: 'AGENTS.md',
    hooksPath: '.claude/hooks/',
  },
  copilot: {
    commandsPath: '.github/prompts/',
    commandsExt: '.prompt.md',
    skillsPath: '.github/skills/',
    agentFile: 'AGENTS.md',
  },
  codex: {
    commandsPath: '.codex/prompts/',
    commandsExt: '.md',
    skillsPath: '.codex/skills/',
    agentFile: 'AGENTS.md',
  },
  cursor: {
    commandsPath: '.cursor/commands/',
    commandsExt: '.md',
    skillsPath: '.cursor/skills/',
    agentFile: 'AGENTS.md',
  },
  opencode: {
    commandsPath: '.opencode/commands/',
    commandsExt: '.md',
    skillsPath: '.opencode/skills/',
    agentFile: 'AGENTS.md',
  },
  gemini: {
    commandsPath: '.gemini/commands/',
    commandsExt: '.md',
    skillsPath: '.gemini/skills/',
    agentFile: 'GEMINI.md',
    agentFileFallback: 'AGENTS.md',
  },
  factory: {
    commandsPath: '.factory/commands/',
    commandsExt: '.md',
    skillsPath: '.factory/skills/',
    agentFile: 'AGENTS.md',
    hooksPath: '.factory/hooks/',
  },
  ampcode: {
    commandsPath: '',
    commandsExt: '.md',
    skillsPath: '',
    agentFile: 'AGENTS.md',
  },
};
