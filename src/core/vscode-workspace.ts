import { existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { Repository, VscodeConfig } from '../models/workspace-config.js';

/**
 * Resolved plugin info for workspace generation
 */
export interface ResolvedPluginInfo {
  resolvedPath: string;
  displayName: string;
  hasPrompts?: boolean;
  hasInstructions?: boolean;
}

/**
 * Input for generating a VSCode workspace
 */
export interface GenerateVscodeWorkspaceInput {
  workspacePath: string;
  repositories: Repository[];
  plugins: ResolvedPluginInfo[];
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
  const { workspacePath, repositories, plugins, template } = input;

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

  // 3. Plugin folders
  for (const plugin of plugins) {
    const entry: WorkspaceFolder = { path: plugin.resolvedPath };
    folders.push(entry);
  }

  // Build settings
  let settings: Record<string, unknown>;
  if (resolvedTemplate?.settings) {
    // Template has full control over settings
    settings = { ...(resolvedTemplate.settings as Record<string, unknown>) };
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  // Add prompt/instruction file locations from plugins
  const promptLocations: Record<string, boolean> = {};
  const instructionLocations: Record<string, boolean> = {};

  for (const plugin of plugins) {
    if (plugin.hasPrompts) {
      promptLocations[`${plugin.resolvedPath}/prompts/**/*.prompt.md`] = true;
    }
    if (plugin.hasInstructions) {
      instructionLocations[`${plugin.resolvedPath}/instructions/**/*.instructions.md`] = true;
    }
  }

  if (Object.keys(promptLocations).length > 0) {
    settings['chat.promptFilesLocations'] = {
      ...(settings['chat.promptFilesLocations'] as Record<string, boolean> | undefined),
      ...promptLocations,
    };
  }
  if (Object.keys(instructionLocations).length > 0) {
    settings['chat.instructionsFilesLocations'] = {
      ...(settings['chat.instructionsFilesLocations'] as Record<string, boolean> | undefined),
      ...instructionLocations,
    };
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
 * Scan a plugin directory to check if it contains prompts/ and/or instructions/ dirs
 */
export function scanPluginForCopilotDirs(pluginPath: string): {
  hasPrompts: boolean;
  hasInstructions: boolean;
} {
  return {
    hasPrompts: existsSync(join(pluginPath, 'prompts')),
    hasInstructions: existsSync(join(pluginPath, 'instructions')),
  };
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
