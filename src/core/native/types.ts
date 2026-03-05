import { spawn } from 'node:child_process';

export interface NativeCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface NativePluginFailure {
  plugin: string;
  error: string;
  client?: string;
}

export interface NativeSyncResult {
  marketplacesAdded: string[];
  pluginsInstalled: string[];
  pluginsFailed: NativePluginFailure[];
  skipped: string[];
}

export interface NativeClient {
  /** Check if the CLI binary is available */
  isAvailable(): Promise<boolean>;

  /** Whether this client supports the given install scope */
  supportsScope(scope: 'user' | 'project'): boolean;

  /** Convert allagents plugin source to this client's spec format. Null = not marketplace-based. */
  toPluginSpec(allagentsSource: string): string | null;

  /** Extract marketplace owner/repo from a plugin spec. Null = not marketplace-based. */
  extractMarketplaceSource(pluginSpec: string): string | null;

  /** Register a marketplace */
  addMarketplace(source: string, options?: { cwd?: string }): Promise<NativeCommandResult>;

  /** Install a plugin */
  installPlugin(spec: string, scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult>;

  /** Uninstall a plugin */
  uninstallPlugin(spec: string, scope: 'user' | 'project', options?: { cwd?: string }): Promise<NativeCommandResult>;

  /** High-level sync: register marketplaces + install plugins */
  syncPlugins(plugins: string[], scope: 'user' | 'project', options?: { cwd?: string; dryRun?: boolean }): Promise<NativeSyncResult>;
}

/**
 * Execute a CLI command and capture output.
 * Shared helper for all native client implementations.
 */
export function executeCommand(
  binary: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<NativeCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(binary, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
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

    let resolved = false;
    proc.on('close', (code: number | null) => {
      if (resolved) return;
      resolved = true;
      const trimmedStderr = stderr.trim();
      resolve({
        success: code === 0,
        output: stdout.trim(),
        ...(trimmedStderr && { error: trimmedStderr }),
      });
    });

    proc.on('error', (err: Error) => {
      if (resolved) return;
      resolved = true;
      resolve({
        success: false,
        output: '',
        error: `Failed to execute ${binary} CLI: ${err.message}`,
      });
    });
  });
}

/**
 * Merge multiple NativeSyncResult objects into one.
 */
export function mergeNativeSyncResults(results: NativeSyncResult[]): NativeSyncResult {
  return results.reduce(
    (acc, r) => ({
      marketplacesAdded: [...acc.marketplacesAdded, ...r.marketplacesAdded],
      pluginsInstalled: [...acc.pluginsInstalled, ...r.pluginsInstalled],
      pluginsFailed: [...acc.pluginsFailed, ...r.pluginsFailed],
      skipped: [...acc.skipped, ...r.skipped],
    }),
    { marketplacesAdded: [], pluginsInstalled: [], pluginsFailed: [], skipped: [] } as NativeSyncResult,
  );
}
