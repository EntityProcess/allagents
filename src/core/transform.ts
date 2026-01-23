import { readFile, writeFile, mkdir, cp, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import type { ClientType } from '../models/workspace-config.js';
import { validateSkill } from '../validators/skill.js';

/**
 * Result of a file copy operation
 */
export interface CopyResult {
  source: string;
  destination: string;
  action: 'copied' | 'skipped' | 'failed';
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
  options: CopyOptions = {}
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

  for (const file of mdFiles) {
    const sourcePath = join(sourceDir, file);

    // Transform extension if needed (e.g., .md → .prompt.md for Copilot)
    let destFileName = file;
    if (mapping.commandsExt === '.prompt.md' && !file.endsWith('.prompt.md')) {
      destFileName = file.replace(/\.md$/, '.prompt.md');
    }

    const destPath = join(destDir, destFileName);

    if (dryRun) {
      results.push({ source: sourcePath, destination: destPath, action: 'copied' });
      continue;
    }

    try {
      const content = await readFile(sourcePath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      results.push({ source: sourcePath, destination: destPath, action: 'copied' });
    } catch (error) {
      results.push({
        source: sourcePath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
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
  options: CopyOptions = {}
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

  for (const entry of skillDirs) {
    const skillSourcePath = join(sourceDir, entry.name);
    const skillDestPath = join(destDir, entry.name);

    // Validate skill before copying
    const validation = await validateSkill(skillSourcePath);
    if (!validation.valid) {
      results.push({
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'failed',
        ...(validation.error && { error: validation.error }),
      });
      continue;
    }

    if (dryRun) {
      results.push({ source: skillSourcePath, destination: skillDestPath, action: 'copied' });
      continue;
    }

    try {
      await cp(skillSourcePath, skillDestPath, { recursive: true });
      results.push({ source: skillSourcePath, destination: skillDestPath, action: 'copied' });
    } catch (error) {
      results.push({
        source: skillSourcePath,
        destination: skillDestPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
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
  options: CopyOptions = {}
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
 * Get the appropriate source agent file for a client
 * Implements source precedence: client-specific file → AGENTS.md
 * @param pluginPath - Path to plugin directory
 * @param client - Target client type
 * @returns Path to source agent file, or null if none found
 */
export function getSourceAgentFile(pluginPath: string, client: ClientType): string | null {
  const mapping = CLIENT_MAPPINGS[client];

  // Check for client-specific agent file first
  const clientAgentFile = join(pluginPath, mapping.agentFile);
  if (existsSync(clientAgentFile)) {
    return clientAgentFile;
  }

  // Fall back to AGENTS.md if specified
  if (mapping.agentFileFallback) {
    const fallbackFile = join(pluginPath, mapping.agentFileFallback);
    if (existsSync(fallbackFile)) {
      return fallbackFile;
    }
  }

  return null;
}

/**
 * Workspace rules to append to agent files
 */
const WORKSPACE_RULES = `
<!-- WORKSPACE-RULES:START -->
# Workspace Rules

## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read \`workspace.yaml\` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from \`workspace.yaml\`, not assumptions
<!-- WORKSPACE-RULES:END -->
`;

/**
 * Copy and create agent files for a specific client
 * Appends workspace rules to agent files
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Copy result
 */
export async function copyAgentFile(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {}
): Promise<CopyResult> {
  const { dryRun = false } = options;
  const mapping = CLIENT_MAPPINGS[client];
  const destPath = join(workspacePath, mapping.agentFile);

  const sourcePath = getSourceAgentFile(pluginPath, client);

  if (dryRun) {
    return {
      source: sourcePath || 'generated',
      destination: destPath,
      action: 'copied',
    };
  }

  try {
    let content = '';

    if (sourcePath) {
      content = await readFile(sourcePath, 'utf-8');
    }

    // Append workspace rules if not already present
    if (!content.includes('WORKSPACE-RULES:START')) {
      content = content.trimEnd() + '\n' + WORKSPACE_RULES;
    }

    await writeFile(destPath, content, 'utf-8');

    return {
      source: sourcePath || 'generated',
      destination: destPath,
      action: 'copied',
    };
  } catch (error) {
    return {
      source: sourcePath || 'generated',
      destination: destPath,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Copy all plugin content to workspace for a specific client
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
  options: CopyOptions = {}
): Promise<CopyResult[]> {
  const results: CopyResult[] = [];

  // Copy commands
  const commandResults = await copyCommands(pluginPath, workspacePath, client, options);
  results.push(...commandResults);

  // Copy skills
  const skillResults = await copySkills(pluginPath, workspacePath, client, options);
  results.push(...skillResults);

  // Copy hooks
  const hookResults = await copyHooks(pluginPath, workspacePath, client, options);
  results.push(...hookResults);

  // Copy/create agent file
  const agentResult = await copyAgentFile(pluginPath, workspacePath, client, options);
  results.push(agentResult);

  return results;
}
