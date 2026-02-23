import { spawn } from 'node:child_process';

export interface ClaudeNativeResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ClaudePluginInfo {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
}

/**
 * Execute a claude CLI command in headless mode.
 * Uses subcommands only — never launches interactive TUI.
 */
export async function executeClaudeCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<ClaudeNativeResult> {
  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      resolve({
        success: code === 0,
        output: stdout.trim(),
        error: stderr.trim() || undefined,
      });
    });

    proc.on('error', (err: Error) => {
      resolve({
        success: false,
        output: '',
        error: `Failed to execute claude CLI: ${err.message}`,
      });
    });
  });
}

/**
 * Check if the claude CLI is available.
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  const result = await executeClaudeCommand(['--version']);
  return result.success;
}

/**
 * Register a marketplace with the claude CLI.
 * Idempotent — ignores errors if already registered.
 */
export async function addMarketplace(
  source: string,
  options: { cwd?: string } = {},
): Promise<ClaudeNativeResult> {
  return executeClaudeCommand(
    ['plugin', 'marketplace', 'add', source],
    options,
  );
}

/**
 * Install a plugin using the claude CLI.
 */
export async function installPlugin(
  pluginSpec: string,
  scope: 'user' | 'project' = 'project',
  options: { cwd?: string } = {},
): Promise<ClaudeNativeResult> {
  return executeClaudeCommand(
    ['plugin', 'install', pluginSpec, '--scope', scope],
    options,
  );
}

/**
 * Uninstall a plugin using the claude CLI.
 */
export async function uninstallPlugin(
  pluginSpec: string,
  scope: 'user' | 'project' = 'project',
  options: { cwd?: string } = {},
): Promise<ClaudeNativeResult> {
  return executeClaudeCommand(
    ['plugin', 'uninstall', pluginSpec, '--scope', scope],
    options,
  );
}

/**
 * List installed plugins using the claude CLI.
 */
export async function listInstalledPlugins(
  options: { cwd?: string } = {},
): Promise<ClaudePluginInfo[]> {
  const result = await executeClaudeCommand(
    ['plugin', 'list', '--json'],
    options,
  );
  if (!result.success) return [];
  try {
    return JSON.parse(result.output) as ClaudePluginInfo[];
  } catch {
    return [];
  }
}

/**
 * Extract marketplace source (owner/repo) from a plugin spec.
 * Returns null if not in "plugin@owner/repo" format.
 */
export function extractMarketplaceSource(pluginSpec: string): string | null {
  const atIndex = pluginSpec.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === pluginSpec.length - 1) return null;
  const marketplacePart = pluginSpec.slice(atIndex + 1);
  if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
    return marketplacePart;
  }
  return null;
}

/**
 * Convert an allagents plugin source to a claude CLI plugin spec.
 *
 * "superpowers@obra/superpowers-marketplace" → "superpowers@superpowers-marketplace"
 * "vercel-labs/agent-browser/skills/agent-browser" → null (not marketplace-based)
 */
export function toClaudePluginSpec(allagentsSource: string): string | null {
  const atIndex = allagentsSource.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;

  const pluginName = allagentsSource.slice(0, atIndex);
  const marketplacePart = allagentsSource.slice(atIndex + 1);

  if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
    const parts = marketplacePart.split('/');
    const repoName = parts[1];
    return `${pluginName}@${repoName}`;
  }
  return allagentsSource;
}

export interface NativeSyncResult {
  marketplacesAdded: string[];
  pluginsInstalled: string[];
  pluginsFailed: { plugin: string; error: string }[];
  skipped: string[];
}

/**
 * Sync plugins using claude CLI native commands.
 * Registers marketplaces and installs plugins.
 */
export async function syncNativePlugins(
  plugins: string[],
  scope: 'user' | 'project' = 'project',
  options: { cwd?: string; dryRun?: boolean } = {},
): Promise<NativeSyncResult> {
  const result: NativeSyncResult = {
    marketplacesAdded: [],
    pluginsInstalled: [],
    pluginsFailed: [],
    skipped: [],
  };

  if (options.dryRun) {
    for (const plugin of plugins) {
      const spec = toClaudePluginSpec(plugin);
      if (spec) {
        result.pluginsInstalled.push(spec);
      } else {
        result.skipped.push(plugin);
      }
    }
    return result;
  }

  // Register unique marketplaces
  const marketplaceSources = new Set<string>();
  for (const plugin of plugins) {
    const source = extractMarketplaceSource(plugin);
    if (source) marketplaceSources.add(source);
  }

  for (const source of marketplaceSources) {
    const addResult = await addMarketplace(source, options);
    if (addResult.success) {
      result.marketplacesAdded.push(source);
    }
  }

  // Install plugins
  for (const plugin of plugins) {
    const spec = toClaudePluginSpec(plugin);
    if (!spec) {
      result.skipped.push(plugin);
      continue;
    }

    const installResult = await installPlugin(spec, scope, options);
    if (installResult.success) {
      result.pluginsInstalled.push(spec);
    } else {
      result.pluginsFailed.push({
        plugin: spec,
        error: installResult.error ?? 'Unknown error',
      });
    }
  }

  return result;
}
