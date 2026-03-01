import { resolve, relative, basename, isAbsolute } from 'node:path';
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
 * Resolves repository paths relative to workspacePath, producing clean relative paths
 * (with `..` segments normalized). This keeps .code-workspace files portable.
 *
 * @param repositories - Repository list from workspace.yaml
 * @param workspacePath - Workspace root for resolving relative paths
 * @returns Map of original paths to normalized relative paths
 *
 * @example
 * // Given: { path: "../Glow" } and workspacePath: "/home/user/workspace"
 * // Result: Map { "../Glow" => "../Glow" }
 */
export function buildPathPlaceholderMap(
  repositories: Repository[],
  workspacePath: string,
): PathPlaceholderMap {
  const map = new Map<string, string>();

  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path);
    const relativePath = relative(workspacePath, absolutePath);
    map.set(repo.path, relativePath);
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
 * "{path:../Glow}/src" → "../Glow/src"
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
  // Track absolute path for deduplication (normalized for cross-platform)
  seenPaths.add(resolve(workspacePath, '.').replace(/\\/g, '/'));

  // 1. Repository folders (from workspace.yaml)
  // Use relative paths so the .code-workspace file stays portable when the workspace moves.
  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path);
    const relPath = relative(workspacePath, absolutePath).replace(/\\/g, '/');
    folders.push({ path: relPath });
    seenPaths.add(absolutePath.replace(/\\/g, '/'));
  }

  // 2. Template folders (deduplicated against repo folders, preserve optional name)
  if (resolvedTemplate && Array.isArray(resolvedTemplate.folders)) {
    for (const folder of resolvedTemplate.folders as WorkspaceFolder[]) {
      const rawPath = folder.path as string;
      // Resolve to absolute for deduplication only
      const absoluteForDedup = (typeof rawPath === 'string' && !isAbsolute(rawPath)
        ? resolve(workspacePath, rawPath)
        : rawPath).replace(/\\/g, '/');
      if (!seenPaths.has(absoluteForDedup)) {
        // Keep the path as-is (just normalize backslashes)
        const normalizedPath = rawPath.replace(/\\/g, '/');
        const entry: WorkspaceFolder = { path: normalizedPath };
        if (folder.name) entry.name = folder.name;
        folders.push(entry);
        seenPaths.add(absoluteForDedup);
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
