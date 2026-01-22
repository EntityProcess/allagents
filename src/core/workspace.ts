import { mkdir, cp, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import simpleGit from 'simple-git';
import { load, dump } from 'js-yaml';
import type { WorkspaceConfig } from '../models/workspace-config.js';

const TEMPLATE_DIR = 'templates/workspace-1';

/**
 * Initialize a new workspace from template
 * @param targetPath - Path where workspace should be created
 * @param templateName - Name of template to use (default: workspace-1)
 * @throws Error if path already exists or initialization fails
 */
export async function initWorkspace(
  targetPath: string,
  templateName: string = 'workspace-1'
): Promise<void> {
  const absoluteTarget = resolve(targetPath);

  // Validate target path doesn't exist
  if (existsSync(absoluteTarget)) {
    throw new Error(
      `Path already exists: ${absoluteTarget}\n  Choose a different path or remove the existing directory`
    );
  }

  // Get template path
  // In development: src/core/workspace.ts -> ../../templates
  // In production (bundled): dist/index.js -> ../templates
  const currentFilePath = new URL(import.meta.url).pathname;
  let projectRoot: string;

  if (currentFilePath.includes('/dist/')) {
    // Bundled: dist/index.js -> go up one level
    projectRoot = resolve(dirname(currentFilePath), '..');
  } else {
    // Development: src/core/workspace.ts -> go up two levels
    projectRoot = resolve(dirname(currentFilePath), '../..');
  }

  const templatePath = join(projectRoot, 'templates', templateName);

  // Validate template exists
  if (!existsSync(templatePath)) {
    throw new Error(
      `Template not found: ${templateName}\n  Available templates: workspace-1`
    );
  }

  try {
    // Create target directory
    await mkdir(absoluteTarget, { recursive: true });

    // Copy template files
    await cp(templatePath, absoluteTarget, { recursive: true });

    // Convert relative plugin paths to absolute in workspace.yaml
    await convertPluginPathsToAbsolute(absoluteTarget);

    // Initialize git repository
    const git = simpleGit(absoluteTarget);
    await git.init();
    await git.add('.');
    await git.commit(`init: Create workspace from template

Created workspace at: ${absoluteTarget}
Template: ${templateName}`);

    console.log(`✓ Workspace created at: ${absoluteTarget}`);
    console.log(`✓ Git repository initialized`);
    console.log(`\nNext steps:`);
    console.log(`  cd ${relative(process.cwd(), absoluteTarget)}`);
    console.log(`  allagents workspace sync`);
  } catch (error) {
    // Clean up on failure
    try {
      const { rm } = await import('fs/promises');
      await rm(absoluteTarget, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (error instanceof Error) {
      throw new Error(`Failed to initialize workspace: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Convert relative plugin paths to absolute paths in workspace.yaml
 * @param workspacePath - Path to workspace directory
 */
async function convertPluginPathsToAbsolute(workspacePath: string): Promise<void> {
  const configPath = join(workspacePath, 'workspace.yaml');

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Convert relative plugin paths to absolute
    config.plugins = config.plugins.map((plugin) => {
      // Skip GitHub URLs
      if (plugin.startsWith('http://') || plugin.startsWith('https://')) {
        return plugin;
      }

      // Convert relative paths to absolute
      if (plugin.startsWith('.')) {
        return resolve(workspacePath, plugin);
      }

      // Already absolute
      return plugin;
    });

    // Write back to file
    const updatedContent = dump(config, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
    });
    await writeFile(configPath, updatedContent, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to convert plugin paths: ${error.message}`);
    }
    throw error;
  }
}
