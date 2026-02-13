import { describe, expect, test } from 'bun:test';
import { formatMcpResult } from '../../../src/cli/format-sync.js';
import type { McpMergeResult } from '../../../src/core/vscode-mcp.js';

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
});
