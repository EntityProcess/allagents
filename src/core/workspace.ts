import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { syncWorkspace, type SyncResult } from './sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';

/**
 * Options for workspace initialization
 */
export interface InitOptions {
  /** Path to existing workspace.yaml or directory containing one to copy from */
  from?: string;
}

/**
 * Result of workspace initialization
 */
export interface InitResult {
  /** Path where workspace was created */
  path: string;
  /** Result of plugin sync (if plugins were configured) */
  syncResult?: SyncResult;
}

/**
 * Initialize a new workspace from template
 * @param targetPath - Path where workspace should be created (default: current directory)
 * @param options - Initialization options
 * @throws Error if path already exists or initialization fails
 */
export async function initWorkspace(
  targetPath = '.',
  options: InitOptions = {},
): Promise<InitResult> {
  const absoluteTarget = resolve(targetPath);
  const configDir = join(absoluteTarget, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);

  // Check if workspace already exists (has .allagents/workspace.yaml)
  if (existsSync(configPath)) {
    throw new Error(
      `Workspace already exists: ${absoluteTarget}\n  Found existing ${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    );
  }

  // Get template path for default template
  const currentFilePath = new URL(import.meta.url).pathname;
  const currentFileDir = dirname(currentFilePath);
  const isProduction = currentFilePath.includes('/dist/');
  const defaultTemplatePath = isProduction
    ? join(currentFileDir, 'templates', 'default')
    : join(currentFileDir, '..', 'templates', 'default');

  try {
    // Create target directory if it doesn't exist
    await mkdir(absoluteTarget, { recursive: true });

    // Create .allagents directory
    await mkdir(configDir, { recursive: true });

    // Determine workspace.yaml source
    let workspaceYamlContent: string;

    if (options.from) {
      // Copy workspace.yaml from --from path
      const fromPath = resolve(options.from);

      if (!existsSync(fromPath)) {
        throw new Error(`Template not found: ${fromPath}`);
      }

      // Check if --from is a file or directory
      const { stat } = await import('node:fs/promises');
      const fromStat = await stat(fromPath);

      let sourceYamlPath: string;
      if (fromStat.isDirectory()) {
        // Look for workspace.yaml in .allagents/ subdirectory first, then root
        const nestedPath = join(fromPath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
        const rootPath = join(fromPath, WORKSPACE_CONFIG_FILE);

        if (existsSync(nestedPath)) {
          sourceYamlPath = nestedPath;
        } else if (existsSync(rootPath)) {
          sourceYamlPath = rootPath;
        } else {
          throw new Error(
            `No workspace.yaml found in: ${fromPath}\n  Expected at: ${nestedPath} or ${rootPath}`,
          );
        }
      } else {
        // --from points directly to a yaml file
        sourceYamlPath = fromPath;
      }

      workspaceYamlContent = await readFile(sourceYamlPath, 'utf-8');
      console.log(`✓ Using workspace.yaml from: ${sourceYamlPath}`);
    } else {
      // Use default template's workspace.yaml
      const defaultYamlPath = join(defaultTemplatePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
      if (!existsSync(defaultYamlPath)) {
        throw new Error(`Default template not found at: ${defaultTemplatePath}`);
      }
      workspaceYamlContent = await readFile(defaultYamlPath, 'utf-8');
    }

    // Write workspace.yaml
    await writeFile(configPath, workspaceYamlContent, 'utf-8');

    // Copy AGENTS.md from default template if it exists and target doesn't have one
    const defaultAgentsPath = join(defaultTemplatePath, 'AGENTS.md');
    const targetAgentsPath = join(absoluteTarget, 'AGENTS.md');
    if (existsSync(defaultAgentsPath) && !existsSync(targetAgentsPath)) {
      await cp(defaultAgentsPath, targetAgentsPath);
    }

    console.log(`✓ Workspace created at: ${absoluteTarget}`);

    // Auto-sync plugins
    console.log('\nSyncing plugins...');
    const syncResult = await syncWorkspace(absoluteTarget);

    if (!syncResult.success && syncResult.error) {
      // Don't fail init if sync fails (e.g., no plugins configured)
      // Just report it
      if (!syncResult.error.includes('Plugin validation failed')) {
        console.log(`  Note: ${syncResult.error}`);
      } else {
        console.error(`  Sync error: ${syncResult.error}`);
      }
    }

    // Show next steps
    if (targetPath !== '.') {
      console.log('\nNext steps:');
      console.log(`  cd ${relative(process.cwd(), absoluteTarget)}`);
    }

    return {
      path: absoluteTarget,
      syncResult,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to initialize workspace: ${error.message}`);
    }
    throw error;
  }
}
