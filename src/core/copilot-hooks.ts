import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ValidatedPlugin } from './sync.js';
import { isExcluded, type CopyResult } from './transform.js';

export const COPILOT_MANAGED_HOOKS_RELATIVE_PATH =
  '.github/hooks/allagents.json';

const PLUGIN_HOOK_PATHS = ['hooks.json', 'hooks/hooks.json'] as const;

type JsonRecord = Record<string, unknown>;

interface CopilotHooksFile {
  version: 1;
  hooks: Record<string, unknown[]>;
}

export interface CopilotHookSyncResult {
  copyResults: CopyResult[];
  warnings: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHooksFile(
  content: string,
  source: string,
  warnings: string[],
): CopilotHooksFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    warnings.push(
      `Copilot hooks: failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.hooks)) {
    warnings.push(
      `Copilot hooks: ${source} must contain version 1 and a hooks object`,
    );
    return null;
  }

  if (parsed.disableAllHooks === true) {
    return { version: 1, hooks: {} };
  }

  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) {
      warnings.push(
        `Copilot hooks: event '${eventName}' in ${source} must be an array`,
      );
      return null;
    }
    hooks[eventName] = entries;
  }

  return { version: 1, hooks };
}

function withPluginRoot(
  hooksFile: CopilotHooksFile,
  pluginRoot: string,
): CopilotHooksFile {
  const hooks = Object.fromEntries(
    Object.entries(hooksFile.hooks).map(([eventName, entries]) => [
      eventName,
      entries.map((entry) => {
        if (!isRecord(entry)) return entry;
        const existingEnv = isRecord(entry.env) ? entry.env : {};
        return {
          ...entry,
          env: {
            ...existingEnv,
            COPILOT_PLUGIN_ROOT: pluginRoot,
          },
        };
      }),
    ]),
  );
  return { version: 1, hooks };
}

async function collectPluginHooks(
  plugin: ValidatedPlugin,
  warnings: string[],
): Promise<CopilotHooksFile | null> {
  const relativePath = PLUGIN_HOOK_PATHS.find((candidate) =>
    existsSync(join(plugin.resolved, candidate)),
  );
  if (!relativePath) return null;

  const hooksPath = join(plugin.resolved, relativePath);
  if (isExcluded(plugin.resolved, hooksPath, plugin.exclude)) return null;

  let hooksFile: CopilotHooksFile | null;
  try {
    hooksFile = parseHooksFile(
      await readFile(hooksPath, 'utf-8'),
      hooksPath,
      warnings,
    );
  } catch (error) {
    warnings.push(
      `Copilot hooks: failed to read ${hooksPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (!hooksFile) return null;

  // The declaration executes payloads from the installed plugin root. If a
  // user excluded any root hooks/ payload, activating the declaration would
  // bypass that exclusion even though the file was not copied to the project.
  // Skip the plugin's generated declaration rather than execute excluded code.
  if (await hasExcludedHookPayload(plugin)) return null;

  return withPluginRoot(hooksFile, plugin.resolved);
}

async function hasExcludedHookPayload(plugin: ValidatedPlugin): Promise<boolean> {
  if (!plugin.exclude || plugin.exclude.length === 0) return false;

  const hooksDir = join(plugin.resolved, 'hooks');
  if (!existsSync(hooksDir)) return false;

  async function visit(directory: string): Promise<boolean> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      if (isExcluded(plugin.resolved, sourcePath, plugin.exclude)) return true;
      if (entry.isDirectory() && (await visit(sourcePath))) return true;
    }
    return false;
  }

  return visit(hooksDir);
}

function pluginTargetsCopilot(plugin: ValidatedPlugin): boolean {
  return (
    plugin.success &&
    plugin.clients.includes('copilot') &&
    plugin.fileArtifacts?.hooks !== false
  );
}

function mergeHooks(files: CopilotHooksFile[]): CopilotHooksFile {
  const hooks: Record<string, unknown[]> = {};
  for (const file of files) {
    for (const [eventName, entries] of Object.entries(file.hooks)) {
      if (entries.length === 0) continue;
      hooks[eventName] = [...(hooks[eventName] ?? []), ...entries];
    }
  }
  return { version: 1, hooks };
}

export async function syncCopilotProjectHooks(
  validatedPlugins: ValidatedPlugin[],
  workspacePath: string,
  options: { dryRun?: boolean; previouslyManaged?: boolean } = {},
): Promise<CopilotHookSyncResult> {
  const warnings: string[] = [];
  const hookFiles = await Promise.all(
    validatedPlugins
      .filter(pluginTargetsCopilot)
      .map((plugin) => collectPluginHooks(plugin, warnings)),
  );
  const merged = mergeHooks(
    hookFiles.filter((file): file is CopilotHooksFile => file !== null),
  );

  if (Object.keys(merged.hooks).length === 0) {
    return { copyResults: [], warnings };
  }

  const hooksPath = join(workspacePath, COPILOT_MANAGED_HOOKS_RELATIVE_PATH);
  if (existsSync(hooksPath) && !options.previouslyManaged) {
    warnings.push(
      `Copilot hooks: not updating ${COPILOT_MANAGED_HOOKS_RELATIVE_PATH} because the existing file is not owned by AllAgents`,
    );
    return { copyResults: [], warnings };
  }

  if (!options.dryRun) {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  }

  return {
    copyResults: [
      {
        source: 'copilot-plugin-hooks',
        destination: hooksPath,
        action: 'generated',
      },
    ],
    warnings,
  };
}
