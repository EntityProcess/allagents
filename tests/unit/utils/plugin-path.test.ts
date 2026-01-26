import { describe, it, expect } from 'bun:test';
import { join, resolve, sep } from 'node:path';
import {
  isGitHubUrl,
  parseGitHubUrl,
  normalizePluginPath,
  parsePluginSource,
  getPluginCachePath,
  validatePluginSource,
} from '../../../src/utils/plugin-path.js';

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
