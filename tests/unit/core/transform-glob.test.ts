import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyWorkspaceFiles } from '../../../src/core/transform.js';

describe('copyWorkspaceFiles with glob patterns', () => {
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'allagents-transform-src-'));
    destDir = await mkdtemp(join(tmpdir(), 'allagents-transform-dest-'));

    // Create test file structure in source
    await mkdir(join(sourceDir, 'docs'), { recursive: true });
    await mkdir(join(sourceDir, 'config'), { recursive: true });
    await writeFile(join(sourceDir, 'README.md'), 'readme content');
    await writeFile(join(sourceDir, 'CLAUDE.md'), 'claude content');
    await writeFile(join(sourceDir, 'docs/guide.md'), 'guide content');
    await writeFile(join(sourceDir, 'docs/api.md'), 'api content');
    await writeFile(join(sourceDir, 'docs/internal.instructions.md'), 'internal content');
    await writeFile(join(sourceDir, 'config/settings.json'), '{"key": "value"}');
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  describe('glob pattern copying', () => {
    it('should copy files matching glob patterns', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['*.md']);

      expect(results.length).toBe(2);
      expect(results.every((r) => r.action === 'copied')).toBe(true);
      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'CLAUDE.md'))).toBe(true);
    });

    it('should copy files matching recursive glob patterns', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['**/*.md']);

      expect(results.length).toBe(5);
      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/guide.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/api.md'))).toBe(true);
    });
  });

  describe('negation exclusion', () => {
    it('should exclude files matching negation patterns', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        '**/*.md',
        '!**/*.instructions.md',
      ]);

      expect(results.length).toBe(4);
      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/internal.instructions.md'))).toBe(false);
    });

    it('should exclude entire directories with negation', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        '**/*.md',
        '!docs/**',
      ]);

      const relativePaths = results.map((r) => r.destination);
      expect(results.length).toBe(2);
      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/guide.md'))).toBe(false);
    });
  });

  describe('re-inclusion after negation', () => {
    it('should re-include specific files after negation', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        '**/*.md',
        '!docs/*.md',
        'docs/guide.md',
      ]);

      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/guide.md'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/api.md'))).toBe(false);
      expect(existsSync(join(destDir, 'docs/internal.instructions.md'))).toBe(false);
    });
  });

  describe('directory structure preservation', () => {
    it('should preserve directory structure when copying', async () => {
      await copyWorkspaceFiles(sourceDir, destDir, ['docs/**/*.md']);

      expect(existsSync(join(destDir, 'docs'))).toBe(true);
      expect(existsSync(join(destDir, 'docs/guide.md'))).toBe(true);
      const content = await readFile(join(destDir, 'docs/guide.md'), 'utf-8');
      expect(content).toBe('guide content');
    });

    it('should create nested directories as needed', async () => {
      // Create deeper nesting in source
      await mkdir(join(sourceDir, 'deep/nested/path'), { recursive: true });
      await writeFile(join(sourceDir, 'deep/nested/path/file.md'), 'deep content');

      await copyWorkspaceFiles(sourceDir, destDir, ['deep/**/*.md']);

      expect(existsSync(join(destDir, 'deep/nested/path/file.md'))).toBe(true);
    });
  });

  describe('dry-run mode', () => {
    it('should not copy files in dry-run mode', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['**/*.md'], { dryRun: true });

      expect(results.length).toBe(5);
      expect(results.every((r) => r.action === 'copied')).toBe(true);
      expect(existsSync(join(destDir, 'README.md'))).toBe(false);
      expect(existsSync(join(destDir, 'docs/guide.md'))).toBe(false);
    });

    it('should report correct destinations in dry-run mode', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['docs/*.md'], { dryRun: true });

      const destinations = results.map((r) => r.destination).sort();
      expect(destinations).toContain(join(destDir, 'docs/guide.md'));
      expect(destinations).toContain(join(destDir, 'docs/api.md'));
    });
  });

  describe('object entry handling', () => {
    it('should handle object entries without pattern expansion', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        { source: 'README.md', dest: 'RENAMED.md' },
      ]);

      expect(results.length).toBe(1);
      expect(existsSync(join(destDir, 'RENAMED.md'))).toBe(true);
      expect(existsSync(join(destDir, 'README.md'))).toBe(false);
    });

    it('should handle mixed string patterns and object entries', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        '*.md',
        { source: 'config/settings.json', dest: 'settings.json' },
      ]);

      expect(results.length).toBe(3);
      expect(existsSync(join(destDir, 'README.md'))).toBe(true);
      expect(existsSync(join(destDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(join(destDir, 'settings.json'))).toBe(true);
    });

    it('should use basename as default dest for object entries', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        { source: 'config/settings.json' },
      ]);

      expect(results.length).toBe(1);
      expect(existsSync(join(destDir, 'settings.json'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should report error for non-existent literal paths', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['nonexistent.md']);

      expect(results.length).toBe(1);
      expect(results[0].action).toBe('failed');
      expect(results[0].error).toContain('Source file not found');
    });

    it('should silently ignore non-matching glob patterns', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, ['*.nonexistent']);

      expect(results.length).toBe(0);
    });

    it('should report error for non-existent object entry source', async () => {
      const results = await copyWorkspaceFiles(sourceDir, destDir, [
        { source: 'nonexistent.md', dest: 'output.md' },
      ]);

      expect(results.length).toBe(1);
      expect(results[0].action).toBe('failed');
      expect(results[0].error).toContain('Source file not found');
    });
  });
});
