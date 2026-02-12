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
 * Repository type for generating workspace rules
 * Re-export from workspace-config for consistency with exactOptionalPropertyTypes
 */
export type { Repository as WorkspaceRepository } from './models/workspace-config.js';
import type { Repository } from './models/workspace-config.js';

/**
 * Generate WORKSPACE-RULES content with embedded repository paths
 * This eliminates the indirection of requiring agents to read workspace.yaml
 * @param repositories - List of repositories with paths and optional descriptions
 */
export function generateWorkspaceRules(repositories: Repository[]): string {
  const repoList = repositories
    .map((r) => `- ${r.path}${r.description ? ` - ${r.description}` : ''}`)
    .join('\n');

  return `
<!-- WORKSPACE-RULES:START -->
## Workspace Repositories
The following repositories are part of this workspace:
${repoList}

## Rule: Use Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use the repository paths listed above, not assumptions
<!-- WORKSPACE-RULES:END -->
`;
}

