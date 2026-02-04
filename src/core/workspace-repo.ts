import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { load, dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { ensureWorkspace, type ModifyResult } from './workspace-modify.js';
import type { WorkspaceConfig, Repository } from '../models/workspace-config.js';

/**
 * Detect source platform and owner/repo from a git remote at the given path.
 * Returns { source, repo } or undefined if not detectable.
 */
export async function detectRemote(repoPath: string): Promise<{ source: string; repo: string } | undefined> {
  try {
    // Unset GIT_DIR/GIT_WORK_TREE so we read the target repo's config,
    // not the caller's (important when run from git hooks or worktrees).
    const env = { ...process.env };
    env.GIT_DIR = undefined;
    env.GIT_WORK_TREE = undefined;

    const proc = Bun.spawn(['git', '-C', repoPath, 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return undefined;

    const url = text.trim();

    // GitHub SSH: git@github.com:owner/repo.git
    // GitHub HTTPS: https://github.com/owner/repo.git
    const githubMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (githubMatch) return { source: 'github', repo: `${githubMatch[1]}/${githubMatch[2]}` };

    // GitLab
    const gitlabMatch = url.match(/gitlab\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (gitlabMatch) return { source: 'gitlab', repo: `${gitlabMatch[1]}/${gitlabMatch[2]}` };

    // Bitbucket
    const bitbucketMatch = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (bitbucketMatch) return { source: 'bitbucket', repo: `${bitbucketMatch[1]}/${bitbucketMatch[2]}` };

    // Azure DevOps: https://dev.azure.com/org/project/_git/repo or org@vs-ssh.visualstudio.com:v3/org/project/repo
    const azureHttpsMatch = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/.]+?)(?:\.git)?$/);
    if (azureHttpsMatch) return { source: 'azure-devops', repo: `${azureHttpsMatch[1]}/${azureHttpsMatch[2]}/${azureHttpsMatch[3]}` };

    const azureSshMatch = url.match(/vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (azureSshMatch) return { source: 'azure-devops', repo: `${azureSshMatch[1]}/${azureSshMatch[2]}/${azureSshMatch[3]}` };

    return undefined;
  } catch {
    return undefined;
  }
}

interface AddRepoOptions {
  source?: string | undefined;
  repo?: string | undefined;
  description?: string | undefined;
}

/**
 * Add a repository to .allagents/workspace.yaml
 */
export async function addRepository(
  path: string,
  options: AddRepoOptions = {},
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  await ensureWorkspace(workspacePath);

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    // Check for duplicate path
    if (config.repositories.some((r) => r.path === path)) {
      return { success: false, error: `Repository already exists: ${path}` };
    }

    const entry: Repository = { path };
    if (options.source) entry.source = options.source;
    if (options.repo) entry.repo = options.repo;
    if (options.description) entry.description = options.description;

    config.repositories.push(entry);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove a repository from .allagents/workspace.yaml by path
 */
export async function removeRepository(
  path: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init' to create a workspace`,
    };
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;

    const index = config.repositories.findIndex((r) => r.path === path);
    if (index === -1) {
      return { success: false, error: `Repository not found: ${path}` };
    }

    config.repositories.splice(index, 1);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * List repositories from .allagents/workspace.yaml
 */
export async function listRepositories(
  workspacePath: string = process.cwd(),
): Promise<Repository[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = load(content) as WorkspaceConfig;
    return config.repositories ?? [];
  } catch {
    return [];
  }
}
