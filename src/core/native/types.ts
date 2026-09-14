import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, open } from 'node:fs/promises';
import { delimiter, dirname, extname, resolve } from 'node:path';
import readCmdShim from 'read-cmd-shim';

export type NativeScope = 'user' | 'project';
export type NativeResourceKind = 'plugin' | 'package';

export interface NativeCommandOptions {
  cwd?: string;
  /**
   * Overlay the inherited process environment. Undefined removes a variable,
   * which is required when an ordinary client operation must neutralize an
   * ambient profile selector.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface NativeCommandResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface NativeOperationContext {
  client: string;
  scope: NativeScope;
  nativeScope: string;
  root: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  roots?: Readonly<Record<string, string>>;
}

export interface NativeResource {
  kind: NativeResourceKind;
  requestedIdentity: string;
  resolvedIdentity: string;
  context: NativeOperationContext;
  provenance: Readonly<Record<string, string>>;
}

export interface NativeSourceResolution {
  success: boolean;
  resource?: NativeResource;
  error?: string;
}

export type NativeObservationStatus =
  | 'installed'
  | 'configured-missing'
  | 'disabled'
  | 'unusable';

export interface NativeResourceObservation {
  resource: NativeResource;
  status: NativeObservationStatus;
  installedPath?: string;
  error?: string;
}

export interface NativeInspectionResult {
  success: boolean;
  resources: NativeResource[];
  error?: string;
  /**
   * Configured resources that are not safe to credit as installed. Adapters
   * omit this when their native inventory has no richer observation model.
   */
  observations?: NativeResourceObservation[];
}

export interface NativeMutationResult {
  success: boolean;
  error?: string;
  registrations?: string[];
}

export type NativeEffectAction =
  | 'registered'
  | 'installed'
  | 'configured-missing'
  | 'disabled'
  | 'unusable'
  | 'unchanged'
  | 'updated'
  | 'removed'
  | 'retained'
  | 'would-register'
  | 'would-install'
  | 'would-update'
  | 'would-remove'
  | 'failed'
  | 'unknown';

export type NativeEffectPhase =
  | 'inspection'
  | 'registration'
  | 'install'
  | 'update'
  | 'remove'
  | 'state';

export interface NativeEffect {
  action: NativeEffectAction;
  resource: NativeResource;
  phase?: NativeEffectPhase;
  changed?: boolean;
  error?: string;
}

export interface NativeEffectData {
  action: NativeEffectAction;
  phase: NativeEffectPhase;
  changed: boolean;
  client: string;
  scope: NativeScope;
  nativeScope: string;
  kind: NativeResourceKind;
  requestedIdentity: string;
  resolvedIdentity: string;
  root: string;
  provenance: Readonly<Record<string, string>>;
  error?: string;
}

function defaultEffectPhase(action: NativeEffectAction): NativeEffectPhase {
  switch (action) {
    case 'registered':
    case 'would-register':
      return 'registration';
    case 'installed':
    case 'would-install':
      return 'install';
    case 'updated':
    case 'would-update':
      return 'update';
    case 'removed':
    case 'would-remove':
      return 'remove';
    case 'retained':
      return 'state';
    default:
      return 'inspection';
  }
}

function defaultEffectChanged(action: NativeEffectAction): boolean {
  return (
    action === 'registered' ||
    action === 'installed' ||
    action === 'updated' ||
    action === 'removed'
  );
}

function stripNativeTerminalControls(value: string): string {
  const safe: string[] = [];
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5b) {
      let end = index + 2;
      while (
        value.charCodeAt(end) >= 0x30 &&
        value.charCodeAt(end) <= 0x3f
      ) {
        end++;
      }
      while (
        value.charCodeAt(end) >= 0x20 &&
        value.charCodeAt(end) <= 0x2f
      ) {
        end++;
      }
      const final = value.charCodeAt(end);
      if (final >= 0x40 && final <= 0x7e) {
        index = end + 1;
        continue;
      }
    }

    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      index++;
      continue;
    }
    safe.push(value.charAt(index));
    index++;
  }
  return safe.join('');
}

/**
 * Keep native failures single-line and free of terminal control sequences so
 * the same safe value can be emitted in human and structured output.
 */
export function sanitizeNativeError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const sanitized = stripNativeTerminalControls(error)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
  return sanitized || undefined;
}

const SENSITIVE_PROVENANCE_KEY =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

export function sanitizeNativeProvenance(
  provenance: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(provenance)) {
    if (SENSITIVE_PROVENANCE_KEY.test(key)) continue;
    let value = rawValue;
    try {
      const url = new URL(rawValue);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ssh:') {
        url.username = '';
        url.password = '';
        for (const queryKey of [...url.searchParams.keys()]) {
          if (SENSITIVE_PROVENANCE_KEY.test(queryKey)) {
            url.searchParams.delete(queryKey);
          }
        }
        url.searchParams.sort();
        url.hash = '';
        value = url.toString();
      }
    } catch {
      // Non-URL provenance is retained unless its key is sensitive.
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function toNativeEffectData(effect: NativeEffect): NativeEffectData {
  const { resource } = effect;
  const error = sanitizeNativeError(effect.error);
  return {
    action: effect.action,
    phase: effect.phase ?? defaultEffectPhase(effect.action),
    changed: effect.changed ?? defaultEffectChanged(effect.action),
    client: resource.context.client,
    scope: resource.context.scope,
    nativeScope: resource.context.nativeScope,
    kind: resource.kind,
    requestedIdentity: resource.requestedIdentity,
    resolvedIdentity: resource.resolvedIdentity,
    root: resource.context.root,
    provenance: sanitizeNativeProvenance(resource.provenance),
    ...(error && { error }),
  };
}

export interface NativeSyncResult {
  success: boolean;
  effects: NativeEffect[];
}

export interface NativeClient {
  readonly client: string;

  /** Check whether the CLI and required lifecycle commands are available. */
  isAvailable(context?: NativeOperationContext): Promise<boolean>;

  /** Whether this client supports the given AllAgents scope. */
  supportsScope(scope: NativeScope): boolean;

  /**
   * Classify and normalize a configured source without mutating or fetching it.
   * A failed result means explicit native installation is unsupported.
   */
  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance?: Readonly<Record<string, string>>,
  ): NativeSourceResolution;

  /** Inspect exact live native state for one selected client/scope/root. */
  inspect(context: NativeOperationContext): Promise<NativeInspectionResult>;

  /** Install one absent resource. */
  install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult>;

  /** Update only the selected resource. */
  update(
    resource: NativeResource,
    current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult>;

  /** Remove only the selected observed resource. */
  remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult>;
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
  options: NativeCommandOptions = {},
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
        exitCode: null,
        signal: null,
      };
    }
  }

  try {
    const env = { ...process.env };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const proc = spawn(command.binary, command.args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on('data', (data: Buffer) => {
      stdout.push(data);
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr.push(data);
    });

    const [code, signal] = (await once(proc, 'close')) as [
      number | null,
      NodeJS.Signals | null,
    ];
    const trimmedStderr = Buffer.concat(stderr).toString().trim();
    return {
      success: code === 0,
      output: Buffer.concat(stdout).toString().trim(),
      ...(trimmedStderr && { error: trimmedStderr }),
      exitCode: code,
      signal,
    };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: `Failed to execute ${binary} CLI: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: null,
      signal: null,
    };
  }
}

export function mergeNativeSyncResults(
  results: NativeSyncResult[],
): NativeSyncResult {
  return {
    success: results.every((result) => result.success),
    effects: results.flatMap((result) => result.effects),
  };
}
