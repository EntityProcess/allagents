import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace } from '../../../src/core/workspace.js';

describe('workspace init preserves existing agent files', () => {
  let tempProject: string;
  let tempSource: string;

  beforeEach(async () => {
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-init-'));
    tempSource = await mkdtemp(join(tmpdir(), 'allagents-src-'));
  });

  afterEach(async () => {
    await rm(tempProject, { recursive: true, force: true });
    await rm(tempSource, { recursive: true, force: true });
  });

  test('does not overwrite existing CLAUDE.md', async () => {
    const existingContent = '# My Project\n\nExisting instructions here.\n';
    await writeFile(join(tempProject, 'CLAUDE.md'), existingContent, 'utf-8');

    // Create a source template with its own CLAUDE.md
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(
      join(tempSource, '.allagents', 'workspace.yaml'),
      'workspace:\n  name: test\nclients:\n  - claude\n',
    );
    await writeFile(join(tempSource, 'CLAUDE.md'), '# Template content\nShould not replace user content.\n');

    await initWorkspace(tempProject, { from: tempSource });

    const result = await readFile(join(tempProject, 'CLAUDE.md'), 'utf-8');
    expect(result).toContain('Existing instructions here.');
    expect(result).not.toContain('Template content');
    // Workspace rules should still be injected
    expect(result).toContain('WORKSPACE-RULES:START');
  });

  test('does not overwrite existing AGENTS.md', async () => {
    const existingContent = '# Agent Instructions\n\nCustom agent rules.\n';
    await writeFile(join(tempProject, 'AGENTS.md'), existingContent, 'utf-8');

    // Create a source template with its own AGENTS.md
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(
      join(tempSource, '.allagents', 'workspace.yaml'),
      'workspace:\n  name: test\nclients:\n  - claude\n',
    );
    await writeFile(join(tempSource, 'AGENTS.md'), '# Template agents\nShould not replace.\n');

    await initWorkspace(tempProject, { from: tempSource });

    const result = await readFile(join(tempProject, 'AGENTS.md'), 'utf-8');
    expect(result).toContain('Custom agent rules.');
    expect(result).not.toContain('Template agents');
    expect(result).toContain('WORKSPACE-RULES:START');
  });

  test('copies agent files from source when they do not exist', async () => {
    // Create a source template with AGENTS.md
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(
      join(tempSource, '.allagents', 'workspace.yaml'),
      'workspace:\n  name: test\nclients:\n  - claude\n',
    );
    await writeFile(join(tempSource, 'AGENTS.md'), '# Template agents\nFrom source.\n');

    await initWorkspace(tempProject, { from: tempSource });

    const result = await readFile(join(tempProject, 'AGENTS.md'), 'utf-8');
    expect(result).toContain('From source.');
    expect(result).toContain('WORKSPACE-RULES:START');
  });
});
