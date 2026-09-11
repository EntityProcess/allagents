import { describe, it, expect } from 'bun:test';
import { collectSyncedPaths } from '../../../src/core/sync.js';
import { CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';
import type { CopyResult } from '../../../src/core/transform.js';
import type { AgentDedupeRecord } from '../../../src/core/transform.js';

describe('collectSyncedPaths with agentDedupeRecords', () => {
  it('drops the removed .md path and tracks the kept .agent.md path instead', () => {
    const workspacePath = '/workspace';
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/workspace/.github/agents/cw-reviewer.md',
        action: 'copied',
      },
    ];
    const agentDedupeRecords: AgentDedupeRecord[] = [
      {
        name: 'cw-reviewer',
        removedPath: '.github/agents/cw-reviewer.md',
        keptPath: '.github/agents/cw-reviewer.agent.md',
      },
    ];

    const result = collectSyncedPaths(
      copyResults,
      workspacePath,
      ['copilot'],
      CLIENT_MAPPINGS,
      agentDedupeRecords,
    );

    expect(result.copilot).toEqual(['.github/agents/cw-reviewer.agent.md']);
  });

  it('applies the same record to every client sharing that agentsPath', () => {
    const workspacePath = '/workspace';
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/workspace/.github/agents/cw-reviewer.md',
        action: 'copied',
      },
    ];
    const agentDedupeRecords: AgentDedupeRecord[] = [
      {
        name: 'cw-reviewer',
        removedPath: '.github/agents/cw-reviewer.md',
        keptPath: '.github/agents/cw-reviewer.agent.md',
      },
    ];
    // After resolveClientMappings, vscode shares copilot's agentsPath — simulate
    // that here directly so this test doesn't depend on that resolution step.
    const mappings = {
      ...CLIENT_MAPPINGS,
      vscode: CLIENT_MAPPINGS.copilot,
    };

    const result = collectSyncedPaths(
      copyResults,
      workspacePath,
      ['copilot', 'vscode'],
      mappings,
      agentDedupeRecords,
    );

    expect(result.copilot).toEqual(['.github/agents/cw-reviewer.agent.md']);
    expect(result.vscode).toEqual(['.github/agents/cw-reviewer.agent.md']);
  });

  it('is a no-op for clients whose agentsPath does not match the record', () => {
    const workspacePath = '/workspace';
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/home/.claude/agents/cw-reviewer.md',
        action: 'copied',
      },
    ];
    const agentDedupeRecords: AgentDedupeRecord[] = [
      {
        name: 'cw-reviewer',
        removedPath: '.github/agents/cw-reviewer.md',
        keptPath: '.github/agents/cw-reviewer.agent.md',
      },
    ];

    const result = collectSyncedPaths(
      copyResults,
      '/home',
      ['claude'],
      CLIENT_MAPPINGS,
      agentDedupeRecords,
    );

    // claude's own copy of the richer .md agent is untouched by a dedup record
    // that only concerns the .github/agents/ directory.
    expect(result.claude).toEqual(['.claude/agents/cw-reviewer.md']);
  });

  it('does not duplicate the kept path if it was already tracked', () => {
    const workspacePath = '/workspace';
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/workspace/.github/agents/cw-reviewer.md',
        action: 'copied',
      },
      {
        source: '/plugin/.github/agents/cw-reviewer.agent.md',
        destination: '/workspace/.github/agents/cw-reviewer.agent.md',
        action: 'copied',
      },
    ];
    const agentDedupeRecords: AgentDedupeRecord[] = [
      {
        name: 'cw-reviewer',
        removedPath: '.github/agents/cw-reviewer.md',
        keptPath: '.github/agents/cw-reviewer.agent.md',
      },
    ];

    const result = collectSyncedPaths(
      copyResults,
      workspacePath,
      ['copilot'],
      CLIENT_MAPPINGS,
      agentDedupeRecords,
    );

    expect(result.copilot).toEqual(['.github/agents/cw-reviewer.agent.md']);
  });
});
