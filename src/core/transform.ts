import { readFile, writeFile, mkdir, cp, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveGlobPatterns, isGlobPattern } from '../utils/glob-patterns.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import type { ClientType, WorkspaceFile } from '../models/workspace-config.js';
import { validateSkill } from '../validators/skill.js';
import { WORKSPACE_RULES } from '../constants.js';

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
}

/**
 * Copy commands from plugin to workspace for a specific client
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
  const mapping = CLIENT_MAPPINGS[client];
  const results: CopyResult[] = [];

  // Skip if client doesn't support commands
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

    // Transform extension if needed (e.g., .md → .prompt.md for Copilot)
    let destFileName = file;
    if (mapping.commandsExt === '.prompt.md' && !file.endsWith('.prompt.md')) {
      destFileName = file.replace(/\.md$/, '.prompt.md');
    }

    const destPath = join(destDir, destFileName);

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
 * Copy skills from plugin to workspace for a specific client
 * Validates each skill before copying
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copySkills(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = CLIENT_MAPPINGS[client];
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
  const skillDirs = entries.filter((e) => e.isDirectory());

  // Process skill directories in parallel for better performance
  const copyPromises = skillDirs.map(async (entry): Promise<CopyResult> => {
    const skillSourcePath = join(sourceDir, entry.name);
    const skillDestPath = join(destDir, entry.name);

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
  const mapping = CLIENT_MAPPINGS[client];
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
  const mapping = CLIENT_MAPPINGS[client];
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
 * Copy all plugin content to workspace for a specific client
 * Plugins provide: commands, skills, hooks, agents
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns All copy results
 */
export async function copyPluginToWorkspace(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  // Run copy operations in parallel for better performance
  const [commandResults, skillResults, hookResults, agentResults] = await Promise.all([
    copyCommands(pluginPath, workspacePath, client, options),
    copySkills(pluginPath, workspacePath, client, options),
    copyHooks(pluginPath, workspacePath, client, options),
    copyAgents(pluginPath, workspacePath, client, options),
  ]);

  return [...commandResults, ...skillResults, ...hookResults, ...agentResults];
}

/**
 * Copy workspace files from source to workspace root
 * Supports glob patterns with gitignore-style negation for string entries.
 * Object entries ({source, dest}) are copied directly without pattern expansion.
 *
 * @param sourcePath - Path to source directory (resolved workspace.source)
 * @param workspacePath - Path to workspace directory
 * @param files - Array of workspace file entries (strings support globs, objects are literal)
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyWorkspaceFiles(
  sourcePath: string,
  workspacePath: string,
  files: WorkspaceFile[],
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const results: CopyResult[] = [];

  // Separate string patterns from object entries
  const stringPatterns: string[] = [];
  const objectEntries: Array<{ source: string; dest: string | undefined }> = [];

  // Track which agent files were copied for WORKSPACE-RULES injection
  const copiedAgentFiles: string[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      stringPatterns.push(file);
    } else {
      objectEntries.push({ source: file.source, dest: file.dest });
    }
  }

  // Process string patterns through glob resolution
  if (stringPatterns.length > 0) {
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
        if (resolved.relativePath === 'CLAUDE.md' || resolved.relativePath === 'AGENTS.md') {
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
        if (resolved.relativePath === 'CLAUDE.md' || resolved.relativePath === 'AGENTS.md') {
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

  // Process object entries directly (no pattern support)
  for (const entry of objectEntries) {
    const srcPath = join(sourcePath, entry.source);
    const basename = entry.source.split('/').pop() || entry.source;
    const destFilename = entry.dest ?? basename;
    const destPath = join(workspacePath, destFilename);

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
      if (destFilename === 'CLAUDE.md' || destFilename === 'AGENTS.md') {
        copiedAgentFiles.push(destFilename);
      }
      continue;
    }

    try {
      await mkdir(dirname(destPath), { recursive: true });
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      results.push({ source: srcPath, destination: destPath, action: 'copied' });

      // Track if this is an agent file
      if (destFilename === 'CLAUDE.md' || destFilename === 'AGENTS.md') {
        copiedAgentFiles.push(destFilename);
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

  // Append WORKSPACE-RULES to the appropriate agent file
  if (copiedAgentFiles.length > 0 && !dryRun) {
    // If both files exist, append to AGENTS.md; otherwise append to whichever one exists
    const targetFile = copiedAgentFiles.includes('AGENTS.md')
      ? 'AGENTS.md'
      : copiedAgentFiles[0];

    const targetPath = join(workspacePath, targetFile);

    try {
      await appendFile(targetPath, WORKSPACE_RULES, 'utf-8');
    } catch (error) {
      results.push({
        source: 'WORKSPACE-RULES',
        destination: targetPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Failed to append WORKSPACE-RULES',
      });
    }
  }

  return results;
}
