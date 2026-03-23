import { createHash } from 'node:crypto';
import { resolve, basename, isAbsolute, relative } from 'node:path';
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
 * Map for path placeholder resolution.
 * Keys are relative paths from workspace.yaml (e.g., "../Glow")
 */
export type PathPlaceholderMap = Map<string, string>;

/**
 * Build a placeholder map from repositories using path as the lookup key.
 *
 * @param repositories - Repository list from workspace.yaml
 * @param workspacePath - Workspace root for resolving relative paths
 * @returns Map of relative paths to absolute paths
 *
 * @example
 * // Given: { path: "../Glow" } and workspacePath: "/home/user/workspace"
 * // Result: Map { "../Glow" => "/home/user/Glow" }
 */
export function buildPathPlaceholderMap(
  repositories: Repository[],
  workspacePath: string,
): PathPlaceholderMap {
  const map = new Map<string, string>();

  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path);
    map.set(repo.path, absolutePath);
  }

  return map;
}

/**
 * Recursively substitute {path:...} placeholders and normalize backslashes to forward slashes.
 *
 * Placeholder format: {path:../Glow} where the value matches a repository path from workspace.yaml
 *
 * @example
 * // Given repositories: [{ path: "../Glow" }]
 * "{path:../Glow}/src" → "/home/user/Glow/src"
 * "D:\\GitHub\\Glow" → "D:/GitHub/Glow"
 */
export function substitutePathPlaceholders<T>(
  obj: T,
  pathMap: PathPlaceholderMap,
): T {
  if (typeof obj === 'string') {
    // First substitute placeholders, then normalize backslashes to forward slashes
    const substituted = obj.replace(/\{path:([^}]+)\}/g, (_match, pathKey: string) => {
      const resolved = pathMap.get(pathKey);
      if (resolved) {
        return resolved;
      }
      // Keep unresolved placeholders for debugging
      return `{path:${pathKey}}`;
    });
    // Normalize all backslashes to forward slashes (cross-platform compatible)
    return substituted.replace(/\\/g, '/') as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => substitutePathPlaceholders(item, pathMap)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substitutePathPlaceholders(value, pathMap);
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

  // Build path placeholder map for substitution
  const pathMap = buildPathPlaceholderMap(repositories, workspacePath);

  // Substitute placeholders in template
  const resolvedTemplate = template
    ? substitutePathPlaceholders(template, pathMap)
    : undefined;

  // Build folders list
  const folders: WorkspaceFolder[] = [];
  const seenPaths = new Set<string>();

  // 0. Current workspace folder
  folders.push({ path: '.' });
  // Track absolute path for deduplication
  seenPaths.add(resolve(workspacePath, '.'));

  // 1. Repository folders (from workspace.yaml)
  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path).replace(/\\/g, '/');
    const entry: WorkspaceFolder = { path: absolutePath };
    if (repo.name) entry.name = repo.name;
    folders.push(entry);
    seenPaths.add(absolutePath);
  }

  // 2. Template folders (deduplicated against repo folders, preserve optional name)
  if (resolvedTemplate && Array.isArray(resolvedTemplate.folders)) {
    for (const folder of resolvedTemplate.folders as WorkspaceFolder[]) {
      const rawPath = folder.path as string;
      const normalizedPath = (typeof rawPath === 'string' && !isAbsolute(rawPath)
        ? resolve(workspacePath, rawPath)
        : rawPath).replace(/\\/g, '/');
      if (!seenPaths.has(normalizedPath)) {
        const entry: WorkspaceFolder = { path: normalizedPath };
        if (folder.name) entry.name = folder.name;
        folders.push(entry);
        seenPaths.add(normalizedPath);
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

/**
 * Compute SHA-256 hash of .code-workspace file content.
 * Used to detect external modifications between syncs.
 */
export function computeWorkspaceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Result of reconciling .code-workspace folders with workspace.yaml repositories.
 */
export interface ReconcileResult {
  /** Updated repositories list after merging changes */
  updatedRepos: Repository[];
  /** Relative paths of repositories added from .code-workspace */
  added: string[];
  /** Relative paths of repositories removed (were in .code-workspace before, now gone) */
  removed: string[];
}

/**
 * 3-way merge of .code-workspace folders and workspace.yaml repositories.
 *
 * Uses lastSyncedRepos as the common ancestor to detect:
 * - Folders removed from .code-workspace → remove from workspace.yaml
 * - Folders added to .code-workspace → add to workspace.yaml
 * - Folders added to workspace.yaml (not in lastSyncedRepos) → keep
 *
 * @param workspacePath - Workspace root directory (for resolving relative paths)
 * @param codeWorkspaceFolders - Folders from the existing .code-workspace file
 * @param lastSyncedRepos - Absolute repo paths from sync state (common ancestor)
 * @param currentRepos - Current repositories from workspace.yaml
 */
export function reconcileVscodeWorkspaceFolders(
  workspacePath: string,
  codeWorkspaceFolders: { path: string; name?: string }[],
  lastSyncedRepos: string[],
  currentRepos: Repository[],
): ReconcileResult {
  const normalizedWorkspacePath = resolve(workspacePath).replace(/\\/g, '/');

  // Build map of absolute paths → names from .code-workspace folders (exclude '.')
  const codeWorkspaceAbsPaths = new Set<string>();
  const codeWorkspaceNames = new Map<string, string>();
  for (const folder of codeWorkspaceFolders) {
    if (folder.path === '.') continue;
    const absPath = (isAbsolute(folder.path)
      ? folder.path
      : resolve(workspacePath, folder.path)
    ).replace(/\\/g, '/');
    codeWorkspaceAbsPaths.add(absPath);
    if (folder.name) codeWorkspaceNames.set(absPath, folder.name);
  }

  // Build set of last-synced absolute paths (common ancestor)
  const lastSyncedSet = new Set(lastSyncedRepos.map(p => p.replace(/\\/g, '/')));

  // Build map of absolute path → Repository for current workspace.yaml repos
  const currentReposByAbsPath = new Map<string, Repository>();
  for (const repo of currentRepos) {
    const absPath = resolve(workspacePath, repo.path).replace(/\\/g, '/');
    currentReposByAbsPath.set(absPath, repo);
  }
  const currentAbsPaths = new Set(currentReposByAbsPath.keys());

  const added: string[] = [];
  const removed: string[] = [];
  const updatedRepos: Repository[] = [];

  // Keep repos still in .code-workspace or newly added to workspace.yaml
  for (const [absPath, repo] of currentReposByAbsPath) {
    const inLastSync = lastSyncedSet.has(absPath);
    const inCodeWorkspace = codeWorkspaceAbsPaths.has(absPath);

    if (inLastSync && !inCodeWorkspace) {
      // Was in last sync, removed from .code-workspace → remove
      removed.push(repo.path);
    } else {
      updatedRepos.push(repo);
    }
  }

  // Find folders added to .code-workspace that aren't in workspace.yaml
  for (const absPath of codeWorkspaceAbsPaths) {
    const inLastSync = lastSyncedSet.has(absPath);
    const inCurrentRepos = currentAbsPaths.has(absPath);

    if (!inLastSync && !inCurrentRepos) {
      // New in .code-workspace, not in workspace.yaml → add
      const relPath = relative(normalizedWorkspacePath, absPath).replace(/\\/g, '/');
      added.push(relPath);
      const newRepo: Repository = { path: relPath };
      const folderName = codeWorkspaceNames.get(absPath);
      if (folderName) newRepo.name = folderName;
      updatedRepos.push(newRepo);
    }
  }

  return { updatedRepos, added, removed };
}
