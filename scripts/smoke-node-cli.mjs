#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'allagents-node-smoke-'));
const repositoryPath = join(root, 'repository');
const workspacePath = join(root, 'workspace');
const homePath = join(root, 'home');
const cliPath = resolve('dist/index.js');
const env = {
  ...process.env,
  HOME: homePath,
  XDG_CONFIG_HOME: join(homePath, '.config'),
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

try {
  await mkdir(repositoryPath);
  await mkdir(homePath);
  await execFileAsync('git', ['init', repositoryPath], { env });
  await execFileAsync(
    'git',
    ['-C', repositoryPath, 'remote', 'add', 'origin', 'https://github.com/allagentsdev/allagents.git'],
    { env },
  );
  await execFileAsync(process.execPath, [cliPath, 'workspace', 'init', workspacePath], { env });

  const { stdout } = await execFileAsync(
    process.execPath,
    [cliPath, '--json', 'workspace', 'repo', 'add', '../repository'],
    { cwd: workspacePath, env },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    path: '../repository',
    source: 'github',
    repo: 'allagentsdev/allagents',
    description: null,
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
