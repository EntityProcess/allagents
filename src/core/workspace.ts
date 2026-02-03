import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, dump } from 'js-yaml';
import { syncWorkspace, type SyncResult } from './sync.js';
import { ensureWorkspaceRules } from './transform.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES } from '../constants.js';
import { isGitHubUrl, parseGitHubUrl } from '../utils/plugin-path.js';
import { fetchWorkspaceFromGitHub, fetchFileFromGitHub } from './github-fetch.js';

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
      // Check if --from is a GitHub URL
      if (isGitHubUrl(options.from)) {
        const fetchResult = await fetchWorkspaceFromGitHub(options.from);
        if (!fetchResult.success || !fetchResult.content) {
          throw new Error(fetchResult.error || 'Failed to fetch workspace from GitHub');
        }
        workspaceYamlContent = fetchResult.content;
        // For GitHub sources, keep workspace.source as-is (it's already a URL or relative to the repo)
        // We need to rewrite relative workspace.source to the full GitHub URL
        const parsed = load(workspaceYamlContent) as Record<string, unknown>;
        const workspace = parsed?.workspace as { source?: string } | undefined;
        if (workspace?.source) {
          const source = workspace.source;
          // If workspace.source is a relative path, convert to GitHub URL
          if (!isGitHubUrl(source) && !isAbsolute(source)) {
            // Build GitHub URL from the --from location plus the relative source
            const parsedUrl = parseGitHubUrl(options.from);
            if (parsedUrl) {
              const basePath = parsedUrl.subpath || '';
              // Remove workspace.yaml from the base path if present
              const baseDir = basePath.replace(/\/?\.allagents\/workspace\.yaml$/, '')
                                       .replace(/\/?workspace\.yaml$/, '');
              // If source is "." (current directory), just use baseDir, otherwise join them
              const sourcePath = source === '.' ? baseDir : (baseDir ? `${baseDir}/${source}` : source);
              // Use the branch from the parsed URL, or default to main if not specified
              const branch = parsedUrl.branch || 'main';
              workspace.source = `https://github.com/${parsedUrl.owner}/${parsedUrl.repo}/tree/${branch}/${sourcePath}`;
              workspaceYamlContent = dump(parsed, { lineWidth: -1 });
            }
          }
        }
        console.log(`✓ Using workspace.yaml from: ${options.from}`);
      } else {
        // Copy workspace.yaml from local --from path
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
      }
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

    if (options.from && isGitHubUrl(options.from)) {
      // Fetch agent files from GitHub
      const parsedUrl = parseGitHubUrl(options.from);
      if (parsedUrl) {
        const basePath = parsedUrl.subpath || '';
        for (const agentFile of AGENT_FILES) {
          const targetFilePath = join(absoluteTarget, agentFile);
          // Skip if file already exists in target - don't overwrite user content
          if (existsSync(targetFilePath)) {
            copiedAgentFiles.push(agentFile);
            continue;
          }
          const filePath = basePath ? `${basePath}/${agentFile}` : agentFile;
          const content = await fetchFileFromGitHub(
            parsedUrl.owner,
            parsedUrl.repo,
            filePath,
            parsedUrl.branch,
          );
          if (content) {
            await writeFile(targetFilePath, content, 'utf-8');
            copiedAgentFiles.push(agentFile);
          }
        }
      }
    } else {
      // Copy agent files from local source
      const effectiveSourceDir = sourceDir ?? defaultTemplatePath;
      for (const agentFile of AGENT_FILES) {
        const targetFilePath = join(absoluteTarget, agentFile);
        // Skip if file already exists in target - don't overwrite user content
        if (existsSync(targetFilePath)) {
          copiedAgentFiles.push(agentFile);
          continue;
        }
        const sourcePath = join(effectiveSourceDir, agentFile);
        if (existsSync(sourcePath)) {
          const content = await readFile(sourcePath, 'utf-8');
          await writeFile(targetFilePath, content, 'utf-8');
          copiedAgentFiles.push(agentFile);
        }
      }
    }

    // Inject WORKSPACE-RULES into all copied agent files
    // If no agent files were copied, create AGENTS.md with just rules
    if (copiedAgentFiles.length === 0) {
      await ensureWorkspaceRules(join(absoluteTarget, 'AGENTS.md'));
      copiedAgentFiles.push('AGENTS.md');
    } else {
      for (const agentFile of copiedAgentFiles) {
        await ensureWorkspaceRules(join(absoluteTarget, agentFile));
      }
    }

    // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
    const parsed = load(workspaceYamlContent) as Record<string, unknown>;
    const clients = (parsed?.clients as string[]) ?? [];
    if (
      clients.includes('claude') &&
      !copiedAgentFiles.includes('CLAUDE.md') &&
      copiedAgentFiles.includes('AGENTS.md')
    ) {
      const agentsPath = join(absoluteTarget, 'AGENTS.md');
      const claudePath = join(absoluteTarget, 'CLAUDE.md');
      await copyFile(agentsPath, claudePath);
    }

    console.log(`✓ Workspace created at: ${absoluteTarget}`);

    // Auto-sync plugins
    // Pass sourceDir so relative paths in workspace.source resolve correctly
    console.log('\nSyncing plugins...');
    const syncResult = await syncWorkspace(absoluteTarget, {
      ...(sourceDir && { workspaceSourceBase: sourceDir }),
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
