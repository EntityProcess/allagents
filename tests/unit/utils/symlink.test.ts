import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, lstat, readlink } from 'node:fs/promises';
import { existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { createSymlink, isValidSymlink } from '../../../src/utils/symlink.js';

const isWindows = platform() === 'win32';

describe('symlink utilities', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-symlink-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createSymlink', () => {
    it('creates a symlink to a directory', async () => {
      // Create target directory
      const targetDir = join(testDir, 'target');
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'file.txt'), 'content');

      // Create parent for symlink
      const linkDir = join(testDir, 'links');
      await mkdir(linkDir, { recursive: true });
      const linkPath = join(linkDir, 'my-link');

      // Create symlink
      const result = await createSymlink(targetDir, linkPath);

      expect(result).toBe(true);
      expect(existsSync(linkPath)).toBe(true);
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);

      // Verify symlink points to correct target
      const target = await readlink(linkPath);
      // On Windows junctions, readlink returns absolute path. On Unix, it's relative.
      const resolvedTarget = resolve(linkDir, target);
      expect(resolvedTarget).toBe(resolve(targetDir));
    });

    it('uses relative paths for symlinks', async () => {
      const targetDir = join(testDir, 'a', 'b', 'target');
      await mkdir(targetDir, { recursive: true });

      const linkPath = join(testDir, 'c', 'd', 'link');
      await mkdir(join(testDir, 'c', 'd'), { recursive: true });

      const result = await createSymlink(targetDir, linkPath);

      expect(result).toBe(true);
      const target = await readlink(linkPath);
      
      // On Windows with junctions, readlink returns absolute path
      // On Unix, it returns the relative path
      if (isWindows) {
        expect(resolve(target)).toBe(resolve(targetDir));
      } else {
        expect(target.startsWith('/')).toBe(false);
        expect(target).toBe('../../a/b/target');
      }
    });

    it('returns true if symlink already points to correct target', async () => {
      const targetDir = join(testDir, 'target');
      await mkdir(targetDir, { recursive: true });

      const linkPath = join(testDir, 'link');

      // Create symlink first time
      const result1 = await createSymlink(targetDir, linkPath);
      expect(result1).toBe(true);

      // Create again - should succeed without recreating
      const result2 = await createSymlink(targetDir, linkPath);
      expect(result2).toBe(true);
    });

    it('replaces symlink pointing to wrong target', async () => {
      const target1 = join(testDir, 'target1');
      const target2 = join(testDir, 'target2');
      await mkdir(target1, { recursive: true });
      await mkdir(target2, { recursive: true });

      const linkPath = join(testDir, 'link');

      // Create symlink to target1
      const result1 = await createSymlink(target1, linkPath);
      expect(result1).toBe(true);

      // Replace with symlink to target2
      const result2 = await createSymlink(target2, linkPath);
      expect(result2).toBe(true);

      // Verify it now points to target2
      const target = await readlink(linkPath);
      const resolvedTarget = resolve(testDir, target);
      expect(resolvedTarget).toBe(resolve(target2));
    });

    it('replaces regular directory with symlink', async () => {
      const targetDir = join(testDir, 'target');
      await mkdir(targetDir, { recursive: true });

      // Create a regular directory at link path
      const linkPath = join(testDir, 'link');
      await mkdir(linkPath, { recursive: true });
      await writeFile(join(linkPath, 'file.txt'), 'old content');

      // Should replace with symlink
      const result = await createSymlink(targetDir, linkPath);

      expect(result).toBe(true);
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
    });

    it('returns true when target and link are same path', async () => {
      const path = join(testDir, 'same');
      await mkdir(path, { recursive: true });

      // Creating symlink from path to itself should succeed (no-op)
      const result = await createSymlink(path, path);
      expect(result).toBe(true);
    });
  });

  describe('isValidSymlink', () => {
    it('returns true for valid symlink to correct target', async () => {
      const targetDir = join(testDir, 'target');
      await mkdir(targetDir, { recursive: true });

      const linkPath = join(testDir, 'link');
      await createSymlink(targetDir, linkPath);

      const result = await isValidSymlink(linkPath, targetDir);
      expect(result).toBe(true);
    });

    it('returns false for symlink to wrong target', async () => {
      const target1 = join(testDir, 'target1');
      const target2 = join(testDir, 'target2');
      await mkdir(target1, { recursive: true });
      await mkdir(target2, { recursive: true });

      const linkPath = join(testDir, 'link');
      await createSymlink(target1, linkPath);

      const result = await isValidSymlink(linkPath, target2);
      expect(result).toBe(false);
    });

    it('returns false for regular directory', async () => {
      const path = join(testDir, 'dir');
      await mkdir(path, { recursive: true });

      const result = await isValidSymlink(path, path);
      expect(result).toBe(false);
    });

    it('returns false for non-existent path', async () => {
      const result = await isValidSymlink(
        join(testDir, 'nonexistent'),
        join(testDir, 'target'),
      );
      expect(result).toBe(false);
    });
  });
});
