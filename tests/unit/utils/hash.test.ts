import { describe, it, expect } from 'bun:test';
import { getShortId } from '../../../src/utils/hash.js';

describe('getShortId', () => {
  it('should return a 6-character string', () => {
    const result = getShortId('test-input');
    expect(result.length).toBe(6);
  });

  it('should return only hexadecimal characters', () => {
    const result = getShortId('some/path/to/plugin');
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should be deterministic - same input produces same output', () => {
    const input = '/home/user/projects/my-plugin';
    const result1 = getShortId(input);
    const result2 = getShortId(input);
    expect(result1).toBe(result2);
  });

  it('should produce different outputs for different inputs', () => {
    const result1 = getShortId('/path/to/plugin-a');
    const result2 = getShortId('/path/to/plugin-b');
    expect(result1).not.toBe(result2);
  });

  it('should handle empty string', () => {
    const result = getShortId('');
    expect(result.length).toBe(6);
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should handle special characters in path', () => {
    const result = getShortId('/path/with spaces/and-dashes_underscores.dots');
    expect(result.length).toBe(6);
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should handle unicode characters', () => {
    const result = getShortId('/path/with/émojis/🚀/and/日本語');
    expect(result.length).toBe(6);
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should produce known hash for predictable testing', () => {
    // SHA-256 of 'test' starts with '9f86d0...'
    const result = getShortId('test');
    expect(result).toBe('9f86d0');
  });

  it('should handle very long strings', () => {
    const longPath = '/very/long/path/' + 'a'.repeat(1000);
    const result = getShortId(longPath);
    expect(result.length).toBe(6);
    expect(result).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should differentiate similar paths', () => {
    const path1 = '/home/user/project1/plugins/skill';
    const path2 = '/home/user/project2/plugins/skill';
    expect(getShortId(path1)).not.toBe(getShortId(path2));
  });
});
