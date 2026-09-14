import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import {
  ProjectWorkspaceConfigSchema,
  UserWorkspaceConfigSchema,
  type ProjectWorkspaceConfig,
  type UserWorkspaceConfig,
  type WorkspaceConfig,
} from '../models/workspace-config.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';

const configName = `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`;

export type WorkspaceConfigScope = 'project' | 'user';

function formatValidationError(
  path: string,
  scope: WorkspaceConfigScope,
  input: unknown,
): ProjectWorkspaceConfig | UserWorkspaceConfig {
  const schema =
    scope === 'user'
      ? UserWorkspaceConfigSchema
      : ProjectWorkspaceConfigSchema;
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const errors = result.error.issues.map(
    (error) => `  - ${error.path.join('.')}: ${error.message}`,
  );
  throw new Error(`${path} validation failed:\n${errors.join('\n')}`);
}

export function validateProjectWorkspaceConfig(
  input: unknown,
  path: string = configName,
): ProjectWorkspaceConfig {
  return formatValidationError(path, 'project', input) as ProjectWorkspaceConfig;
}

export function validateUserWorkspaceConfig(
  input: unknown,
  path: string = configName,
): UserWorkspaceConfig {
  return formatValidationError(path, 'user', input) as UserWorkspaceConfig;
}

async function loadConfigFile(path: string): Promise<unknown> {
  try {
    const parsed = load(await readFile(path, 'utf-8'));
    if (!parsed) throw new Error(`${configName} is empty`);
    return parsed;
  } catch (error) {
    if (error instanceof Error) {
      if ('code' in error && error.code === 'ENOENT') {
        throw new Error(
          `${configName} not found at ${path}\n  Run 'allagents workspace init <path>' to create a new workspace`,
        );
      }
      if (error.name === 'YAMLException') {
        throw new Error(`Invalid YAML in ${configName}: ${error.message}`);
      }
      throw error;
    }
    throw new Error(`Unknown error parsing ${configName}: ${String(error)}`);
  }
}

async function parseConfigFile(
  path: string,
  scope: WorkspaceConfigScope,
): Promise<ProjectWorkspaceConfig | UserWorkspaceConfig> {
  return formatValidationError(configName, scope, await loadConfigFile(path));
}

/**
 * Parse a project workspace. This remains the project-compatible parser used
 * by existing project synchronization call sites.
 */
export async function parseWorkspaceConfig(
  path: string,
): Promise<ProjectWorkspaceConfig> {
  return parseConfigFile(path, 'project') as Promise<ProjectWorkspaceConfig>;
}

/**
 * Parse the user workspace, including optional global profile declarations.
 */
export async function parseUserWorkspaceConfig(
  path: string,
): Promise<UserWorkspaceConfig> {
  return parseConfigFile(path, 'user') as Promise<UserWorkspaceConfig>;
}

/**
 * Validate a project workspace before mutating it while retaining its original
 * YAML object representation.
 */
export async function parseWorkspaceConfigForEdit(
  path: string,
): Promise<WorkspaceConfig> {
  const input = await loadConfigFile(path);
  validateProjectWorkspaceConfig(input);
  return input as WorkspaceConfig;
}

/**
 * Validate a user workspace before mutation without materializing profile
 * defaults or dropping unrelated top-level fields. Profiles-only workspaces
 * receive the ordinary empty arrays required by existing mutation code.
 */
export async function parseUserWorkspaceConfigForEdit(
  path: string,
): Promise<WorkspaceConfig> {
  const input = await loadConfigFile(path);
  const validated = validateUserWorkspaceConfig(input);
  const config = input as Record<string, unknown>;
  config.repositories ??= validated.repositories;
  config.plugins ??= validated.plugins;
  config.clients ??= validated.clients;
  return config as WorkspaceConfig;
}
