import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

interface TreeEntry {
  path: string;
  type: 'directory' | 'file' | 'symlink';
  contents?: string;
}

function snapshotTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const snapshotPath = relative(root, path);
      if (entry.isDirectory()) {
        entries.push({ path: snapshotPath, type: 'directory' });
        visit(path);
      } else if (entry.isSymbolicLink()) {
        entries.push({
          path: snapshotPath,
          type: 'symlink',
          contents: readlinkSync(path),
        });
      } else {
        entries.push({
          path: snapshotPath,
          type: 'file',
          contents: readFileSync(path).toString('base64'),
        });
      }
    }
  }

  visit(root);
  return entries;
}

describe('profile list read-only e2e', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not check for updates, prompt, or mutate the isolated filesystem', () => {
    const root = mkdtempSync(join(tmpdir(), 'allagents-profile-list-e2e-'));
    roots.push(root);
    const homeDir = join(root, 'home');
    const workspaceDir = join(root, 'workspace');
    const configDir = join(homeDir, '.allagents');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(configDir, 'version-check.json'),
      JSON.stringify({
        latestVersion: '9999.0.0',
        lastCheckedAt: new Date().toISOString(),
      }),
    );

    const before = snapshotTree(root);
    const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
    const proc = Bun.spawnSync(['bun', 'run', cliEntry, 'profile', 'list'], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        ALLAGENTS_TEST_HOME: homeDir,
        HOME: homeDir,
        USERPROFILE: homeDir,
        XDG_CACHE_HOME: join(homeDir, '.cache'),
        XDG_CONFIG_HOME: join(homeDir, '.config'),
        XDG_DATA_HOME: join(homeDir, '.local', 'share'),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        XDG_STATE_HOME: join(homeDir, '.local', 'state'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    const output = `${stdout}\n${stderr}`;

    expect(proc.exitCode).toBe(0);
    expect(stdout).toBe('No profiles found.\n');
    expect(stderr).toBe('');
    expect(output).not.toContain('Update available:');
    expect(output).not.toContain('Select a profile');
    expect(snapshotTree(root)).toEqual(before);
  });
});
