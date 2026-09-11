import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dedupeAgentFilesByName,
  type AgentDedupeSource,
} from '../../../src/core/transform.js';

describe('dedupeAgentFilesByName', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-agent-dedupe-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    agentsDir = join(workspaceDir, '.github', 'agents');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Write a plugin's root agents/<name>.md source file. */
  async function writePortableAgent(name: string, content: string) {
    const dir = join(pluginDir, 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content);
  }

  /** Write a plugin's .github/agents/<name>.agent.md source file. */
  async function writeGithubAgent(name: string, content: string) {
    const dir = join(pluginDir, '.github', 'agents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content);
  }

  /** Simulate copyAgents/copyGitHubContent having already run for these files. */
  async function materializeDestination(names: string[]) {
    for (const name of names) {
      const source = existsSync(join(pluginDir, 'agents', name))
        ? join(pluginDir, 'agents', name)
        : join(pluginDir, '.github', 'agents', name);
      await writeFile(join(agentsDir, name), await readFile(source, 'utf-8'));
    }
  }

  it('removes the plain .md file when a .agent.md file declares the same name', async () => {
    await writePortableAgent(
      'cw-reviewer.md',
      '---\nname: cw-reviewer\nargument-hint: PR number\n---\n\nportable version',
    );
    await writeGithubAgent(
      'cw-reviewer.agent.md',
      '---\nname: cw-reviewer\n---\n\ngithub-native version',
    );
    await materializeDestination(['cw-reviewer.md', 'cw-reviewer.agent.md']);

    const sources: AgentDedupeSource[] = [{ pluginPath: pluginDir }];
    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      sources,
    );

    expect(records).toEqual([
      {
        name: 'cw-reviewer',
        removedPath: '.github/agents/cw-reviewer.md',
        keptPath: '.github/agents/cw-reviewer.agent.md',
      },
    ]);
    expect(existsSync(join(agentsDir, 'cw-reviewer.md'))).toBe(false);
    expect(existsSync(join(agentsDir, 'cw-reviewer.agent.md'))).toBe(true);
  });

  it('leaves files alone when only one variant exists', async () => {
    await writePortableAgent('cw-coder.md', '---\nname: cw-coder\n---\n');
    await writeGithubAgent(
      'round-table-worker.agent.md',
      '---\nname: round-table-worker\n---\n',
    );
    await materializeDestination(['cw-coder.md', 'round-table-worker.agent.md']);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }],
    );

    expect(records).toEqual([]);
    const remaining = await readdir(agentsDir);
    expect(remaining.sort()).toEqual([
      'cw-coder.md',
      'round-table-worker.agent.md',
    ]);
  });

  it('does not delete files whose frontmatter has no readable name field', async () => {
    await writePortableAgent('broken.md', 'no frontmatter here');
    await writeGithubAgent(
      'broken.agent.md',
      '---\ndescription: missing a name field\n---\n',
    );
    await materializeDestination(['broken.md', 'broken.agent.md']);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }],
    );

    expect(records).toEqual([]);
    expect(existsSync(join(agentsDir, 'broken.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'broken.agent.md'))).toBe(true);
  });

  it('reports removals without deleting anything in dry-run mode', async () => {
    await writePortableAgent('layout-agent.md', '---\nname: layout-agent\n---\n');
    await writeGithubAgent(
      'layout-agent.agent.md',
      '---\nname: layout-agent\n---\n',
    );
    await materializeDestination(['layout-agent.md', 'layout-agent.agent.md']);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }],
      { dryRun: true },
    );

    expect(records).toEqual([
      {
        name: 'layout-agent',
        removedPath: '.github/agents/layout-agent.md',
        keptPath: '.github/agents/layout-agent.agent.md',
      },
    ]);
    // Dry run must not touch disk.
    expect(existsSync(join(agentsDir, 'layout-agent.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'layout-agent.agent.md'))).toBe(true);
  });

  it('reports what a fresh sync would dedupe even before any destination file exists', async () => {
    // Regression test: dry-run must reason from plugin *source* files, not
    // the destination directory, so a brand-new workspace still gets an
    // accurate preview instead of silently finding nothing.
    await writePortableAgent(
      'message-mapper.md',
      '---\nname: message-mapper\n---\n',
    );
    await writeGithubAgent(
      'message-mapper.agent.md',
      '---\nname: message-mapper\n---\n',
    );
    // Deliberately not calling materializeDestination() — agentsDir is empty.

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }],
      { dryRun: true },
    );

    expect(records).toEqual([
      {
        name: 'message-mapper',
        removedPath: '.github/agents/message-mapper.md',
        keptPath: '.github/agents/message-mapper.agent.md',
      },
    ]);
  });

  it('never touches a file the given plugins do not ship, even if it collides on disk', async () => {
    // A user (or an unrelated, unconfigured plugin) created these directly in
    // the destination directory. No plugin in `sources` ships either file.
    await writeFile(
      join(agentsDir, 'foo.md'),
      '---\nname: foo\n---\n\nuser-owned',
    );
    await writeFile(
      join(agentsDir, 'foo.agent.md'),
      '---\nname: foo\n---\n\nuser-owned',
    );

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }], // pluginDir has no agents/ or .github/agents/ at all
    );

    expect(records).toEqual([]);
    expect(existsSync(join(agentsDir, 'foo.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'foo.agent.md'))).toBe(true);
  });

  it('excludes candidates matching the plugin exclude patterns', async () => {
    await writePortableAgent(
      'excluded-agent.md',
      '---\nname: excluded-agent\n---\n',
    );
    await writeGithubAgent(
      'excluded-agent.agent.md',
      '---\nname: excluded-agent\n---\n',
    );
    await materializeDestination(['excluded-agent.md', 'excluded-agent.agent.md']);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir, exclude: ['agents/**'] }],
    );

    // The root agents/*.md candidate is excluded, so there is no plain .md
    // candidate left to collapse — the .github/agents/*.agent.md one is
    // untouched either way.
    expect(records).toEqual([]);
    expect(existsSync(join(agentsDir, 'excluded-agent.md'))).toBe(true);
  });

  it('skips a source entirely when fileArtifacts marks it as not provided', async () => {
    await writePortableAgent('gated.md', '---\nname: gated\n---\n');
    await writeGithubAgent('gated.agent.md', '---\nname: gated\n---\n');
    await materializeDestination(['gated.md', 'gated.agent.md']);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [
        {
          pluginPath: pluginDir,
          fileArtifacts: {
            commands: true,
            skills: true,
            hooks: true,
            agents: false, // this marketplace entry does not declare agents
            mcpServers: true,
            github: true,
          },
        },
      ],
    );

    expect(records).toEqual([]);
    expect(existsSync(join(agentsDir, 'gated.md'))).toBe(true);
  });

  it('matches by frontmatter name, not by filename stem', async () => {
    // Filenames deliberately do not share a stem — only the `name:` field matches.
    await writePortableAgent(
      'legacy-filename.md',
      '---\nname: cus-gen-dbd-agent\n---\n',
    );
    await writeGithubAgent(
      'cus-gen-dbd-agent.agent.md',
      '---\nname: cus-gen-dbd-agent\n---\n',
    );
    await materializeDestination([
      'legacy-filename.md',
      'cus-gen-dbd-agent.agent.md',
    ]);

    const records = await dedupeAgentFilesByName(
      workspaceDir,
      '.github/agents/',
      [{ pluginPath: pluginDir }],
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.removedPath).toBe('.github/agents/legacy-filename.md');
    expect(existsSync(join(agentsDir, 'legacy-filename.md'))).toBe(false);
  });
});
