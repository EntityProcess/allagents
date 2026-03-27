import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateAgentFiles } from '../../../src/core/workspace-repo.js';

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
      'repositories:\n  - path: ./my-repo\nplugins: []\nclients:\n  - claude\n',
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
      'repositories:\n  - path: ./my-repo\n  - path: ./repo2\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<name>skill-a</name>');
    expect(agentsContent).toContain('<name>skill-b</name>');
    expect(agentsContent).toContain('./my-repo/.claude/skills/skill-a/SKILL.md');
    expect(agentsContent).toContain('./repo2/.claude/skills/skill-b/SKILL.md');
  });
});
