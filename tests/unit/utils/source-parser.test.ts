import { describe, it, expect } from 'bun:test';
import { extractOrgFromSource } from '../../../src/utils/source-parser.js';

describe('extractOrgFromSource', () => {
  describe('github: prefix format', () => {
    it('should extract org from github:org/repo', () => {
      expect(extractOrgFromSource('github:anthropic/repo')).toBe('anthropic');
    });

    it('should extract org from github:org/repo#branch', () => {
      expect(extractOrgFromSource('github:anthropic/repo#main')).toBe('anthropic');
      expect(extractOrgFromSource('github:anthropic/repo#feature/my-branch')).toBe('anthropic');
    });

    it('should handle hyphenated org names', () => {
      expect(extractOrgFromSource('github:my-org/repo')).toBe('my-org');
      expect(extractOrgFromSource('github:my-org/repo#branch')).toBe('my-org');
    });

    it('should handle numeric org names', () => {
      expect(extractOrgFromSource('github:org123/repo')).toBe('org123');
    });

    it('should handle single character org names', () => {
      expect(extractOrgFromSource('github:a/repo')).toBe('a');
    });
  });

  describe('gh: prefix format', () => {
    it('should extract org from gh:org/repo', () => {
      expect(extractOrgFromSource('gh:anthropic/repo')).toBe('anthropic');
    });

    it('should extract org from gh:org/repo#branch', () => {
      expect(extractOrgFromSource('gh:anthropic/repo#develop')).toBe('anthropic');
    });
  });

  describe('full GitHub URL format', () => {
    it('should extract org from https://github.com/org/repo', () => {
      expect(extractOrgFromSource('https://github.com/anthropic/claude-code')).toBe('anthropic');
    });

    it('should extract org from http://github.com/org/repo', () => {
      expect(extractOrgFromSource('http://github.com/anthropic/repo')).toBe('anthropic');
    });

    it('should extract org from https://www.github.com/org/repo', () => {
      expect(extractOrgFromSource('https://www.github.com/EntityProcess/allagents')).toBe('EntityProcess');
    });

    it('should extract org from github.com/org/repo (no protocol)', () => {
      expect(extractOrgFromSource('github.com/anthropic/repo')).toBe('anthropic');
    });

    it('should extract org from URLs with tree/branch/path', () => {
      expect(extractOrgFromSource('https://github.com/anthropic/repo/tree/main/plugins')).toBe('anthropic');
    });
  });

  describe('shorthand format (org/repo)', () => {
    it('should extract org from owner/repo', () => {
      expect(extractOrgFromSource('anthropic/claude-plugins-official')).toBe('anthropic');
    });

    it('should extract org from owner/repo/subpath', () => {
      expect(extractOrgFromSource('anthropic/repo/plugins/code-review')).toBe('anthropic');
    });

    it('should handle dots in repo names', () => {
      expect(extractOrgFromSource('WiseTechGlobal/WTG.AI.Prompts')).toBe('WiseTechGlobal');
    });
  });

  describe('local paths - should return null', () => {
    it('should return null for relative paths starting with ./', () => {
      expect(extractOrgFromSource('./local/path')).toBeNull();
    });

    it('should return null for relative paths starting with ../', () => {
      expect(extractOrgFromSource('../parent/path')).toBeNull();
    });

    it('should return null for absolute Unix paths', () => {
      expect(extractOrgFromSource('/home/user/plugins/skill')).toBeNull();
    });

    it('should return null for Windows absolute paths', () => {
      expect(extractOrgFromSource('C:\\Users\\test\\plugins')).toBeNull();
      expect(extractOrgFromSource('D:/Projects/plugins')).toBeNull();
    });

    it('should return null for paths with backslashes', () => {
      expect(extractOrgFromSource('local\\path\\to\\plugin')).toBeNull();
    });

    it('should return null for current directory', () => {
      expect(extractOrgFromSource('.')).toBeNull();
    });

    it('should return null for parent directory', () => {
      expect(extractOrgFromSource('..')).toBeNull();
    });
  });

  describe('invalid or empty input - should return null', () => {
    it('should return null for empty string', () => {
      expect(extractOrgFromSource('')).toBeNull();
    });

    it('should return null for whitespace-only string', () => {
      expect(extractOrgFromSource('   ')).toBeNull();
      expect(extractOrgFromSource('\t')).toBeNull();
      expect(extractOrgFromSource('\n')).toBeNull();
    });

    it('should return null for github: with no repo', () => {
      expect(extractOrgFromSource('github:')).toBeNull();
    });

    it('should return null for github: with empty org', () => {
      expect(extractOrgFromSource('github:/repo')).toBeNull();
    });

    it('should return null for github: with only org (no slash)', () => {
      expect(extractOrgFromSource('github:anthropic')).toBeNull();
    });

    it('should return null for invalid org starting with hyphen', () => {
      expect(extractOrgFromSource('github:-invalid/repo')).toBeNull();
    });

    it('should return null for invalid org ending with hyphen', () => {
      expect(extractOrgFromSource('github:invalid-/repo')).toBeNull();
    });

    it('should return null for org with consecutive hyphens', () => {
      expect(extractOrgFromSource('github:in--valid/repo')).toBeNull();
    });

    it('should return null for org with special characters', () => {
      expect(extractOrgFromSource('github:org@name/repo')).toBeNull();
      expect(extractOrgFromSource('github:org.name/repo')).toBeNull();
      expect(extractOrgFromSource('github:org_name/repo')).toBeNull();
    });

    it('should return null for string with no slash', () => {
      expect(extractOrgFromSource('anthropic')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle whitespace around input', () => {
      expect(extractOrgFromSource('  github:anthropic/repo  ')).toBe('anthropic');
    });

    it('should handle multiple # in branch name', () => {
      expect(extractOrgFromSource('github:anthropic/repo#branch#with#hashes')).toBe('anthropic');
    });

    it('should handle empty branch after #', () => {
      expect(extractOrgFromSource('github:anthropic/repo#')).toBe('anthropic');
    });

    it('should be case-sensitive for org names', () => {
      expect(extractOrgFromSource('github:Anthropic/repo')).toBe('Anthropic');
      expect(extractOrgFromSource('github:ANTHROPIC/repo')).toBe('ANTHROPIC');
    });

    it('should handle long org names', () => {
      const longOrg = 'a'.repeat(39);
      expect(extractOrgFromSource(`github:${longOrg}/repo`)).toBe(longOrg);
    });

    it('should handle org names with numbers', () => {
      expect(extractOrgFromSource('github:123org/repo')).toBe('123org');
      expect(extractOrgFromSource('github:org456/repo')).toBe('org456');
    });
  });
});
