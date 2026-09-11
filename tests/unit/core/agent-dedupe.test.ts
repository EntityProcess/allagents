import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dedupeAgentFilesByName } from '../../../src/core/transform.js';

describe('dedupeAgentFilesByName', () => {
  let testDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-agent-dedupe-'));
    agentsDir = join(testDir, '.github', 'agents');
    await mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('removes the plain .md file when a .agent.md file declares the same name', async () => {
    await writeFile(
      join(agentsDir, 'cw-reviewer.md'),
      '---\nname: cw-reviewer\nargument-hint: PR number\n---\n\nportable version',
    );
    await writeFile(
      join(agentsDir, 'cw-reviewer.agent.md'),
      '---\nname: cw-reviewer\n---\n\ngithub-native version',
    );

    const records = await dedupeAgentFilesByName(testDir, '.github/agents/');

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
    await writeFile(
      join(agentsDir, 'cw-coder.md'),
      '---\nname: cw-coder\n---\n\nno agent.md sibling',
    );
    await writeFile(
      join(agentsDir, 'round-table-worker.agent.md'),
      '---\nname: round-table-worker\n---\n\nno plain .md sibling',
    );

    const records = await dedupeAgentFilesByName(testDir, '.github/agents/');

    expect(records).toEqual([]);
    const remaining = await readdir(agentsDir);
    expect(remaining.sort()).toEqual([
      'cw-coder.md',
      'round-table-worker.agent.md',
    ]);
  });

  it('does not delete files whose frontmatter has no readable name field', async () => {
    await writeFile(join(agentsDir, 'broken.md'), 'no frontmatter here');
    await writeFile(
      join(agentsDir, 'broken.agent.md'),
      '---\ndescription: missing a name field\n---\n',
    );

    const records = await dedupeAgentFilesByName(testDir, '.github/agents/');

    expect(records).toEqual([]);
    expect(existsSync(join(agentsDir, 'broken.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'broken.agent.md'))).toBe(true);
  });

  it('reports removals without deleting anything in dry-run mode', async () => {
    await writeFile(
      join(agentsDir, 'layout-agent.md'),
      '---\nname: layout-agent\n---\n',
    );
    await writeFile(
      join(agentsDir, 'layout-agent.agent.md'),
      '---\nname: layout-agent\n---\n',
    );

    const records = await dedupeAgentFilesByName(testDir, '.github/agents/', {
      dryRun: true,
    });

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

  it('returns empty when the agents directory does not exist', async () => {
    const records = await dedupeAgentFilesByName(testDir, '.claude/agents/');
    expect(records).toEqual([]);
  });

  it('matches by frontmatter name, not by filename stem', async () => {
    // Filenames deliberately do not share a stem — only the `name:` field matches.
    await writeFile(
      join(agentsDir, 'legacy-filename.md'),
      '---\nname: cus-gen-dbd-agent\n---\n',
    );
    await writeFile(
      join(agentsDir, 'cus-gen-dbd-agent.agent.md'),
      '---\nname: cus-gen-dbd-agent\n---\n',
    );

    const records = await dedupeAgentFilesByName(testDir, '.github/agents/');

    expect(records).toHaveLength(1);
    expect(records[0]?.removedPath).toBe('.github/agents/legacy-filename.md');
    expect(existsSync(join(agentsDir, 'legacy-filename.md'))).toBe(false);
  });
});
