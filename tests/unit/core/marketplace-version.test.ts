import { describe, it, expect, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Env that prevents git from walking up to a parent repo
const gitEnv = (dir: string) => ({
  ...process.env,
  GIT_CEILING_DIRECTORIES: dir,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
});

// Mock simple-git with a real-ish implementation that delegates to actual git
mock.module('simple-git', () => ({
  default: (dir: string) => ({
    log: async (opts: { maxCount?: number }) => {
      try {
        const format = '--format=%H%n%aI';
        const maxCount = opts?.maxCount ? `-n ${opts.maxCount}` : '';
        const output = execSync(`git log ${maxCount} ${format}`, {
          cwd: dir,
          encoding: 'utf-8',
          env: gitEnv(dir),
        }).trim();
        const lines = output.split('\n');
        if (lines.length < 2) return { latest: null };
        return {
          latest: {
            hash: lines[0],
            date: lines[1],
          },
        };
      } catch {
        throw new Error('not a git repo');
      }
    },
  }),
}));

const { getMarketplaceVersion } = await import(
  '../../../src/core/marketplace.js'
);

describe('getMarketplaceVersion', () => {
  it('should return hash and date for a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-version-'));
    const env = gitEnv(dir);
    try {
      execSync('git init', { cwd: dir, env });
      execSync('git config user.email "test@test.com"', { cwd: dir, env });
      execSync('git config user.name "Test"', { cwd: dir, env });
      writeFileSync(join(dir, 'file.txt'), 'hello');
      execSync('git add .', { cwd: dir, env });
      execSync('git commit -m "initial"', { cwd: dir, env });

      const result = (await getMarketplaceVersion(dir)) as {
        hash: string;
        date: Date;
      } | null;
      expect(result).not.toBeNull();
      expect(result!.hash).toMatch(/^[0-9a-f]{7,}$/);
      expect(result!.date).toBeInstanceOf(Date);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('should return null for a non-git directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mp-version-'));
    try {
      const result = await getMarketplaceVersion(dir);
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('should return null for a non-existent path', async () => {
    const result = await getMarketplaceVersion(
      '/tmp/nonexistent-marketplace-path',
    );
    expect(result).toBeNull();
  });
});
