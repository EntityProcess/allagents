import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace } from '../../../src/core/workspace.js';

/** workspace.yaml content with repositories (triggers agent file creation) */
const YAML_WITH_REPOS =
  'workspace:\n  name: test\nrepositories:\n  - path: ./repo\nclients:\n  - claude\n';

/** workspace.yaml content without repositories (skips agent file creation) */
const YAML_WITHOUT_REPOS =
  'workspace:\n  name: test\nrepositories: []\nclients:\n  - claude\n';

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

    // Create a source template with its own CLAUDE.md and repositories
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), YAML_WITH_REPOS);
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

    // Create a source template with its own AGENTS.md and repositories
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), YAML_WITH_REPOS);
    await writeFile(join(tempSource, 'AGENTS.md'), '# Template agents\nShould not replace.\n');

    await initWorkspace(tempProject, { from: tempSource });

    const result = await readFile(join(tempProject, 'AGENTS.md'), 'utf-8');
    expect(result).toContain('Custom agent rules.');
    expect(result).not.toContain('Template agents');
    expect(result).toContain('WORKSPACE-RULES:START');
  });

  test('copies agent files from source when they do not exist', async () => {
    // Create a source template with AGENTS.md and repositories
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), YAML_WITH_REPOS);
    await writeFile(join(tempSource, 'AGENTS.md'), '# Template agents\nFrom source.\n');

    await initWorkspace(tempProject, { from: tempSource });

    const result = await readFile(join(tempProject, 'AGENTS.md'), 'utf-8');
    expect(result).toContain('From source.');
    expect(result).toContain('WORKSPACE-RULES:START');
  });
});

describe('workspace init skips agent files when repositories is empty', () => {
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

  test('does not create AGENTS.md or CLAUDE.md when repositories is empty', async () => {
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), YAML_WITHOUT_REPOS);
    await writeFile(join(tempSource, 'AGENTS.md'), '# Template agents\n');
    await writeFile(join(tempSource, 'CLAUDE.md'), '# Template claude\n');

    await initWorkspace(tempProject, { from: tempSource });

    // workspace.yaml should exist
    expect(existsSync(join(tempProject, '.allagents', 'workspace.yaml'))).toBe(true);
    // Agent files should NOT be created
    expect(existsSync(join(tempProject, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tempProject, 'CLAUDE.md'))).toBe(false);
  });

  test('does not create AGENTS.md or CLAUDE.md when repositories is absent', async () => {
    const yamlNoReposKey = 'workspace:\n  name: test\nplugins: []\nclients:\n  - claude\n';
    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), yamlNoReposKey);

    await initWorkspace(tempProject, { from: tempSource });

    expect(existsSync(join(tempProject, '.allagents', 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(tempProject, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tempProject, 'CLAUDE.md'))).toBe(false);
  });

  test('does not inject WORKSPACE-RULES into pre-existing agent files when repositories is empty', async () => {
    // Pre-create an AGENTS.md in the target
    const existingContent = '# My Instructions\n';
    await writeFile(join(tempProject, 'AGENTS.md'), existingContent, 'utf-8');

    await mkdir(join(tempSource, '.allagents'), { recursive: true });
    await writeFile(join(tempSource, '.allagents', 'workspace.yaml'), YAML_WITHOUT_REPOS);

    await initWorkspace(tempProject, { from: tempSource });

    // AGENTS.md should remain untouched (no WORKSPACE-RULES injected)
    const result = await readFile(join(tempProject, 'AGENTS.md'), 'utf-8');
    expect(result).toBe(existingContent);
    expect(result).not.toContain('WORKSPACE-RULES');
  });
});
