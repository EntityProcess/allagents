import { readdir } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve, win32 } from 'node:path';
import { ProfileNameSchema } from '../../models/workspace-config.js';
import type { ProfileLauncherInvocation } from './types.js';
import {
  assertSafeProfilePath,
  fingerprintProfileFile,
  materializeManagedFile,
  type ManagedFileMaterializationResult,
} from './files.js';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:^|_)(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|SIGNATURE|TOKEN)(?:$|_)/i;
const SENSITIVE_FIELD =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;
const SENSITIVE_ARGUMENT =
  /^(?:(?:--?|\/)(?:auth|credential|key|password|secret|signature|token)(?:$|[-_.:=])|(?:auth|credential|key|password|secret|signature|token)\s*=)/i;

function containsCredentialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:', 'ssh:'].includes(url.protocol) &&
      (Boolean(url.username) ||
        Boolean(url.password) ||
        [...url.searchParams.keys()].some((key) => SENSITIVE_FIELD.test(key)))
    );
  } catch {
    return false;
  }
}

function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('Launcher values cannot contain NUL bytes');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  if (value.includes('\0')) throw new Error('Launcher values cannot contain NUL bytes');
  return `'${value.replaceAll("'", "''")}'`;
}

function validateInvocation(invocation: ProfileLauncherInvocation): void {
  if (!invocation.command) throw new Error('Profile launcher command cannot be empty');
  for (const argument of [invocation.command, ...invocation.args]) {
    if (
      containsCredentialUrl(argument) ||
      /\bbearer\s+\S+/i.test(argument) ||
      SENSITIVE_ARGUMENT.test(argument)
    ) {
      throw new Error('Profile launcher arguments cannot contain credentials or secret-bearing options');
    }
  }
  for (const [name, value] of Object.entries(invocation.env)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Invalid profile launcher environment name: ${name}`);
    }
    if (
      value !== undefined &&
      !ENVIRONMENT_REFERENCE.test(value) &&
      (SENSITIVE_ENVIRONMENT_NAME.test(name) || containsCredentialUrl(value))
    ) {
      throw new Error(
        `Profile launcher cannot embed a value for sensitive environment variable ${name}; use an exact \${ENV_VAR} reference`,
      );
    }
  }
}

function posixEnvironmentLines(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (value === undefined) return `unset ${name}`;
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (reference?.[1]) return `export ${name}="\${${reference[1]}}"`;
      return `export ${quotePosix(`${name}=${value}`)}`;
    });
}

function powerShellEnvironmentLines(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (value === undefined) {
        return `Remove-Item -LiteralPath ${quotePowerShell(`Env:${name}`)} -ErrorAction SilentlyContinue`;
      }
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (reference?.[1]) return `$env:${name} = $env:${reference[1]}`;
      return `$env:${name} = ${quotePowerShell(value)}`;
    });
}

export interface RenderedProfileLauncher {
  readonly companion: 'posix' | 'powershell' | 'cmd';
  readonly fileName: string;
  readonly content: string;
  readonly mode: number;
}

export function renderProfileLaunchers(
  basename: string,
  invocation: ProfileLauncherInvocation,
): readonly RenderedProfileLauncher[] {
  const name = ProfileNameSchema.safeParse(basename);
  if (!name.success) {
    throw new Error(
      `Invalid cross-platform profile launcher basename '${basename}': ${name.error.issues[0]?.message ?? 'invalid name'}`,
    );
  }
  validateInvocation(invocation);

  const posixCommand = [invocation.command, ...invocation.args]
    .map(quotePosix)
    .join(' ');
  const powerShellArguments = invocation.args.map(quotePowerShell).join(', ');
  return [
    {
      companion: 'posix',
      fileName: basename,
      content: [
        '#!/bin/sh',
        ...posixEnvironmentLines(invocation.env),
        `exec ${posixCommand} "$@"`,
        '',
      ].join('\n'),
      mode: 0o755,
    },
    {
      companion: 'powershell',
      fileName: `${basename}.ps1`,
      content: [
        "$ErrorActionPreference = 'Stop'",
        'function Resolve-ProfileCommand {',
        '  param([string] $Command)',
        '  $resolved = Get-Command -Name $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1',
        '  $path = $resolved.Source',
        "  if ([IO.Path]::GetExtension($path) -ine '.cmd') {",
        '    return [pscustomobject]@{ Path = $path; Prefix = @() }',
        '  }',
        '  # Avoid cmd.exe argument re-parsing by unwrapping standard package-manager shims.',
        '  $content = Get-Content -LiteralPath $path -Raw',
        `  $match = [regex]::Match($content, ${quotePowerShell('"%(?:~dp0|dp0%)\\\\([^"]+?)"\\s+%\\*')})`,
        "  if (-not $match.Success) { throw \"Cannot safely execute command shim '$path'\" }",
        '  $target = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $path) $match.Groups[1].Value))',
        '  $firstLine = Get-Content -LiteralPath $target -TotalCount 1',
        `  $shebang = [regex]::Match($firstLine, ${quotePowerShell('^#!\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?)?([^ \\t]+)\\s*$')})`,
        '  if ($shebang.Success) {',
        '    $interpreterName = $shebang.Groups[1].Value',
        '    $interpreterBase = [IO.Path]::GetFileNameWithoutExtension($interpreterName)',
        "    if ($interpreterBase -notin @('node', 'bun')) { throw \"Unsupported command shim interpreter '$interpreterName'\" }",
        '    $interpreterExecutable = "$interpreterBase.exe"',
        '    $siblingInterpreter = Join-Path (Split-Path -Parent $path) $interpreterExecutable',
        '    $interpreter = if (Test-Path -LiteralPath $siblingInterpreter -PathType Leaf) { $siblingInterpreter } else { (Get-Command -Name $interpreterExecutable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }',
        '    return [pscustomobject]@{ Path = $interpreter; Prefix = @($target) }',
        '  }',
        '  $extension = [IO.Path]::GetExtension($target)',
        "  if ($extension -notin @('.com', '.exe')) { throw \"Unsupported command shim target '$target'\" }",
        '  return [pscustomobject]@{ Path = $target; Prefix = @() }',
        '}',
        'function ConvertTo-WindowsCommandLineArgument {',
        '  param([AllowEmptyString()][string] $Value)',
        `  if ($Value.Length -gt 0 -and $Value -notmatch '[\\s"]') { return $Value }`,
        `  $escaped = [regex]::Replace($Value, '(\\\\*)"', '$1$1\\"')`,
        `  $escaped = [regex]::Replace($escaped, '(\\\\*)$', '$1$1')`,
        `  return '"' + $escaped + '"'`,
        '}',
        ...powerShellEnvironmentLines(invocation.env),
        `$profileCommand = Resolve-ProfileCommand ${quotePowerShell(invocation.command)}`,
        `$profileArguments = @(${powerShellArguments}) + @($args)`,
        '$allArguments = $profileCommand.Prefix + $profileArguments',
        '$startInfo = [Diagnostics.ProcessStartInfo]::new()',
        '$startInfo.FileName = $profileCommand.Path',
        "$startInfo.Arguments = (($allArguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string] $_) }) -join ' ')",
        '$startInfo.UseShellExecute = $false',
        '$process = [Diagnostics.Process]::Start($startInfo)',
        '$process.WaitForExit()',
        'exit $process.ExitCode',
        '',
      ].join('\r\n'),
      mode: 0o755,
    },
    {
      companion: 'cmd',
      fileName: `${basename}.cmd`,
      content: [
        '@echo off',
        'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dpn0.ps1" %*',
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'),
      mode: 0o755,
    },
  ];
}

export interface LauncherPathDiagnostic {
  readonly onPath: boolean;
  readonly binRoot: string;
  readonly message: string;
}

export function diagnoseLauncherPath(
  binRoot: string,
  pathValue = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): LauncherPathDiagnostic {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const normalize = platform === 'win32'
    ? (value: string) => win32.resolve(value.replace(/^"|"$/g, '')).toLowerCase()
    : (value: string) => resolve(value.replace(/^"|"$/g, ''));
  const normalizedRoot = normalize(binRoot);
  const onPath = pathValue
    .split(pathDelimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => normalize(entry) === normalizedRoot);
  return {
    onPath,
    binRoot: resolve(binRoot),
    message: onPath
      ? `Profile launcher directory is on PATH: ${binRoot}`
      : `Profile launcher directory is not on PATH: ${binRoot}`,
  };
}

export interface InstallProfileLaunchersOptions {
  readonly binRoot: string;
  readonly basename: string;
  readonly invocation: ProfileLauncherInvocation;
  /** Expected content fingerprints keyed by absolute launcher path. */
  readonly previousFingerprints?: Readonly<Record<string, string>>;
  readonly pathValue?: string;
  readonly platform?: NodeJS.Platform;
}

export interface InstalledProfileLauncher {
  readonly companion: RenderedProfileLauncher['companion'];
  readonly path: string;
  readonly result: ManagedFileMaterializationResult;
}

export interface InstallProfileLaunchersResult {
  readonly launchers: readonly InstalledProfileLauncher[];
  readonly path: LauncherPathDiagnostic;
}

async function caseFoldedWindowsPath(path: string): Promise<string> {
  try {
    const expectedName = basename(path).toLowerCase();
    const actualName = (await readdir(dirname(path))).find(
      (entry) => entry.toLowerCase() === expectedName,
    );
    return actualName ? join(dirname(path), actualName) : path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
    throw error;
  }
}

export async function installProfileLaunchers(
  options: InstallProfileLaunchersOptions,
): Promise<InstallProfileLaunchersResult> {
  const platform = options.platform ?? process.platform;
  const rendered = renderProfileLaunchers(options.basename, options.invocation).filter(
    (launcher) =>
      platform === 'win32'
        ? launcher.companion !== 'posix'
        : launcher.companion === 'posix',
  );
  const planned = rendered.map((launcher) => ({
    launcher,
    path: resolve(options.binRoot, launcher.fileName),
  }));

  // Preflight the entire platform-specific set before the first mutation.
  for (const entry of planned) {
    await assertSafeProfilePath(options.binRoot, entry.path);
    const inspectedPath = platform === 'win32'
      ? await caseFoldedWindowsPath(entry.path)
      : entry.path;
    const existingFingerprint = await fingerprintProfileFile(inspectedPath);
    if (!existingFingerprint) continue;
    const expected =
      options.previousFingerprints?.[entry.path] ??
      options.previousFingerprints?.[inspectedPath];
    if (!expected) {
      throw new Error(`Profile launcher collides with an unowned file: ${inspectedPath}`);
    }
    if (existingFingerprint !== expected) {
      throw new Error(`Profile launcher was modified outside AllAgents: ${inspectedPath}`);
    }
  }

  const launchers: InstalledProfileLauncher[] = [];
  for (const entry of planned) {
    const result = await materializeManagedFile({
      root: options.binRoot,
      path: entry.path,
      content: entry.launcher.content,
      mode: entry.launcher.mode,
      ...(options.previousFingerprints?.[entry.path] && {
        previousFingerprint: options.previousFingerprints[entry.path],
      }),
    });
    launchers.push({
      companion: entry.launcher.companion,
      path: entry.path,
      result,
    });
  }
  return {
    launchers,
    path: diagnoseLauncherPath(
      options.binRoot,
      options.pathValue,
      platform,
    ),
  };
}
