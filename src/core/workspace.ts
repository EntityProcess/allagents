import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, dump } from 'js-yaml';
import { syncWorkspace, type SyncResult } from './sync.js';
import { ensureWorkspaceRules } from './transform.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES } from '../constants.js';
import { isGitHubUrl } from '../utils/plugin-path.js';

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
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentFileDir = dirname(currentFilePath);
  const isProduction = currentFilePath.includes(`${sep}dist${sep}`);
  const defaultTemplatePath = isProduction
    ? join(currentFileDir, 'templates', 'default')
    : join(currentFileDir, '..', 'templates', 'default');

  try {
    // Create target directory if it doesn't exist
    await mkdir(absoluteTarget, { recursive: true });

    // Create .allagents directory
    await mkdir(configDir, { recursive: true });

    // Determine workspace.yaml source and track source directory for relative path resolution
    let workspaceYamlContent: string;
    let sourceDir: string | undefined;

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
          sourceDir = fromPath; // Source dir is the directory containing .allagents/
        } else if (existsSync(rootPath)) {
          sourceYamlPath = rootPath;
          sourceDir = fromPath; // Source dir is where workspace.yaml lives
        } else {
          throw new Error(
            `No workspace.yaml found in: ${fromPath}\n  Expected at: ${nestedPath} or ${rootPath}`,
          );
        }
      } else {
        // --from points directly to a yaml file
        sourceYamlPath = fromPath;
        // Source dir depends on whether yaml is inside .allagents/ or at workspace root
        const parentDir = dirname(fromPath);
        if (parentDir.endsWith(CONFIG_DIR)) {
          // yaml is in .allagents/, source dir is the workspace root (parent of .allagents/)
          sourceDir = dirname(parentDir);
        } else {
          // yaml is at workspace root, source dir is that directory
          sourceDir = parentDir;
        }
      }

      workspaceYamlContent = await readFile(sourceYamlPath, 'utf-8');

      // Rewrite relative workspace.source to absolute path so sync works after init
      if (sourceDir) {
        const parsed = load(workspaceYamlContent) as Record<string, unknown>;
        const workspace = parsed?.workspace as { source?: string } | undefined;
        if (workspace?.source) {
          const source = workspace.source;
          // Convert relative local paths to absolute (skip URLs and already-absolute paths)
          if (!isGitHubUrl(source) && !isAbsolute(source)) {
            workspace.source = resolve(sourceDir, source);
            workspaceYamlContent = dump(parsed, { lineWidth: -1 });
          }
        }
      }

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

    // Auto-copy agent files (AGENTS.md, CLAUDE.md) from source if they exist
    const copiedAgentFiles: string[] = [];
    const effectiveSourceDir = sourceDir ?? defaultTemplatePath;

    for (const agentFile of AGENT_FILES) {
      const sourcePath = join(effectiveSourceDir, agentFile);
      if (existsSync(sourcePath)) {
        const content = await readFile(sourcePath, 'utf-8');
        await writeFile(join(absoluteTarget, agentFile), content, 'utf-8');
        copiedAgentFiles.push(agentFile);
      }
    }

    // Inject WORKSPACE-RULES into all copied agent files
    // If no agent files were copied, create AGENTS.md with just rules
    if (copiedAgentFiles.length === 0) {
      await ensureWorkspaceRules(join(absoluteTarget, 'AGENTS.md'));
    } else {
      for (const agentFile of copiedAgentFiles) {
        await ensureWorkspaceRules(join(absoluteTarget, agentFile));
      }
    }

    console.log(`✓ Workspace created at: ${absoluteTarget}`);

    // Auto-sync plugins
    // Pass sourceDir so relative paths in workspace.source resolve correctly
    console.log('\nSyncing plugins...');
    const syncResult = await syncWorkspace(absoluteTarget, {
      workspaceSourceBase: sourceDir,
    });

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
