import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  diagnoseLauncherPath,
  installProfileLaunchers,
  renderProfileLaunchers,
} from '../../../src/core/profile/launcher.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-profile-launcher-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile launchers', () => {
  it('renders POSIX and deterministic Windows companions with exact static quoting and identity', () => {
    const launchers = renderProfileLaunchers('work-profile', {
      command: "C:\\Program Files\\Pi's Runtime\\pi.exe",
      args: ['--profile', 'name with spaces', "quote'value"],
      env: {
        OMP_PROFILE: undefined,
        PI_CODING_AGENT_DIR: "C:\\Profiles\\Pi's Work",
        API_TOKEN: '${RUNTIME_TOKEN}',
      },
    });
    expect(launchers.map((launcher) => launcher.fileName)).toEqual([
      'work-profile',
      'work-profile.ps1',
      'work-profile.cmd',
    ]);
    const posix = launchers[0]?.content ?? '';
    expect(posix).toStartWith('#!/bin/sh\n');
    expect(posix).toContain('unset OMP_PROFILE');
    expect(posix).toContain('export API_TOKEN="${RUNTIME_TOKEN}"');
    expect(posix).toContain(`'quote'"'"'value' "$@"`);
    expect(posix).not.toContain('actual-secret');

    const powershell = launchers[1]?.content ?? '';
    expect(powershell).toContain("$env:API_TOKEN = $env:RUNTIME_TOKEN");
    expect(powershell).toContain("'C:\\Program Files\\Pi''s Runtime\\pi.exe'");
    expect(powershell).toContain("'quote''value' @args");
    expect(powershell).toContain('exit $LASTEXITCODE');

    const cmd = launchers[2]?.content ?? '';
    expect(cmd).toContain('-File "%~dpn0.ps1" %*');
    expect(cmd).toContain('exit /b %ERRORLEVEL%');
    expect(() => renderProfileLaunchers('CON', {
      command: 'pi',
      args: [],
      env: {},
    })).toThrow('Invalid cross-platform');
    for (const valid of ['safe.name', 'profile.cmd', 'profile.ps1']) {
      expect(renderProfileLaunchers(valid, {
        command: 'pi',
        args: [],
        env: {},
      })[0]?.fileName).toBe(valid);
    }
    for (const invalid of ['trailing.', 'profile.PS1', '-leading', '.', '..']) {
      expect(() => renderProfileLaunchers(invalid, {
        command: 'pi',
        args: [],
        env: {},
      })).toThrow('Invalid cross-platform');
    }
  });

  it('does not embed sensitive environment values but accepts exact environment references', () => {
    expect(() => renderProfileLaunchers('safe', {
      command: 'pi',
      args: [],
      env: { API_TOKEN: 'actual-secret' },
    })).toThrow('cannot embed');
    expect(() => renderProfileLaunchers('safe', {
      command: 'pi',
      args: [],
      env: { API_TOKEN: '$RUNTIME_TOKEN' },
    })).toThrow('exact ${ENV_VAR}');
    expect(() => renderProfileLaunchers('safe', {
      command: 'pi',
      args: ['--token=actual-secret'],
      env: {},
    })).toThrow('arguments cannot contain credentials');
    const rendered = renderProfileLaunchers('safe', {
      command: 'pi',
      args: [],
      env: { API_TOKEN: '${RUNTIME_TOKEN}' },
    });
    expect(rendered.map((launcher) => launcher.content).join('\n')).not.toContain('actual-secret');
  });

  it('preflights every companion collision before writing any launcher', async () => {
    const root = await temporaryRoot();
    const binRoot = join(root, 'bin');
    await mkdir(binRoot);
    await writeFile(join(binRoot, 'WORK.CMD'), 'user-owned cmd');
    await expect(installProfileLaunchers({
      binRoot,
      basename: 'work',
      invocation: { command: 'pi', args: [], env: {} },
      platform: 'win32',
    })).rejects.toThrow('collides with an unowned file');
    await expect(readFile(join(binRoot, 'work.ps1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(binRoot, 'work'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(binRoot, 'WORK.CMD'), 'utf8')).toBe('user-owned cmd');
  });

  it('installs only the PowerShell and cmd companions on Windows', async () => {
    const root = await temporaryRoot();
    const binRoot = join(root, 'bin');
    const installed = await installProfileLaunchers({
      binRoot,
      basename: 'work.profile',
      invocation: {
        command: 'omp',
        args: ['--profile', 'work.profile'],
        env: { OMP_PROFILE: undefined },
      },
      platform: 'win32',
      pathValue: `${binRoot};C:\\Windows`,
    });
    expect(installed.launchers.map((launcher) => launcher.companion)).toEqual([
      'powershell',
      'cmd',
    ]);
    expect(await readFile(join(binRoot, 'work.profile.ps1'), 'utf8')).toContain(
      "& 'omp' '--profile' 'work.profile' @args",
    );
    expect(await readFile(join(binRoot, 'work.profile.cmd'), 'utf8')).toContain(
      '-File \"%~dpn0.ps1\" %*',
    );
    await expect(readFile(join(binRoot, 'work.profile'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('forwards arbitrary POSIX arguments, cwd, environment, and exit status', async () => {
    const root = await temporaryRoot();
    const binRoot = join(root, 'bin');
    const workingDirectory = join(root, 'working directory');
    const recorder = join(root, 'record-argv.cjs');
    await mkdir(workingDirectory);
    await writeFile(
      recorder,
      [
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), root: process.env.PROFILE_ROOT, removed: process.env.REMOVE_ME ?? null }));",
        'process.exit(23);',
      ].join('\n'),
      'utf8',
    );
    const installed = await installProfileLaunchers({
      binRoot,
      basename: 'work',
      invocation: {
        command: process.execPath,
        args: [recorder, 'static argument', "static'quote"],
        env: {
          PROFILE_ROOT: "root with spaces and 'quote'",
          REMOVE_ME: undefined,
        },
      },
      pathValue: process.env.PATH,
    });
    expect(installed.launchers).toHaveLength(1);

    const arbitrary = [
      'space value',
      'double"quote',
      "single'quote",
      '$dollar',
      'semi;colon',
      '',
      'unicode-日本語',
    ];
    const child = spawn(join(binRoot, 'work'), arbitrary, {
      cwd: workingDirectory,
      env: { ...process.env, REMOVE_ME: 'ambient' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    const [exitCode] = await once(child, 'close') as [number | null];
    expect(exitCode).toBe(23);
    const result = JSON.parse(Buffer.concat(stdout).toString()) as {
      args: string[];
      cwd: string;
      root: string;
      removed: string | null;
    };
    expect(result.args).toEqual(['static argument', "static'quote", ...arbitrary]);
    expect(result.cwd).toBe(workingDirectory);
    expect(result.root).toBe("root with spaces and 'quote'");
    expect(result.removed).toBeNull();
  });

  it('reports PATH membership without mutating shell startup files', async () => {
    const root = await temporaryRoot();
    const binRoot = join(root, 'bin');
    const shellStartup = join(root, '.profile');
    await writeFile(shellStartup, 'unchanged');
    expect(diagnoseLauncherPath(binRoot, `/usr/bin:${binRoot}`, 'linux').onPath).toBe(true);
    const missing = diagnoseLauncherPath(binRoot, '/usr/bin', 'linux');
    expect(missing.onPath).toBe(false);
    expect(missing.message).toContain('not on PATH');
    expect(diagnoseLauncherPath('C:\\Users\\Me\\bin', 'C:\\Windows;"C:\\Users\\Me\\bin"', 'win32').onPath).toBe(true);
    expect(await readFile(shellStartup, 'utf8')).toBe('unchanged');
    expect(missing.binRoot).toBe(resolve(binRoot));
  });
});
