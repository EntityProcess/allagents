import { describe, expect, test } from 'bun:test';
import { formatMcpResult, formatNativeResult, classifyCopyResults, formatArtifactLines, formatPluginArtifacts, formatSyncSummary, formatDeletedArtifacts, formatPluginHeader } from '../../../src/cli/format-sync.js';
import type { CopyResult } from '../../../src/core/transform.js';
import type { SyncResult, DeletedArtifact, PluginSyncResult } from '../../../src/core/sync.js';
import type { McpMergeResult } from '../../../src/core/vscode-mcp.js';
import type { NativeSyncResult } from '../../../src/core/native/types.js';

function makeResult(overrides: Partial<McpMergeResult> = {}): McpMergeResult {
  return {
    added: 0,
    skipped: 0,
    overwritten: 0,
    removed: 0,
    warnings: [],
    addedServers: [],
    skippedServers: [],
    overwrittenServers: [],
    removedServers: [],
    trackedServers: [],
    ...overrides,
  };
}

describe('formatMcpResult', () => {
  test('returns empty array when no changes', () => {
    expect(formatMcpResult(makeResult())).toEqual([]);
  });

  test('shows added servers', () => {
    const lines = formatMcpResult(makeResult({
      added: 2,
      addedServers: ['server1', 'server2'],
    }));

    expect(lines).toEqual([
      'MCP servers: 2 added',
      '  + server1',
      '  + server2',
    ]);
  });

  test('shows all change types and file modified', () => {
    const lines = formatMcpResult(makeResult({
      added: 1,
      overwritten: 1,
      removed: 1,
      skipped: 1,
      addedServers: ['new'],
      overwrittenServers: ['updated'],
      removedServers: ['old'],
      skippedServers: ['conflict'],
      configPath: '/path/to/mcp.json',
    }));

    expect(lines).toEqual([
      'MCP servers: 1 added, 1 updated, 1 removed, 1 skipped',
      '  + new',
      '  ~ updated',
      '  - old',
      'File modified: /path/to/mcp.json',
    ]);
  });

  test('omits file modified when configPath is not set', () => {
    const lines = formatMcpResult(makeResult({
      added: 1,
      addedServers: ['server1'],
    }));

    expect(lines.some((l) => l.includes('File modified'))).toBe(false);
  });

  test('displays vscode scope as vscode, not copilot', () => {
    const lines = formatMcpResult(makeResult({
      added: 1,
      addedServers: ['deepwiki'],
    }), 'vscode');

    expect(lines[0]).toBe('MCP servers (vscode): 1 added');
  });
});

describe('classifyCopyResults', () => {
  test('classifies skills, commands, agents, hooks by client from destination path', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/commands/commit.md', destination: '/workspace/.claude/commands/commit.md', action: 'copied' },
      { source: '/plugin/commands/review.md', destination: '/workspace/.claude/commands/review.md', action: 'copied' },
      { source: '/plugin/skills/brainstorming', destination: '/workspace/.claude/skills/brainstorming', action: 'copied' },
      { source: '/plugin/agents/reviewer.md', destination: '/workspace/.claude/agents/reviewer.md', action: 'copied' },
      { source: '/plugin/hooks', destination: '/workspace/.claude/hooks/', action: 'copied' },
      { source: '/plugin/agents/reviewer.md', destination: '/workspace/.github/agents/reviewer.md', action: 'copied' },
      { source: '/plugin/hooks', destination: '/workspace/.github/hooks/', action: 'copied' },
    ];

    const result = classifyCopyResults(copyResults);

    expect(result.get('claude')).toEqual({ skills: 1, commands: 2, agents: 1, hooks: 1 });
    expect(result.get('copilot')).toEqual({ skills: 0, commands: 0, agents: 1, hooks: 1 });
  });

  test('ignores non-copied results', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/skills/foo', destination: '/workspace/.claude/skills/foo', action: 'failed', error: 'oops' },
      { source: '/plugin/skills/bar', destination: '/workspace/.claude/skills/bar', action: 'skipped' },
    ];

    const result = classifyCopyResults(copyResults);
    expect(result.size).toBe(0);
  });

  test('aliases vscode to copilot in display output', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/skills/a', destination: '/workspace/.agents/skills/a', action: 'copied' },
      { source: '/plugin/skills/b', destination: '/workspace/.agents/skills/b', action: 'copied' },
    ];

    const result = classifyCopyResults(copyResults);
    // vscode paths (.agents/skills/) should be classified as copilot
    expect(result.has('vscode')).toBe(false);
    expect(result.get('copilot')).toEqual({ skills: 2, commands: 0, agents: 0, hooks: 0 });
  });

  test('merges vscode and copilot artifact counts', () => {
    const copyResults: CopyResult[] = [
      // vscode destination (.agents/skills/)
      { source: '/plugin/skills/a', destination: '/workspace/.agents/skills/a', action: 'copied' },
      // copilot destinations (.github/skills/ and .github/agents/)
      { source: '/plugin/skills/b', destination: '/workspace/.github/skills/b', action: 'copied' },
      { source: '/plugin/agents/c.md', destination: '/workspace/.github/agents/c.md', action: 'copied' },
    ];

    const result = classifyCopyResults(copyResults);
    expect(result.has('vscode')).toBe(false);
    expect(result.get('copilot')).toEqual({ skills: 2, commands: 0, agents: 1, hooks: 0 });
  });

  test('handles user-scope paths', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/skills/foo', destination: '/home/user/.codex/skills/foo', action: 'copied' },
      { source: '/plugin/skills/bar', destination: '/home/user/.codex/skills/bar', action: 'copied' },
    ];

    const result = classifyCopyResults(copyResults);
    expect(result.get('codex')).toEqual({ skills: 2, commands: 0, agents: 0, hooks: 0 });
  });
});

describe('formatArtifactLines', () => {
  test('formats per-client artifact counts', () => {
    const counts = new Map([
      ['claude', { skills: 3, commands: 2, agents: 1, hooks: 1 }],
      ['copilot', { skills: 3, commands: 0, agents: 1, hooks: 0 }],
    ]);

    const lines = formatArtifactLines(counts);
    expect(lines).toEqual([
      '  claude: 2 commands, 3 skills, 1 agent, 1 hook',
      '  copilot: 3 skills, 1 agent',
    ]);
  });

  test('uses singular form for count of 1', () => {
    const counts = new Map([
      ['claude', { skills: 1, commands: 1, agents: 1, hooks: 1 }],
    ]);

    const lines = formatArtifactLines(counts);
    expect(lines).toEqual(['  claude: 1 command, 1 skill, 1 agent, 1 hook']);
  });

  test('omits zero-count artifact types', () => {
    const counts = new Map([
      ['codex', { skills: 5, commands: 0, agents: 0, hooks: 0 }],
    ]);

    const lines = formatArtifactLines(counts);
    expect(lines).toEqual(['  codex: 5 skills']);
  });
});

describe('formatPluginArtifacts', () => {
  test('returns artifact lines for copied results', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/skills/a', destination: '/workspace/.claude/skills/a', action: 'copied' },
      { source: '/plugin/skills/b', destination: '/workspace/.claude/skills/b', action: 'copied' },
    ];

    const lines = formatPluginArtifacts(copyResults);
    expect(lines).toEqual(['  claude: 2 skills']);
  });

  test('returns empty for no copied results', () => {
    expect(formatPluginArtifacts([])).toEqual([]);
  });

  test('falls back to file count for unclassifiable destinations', () => {
    const copyResults: CopyResult[] = [
      { source: '/plugin/something.txt', destination: '/workspace/something.txt', action: 'copied' },
    ];

    const lines = formatPluginArtifacts(copyResults);
    expect(lines).toEqual(['  Copied: 1 file']);
  });
});

describe('formatSyncSummary', () => {
  test('returns empty when no failures/generated/skipped', () => {
    const result: SyncResult = {
      success: true,
      pluginResults: [{
        plugin: 'test-plugin',
        resolved: '/tmp/test-plugin',
        success: true,
        copyResults: [
          { source: '/plugin/skills/a', destination: '/workspace/.claude/skills/a', action: 'copied' },
        ],
      }],
      totalCopied: 1,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };

    const lines = formatSyncSummary(result);
    expect(lines).toEqual([]);
  });

  test('includes failed and generated counts', () => {
    const result: SyncResult = {
      success: false,
      pluginResults: [{
        plugin: 'test-plugin',
        resolved: '/tmp/test-plugin',
        success: false,
        copyResults: [
          { source: '/plugin/skills/a', destination: '/workspace/.claude/skills/a', action: 'copied' },
          { source: '/plugin/skills/b', destination: '/workspace/.claude/skills/b', action: 'failed', error: 'oops' },
        ],
      }],
      totalCopied: 1,
      totalFailed: 1,
      totalSkipped: 0,
      totalGenerated: 1,
    };

    const lines = formatSyncSummary(result);
    expect(lines).toEqual([
      '  Total generated: 1',
      '  Total failed: 1',
    ]);
  });
});

describe('formatNativeResult', () => {
  test('includes provider name when present on failed native installs', () => {
    const result: NativeSyncResult = {
      marketplacesAdded: [],
      pluginsInstalled: [],
      pluginsFailed: [
        { client: 'copilot', plugin: 'glow@wtg-ai-prompts', error: 'boom' },
      ],
      skipped: [],
    };

    expect(formatNativeResult(result)).toEqual([
      '  ✗ [copilot] glow@wtg-ai-prompts: boom',
    ]);
  });
});

describe('formatDeletedArtifacts', () => {
  test('returns empty array when no artifacts deleted', () => {
    expect(formatDeletedArtifacts([])).toEqual([]);
  });

  test('formats a single deleted skill', () => {
    const artifacts: DeletedArtifact[] = [
      { client: 'claude', type: 'skill', name: 'browser-automation' },
    ];
    expect(formatDeletedArtifacts(artifacts)).toEqual([
      "  Deleted: skill 'browser-automation'",
    ]);
  });

  test('formats multiple deleted artifacts', () => {
    const artifacts: DeletedArtifact[] = [
      { client: 'claude', type: 'skill', name: 'old-skill' },
      { client: 'claude', type: 'command', name: 'deprecated-cmd' },
    ];
    const lines = formatDeletedArtifacts(artifacts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  Deleted: skill 'old-skill', command 'deprecated-cmd'");
  });

  test('deduplicates same artifact across different clients', () => {
    const artifacts: DeletedArtifact[] = [
      { client: 'claude', type: 'skill', name: 'my-skill' },
      { client: 'copilot', type: 'skill', name: 'my-skill' },
      { client: 'universal', type: 'skill', name: 'my-skill' },
    ];
    const lines = formatDeletedArtifacts(artifacts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  Deleted: skill 'my-skill'");
  });

  test('shows distinct artifacts from multiple clients without duplication', () => {
    const artifacts: DeletedArtifact[] = [
      { client: 'claude', type: 'skill', name: 'skill-a' },
      { client: 'copilot', type: 'skill', name: 'skill-a' },
      { client: 'claude', type: 'command', name: 'cmd-b' },
    ];
    const lines = formatDeletedArtifacts(artifacts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  Deleted: skill 'skill-a', command 'cmd-b'");
  });
});

describe('formatSyncSummary with deletedArtifacts', () => {
  test('shows deleted artifacts when present', () => {
    const result: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      deletedArtifacts: [
        { client: 'claude', type: 'skill', name: 'removed-skill' },
      ],
    };

    const lines = formatSyncSummary(result);
    expect(lines).toContain("  Deleted: skill 'removed-skill'");
  });

  test('does not show deleted section when deletedArtifacts is empty', () => {
    const result: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      deletedArtifacts: [],
    };

    const lines = formatSyncSummary(result);
    expect(lines.some((l) => l.includes('Deleted'))).toBe(false);
  });

  test('does not show deleted section when deletedArtifacts is undefined', () => {
    const result: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };

    const lines = formatSyncSummary(result);
    expect(lines.some((l) => l.includes('Deleted'))).toBe(false);
  });
});

describe('formatPluginHeader', () => {
  test('shows scope when present', () => {
    const pr: PluginSyncResult = {
      plugin: 'deepwiki@allagents',
      resolved: '/tmp/deepwiki',
      success: true,
      copyResults: [],
      scope: 'project',
    };
    expect(formatPluginHeader(pr)).toBe('\u2713 Plugin: deepwiki@allagents (scope: project)');
  });

  test('shows failure status', () => {
    const pr: PluginSyncResult = {
      plugin: 'broken-plugin',
      resolved: '/tmp/broken',
      success: false,
      copyResults: [],
      scope: 'project',
    };
    expect(formatPluginHeader(pr)).toBe('\u2717 Plugin: broken-plugin (scope: project)');
  });

  test('omits scope when not set', () => {
    const pr: PluginSyncResult = {
      plugin: 'test-plugin',
      resolved: '/tmp/test',
      success: true,
      copyResults: [],
    };
    expect(formatPluginHeader(pr)).toBe('\u2713 Plugin: test-plugin');
  });
});
