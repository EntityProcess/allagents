import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyHooks } from '../../../src/core/transform.js';

describe('OMP hook sync', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('copies plugin hook factories into the project discovery path', async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-omp-hooks-'));
    const plugin = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const source = join(plugin, 'hooks', 'pre', 'guard.ts');
    await mkdir(join(plugin, 'hooks', 'pre'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(source, 'export default function guard() {}\n');

    const results = await copyHooks(plugin, workspace, 'omp');

    expect(results).toEqual([
      {
        source: join(plugin, 'hooks'),
        destination: join(workspace, '.omp', 'hooks'),
        action: 'copied',
      },
    ]);
    expect(
      await readFile(join(workspace, '.omp', 'hooks', 'pre', 'guard.ts'), 'utf8'),
    ).toBe('export default function guard() {}\n');
  });
});
