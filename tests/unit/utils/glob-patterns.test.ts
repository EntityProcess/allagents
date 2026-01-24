import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isGlobPattern,
  isNegationPattern,
  resolveGlobPatterns,
} from '../../../src/utils/glob-patterns.js';

describe('isGlobPattern', () => {
  it('should detect asterisk patterns', () => {
    expect(isGlobPattern('*.md')).toBe(true);
    expect(isGlobPattern('**/*.ts')).toBe(true);
    expect(isGlobPattern('src/*.js')).toBe(true);
  });

  it('should detect question mark patterns', () => {
    expect(isGlobPattern('file?.txt')).toBe(true);
  });

  it('should detect bracket patterns', () => {
    expect(isGlobPattern('[abc].txt')).toBe(true);
    expect(isGlobPattern('*.{ts,js}')).toBe(true);
  });

  it('should reject literal paths', () => {
    expect(isGlobPattern('file.txt')).toBe(false);
    expect(isGlobPattern('src/file.ts')).toBe(false);
    expect(isGlobPattern('path/to/file.md')).toBe(false);
  });

  it('should handle negation prefix correctly', () => {
    expect(isGlobPattern('!*.md')).toBe(true);
    expect(isGlobPattern('!file.txt')).toBe(false);
    expect(isGlobPattern('!**/*.ts')).toBe(true);
  });
});

describe('isNegationPattern', () => {
  it('should detect negation patterns', () => {
    expect(isNegationPattern('!*.md')).toBe(true);
    expect(isNegationPattern('!file.txt')).toBe(true);
    expect(isNegationPattern('!**/*.ts')).toBe(true);
  });

  it('should reject non-negation patterns', () => {
    expect(isNegationPattern('*.md')).toBe(false);
    expect(isNegationPattern('file.txt')).toBe(false);
    expect(isNegationPattern('**/*.ts')).toBe(false);
  });
});

describe('resolveGlobPatterns', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'allagents-glob-test-'));
    // Create test file structure
    await mkdir(join(tempDir, 'docs'), { recursive: true });
    await mkdir(join(tempDir, 'src'), { recursive: true });
    await writeFile(join(tempDir, 'README.md'), 'readme');
    await writeFile(join(tempDir, 'CLAUDE.md'), 'claude');
    await writeFile(join(tempDir, 'docs/guide.md'), 'guide');
    await writeFile(join(tempDir, 'docs/api.md'), 'api');
    await writeFile(join(tempDir, 'docs/internal.instructions.md'), 'internal');
    await writeFile(join(tempDir, 'src/index.ts'), 'index');
    await writeFile(join(tempDir, 'src/utils.ts'), 'utils');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve simple glob patterns', async () => {
    const result = await resolveGlobPatterns(tempDir, ['*.md']);
    expect(result.length).toBe(2);
    const relativePaths = result.map((r) => r.relativePath).sort();
    expect(relativePaths).toEqual(['CLAUDE.md', 'README.md']);
  });

  it('should resolve recursive glob patterns', async () => {
    const result = await resolveGlobPatterns(tempDir, ['**/*.md']);
    expect(result.length).toBe(5);
    const relativePaths = result.map((r) => r.relativePath).sort();
    expect(relativePaths).toContain('README.md');
    expect(relativePaths).toContain('docs/guide.md');
  });

  it('should handle negation patterns', async () => {
    const result = await resolveGlobPatterns(tempDir, [
      '**/*.md',
      '!**/*.instructions.md',
    ]);
    expect(result.length).toBe(4);
    const relativePaths = result.map((r) => r.relativePath);
    expect(relativePaths).not.toContain('docs/internal.instructions.md');
  });

  it('should allow re-inclusion after negation', async () => {
    const result = await resolveGlobPatterns(tempDir, [
      '**/*.md',
      '!docs/*.md',
      'docs/guide.md',
    ]);
    const relativePaths = result.map((r) => r.relativePath).sort();
    expect(relativePaths).toContain('docs/guide.md');
    expect(relativePaths).not.toContain('docs/api.md');
    expect(relativePaths).not.toContain('docs/internal.instructions.md');
  });

  it('should handle literal paths', async () => {
    const result = await resolveGlobPatterns(tempDir, ['README.md', 'src/index.ts']);
    expect(result.length).toBe(2);
    const relativePaths = result.map((r) => r.relativePath).sort();
    expect(relativePaths).toEqual(['README.md', 'src/index.ts']);
  });

  it('should handle mixed patterns and literals', async () => {
    const result = await resolveGlobPatterns(tempDir, [
      '*.md',
      'src/index.ts',
    ]);
    expect(result.length).toBe(3);
    const relativePaths = result.map((r) => r.relativePath).sort();
    expect(relativePaths).toEqual(['CLAUDE.md', 'README.md', 'src/index.ts']);
  });

  it('should return absolute source paths', async () => {
    const result = await resolveGlobPatterns(tempDir, ['README.md']);
    expect(result[0].sourcePath).toBe(join(tempDir, 'README.md'));
  });

  it('should handle negation of literal paths', async () => {
    const result = await resolveGlobPatterns(tempDir, [
      '**/*.md',
      '!README.md',
    ]);
    const relativePaths = result.map((r) => r.relativePath);
    expect(relativePaths).not.toContain('README.md');
    expect(relativePaths).toContain('CLAUDE.md');
  });

  it('should silently ignore empty glob matches', async () => {
    const result = await resolveGlobPatterns(tempDir, ['*.nonexistent']);
    expect(result.length).toBe(0);
  });
});
