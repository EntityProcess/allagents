import { describe, expect, test } from 'bun:test';
import { mergeNativeSyncResults } from '../../../../src/core/native/types.js';
import type { NativeSyncResult } from '../../../../src/core/native/types.js';

describe('native/types', () => {
  describe('mergeNativeSyncResults', () => {
    test('merges two results', () => {
      const a: NativeSyncResult = {
        marketplacesAdded: ['a/repo'],
        pluginsInstalled: ['p1@repo'],
        pluginsFailed: [],
        skipped: [],
      };
      const b: NativeSyncResult = {
        marketplacesAdded: ['b/repo'],
        pluginsInstalled: ['p2@repo'],
        pluginsFailed: [{ plugin: 'p3@repo', error: 'fail' }],
        skipped: ['local-plugin'],
      };
      const merged = mergeNativeSyncResults([a, b]);
      expect(merged.marketplacesAdded).toEqual(['a/repo', 'b/repo']);
      expect(merged.pluginsInstalled).toEqual(['p1@repo', 'p2@repo']);
      expect(merged.pluginsFailed).toEqual([{ plugin: 'p3@repo', error: 'fail' }]);
      expect(merged.skipped).toEqual(['local-plugin']);
    });

    test('returns empty result for empty array', () => {
      const merged = mergeNativeSyncResults([]);
      expect(merged.marketplacesAdded).toEqual([]);
      expect(merged.pluginsInstalled).toEqual([]);
      expect(merged.pluginsFailed).toEqual([]);
      expect(merged.skipped).toEqual([]);
    });
  });
});
