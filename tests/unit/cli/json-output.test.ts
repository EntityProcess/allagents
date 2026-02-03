import { describe, test, expect } from 'bun:test';
import { extractJsonFlag } from '../../../src/cli/json-output.js';

describe('extractJsonFlag', () => {
  test('returns json false when flag is absent', () => {
    const result = extractJsonFlag(['workspace', 'sync']);
    expect(result.json).toBe(false);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from end of args', () => {
    const result = extractJsonFlag(['workspace', 'sync', '--json']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from beginning of args', () => {
    const result = extractJsonFlag(['--json', 'workspace', 'sync']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from middle of args', () => {
    const result = extractJsonFlag(['workspace', '--json', 'sync']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });
});
