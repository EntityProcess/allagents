import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { resolveGlobPatterns, isGlobPattern } from '../utils/glob-patterns.js';
import { CLIENT_MAPPINGS, isUniversalClient } from '../models/client-mapping.js';
import type { ClientMapping } from '../models/client-mapping.js';
import type { ClientType, WorkspaceFile, SyncMode } from '../models/workspace-config.js';
import { validateSkill } from '../validators/skill.js';
import { generateWorkspaceRules, type WorkspaceRepository } from '../constants.js';
import { parseFileSource } from '../utils/plugin-path.js';
import { createSymlink } from '../utils/symlink.js';
import { adjustLinksInContent } from '../utils/link-adjuster.js';

/**
 * Agent instruction files that receive WORKSPACE-RULES injection
 */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Ensure WORKSPACE-RULES exist in a file (creates file if needed)
 * - If file doesn't exist: creates it with just the rules
 * - If file exists without markers: appends rules
 * - If file exists with markers: replaces content between markers (idempotent)
 * @param filePath - Path to the agent file (CLAUDE.md or AGENTS.md)
 * @param repositories - Array of repositories to include in the rules (paths embedded directly)
 */
export async function ensureWorkspaceRules(filePath: string, repositories: WorkspaceRepository[]): Promise<void> {
  const rulesContent = generateWorkspaceRules(repositories);
  const startMarker = '<!-- WORKSPACE-RULES:START -->';
  const endMarker = '<!-- WORKSPACE-RULES:END -->';

  if (!existsSync(filePath)) {
    // Create new file with just the rules
    await writeFile(filePath, `${rulesContent.trim()}\n`, 'utf-8');
    return;
  }

  const content = await readFile(filePath, 'utf-8');
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Markers exist - replace content between them (including markers)
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    await writeFile(filePath, before + rulesContent.trim() + after, 'utf-8');
  } else {
    // No markers - append
    await writeFile(filePath, content + rulesContent, 'utf-8');
  }
}

/**
 * Result of a file copy operation
 */
export interface CopyResult {
  source: string;
  destination: string;
  action: 'copied' | 'skipped' | 'failed' | 'generated';
  error?: string;
}

/**
 * Options for copy operations
 */
export interface CopyOptions {
  /** Simulate copy without making changes */
  dryRun?: boolean;
  /** Override client path mappings (defaults to CLIENT_MAPPINGS) */
  clientMappings?: Record<string, ClientMapping>;
}

/**
 * Options for skill copy operations
 */
export interface SkillCopyOptions extends CopyOptions {
  /**
   * Map of skill folder name to resolved name.
   * When provided, skills will be copied using the resolved name instead of folder name.
   * Key format: "folderName" (just the skill folder name)
   * Value: resolved name to use for the destination
   */
  skillNameMap?: Map<string, string>;
  /**
   * Sync mode for skills.
   * - 'symlink': Create symlinks from client paths to canonical location
   * - 'copy': Copy files directly (default for backward compatibility)
   */
  syncMode?: SyncMode;
  /**
   * Path to canonical skills location (e.g., '.agents/skills/').
   * Required when syncMode is 'symlink' and client is non-universal.
   */
  canonicalSkillsPath?: string;
}

/**
 * Options for workspace file copy operations
 */
export interface WorkspaceCopyOptions extends CopyOptions {
  /**
   * Map of GitHub repo keys (owner/repo) to their cache paths.
   * Required for resolving GitHub file sources.
   */
  githubCache?: Map<string, string>;
  /**
   * Repositories to embed in WORKSPACE-RULES.
   * When provided, rules include actual repository paths directly.
   * When empty/absent, WORKSPACE-RULES injection is skipped.
   */
  repositories?: WorkspaceRepository[];
}

/**
 * Get the client mapping, using override if provided, otherwise falling back to CLIENT_MAPPINGS
 */
function getMapping(client: ClientType, options?: { clientMappings?: Record<string, ClientMapping> }): ClientMapping {
  return (options?.clientMappings as Record<ClientType, ClientMapping>)?.[client] ?? CLIENT_MAPPINGS[client];
}

/**
 * Copy commands from plugin to workspace for a specific client
 * Commands are copied to clients that support commandsPath
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyCommands(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support commands (only Claude has commandsPath)
  if (!mapping.commandsPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'commands');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = join(workspacePath, mapping.commandsPath);
  if (!dryRun) {
    await mkdir(destDir, { recursive: true });
  }

  const files = await readdir(sourceDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  // Process files in parallel for better performance
  const copyPromises = mdFiles.map(async (file): Promise<CopyResult> => {
    const sourcePath = join(sourceDir, file);
    const destPath = join(destDir, file);

    if (dryRun) {
      return { source: sourcePath, destination: destPath, action: 'copied' };
    }

    try {
      const content = await readFile(sourcePath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      return { source: sourcePath, destination: destPath, action: 'copied' };
    } catch (error) {
      return {
        source: sourcePath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  return Promise.all(copyPromises);
}

/**
 * Copy skills from plugin to workspace for a specific client.
 * Validates each skill before copying.
 *
 * When syncMode is 'symlink' and client is non-universal:
 * - Skills should already be copied to canonical location
 * - Creates symlinks from client path to canonical location
 * - Falls back to copy if symlink creation fails
 *
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun, skillNameMap, syncMode, canonicalSkillsPath)
 * @returns Array of copy results
 */
export async function copySkills(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: SkillCopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false, skillNameMap, syncMode = 'copy', canonicalSkillsPath } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support skills
  if (!mapping.skillsPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'skills');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = join(workspacePath, mapping.skillsPath);
  if (!dryRun) {
    await mkdir(destDir, { recursive: true });
  }

  const entries = await readdir(sourceDir, { withFileTypes: true });
  let skillDirs = entries.filter((e) => e.isDirectory());

  // When skillNameMap is provided, only copy skills that are in the map
  // (disabled skills are excluded from the map during collection)
  if (skillNameMap) {
    skillDirs = skillDirs.filter((e) => skillNameMap.has(e.name));
  }

  // Determine if we should use symlinks for this client
  const useSymlinks = syncMode === 'symlink' && !isUniversalClient(client) && canonicalSkillsPath;

  // Process skill directories in parallel for better performance
  const copyPromises = skillDirs.map(async (entry): Promise<CopyResult> => {
    const skillSourcePath = join(sourceDir, entry.name);
    // Use resolved name from skillNameMap if available, otherwise use folder name
    const resolvedName = skillNameMap?.get(entry.name) ?? entry.name;
    const skillDestPath = join(destDir, resolvedName);

    // Validate skill before copying
    const validation = await validateSkill(skillSourcePath);
    if (!validation.valid) {
      return {
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'failed',
        ...(validation.error && { error: validation.error }),
      };
    }

    if (dryRun) {
      return {
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'copied',
      };
    }

    // If using symlinks, create symlink from client path to canonical location
    if (useSymlinks) {
      const canonicalSkillPath = join(workspacePath, canonicalSkillsPath, resolvedName);
      const symlinkCreated = await createSymlink(canonicalSkillPath, skillDestPath);

      if (symlinkCreated) {
        return {
          source: canonicalSkillPath,
          destination: skillDestPath,
          action: 'copied', // Report as copied for consistency
        };
      }
      // Symlink failed, fall back to copy
      // Log warning? For now, just fall through to copy
    }

    try {
      await cp(skillSourcePath, skillDestPath, { recursive: true });
      return {
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'copied',
      };
    } catch (error) {
      return {
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  return Promise.all(copyPromises);
}

/**
 * Information about a skill collected from a plugin
 */
export interface CollectedSkill {
  /** Skill folder name */
  folderName: string;
  /** Path to the skill directory */
  skillPath: string;
  /** Plugin path this skill belongs to */
  pluginPath: string;
  /** Plugin source (original reference, e.g., GitHub URL or local path) */
  pluginSource: string;
}

/**
 * Collect skill information from a plugin without copying
 * Used for the first pass of two-pass name resolution
 * @param pluginPath - Resolved path to plugin directory
 * @param pluginSource - Original plugin source reference
 * @param disabledSkills - Optional set of disabled skill keys (plugin:skill format)
 * @param pluginName - Optional plugin name for building skill keys
 * @returns Array of collected skill information
 */
export async function collectPluginSkills(
  pluginPath: string,
  pluginSource: string,
  disabledSkills?: Set<string>,
  pluginName?: string,
): Promise<CollectedSkill[]> {
  const skillsDir = join(pluginPath, 'skills');

  if (!existsSync(skillsDir)) {
    return [];
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  // Filter out disabled skills if disabledSkills set is provided
  const filteredDirs = disabledSkills && pluginName
    ? skillDirs.filter((e) => !disabledSkills.has(`${pluginName}:${e.name}`))
    : skillDirs;

  return filteredDirs.map((entry) => ({
    folderName: entry.name,
    skillPath: join(skillsDir, entry.name),
    pluginPath,
    pluginSource,
  }));
}

/**
 * Copy hooks from plugin to workspace for a specific client
 * Only copies if client supports hooks
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyHooks(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support hooks
  if (!mapping.hooksPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'hooks');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = join(workspacePath, mapping.hooksPath);

  if (dryRun) {
    results.push({ source: sourceDir, destination: destDir, action: 'copied' });
    return results;
  }

  await mkdir(destDir, { recursive: true });

  try {
    await cp(sourceDir, destDir, { recursive: true });
    results.push({ source: sourceDir, destination: destDir, action: 'copied' });
  } catch (error) {
    results.push({
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return results;
}

/**
 * Copy agents from plugin to workspace for a specific client
 * Agents are subagent definitions (.md files) that can be spawned via Task tool
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyAgents(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support agents
  if (!mapping.agentsPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'agents');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = join(workspacePath, mapping.agentsPath);
  if (!dryRun) {
    await mkdir(destDir, { recursive: true });
  }

  const files = await readdir(sourceDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  // Process files in parallel for better performance
  const copyPromises = mdFiles.map(async (file): Promise<CopyResult> => {
    const sourcePath = join(sourceDir, file);
    const destPath = join(destDir, file);

    if (dryRun) {
      return { source: sourcePath, destination: destPath, action: 'copied' };
    }

    try {
      const content = await readFile(sourcePath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      return { source: sourcePath, destination: destPath, action: 'copied' };
    } catch (error) {
      return {
        source: sourcePath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  return Promise.all(copyPromises);
}

/**
 * Options for copying GitHub content
 */
export interface GitHubCopyOptions extends CopyOptions {
  /**
   * Map of skill folder name to resolved name.
   * Used when skills are renamed due to conflicts, so links can be adjusted accordingly.
   */
  skillNameMap?: Map<string, string>;
}

/**
 * Recursively process a directory, copying files and adjusting links in markdown.
 * Single-pass approach: read source → transform if markdown → write to dest.
 */
async function copyAndAdjustDirectory(
  sourceDir: string,
  destDir: string,
  sourceBase: string,
  skillsPath: string,
  skillNameMap?: Map<string, string>,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      await copyAndAdjustDirectory(sourcePath, destPath, sourceBase, skillsPath, skillNameMap);
    } else {
      const relativePath = relative(sourceBase, sourcePath).replaceAll('\\', '/');
      const isMarkdown = entry.name.endsWith('.md') || entry.name.endsWith('.markdown');

      if (isMarkdown) {
        // Read, transform, write in one pass
        let content = await readFile(sourcePath, 'utf-8');
        content = adjustLinksInContent(content, relativePath, {
          ...(skillNameMap && { skillNameMap }),
          workspaceSkillsPath: skillsPath,
        });
        await writeFile(destPath, content, 'utf-8');
      } else {
        // Copy non-markdown files directly
        await cp(sourcePath, destPath);
      }
    }
  }
}

/**
 * Copy GitHub-specific content from plugin to workspace
 * This includes prompts (.github/prompts/), copilot-instructions.md, and other GitHub Copilot files.
 * Adjusts relative links in markdown files to point to correct workspace locations.
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun, skillNameMap)
 * @returns Array of copy results
 */
export async function copyGitHubContent(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: GitHubCopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false, skillNameMap } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support GitHub content
  if (!mapping.githubPath) {
    return results;
  }

  const sourceDir = join(pluginPath, '.github');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = join(workspacePath, mapping.githubPath);

  if (dryRun) {
    results.push({ source: sourceDir, destination: destDir, action: 'copied' });
    return results;
  }

  try {
    // Single-pass: copy files and adjust markdown links in one traversal
    if (mapping.skillsPath) {
      await copyAndAdjustDirectory(sourceDir, destDir, sourceDir, mapping.skillsPath, skillNameMap);
    } else {
      // No skills path - just copy without adjustment
      await cp(sourceDir, destDir, { recursive: true });
    }
    results.push({ source: sourceDir, destination: destDir, action: 'copied' });
  } catch (error) {
    results.push({
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return results;
}

/**
 * Options for copying a plugin to workspace
 */
export interface PluginCopyOptions extends CopyOptions {
  /**
   * Map of skill folder name to resolved name for this specific plugin.
   * When provided, skills will be copied using the resolved name instead of folder name.
   */
  skillNameMap?: Map<string, string>;
  /**
   * Sync mode for skills.
   * - 'symlink': Create symlinks from client paths to canonical location
   * - 'copy': Copy files directly (default for backward compatibility)
   */
  syncMode?: SyncMode;
  /**
   * Path to canonical skills location (e.g., '.agents/skills/').
   * Required when syncMode is 'symlink' and client is non-universal.
   */
  canonicalSkillsPath?: string;
}

/**
 * Copy all plugin content to workspace for a specific client
 * Plugins provide: commands, skills, hooks, agents, and GitHub-specific content
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun, skillNameMap, syncMode, canonicalSkillsPath)
 * @returns All copy results
 */
export async function copyPluginToWorkspace(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: PluginCopyOptions = {},
): Promise<CopyResult[]> {
  const { skillNameMap, syncMode, canonicalSkillsPath, ...baseOptions } = options;

  // Run copy operations in parallel for better performance
  const [commandResults, skillResults, hookResults, agentResults, githubResults] = await Promise.all([
    copyCommands(pluginPath, workspacePath, client, baseOptions),
    copySkills(pluginPath, workspacePath, client, {
      ...baseOptions,
      ...(skillNameMap && { skillNameMap }),
      ...(syncMode && { syncMode }),
      ...(canonicalSkillsPath && { canonicalSkillsPath }),
    }),
    copyHooks(pluginPath, workspacePath, client, baseOptions),
    copyAgents(pluginPath, workspacePath, client, baseOptions),
    copyGitHubContent(pluginPath, workspacePath, client, {
      ...baseOptions,
      ...(skillNameMap && { skillNameMap }),
    }),
  ]);

  return [...commandResults, ...skillResults, ...hookResults, ...agentResults, ...githubResults];
}

/**
 * Check if a source string is an explicit GitHub reference
 *
 * More conservative than isGitHubUrl - only returns true for explicit GitHub formats:
 * - https://github.com/...
 * - github.com/...
 * - gh:owner/repo/...
 * - owner/repo/path/to/file (must have at least 3 path segments for file sources)
 *
 * This prevents ambiguous paths like "config/settings.json" from being treated as GitHub URLs.
 */
function isExplicitGitHubSource(source: string): boolean {
  // Explicit URL patterns
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format (owner/repo/path), require at least 3 segments
  // This ensures paths like "config/settings.json" are treated as local
  if (!source.startsWith('.') && !source.startsWith('/') && source.includes('/')) {
    const parts = source.split('/');
    // Need owner, repo, AND at least one path segment for file sources
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (parts[0] && parts[1] && validOwnerRepo.test(parts[0]) && validOwnerRepo.test(parts[1])) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve a file source to an absolute path
 *
 * For local paths:
 * - Absolute paths are used as-is
 * - Relative paths are resolved relative to defaultSourcePath
 *
 * For GitHub paths:
 * - Resolved from the githubCache using owner/repo as key
 *
 * @param source - The source string (local path or GitHub URL)
 * @param defaultSourcePath - Default source directory for resolving relative local paths
 * @param githubCache - Map of owner/repo to cache paths for GitHub sources
 * @returns Resolved absolute path or null if cannot resolve
 */
function resolveFileSourcePath(
  source: string,
  defaultSourcePath: string | undefined,
  githubCache: Map<string, string> | undefined,
): { path: string; error?: string } | null {
  // First, check if this is an explicit GitHub source
  // This prevents paths like "config/settings.json" from being treated as GitHub URLs
  if (!isExplicitGitHubSource(source)) {
    // Treat as local path
    if (source.startsWith('/')) {
      // Absolute path
      return { path: source };
    }
    if (source.startsWith('../')) {
      // Relative path going "up" - resolve from workspace root (cwd)
      return { path: join(process.cwd(), source) };
    }
    // Relative path within source - resolve from defaultSourcePath
    if (defaultSourcePath) {
      return { path: join(defaultSourcePath, source) };
    }
    // No defaultSourcePath - resolve from cwd
    return { path: join(process.cwd(), source) };
  }

  // Parse as GitHub source
  const parsed = parseFileSource(source);

  // GitHub source - need to resolve from cache
  if (parsed.type === 'github' && parsed.owner && parsed.repo && parsed.filePath) {
    const cacheKey = `${parsed.owner}/${parsed.repo}`;
    const cachePath = githubCache?.get(cacheKey);

    if (!cachePath) {
      return {
        path: '',
        error: `GitHub cache not found for ${cacheKey}. Ensure the repo is fetched.`,
      };
    }

    return { path: join(cachePath, parsed.filePath) };
  }

  // GitHub source without file path - invalid for file sources
  if (parsed.type === 'github') {
    return {
      path: '',
      error: `Invalid GitHub file source: ${source}. Must include path to file (e.g., owner/repo/path/to/file.md)`,
    };
  }

  return null;
}

/**
 * Copy workspace files from source to workspace root
 * Supports glob patterns with gitignore-style negation for string entries.
 * Object entries ({source, dest}) are copied directly without pattern expansion.
 *
 * File source resolution:
 * - String entries: resolved relative to sourcePath (supports globs)
 * - Object entries with explicit source: resolved directly (local path or GitHub URL)
 * - Object entries without source: dest is used as path relative to sourcePath
 *
 * @param sourcePath - Path to source directory (resolved workspace.source), can be undefined if all files have explicit source
 * @param workspacePath - Path to workspace directory
 * @param files - Array of workspace file entries (strings support globs, objects are literal)
 * @param options - Copy options (dryRun, githubCache)
 * @returns Array of copy results
 */
export async function copyWorkspaceFiles(
  sourcePath: string | undefined,
  workspacePath: string,
  files: WorkspaceFile[],
  options: WorkspaceCopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false, githubCache, repositories = [] } = options;
  const results: CopyResult[] = [];

  // Separate string patterns from object entries
  const stringPatterns: string[] = [];
  const objectEntries: Array<{ source?: string; dest: string }> = [];

  // Track which agent files were copied for WORKSPACE-RULES injection
  const copiedAgentFiles: string[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      stringPatterns.push(file);
    } else {
      // Compute dest from source basename if not provided
      let dest = file.dest;
      if (!dest && file.source) {
        // Extract basename from source (handles both local paths and GitHub paths)
        const parts = file.source.split('/');
        dest = parts[parts.length - 1] || file.source;
      }
      if (!dest) {
        // Neither source nor dest provided - this is invalid
        results.push({
          source: 'unknown',
          destination: join(workspacePath, 'unknown'),
          action: 'failed',
          error: 'File entry must have at least source or dest specified',
        });
        continue;
      }
      objectEntries.push(file.source ? { source: file.source, dest } : { dest });
    }
  }

  // Process string patterns through glob resolution (requires sourcePath)
  if (stringPatterns.length > 0) {
    if (!sourcePath) {
      // String patterns require a source path
      for (const pattern of stringPatterns) {
        if (!isGlobPattern(pattern) && !pattern.startsWith('!')) {
          results.push({
            source: pattern,
            destination: join(workspacePath, pattern),
            action: 'failed',
            error: `Cannot resolve file '${pattern}' - no workspace.source configured and no explicit source provided`,
          });
        }
      }
    } else {
      const resolvedFiles = await resolveGlobPatterns(sourcePath, stringPatterns);
      for (const resolved of resolvedFiles) {
        const destPath = join(workspacePath, resolved.relativePath);

        if (!existsSync(resolved.sourcePath)) {
          // Only report error for literal (non-glob) patterns
          const wasLiteral = stringPatterns.some(
            (p) => !isGlobPattern(p) && !p.startsWith('!') && p === resolved.relativePath,
          );
          if (wasLiteral) {
            results.push({
              source: resolved.sourcePath,
              destination: destPath,
              action: 'failed',
              error: `Source file not found: ${resolved.sourcePath}`,
            });
          }
          continue;
        }

        if (dryRun) {
          results.push({ source: resolved.sourcePath, destination: destPath, action: 'copied' });
          // Track agent files even in dry-run for accurate reporting
          if ((AGENT_FILES as readonly string[]).includes(resolved.relativePath)) {
            copiedAgentFiles.push(resolved.relativePath);
          }
          continue;
        }

        try {
          await mkdir(dirname(destPath), { recursive: true });
          const content = await readFile(resolved.sourcePath, 'utf-8');
          await writeFile(destPath, content, 'utf-8');
          results.push({ source: resolved.sourcePath, destination: destPath, action: 'copied' });

          // Track if this is an agent file
          if ((AGENT_FILES as readonly string[]).includes(resolved.relativePath)) {
            copiedAgentFiles.push(resolved.relativePath);
          }
        } catch (error) {
          results.push({
            source: resolved.sourcePath,
            destination: destPath,
            action: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  // Process object entries directly (no pattern support)
  for (const entry of objectEntries) {
    const destPath = join(workspacePath, entry.dest);
    let srcPath: string;

    if (entry.source) {
      // Has explicit source - resolve it (can be local or GitHub)
      const resolved = resolveFileSourcePath(entry.source, sourcePath, githubCache);
      if (!resolved) {
        results.push({
          source: entry.source,
          destination: destPath,
          action: 'failed',
          error: `Failed to resolve source: ${entry.source}`,
        });
        continue;
      }
      if (resolved.error) {
        results.push({
          source: entry.source,
          destination: destPath,
          action: 'failed',
          error: resolved.error,
        });
        continue;
      }
      srcPath = resolved.path;
    } else {
      // No explicit source - use dest as path relative to sourcePath
      if (!sourcePath) {
        results.push({
          source: entry.dest,
          destination: destPath,
          action: 'failed',
          error: `Cannot resolve file '${entry.dest}' - no workspace.source configured and no explicit source provided`,
        });
        continue;
      }
      srcPath = join(sourcePath, entry.dest);
    }

    if (!existsSync(srcPath)) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: `Source file not found: ${srcPath}`,
      });
      continue;
    }

    if (dryRun) {
      results.push({ source: srcPath, destination: destPath, action: 'copied' });
      // Track agent files even in dry-run for accurate reporting
      if ((AGENT_FILES as readonly string[]).includes(entry.dest)) {
        copiedAgentFiles.push(entry.dest);
      }
      continue;
    }

    try {
      await mkdir(dirname(destPath), { recursive: true });
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      results.push({ source: srcPath, destination: destPath, action: 'copied' });

      // Track if this is an agent file
      if ((AGENT_FILES as readonly string[]).includes(entry.dest)) {
        copiedAgentFiles.push(entry.dest);
      }
    } catch (error) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Inject WORKSPACE-RULES into all copied agent files (idempotent)
  // Skip when repositories is empty — rules reference repository paths that don't exist
  if (!dryRun && repositories.length > 0) {
    for (const agentFile of copiedAgentFiles) {
      const targetPath = join(workspacePath, agentFile);
      try {
        await ensureWorkspaceRules(targetPath, repositories);
      } catch (error) {
        results.push({
          source: 'WORKSPACE-RULES',
          destination: targetPath,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Failed to inject WORKSPACE-RULES',
        });
      }
    }
  }

  return results;
}
