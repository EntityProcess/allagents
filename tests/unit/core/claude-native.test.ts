import { describe, expect, test } from 'bun:test';
import {
  toClaudePluginSpec,
  extractMarketplaceSource,
} from '../../../src/core/claude-native.js';

describe('claude-native', () => {
  describe('toClaudePluginSpec', () => {
    test('converts marketplace spec with owner/repo to plugin@repo', () => {
      expect(toClaudePluginSpec('superpowers@obra/superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('preserves plugin@marketplace format', () => {
      expect(toClaudePluginSpec('superpowers@superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('returns null for direct GitHub paths', () => {
      expect(
        toClaudePluginSpec('vercel-labs/agent-browser/skills/agent-browser'),
      ).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(toClaudePluginSpec('')).toBeNull();
    });
  });

  describe('extractMarketplaceSource', () => {
    test('extracts owner/repo from marketplace spec', () => {
      expect(
        extractMarketplaceSource('superpowers@obra/superpowers-marketplace'),
      ).toBe('obra/superpowers-marketplace');
    });

    test('returns null for non-marketplace specs', () => {
      expect(
        extractMarketplaceSource('vercel-labs/agent-browser/skills/agent-browser'),
      ).toBeNull();
    });

    test('returns null for plain marketplace name', () => {
      expect(
        extractMarketplaceSource('superpowers@superpowers-marketplace'),
      ).toBeNull();
    });
  });
});
