import { describe, it, expect } from 'bun:test';
import { execa } from 'execa';
import { resolve } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = resolve(import.meta.dir, '../../dist/index.js');

async function runCli(args: string[], options?: { env?: Record<string, string>; cwd?: string }) {
  try {
    const result = await execa('node', [CLI, ...args], {
      ...(options?.env && { env: { ...process.env, ...options.env } }),
      ...(options?.cwd && { cwd: options.cwd }),
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: any) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', exitCode: error.exitCode || 1 };
  }
}

describe('workspace init preserves existing files', () => {
  it('does not overwrite existing CLAUDE.md when using --from', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-init-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-src-'));
    try {
      // Create existing CLAUDE.md in target
      const existingContent = '# My Project\n\nExisting instructions that must survive init.\n';
      await writeFile(join(projectDir, 'CLAUDE.md'), existingContent, 'utf-8');

      // Create a template source with its own CLAUDE.md
      await mkdir(join(sourceDir, '.allagents'), { recursive: true });
      await writeFile(
        join(sourceDir, '.allagents', 'workspace.yaml'),
        'workspace:\n  name: test\nclients:\n  - claude\n',
      );
      await writeFile(join(sourceDir, 'CLAUDE.md'), '# Template\nThis should NOT replace user content.\n');

      const { exitCode } = await runCli(['workspace', 'init', '--from', sourceDir], { cwd: projectDir });
      expect(exitCode).toBe(0);

      const result = await readFile(join(projectDir, 'CLAUDE.md'), 'utf-8');
      expect(result).toContain('Existing instructions that must survive init.');
      expect(result).not.toContain('Template');
      expect(result).toContain('WORKSPACE-RULES:START');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing AGENTS.md when using --from', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-init-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-src-'));
    try {
      // Create existing AGENTS.md in target
      const existingContent = '# Agent Rules\n\nCustom agent instructions that must survive init.\n';
      await writeFile(join(projectDir, 'AGENTS.md'), existingContent, 'utf-8');

      // Create a template source with its own AGENTS.md
      await mkdir(join(sourceDir, '.allagents'), { recursive: true });
      await writeFile(
        join(sourceDir, '.allagents', 'workspace.yaml'),
        'workspace:\n  name: test\nclients:\n  - claude\n',
      );
      await writeFile(join(sourceDir, 'AGENTS.md'), '# Template\nThis should NOT replace user content.\n');

      const { exitCode } = await runCli(['workspace', 'init', '--from', sourceDir], { cwd: projectDir });
      expect(exitCode).toBe(0);

      const result = await readFile(join(projectDir, 'AGENTS.md'), 'utf-8');
      expect(result).toContain('Custom agent instructions that must survive init.');
      expect(result).not.toContain('Template');
      expect(result).toContain('WORKSPACE-RULES:START');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
