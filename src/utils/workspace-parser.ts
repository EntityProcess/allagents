import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import { WorkspaceConfigSchema, type WorkspaceConfig } from '../models/workspace-config.js';

/**
 * Parse and validate workspace.yaml file
 * @param path - Path to workspace.yaml file
 * @returns Validated WorkspaceConfig
 * @throws Error if file doesn't exist, is invalid YAML, or fails validation
 */
export async function parseWorkspaceConfig(path: string): Promise<WorkspaceConfig> {
  try {
    // Read the YAML file
    const content = await readFile(path, 'utf-8');

    // Parse YAML
    const parsed = load(content);

    if (!parsed) {
      throw new Error('workspace.yaml is empty');
    }

    // Validate with Zod schema
    const result = WorkspaceConfigSchema.safeParse(parsed);

    if (!result.success) {
      const errors = result.error.errors.map((err) => `  - ${err.path.join('.')}: ${err.message}`);
      throw new Error(`workspace.yaml validation failed:\n${errors.join('\n')}`);
    }

    return result.data;
  } catch (error) {
    if (error instanceof Error) {
      // Re-throw validation errors as-is
      if (error.message.includes('validation failed')) {
        throw error;
      }

      // Handle file not found
      if ('code' in error && error.code === 'ENOENT') {
        throw new Error(
          `workspace.yaml not found at ${path}\n  Run 'allagents workspace init <path>' to create a new workspace`
        );
      }

      // Handle YAML parsing errors
      if (error.message.includes('YAMLException')) {
        throw new Error(`Invalid YAML in workspace.yaml: ${error.message}`);
      }

      // Re-throw other errors
      throw error;
    }

    throw new Error(`Unknown error parsing workspace.yaml: ${String(error)}`);
  }
}
