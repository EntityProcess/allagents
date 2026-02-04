import { resolve, basename } from 'node:path';
import type { Repository, VscodeConfig } from '../models/workspace-config.js';

/**
 * Input for generating a VSCode workspace
 */
export interface GenerateVscodeWorkspaceInput {
  workspacePath: string;
  repositories: Repository[];
  template: Record<string, unknown> | undefined;
}

/**
 * Folder entry in a .code-workspace file
 */
interface WorkspaceFolder {
  path: string;
  name?: string;
}

/**
 * Default VSCode settings when no template is provided
 */
const DEFAULT_SETTINGS: Record<string, unknown> = {
  'chat.agent.maxRequests': 999,
};

/**
 * Recursively substitute {repo:../path} placeholders in all string values
 */
export function substituteRepoPlaceholders<T>(
  obj: T,
  repoMap: Map<string, string>,
): T {
  if (typeof obj === 'string') {
    return obj.replace(/\{repo:([^}]+)\}/g, (_match, repoPath: string) => {
      return repoMap.get(repoPath) ?? `{repo:${repoPath}}`;
    }) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => substituteRepoPlaceholders(item, repoMap)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteRepoPlaceholders(value, repoMap);
    }
    return result as T;
  }

  return obj;
}

/**
 * Generate a .code-workspace JSON structure from workspace config and optional template
 */
export function generateVscodeWorkspace(
  input: GenerateVscodeWorkspaceInput,
): Record<string, unknown> {
  const { workspacePath, repositories, template } = input;

  // Build repo path map for placeholder substitution
  const repoMap = new Map<string, string>();
  for (const repo of repositories) {
    repoMap.set(repo.path, resolve(workspacePath, repo.path));
  }

  // Substitute placeholders in template
  const resolvedTemplate = template
    ? substituteRepoPlaceholders(template, repoMap)
    : undefined;

  // Build folders list
  const folders: WorkspaceFolder[] = [];
  const seenPaths = new Set<string>();

  // 0. Current workspace folder
  folders.push({ path: '.' });

  // 1. Repository folders (from workspace.yaml)
  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path);
    folders.push({ path: absolutePath });
    seenPaths.add(absolutePath);
  }

  // 2. Template folders (deduplicated against repo folders, preserve optional name)
  if (resolvedTemplate && Array.isArray(resolvedTemplate.folders)) {
    for (const folder of resolvedTemplate.folders as WorkspaceFolder[]) {
      if (!seenPaths.has(folder.path)) {
        const entry: WorkspaceFolder = { path: folder.path };
        if (folder.name) entry.name = folder.name;
        folders.push(entry);
        seenPaths.add(folder.path);
      }
    }
  }

  // Build settings
  let settings: Record<string, unknown>;
  if (resolvedTemplate?.settings) {
    // Template has full control over settings
    settings = { ...(resolvedTemplate.settings as Record<string, unknown>) };
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  // Build result — folders and settings first, then pass through all other template keys
  const result: Record<string, unknown> = { folders, settings };

  if (resolvedTemplate) {
    for (const [key, value] of Object.entries(resolvedTemplate)) {
      if (key !== 'folders' && key !== 'settings') {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Determine the output filename for the .code-workspace file
 *
 * Priority: vscodeConfig.output > <dirname>.code-workspace
 */
export function getWorkspaceOutputPath(
  workspacePath: string,
  vscodeConfig: VscodeConfig | undefined,
): string {
  const name = vscodeConfig?.output;

  if (name) {
    const filename = name.endsWith('.code-workspace') ? name : `${name}.code-workspace`;
    return resolve(workspacePath, filename);
  }

  // Default: use workspace directory name
  const dirName = basename(resolve(workspacePath));
  return resolve(workspacePath, `${dirName}.code-workspace`);
}
