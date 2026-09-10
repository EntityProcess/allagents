import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, open } from 'node:fs/promises';
import { delimiter, dirname, extname, resolve } from 'node:path';
import readCmdShim from 'read-cmd-shim';

export interface NativeCommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface NativePluginInstalled {
  plugin: string;
  client?: string;
}

export interface NativePluginFailure {
  plugin: string;
  error: string;
  client?: string;
}

export interface NativeSyncResult {
  marketplacesAdded: string[];
  pluginsInstalled: NativePluginInstalled[];
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

async function resolveWindowsBinary(
  binary: string,
  nativeOnly = false,
): Promise<string> {
  const pathEntries = /[\\/]/.test(binary)
    ? ['']
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((pathEntry) => {
          const trimmed = pathEntry.trim();
          return trimmed.startsWith('"') && trimmed.endsWith('"')
            ? trimmed.slice(1, -1)
            : trimmed;
        })
        // Empty Windows PATH entries mean cwd, but client binaries must come
        // from an explicit PATH directory rather than the workspace.
        .filter((pathEntry) => pathEntry.length > 0);
  const configuredExtensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(delimiter)
    .map((extension) => {
      const normalized = extension.trim().toLowerCase();
      return normalized && !normalized.startsWith('.')
        ? `.${normalized}`
        : normalized;
    })
    .filter((extension) => extension.length > 0);
  const extensions = extname(binary)
    ? ['']
    : nativeOnly
      ? configuredExtensions.filter(
          (extension) => extension === '.com' || extension === '.exe',
        )
      : configuredExtensions;

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${binary}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }

  throw new Error(`command not found on PATH: ${binary}`);
}

async function resolveWindowsNativeBinary(binary: string): Promise<string> {
  const extension = extname(binary).toLowerCase();
  if (extension && extension !== '.com' && extension !== '.exe') {
    throw new Error(`unsafe Windows interpreter '${binary}'`);
  }
  return resolveWindowsBinary(binary, true);
}

async function resolveWindowsShimInterpreter(
  interpreter: string,
  shimDirectory: string,
): Promise<string> {
  const normalizedInterpreter = interpreter.toLowerCase();
  if (
    normalizedInterpreter !== 'node' &&
    normalizedInterpreter !== 'node.exe'
  ) {
    throw new Error(`unsupported command shim interpreter '${interpreter}'`);
  }

  const siblingNode = resolve(shimDirectory, 'node.exe');
  try {
    await access(siblingNode);
    return siblingNode;
  } catch {
    return resolveWindowsNativeBinary(interpreter);
  }
}

async function resolveWindowsCommand(
  binary: string,
  args: string[],
): Promise<{ binary: string; args: string[] }> {
  const resolvedBinary = await resolveWindowsBinary(binary);
  const extension = extname(resolvedBinary).toLowerCase();
  if (extension !== '.cmd') {
    if (extension !== '.com' && extension !== '.exe') {
      throw new Error(
        `cannot safely execute Windows command '${resolvedBinary}'`,
      );
    }
    return { binary: resolvedBinary, args };
  }

  const target = resolve(
    dirname(resolvedBinary),
    await readCmdShim(resolvedBinary),
  );
  const targetExtension = extname(target).toLowerCase();
  if (
    targetExtension === '.bat' ||
    targetExtension === '.cmd' ||
    targetExtension === '.ps1'
  ) {
    throw new Error(`cannot safely execute command shim target '${target}'`);
  }
  const file = await open(target, 'r');
  const buffer = Buffer.alloc(256);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await file.read(buffer, 0, buffer.length, 0));
  } finally {
    await file.close();
  }
  const [firstLine = ''] = buffer
    .toString('utf8', 0, bytesRead)
    .split(/\r?\n/, 1);
  const shebang = firstLine.match(
    /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?([^ \t]+)\s*$/,
  );
  if (!shebang) {
    if (firstLine.startsWith('#!')) {
      throw new Error(
        `unsupported command shim shebang in '${resolvedBinary}'`,
      );
    }
    if (targetExtension !== '.com' && targetExtension !== '.exe') {
      throw new Error(`unsupported command shim target '${target}'`);
    }
    return { binary: target, args };
  }

  const interpreter = shebang[1];
  if (!interpreter) {
    throw new Error(`missing command shim interpreter in '${resolvedBinary}'`);
  }

  return {
    binary: await resolveWindowsShimInterpreter(
      interpreter,
      dirname(resolvedBinary),
    ),
    args: [target, ...args],
  };
}

/**
 * Execute a CLI command and capture output.
 * Shared helper for all native client implementations.
 */
export async function executeCommand(
  binary: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<NativeCommandResult> {
  let command = { binary, args };
  if (process.platform === 'win32') {
    try {
      command = await resolveWindowsCommand(binary, args);
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to execute ${binary} CLI: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const proc = spawn(command.binary, command.args, {
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

    const [code] = (await once(proc, 'close')) as [number | null];
    const trimmedStderr = stderr.trim();
    return {
      success: code === 0,
      output: stdout.trim(),
      ...(trimmedStderr && { error: trimmedStderr }),
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: `Failed to execute ${binary} CLI: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
