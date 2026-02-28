import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPluginManifest } from '../../../src/core/plugin.js';

describe('getPluginManifest', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-manifest-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns parsed manifest when plugin.json exists', async () => {
    await writeFile(
      join(testDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', version: '1.0.0', description: 'A test' }),
    );

    const manifest = await getPluginManifest(testDir);

    expect(manifest).not.toBeNull();
    expect(manifest!.name).toBe('test-plugin');
  });

  it('returns manifest with exclude patterns', async () => {
    await writeFile(
      join(testDir, 'plugin.json'),
      JSON.stringify({
        name: 'test-plugin',
        version: '1.0.0',
        description: 'A test',
        exclude: ['.github/instructions/skills.instructions.md'],
      }),
    );

    const manifest = await getPluginManifest(testDir);

    expect(manifest).not.toBeNull();
    expect(manifest!.exclude).toEqual(['.github/instructions/skills.instructions.md']);
  });

  it('returns null when plugin.json does not exist', async () => {
    const manifest = await getPluginManifest(testDir);

    expect(manifest).toBeNull();
  });

  it('returns null when plugin.json is invalid JSON', async () => {
    await writeFile(join(testDir, 'plugin.json'), 'not json');

    const manifest = await getPluginManifest(testDir);

    expect(manifest).toBeNull();
  });
});
