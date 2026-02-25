import { describe, expect, test } from 'bun:test';
import { ClaudeNativeClient } from '../../../../src/core/native/claude.js';

describe('native/claude', () => {
  const client = new ClaudeNativeClient();

  describe('toPluginSpec', () => {
    test('converts marketplace spec — drops owner, keeps repo', () => {
      expect(client.toPluginSpec('superpowers@obra/superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('preserves plugin@marketplace format', () => {
      expect(client.toPluginSpec('superpowers@superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
    });

    test('returns null for direct GitHub paths', () => {
      expect(client.toPluginSpec('vercel-labs/agent-browser/skills/agent-browser')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(client.toPluginSpec('')).toBeNull();
    });

    test('returns null for trailing slash in marketplace', () => {
      expect(client.toPluginSpec('plugin@owner/')).toBeNull();
    });
  });

  describe('extractMarketplaceSource', () => {
    test('extracts owner/repo from marketplace spec', () => {
      expect(client.extractMarketplaceSource('superpowers@obra/superpowers-marketplace')).toBe(
        'obra/superpowers-marketplace',
      );
    });

    test('returns null for non-marketplace specs', () => {
      expect(client.extractMarketplaceSource('vercel-labs/agent-browser/skills/agent-browser')).toBeNull();
    });

    test('returns null for plain marketplace name', () => {
      expect(client.extractMarketplaceSource('superpowers@superpowers-marketplace')).toBeNull();
    });
  });
});
