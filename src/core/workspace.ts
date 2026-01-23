import { mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import simpleGit from 'simple-git';
import { CONFIG_DIR } from '../constants.js';

/**
 * Initialize a new workspace from template
 * @param targetPath - Path where workspace should be created
 * @param templateName - Name of template to use (default: default)
 * @throws Error if path already exists or initialization fails
 */
export async function initWorkspace(
  targetPath: string,
  templateName = 'default',
): Promise<void> {
  const absoluteTarget = resolve(targetPath);

  // Validate target path doesn't exist
  if (existsSync(absoluteTarget)) {
    throw new Error(
      `Path already exists: ${absoluteTarget}\n  Choose a different path or remove the existing directory`,
    );
  }

  // Get template path relative to this file
  // In development: src/core/workspace.ts -> ../templates/
  // In production: dist/index.js -> templates/ (same directory)
  const currentFilePath = new URL(import.meta.url).pathname;
  const currentFileDir = dirname(currentFilePath);

  // Bundled files are flat in dist/, source files are in src/core/
  const isProduction = currentFilePath.includes('/dist/');
  const templatePath = isProduction
    ? join(currentFileDir, 'templates', templateName)
    : join(currentFileDir, '..', 'templates', templateName);

  // Validate template exists
  if (!existsSync(templatePath)) {
    throw new Error(
      `Template not found: ${templateName}\n  Available templates: default`,
    );
  }

  try {
    // Create target directory
    await mkdir(absoluteTarget, { recursive: true });

    // Copy template files
    await cp(templatePath, absoluteTarget, { recursive: true });

    // Initialize git repository
    const git = simpleGit(absoluteTarget);
    await git.init();
    await git.add('.');
    await git.commit(`init: Create workspace from template

Created workspace at: ${absoluteTarget}
Template: ${templateName}`);

    console.log(`✓ Workspace created at: ${absoluteTarget}`);
    console.log('✓ Git repository initialized');
    console.log('\nNext steps:');
    console.log(`  cd ${relative(process.cwd(), absoluteTarget)}`);
    console.log('  allagents workspace sync');
  } catch (error) {
    // Clean up on failure
    try {
      const { rm } = await import('node:fs/promises');
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
