import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { join, resolve, sep } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mock the git module for verifyGitHubUrlExists tests
const repoExistsMock = mock(() => Promise.resolve(true));
const cloneToTempMock = mock(() => Promise.resolve(''));
const cleanupTempDirMock = mock(() => Promise.resolve());

mock.module('../../../src/core/git.js', () => ({
  repoExists: repoExistsMock,
  cloneToTemp: cloneToTempMock,
  cleanupTempDir: cleanupTempDirMock,
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.name = 'GitCloneError';
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
}));

const {
  isGitHubUrl,
  parseGitHubUrl,
  normalizePluginPath,
  parsePluginSource,
  getPluginCachePath,
  validatePluginSource,
  verifyGitHubUrlExists,
} = await import('../../../src/utils/plugin-path.js');

describe('isGitHubUrl', () => {
  it('should detect standard GitHub HTTPS URLs', () => {
    expect(isGitHubUrl('https://github.com/owner/repo')).toBe(true);
    expect(isGitHubUrl('https://www.github.com/owner/repo')).toBe(true);
    expect(isGitHubUrl('http://github.com/owner/repo')).toBe(true);
  });

  it('should detect GitHub URLs without protocol', () => {
    expect(isGitHubUrl('github.com/owner/repo')).toBe(true);
  });

  it('should detect gh: prefix URLs', () => {
    expect(isGitHubUrl('gh:owner/repo')).toBe(true);
  });

  it('should detect shorthand owner/repo format', () => {
    expect(isGitHubUrl('anthropics/claude-plugins-official')).toBe(true);
    expect(isGitHubUrl('owner/repo')).toBe(true);
  });

  it('should detect shorthand owner/repo/subpath format', () => {
    expect(isGitHubUrl('anthropics/claude-plugins-official/plugins/code-review')).toBe(true);
    expect(isGitHubUrl('owner/repo/deep/nested/path')).toBe(true);
  });

  it('should detect repo names with dots', () => {
    expect(isGitHubUrl('WiseTechGlobal/WTG.AI.Prompts')).toBe(true);
    expect(isGitHubUrl('WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise')).toBe(true);
  });

  it('should reject non-GitHub URLs', () => {
    expect(isGitHubUrl('https://gitlab.com/owner/repo')).toBe(false);
    expect(isGitHubUrl('/local/path')).toBe(false);
    expect(isGitHubUrl('./relative/path')).toBe(false);
    expect(isGitHubUrl('../relative/path')).toBe(false);
    expect(isGitHubUrl('not-a-url')).toBe(false);
    expect(isGitHubUrl('C:/windows/path')).toBe(false);
  });
});

describe('parseGitHubUrl', () => {
  it('should parse standard GitHub URLs', () => {
    const result = parseGitHubUrl('https://github.com/EntityProcess/allagents');
    expect(result).toEqual({ owner: 'EntityProcess', repo: 'allagents' });
  });

  it('should parse URLs with .git extension', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse gh: prefix URLs', () => {
    const result = parseGitHubUrl('gh:owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse github.com URLs without protocol', () => {
    const result = parseGitHubUrl('github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse URLs with tree/branch paths', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      branch: 'main',
      subpath: 'plugins/code-review',
    });
  });

  it('should parse shorthand owner/repo format', () => {
    const result = parseGitHubUrl('anthropics/claude-plugins-official');
    expect(result).toEqual({ owner: 'anthropics', repo: 'claude-plugins-official' });
  });

  it('should parse shorthand owner/repo/subpath format', () => {
    const result = parseGitHubUrl('anthropics/claude-plugins-official/plugins/code-review');
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      subpath: 'plugins/code-review',
    });
  });

  it('should parse repo names with dots', () => {
    const result = parseGitHubUrl('WiseTechGlobal/WTG.AI.Prompts');
    expect(result).toEqual({ owner: 'WiseTechGlobal', repo: 'WTG.AI.Prompts' });
  });

  it('should parse repo names with dots and subpath', () => {
    const result = parseGitHubUrl('WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise');
    expect(result).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'WTG.AI.Prompts',
      subpath: 'plugins/cargowise',
    });
  });

  it('should parse URLs with tree/branch but no subpath', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/python-sdk/tree/develop'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'python-sdk',
      branch: 'develop',
    });
  });

  it('should parse URLs with tree/branch and subpath', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/python-sdk/tree/develop/examples/tools'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'python-sdk',
      branch: 'develop',
      subpath: 'examples/tools',
    });
  });

  it('should return null for invalid URLs', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubUrl('not-a-url')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
  });
});

describe('normalizePluginPath', () => {
  it('should leave GitHub URLs unchanged', () => {
    const url = 'https://github.com/owner/repo';
    expect(normalizePluginPath(url)).toBe(url);
  });

  it('should leave absolute paths unchanged', () => {
    const path = '/absolute/path/to/plugin';
    expect(normalizePluginPath(path)).toBe(path);
  });

  it('should convert relative paths to absolute', () => {
    const baseDir = resolve('/base/dir');
    const result = normalizePluginPath('./relative/path', baseDir);
    expect(result).toBe(join(baseDir, 'relative', 'path'));
  });

  it('should handle parent directory references', () => {
    const baseDir = resolve('/base/dir');
    const result = normalizePluginPath('../parent/path', baseDir);
    expect(result).toBe(resolve(baseDir, '..', 'parent', 'path'));
  });

  it('should use current directory as default base', () => {
    const result = normalizePluginPath('./test');
    expect(result).toContain(`${sep}test`);
    expect(result).toMatch(/^([A-Z]:\\|\/)/); // Windows drive or Unix root
  });
});

describe('parsePluginSource', () => {
  it('should parse GitHub sources', () => {
    const result = parsePluginSource('https://github.com/owner/repo');
    expect(result.type).toBe('github');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.original).toBe('https://github.com/owner/repo');
  });

  it('should parse local absolute paths', () => {
    const result = parsePluginSource('/absolute/path');
    expect(result.type).toBe('local');
    expect(result.normalized).toBe('/absolute/path');
    expect(result.owner).toBeUndefined();
    expect(result.repo).toBeUndefined();
  });

  it('should parse local relative paths', () => {
    const baseDir = resolve('/base');
    const result = parsePluginSource('./relative/path', baseDir);
    expect(result.type).toBe('local');
    expect(result.normalized).toBe(join(baseDir, 'relative', 'path'));
    expect(result.original).toBe('./relative/path');
  });
});

describe('getPluginCachePath', () => {
  it('should generate cache path with owner and repo', () => {
    const result = getPluginCachePath('EntityProcess', 'allagents');
    const expectedPath = join('.allagents', 'plugins', 'marketplaces', 'EntityProcess-allagents');
    expect(result).toContain(expectedPath);
  });

  it('should use home directory', () => {
    const result = getPluginCachePath('owner', 'repo');
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    expect(result.startsWith(homeDir || '')).toBe(true);
  });
});

describe('validatePluginSource', () => {
  it('should accept valid GitHub URLs', () => {
    const result = validatePluginSource('https://github.com/owner/repo');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept valid local paths', () => {
    const result = validatePluginSource('/local/path');
    expect(result.valid).toBe(true);
  });

  it('should reject empty sources', () => {
    const result = validatePluginSource('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be empty');
  });

  it('should reject whitespace-only sources', () => {
    const result = validatePluginSource('   ');
    expect(result.valid).toBe(false);
  });

  it('should reject invalid GitHub URLs', () => {
    const result = validatePluginSource('gh:invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });
});

describe('verifyGitHubUrlExists', () => {
  beforeEach(() => {
    repoExistsMock.mockClear();
    cloneToTempMock.mockClear();
    cleanupTempDirMock.mockClear();
  });

  it('should return exists=true for valid repo', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    const result = await verifyGitHubUrlExists('owner/repo');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return exists=true for valid repo with subpath', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    // Create temp dir with the subpath
    const tempDir = join(tmpdir(), `test-verify-${Date.now()}`);
    mkdirSync(join(tempDir, 'plugins', 'myplugin'), { recursive: true });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await verifyGitHubUrlExists('owner/repo/plugins/myplugin');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return error for invalid URL format', async () => {
    const result = await verifyGitHubUrlExists('invalid');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL format');
  });

  it('should return error when repository not found', async () => {
    repoExistsMock.mockResolvedValueOnce(false);

    const result = await verifyGitHubUrlExists('owner/nonexistent-repo');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('not found or not accessible');
  });

  it('should return error when path not found in repo', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    // Create temp dir WITHOUT the subpath
    const tempDir = join(tmpdir(), `test-verify-nopath-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await verifyGitHubUrlExists('owner/repo/nonexistent/path');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Path not found in repository');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
