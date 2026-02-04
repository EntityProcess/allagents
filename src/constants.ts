/**
 * Get the user's home directory (cross-platform).
 */
export function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '~';
}

/**
 * Configuration directory name
 */
export const CONFIG_DIR = '.allagents';

/**
 * Sync state filename (tracks which files were synced)
 */
export const SYNC_STATE_FILE = 'sync-state.json';

/**
 * Workspace config filename
 */
export const WORKSPACE_CONFIG_FILE = 'workspace.yaml';

/**
 * Path to workspace config relative to workspace root
 */
export const WORKSPACE_CONFIG_PATH = `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`;

/**
 * Agent instruction files that are auto-copied from templates
 * AGENTS.md is preferred for WORKSPACE-RULES injection, CLAUDE.md is fallback
 */
export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Static WORKSPACE-RULES content to append to agent files (CLAUDE.md/AGENTS.md)
 * These rules tell AI to read workspace.yaml for actual repo info
 */
export const WORKSPACE_RULES = `
<!-- WORKSPACE-RULES:START -->
## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read \`.allagents/workspace.yaml\` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from \`.allagents/workspace.yaml\`, not assumptions
<!-- WORKSPACE-RULES:END -->
`;
