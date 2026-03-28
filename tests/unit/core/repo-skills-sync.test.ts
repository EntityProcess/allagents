import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateAgentFiles } from '../../../src/core/workspace-repo.js';
import { discoverWorkspaceSkills } from '../../../src/core/repo-skills.js';

function makeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe('updateAgentFiles with skills', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-sync-test-'));
    repoDir = join(workspaceDir, 'my-repo');
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('embeds discovered skills in AGENTS.md', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<available_skills>');
    expect(agentsContent).toContain('<name>test-skill</name>');
    expect(agentsContent).toContain('./my-repo/.claude/skills/test-skill/SKILL.md');
  });

  it('uses custom skill paths from workspace.yaml', async () => {
    makeSkill(join(repoDir, 'plugins', 'my-plugin', 'skills'), 'custom', 'Custom skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills:\n      - plugins/my-plugin/skills\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<name>custom</name>');
    expect(agentsContent).toContain('./my-repo/plugins/my-plugin/skills/custom/SKILL.md');
  });

  it('skips repos with skills: false', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'hidden', 'Should not appear');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: false\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('<available_skills>');
  });

  it('omits skills block when repos have no skills', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('<available_skills>');
  });

  it('includes skills from multiple repos', async () => {
    const repoDir2 = join(workspaceDir, 'repo2');
    mkdirSync(repoDir2, { recursive: true });

    makeSkill(join(repoDir, '.claude', 'skills'), 'skill-a', 'First skill');
    makeSkill(join(repoDir2, '.claude', 'skills'), 'skill-b', 'Second skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\n  - path: ./repo2\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<name>skill-a</name>');
    expect(agentsContent).toContain('<name>skill-b</name>');
    expect(agentsContent).toContain('./my-repo/.claude/skills/skill-a/SKILL.md');
    expect(agentsContent).toContain('./repo2/.claude/skills/skill-b/SKILL.md');
  });

  it('renders section heading as Repository Skills', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('## Repository Skills');
    expect(agentsContent).not.toContain('## Workspace Skills');
  });
});

describe('discoverWorkspaceSkills deduplication', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-dedup-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('deduplicates same-name skills, preferring .agents path', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    // repo1 has the skill under .claude/skills
    makeSkill(join(repo1, '.claude', 'skills'), 'my-skill', 'From claude');
    // repo2 has the skill under .agents/skills
    makeSkill(join(repo2, '.agents', 'skills'), 'my-skill', 'From agents');

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude', 'universal'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].location).toContain('.agents/skills/my-skill');
  });

  it('deduplicates same-name skills, preferring larger file when no .agents', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    // repo1 has a small skill
    makeSkill(join(repo1, '.claude', 'skills'), 'my-skill', 'Small');
    // repo2 has a larger skill (more content)
    const largeSkillDir = join(repo2, '.claude', 'skills', 'my-skill');
    mkdirSync(largeSkillDir, { recursive: true });
    writeFileSync(
      join(largeSkillDir, 'SKILL.md'),
      `---\nname: my-skill\ndescription: Large\n---\n\n${'x'.repeat(500)}\n`,
    );

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].description).toBe('Large');
    expect(results[0].location).toContain('./repo2/');
  });

  it('keeps distinct skills from different repos', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    makeSkill(join(repo1, '.claude', 'skills'), 'skill-a', 'First');
    makeSkill(join(repo2, '.claude', 'skills'), 'skill-b', 'Second');

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['skill-a', 'skill-b']);
  });
});
