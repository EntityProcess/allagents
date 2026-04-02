import { describe, expect, test } from 'bun:test';
import { mergeSyncResults } from '../../../src/core/sync.js';
import type { SyncResult } from '../../../src/core/sync.js';

describe('mergeSyncResults', () => {
  test('merges two successful results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [{ plugin: 'a', resolved: '/a', success: true, copyResults: [] }],
      totalCopied: 2,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 1,
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [{ plugin: 'b', resolved: '/b', success: true, copyResults: [] }],
      totalCopied: 3,
      totalFailed: 0,
      totalSkipped: 1,
      totalGenerated: 0,
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.success).toBe(true);
    expect(merged.pluginResults).toHaveLength(2);
    expect(merged.totalCopied).toBe(5);
    expect(merged.totalFailed).toBe(0);
    expect(merged.totalSkipped).toBe(1);
    expect(merged.totalGenerated).toBe(1);
  });

  test('merges when one has failures', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 1,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
    const b: SyncResult = {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 1,
      totalSkipped: 0,
      totalGenerated: 0,
      error: 'plugin failed',
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.success).toBe(false);
    expect(merged.totalCopied).toBe(1);
    expect(merged.totalFailed).toBe(1);
  });

  test('merges warnings from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: ['warn1'],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: ['warn2'],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.warnings).toEqual(['warn1', 'warn2']);
  });

  test('merges messages from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      messages: ['msg1'],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      messages: ['msg2'],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.messages).toEqual(['msg1', 'msg2']);
  });

  test('merges nativeResult from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: {
        marketplacesAdded: ['org/repo-a'],
        pluginsInstalled: [{ plugin: 'pluginA@repo-a', client: 'claude' }],
        pluginsFailed: [],
        skipped: [],
      },
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: {
        marketplacesAdded: ['org/repo-b'],
        pluginsInstalled: [{ plugin: 'pluginB@repo-b', client: 'copilot' }],
        pluginsFailed: [{ plugin: 'pluginC@repo-c', error: 'not found' }],
        skipped: ['local-plugin'],
      },
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.nativeResult).toEqual({
      marketplacesAdded: ['org/repo-a', 'org/repo-b'],
      pluginsInstalled: [
        { plugin: 'pluginA@repo-a', client: 'claude' },
        { plugin: 'pluginB@repo-b', client: 'copilot' },
      ],
      pluginsFailed: [{ plugin: 'pluginC@repo-c', error: 'not found' }],
      skipped: ['local-plugin'],
    });
  });

  test('uses single nativeResult when only one side has it', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: {
        marketplacesAdded: ['org/repo'],
        pluginsInstalled: [{ plugin: 'plugin@repo', client: 'claude' }],
        pluginsFailed: [],
        skipped: [],
      },
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.nativeResult).toEqual(a.nativeResult);
  });

  test('merges purgedPaths from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      purgedPaths: [{ client: 'claude', paths: ['/a'] }],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      purgedPaths: [{ client: 'copilot', paths: ['/b'] }],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.purgedPaths).toEqual([
      { client: 'claude', paths: ['/a'] },
      { client: 'copilot', paths: ['/b'] },
    ]);
  });
});
