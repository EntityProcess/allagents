import { describe, expect, it } from 'bun:test';
import { collectSyncedPaths } from '../../../src/core/sync.js';
import { CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';
import type {
  AgentDedupeRecord,
  CopyResult,
} from '../../../src/core/transform.js';

const deduped: AgentDedupeRecord = {
  name: 'cw-reviewer',
  removedPath: '.github/agents/cw-reviewer.md',
  keptPath: '.github/agents/cw-reviewer.agent.md',
};

describe('collectSyncedPaths with planned agent outcomes', () => {
  it('tracks the successful GitHub output and removes its successfully deduped portable twin', () => {
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

    expect(
      collectSyncedPaths(
        copyResults,
        '/workspace',
        ['copilot'],
        CLIENT_MAPPINGS,
        [deduped],
      ).copilot,
    ).toEqual(['.github/agents/cw-reviewer.agent.md']);
  });

  it('does not invent ownership of a kept path that has no successful copy result', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/workspace/.github/agents/cw-reviewer.md',
        action: 'copied',
      },
    ];

    expect(
      collectSyncedPaths(
        copyResults,
        '/workspace',
        ['copilot'],
        CLIENT_MAPPINGS,
        [deduped],
      ).copilot,
    ).toEqual([]);
  });

  it('keeps tracking portable output when the preferred GitHub copy failed', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/agents/cw-reviewer.md',
        destination: '/workspace/.github/agents/cw-reviewer.md',
        action: 'copied',
      },
      {
        source: '/plugin/.github/agents/cw-reviewer.agent.md',
        destination: '/workspace/.github/agents/cw-reviewer.agent.md',
        action: 'failed',
        error: 'EISDIR',
      },
    ];

    expect(
      collectSyncedPaths(
        copyResults,
        '/workspace',
        ['copilot'],
        CLIENT_MAPPINGS,
      ).copilot,
    ).toEqual(['.github/agents/cw-reviewer.md']);
  });

  it('tracks a GitHub-format-only agent from its individual copy result', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/.github/agents/cw-reviewer.agent.md',
        destination: '/workspace/.github/agents/cw-reviewer.agent.md',
        action: 'copied',
      },
    ];

    expect(
      collectSyncedPaths(
        copyResults,
        '/workspace',
        ['copilot'],
        CLIENT_MAPPINGS,
      ).copilot,
    ).toEqual(['.github/agents/cw-reviewer.agent.md']);
  });

  it('projects a shared agents path for every consuming client', () => {
    const mappings = {
      ...CLIENT_MAPPINGS,
      vscode: CLIENT_MAPPINGS.copilot,
    };
    const copyResults: CopyResult[] = [
      {
        source: '/plugin/.github/agents/cw-reviewer.agent.md',
        destination: '/workspace/.github/agents/cw-reviewer.agent.md',
        action: 'copied',
      },
    ];

    const result = collectSyncedPaths(
      copyResults,
      '/workspace',
      ['copilot', 'vscode'],
      mappings,
    );
    expect(result.copilot).toEqual([
      '.github/agents/cw-reviewer.agent.md',
    ]);
    expect(result.vscode).toEqual([
      '.github/agents/cw-reviewer.agent.md',
    ]);
  });
});
