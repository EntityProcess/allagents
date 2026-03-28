import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRepoSkills, discoverWorkspaceSkills } from '../../../src/core/repo-skills.js';

function makeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe('discoverRepoSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-skills-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers skills from default client paths', async () => {
    makeSkill(join(tmpDir, '.claude', 'skills'), 'my-skill', 'A test skill');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('my-skill');
    expect(results[0].description).toBe('A test skill');
    expect(results[0].relativePath).toBe('.claude/skills/my-skill/SKILL.md');
  });

  it('deduplicates skills across clients sharing same path', async () => {
    makeSkill(join(tmpDir, '.agents', 'skills'), 'shared-skill', 'Shared');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['universal', 'vscode'],
    });

    expect(results).toHaveLength(1);
  });

  it('uses custom skill paths when provided', async () => {
    makeSkill(join(tmpDir, 'plugins', 'my-plugin', 'skills'), 'custom-skill', 'Custom');

    const results = await discoverRepoSkills(tmpDir, {
      skillPaths: ['plugins/my-plugin/skills'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('custom-skill');
    expect(results[0].relativePath).toBe('plugins/my-plugin/skills/custom-skill/SKILL.md');
  });

  it('returns empty array when skills disabled', async () => {
    makeSkill(join(tmpDir, '.claude', 'skills'), 'should-not-find', 'Nope');

    const results = await discoverRepoSkills(tmpDir, {
      disabled: true,
    });

    expect(results).toEqual([]);
  });

  it('skips symlinked skill directories', async () => {
    const realSkillDir = join(tmpDir, 'real-skills', 'real-skill');
    mkdirSync(realSkillDir, { recursive: true });
    writeFileSync(
      join(realSkillDir, 'SKILL.md'),
      '---\nname: real-skill\ndescription: Real\n---\n',
    );

    const claudeSkills = join(tmpDir, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync(realSkillDir, join(claudeSkills, 'linked-skill'));

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toEqual([]);
  });

  it('skips skills with invalid frontmatter', async () => {
    const skillDir = join(tmpDir, '.claude', 'skills', 'bad-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# No frontmatter\n');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toEqual([]);
  });

  it('discovers skills from multiple client paths', async () => {
    makeSkill(join(tmpDir, '.claude', 'skills'), 'claude-skill', 'Claude skill');
    makeSkill(join(tmpDir, '.agents', 'skills'), 'agents-skill', 'Agents skill');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude', 'universal'],
    });

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['agents-skill', 'claude-skill']);
  });

  it('returns empty when skill directory does not exist', async () => {
    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toEqual([]);
  });
});

describe('discoverWorkspaceSkills opt-in', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-optin-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips repos where skills is undefined (opt-in)', async () => {
    const repoDir = join(tmpDir, 'my-repo');
    makeSkill(join(repoDir, '.claude', 'skills'), 'some-skill', 'A skill');

    const results = await discoverWorkspaceSkills(
      tmpDir,
      [{ path: './my-repo' }],
      ['claude'],
    );

    expect(results).toEqual([]);
  });

  it('discovers skills when skills: true', async () => {
    const repoDir = join(tmpDir, 'my-repo');
    makeSkill(join(repoDir, '.claude', 'skills'), 'some-skill', 'A skill');

    const results = await discoverWorkspaceSkills(
      tmpDir,
      [{ path: './my-repo', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('some-skill');
  });
});
