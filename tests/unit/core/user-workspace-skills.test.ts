import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';

// Mock home directory
const originalHome = process.env.HOME;

describe('user-scope disabledSkills helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-user-test-'));
    process.env.HOME = tmpDir;
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('adds and removes disabled skills in user config', async () => {
    const config = { repositories: [], plugins: [], clients: ['copilot'] };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    // Import after setting HOME
    const { addUserDisabledSkill, removeUserDisabledSkill, getUserDisabledSkills } = await import('../../../src/core/user-workspace.js');

    const addResult = await addUserDisabledSkill('superpowers:brainstorming');
    expect(addResult.success).toBe(true);

    let skills = await getUserDisabledSkills();
    expect(skills).toContain('superpowers:brainstorming');

    const removeResult = await removeUserDisabledSkill('superpowers:brainstorming');
    expect(removeResult.success).toBe(true);

    skills = await getUserDisabledSkills();
    expect(skills).not.toContain('superpowers:brainstorming');
  });
});
