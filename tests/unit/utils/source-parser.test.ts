import { describe, it, expect } from 'bun:test';
import { extractOrgFromSource } from '../../../src/utils/source-parser.js';

describe('extractOrgFromSource', () => {
  describe('GitHub formats', () => {
    it('should extract org from github: and gh: prefix formats', () => {
      expect(extractOrgFromSource('github:anthropic/repo')).toBe('anthropic');
      expect(extractOrgFromSource('github:anthropic/repo#main')).toBe('anthropic');
      expect(extractOrgFromSource('gh:my-org/repo')).toBe('my-org');
      expect(extractOrgFromSource('gh:my-org/repo#branch')).toBe('my-org');
    });

    it('should extract org from full GitHub URLs', () => {
      expect(extractOrgFromSource('https://github.com/anthropic/claude-code')).toBe('anthropic');
      expect(extractOrgFromSource('github.com/EntityProcess/allagents')).toBe('EntityProcess');
      expect(extractOrgFromSource('https://github.com/org/repo/tree/main/path')).toBe('org');
    });

    it('should extract org from shorthand format (org/repo)', () => {
      expect(extractOrgFromSource('anthropic/claude-plugins')).toBe('anthropic');
      expect(extractOrgFromSource('WiseTechGlobal/WTG.AI.Prompts')).toBe('WiseTechGlobal');
    });
  });

  describe('local paths - should return null', () => {
    it('should return null for local paths', () => {
      expect(extractOrgFromSource('./local/path')).toBeNull();
      expect(extractOrgFromSource('../parent/path')).toBeNull();
      expect(extractOrgFromSource('/home/user/plugins')).toBeNull();
      expect(extractOrgFromSource('C:\\Users\\test\\plugins')).toBeNull();
      expect(extractOrgFromSource('.')).toBeNull();
    });
  });

  describe('invalid input - should return null', () => {
    it('should return null for invalid input', () => {
      expect(extractOrgFromSource('')).toBeNull();
      expect(extractOrgFromSource('   ')).toBeNull();
      expect(extractOrgFromSource('github:')).toBeNull();
      expect(extractOrgFromSource('github:/repo')).toBeNull();
      expect(extractOrgFromSource('github:-invalid/repo')).toBeNull();
      expect(extractOrgFromSource('github:in--valid/repo')).toBeNull();
    });
  });

  it('should handle whitespace and preserve case', () => {
    expect(extractOrgFromSource('  github:anthropic/repo  ')).toBe('anthropic');
    expect(extractOrgFromSource('github:Anthropic/repo')).toBe('Anthropic');
  });
});
