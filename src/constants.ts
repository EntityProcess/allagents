import { homedir } from 'node:os';

/**
 * Get the user's home directory (cross-platform).
 *
 * Delegates to Node's os.homedir() rather than reading process.env.HOME
 * directly: on Windows, os.homedir() ignores HOME and resolves via
 * USERPROFILE, so it isn't affected by shells (e.g. Git Bash/MSYS) that
 * mistranslate a misconfigured HOME into a bare drive root like "C:\\"
 * (see EntityProcess/allagents#433).
 */
export function getHomeDir(): string {
  // Bun caches os.homedir() for the process, so tests cannot isolate user state
  // by mutating HOME/USERPROFILE. This deliberately named override belongs to
  // AllAgents tests; production continues to use the Windows-safe os.homedir().
  return process.env.ALLAGENTS_TEST_HOME || homedir();
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

export interface SkillsIndexRef {
  repoName: string;
  indexPath: string;
}

/**
 * Generate WORKSPACE-RULES content with embedded repository paths and optional skills-index links
 * This eliminates the indirection of requiring agents to read workspace.yaml
 * @param repositories - List of repositories with paths and optional descriptions
 * @param skillsIndexRefs - References to per-repo skills-index files
 */
export function generateWorkspaceRules(
  repositories: Repository[],
  skillsIndexRefs: SkillsIndexRef[] = [],
): string {
  const repoList = repositories
    .map((r) => `- ${r.path}${r.description ? ` - ${r.description}` : ''}`)
    .join('\n');

  let skillsBlock = '';
  if (skillsIndexRefs.length > 0) {
    const refLines = skillsIndexRefs
      .map((r) => `- ${r.repoName}: ${r.indexPath}`)
      .join('\n');

    skillsBlock = `
## Repository Skills
If the skills from the following repositories are not already available in your context, read the corresponding index file:
${refLines}
`;
  }

  return `
<!-- WORKSPACE-RULES:START -->
## Workspace Repositories
The following repositories are part of this workspace:
${repoList}

## Rule: Use Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use the repository paths listed above, not assumptions
${skillsBlock}<!-- WORKSPACE-RULES:END -->
`;
}

