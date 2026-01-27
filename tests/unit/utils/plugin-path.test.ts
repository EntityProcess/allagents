import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { join, resolve, sep } from 'node:path';
import {
  isGitHubUrl,
  parseGitHubUrl,
  normalizePluginPath,
  parsePluginSource,
  getPluginCachePath,
  validatePluginSource,
  verifyGitHubUrlExists,
} from '../../../src/utils/plugin-path.js';
import * as execa from 'execa';

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
      'https://github.com/WiseTechGlobal/WTG.AI.Prompts/tree/develop'
    );
    expect(result).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'WTG.AI.Prompts',
      branch: 'develop',
    });
  });

  it('should parse URLs with tree/branch and subpath', () => {
    const result = parseGitHubUrl(
      'https://github.com/WiseTechGlobal/WTG.AI.Prompts/tree/develop/plugins/cargowise'
    );
    expect(result).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'WTG.AI.Prompts',
      branch: 'develop',
      subpath: 'plugins/cargowise',
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
  let execaSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    execaSpy = spyOn(execa, 'execa');
  });

  afterEach(() => {
    execaSpy.mockRestore();
  });

  it('should return exists=true for valid repo', async () => {
    execaSpy.mockResolvedValue({ stdout: '', stderr: '' } as never);

    const result = await verifyGitHubUrlExists('owner/repo');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return exists=true for valid repo with subpath', async () => {
    execaSpy.mockResolvedValue({ stdout: '', stderr: '' } as never);

    const result = await verifyGitHubUrlExists('owner/repo/plugins/myplugin');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return error for invalid URL format', async () => {
    const result = await verifyGitHubUrlExists('invalid');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL format');
  });

  it('should return error when gh CLI is not installed', async () => {
    execaSpy.mockRejectedValue(new Error('Command not found: gh') as never);

    const result = await verifyGitHubUrlExists('owner/repo');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('gh CLI not installed');
  });

  it('should return error when repository not found', async () => {
    // First call (gh --version) succeeds
    execaSpy.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);
    // Second call (gh repo view) fails with 404
    execaSpy.mockRejectedValueOnce(new Error('HTTP 404: Not Found') as never);

    const result = await verifyGitHubUrlExists('owner/nonexistent-repo');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Repository not found');
  });

  it('should return error when path not found in repo', async () => {
    // gh --version succeeds
    execaSpy.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);
    // gh repo view succeeds
    execaSpy.mockResolvedValueOnce({ stdout: '{}', stderr: '' } as never);
    // gh api for contents fails with 404
    execaSpy.mockRejectedValueOnce(new Error('HTTP 404: Not Found') as never);

    const result = await verifyGitHubUrlExists('owner/repo/nonexistent/path');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Path not found in repository');
  });

  it('should return error when authentication required', async () => {
    // gh --version succeeds
    execaSpy.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);
    // gh repo view fails with auth error
    execaSpy.mockRejectedValueOnce(new Error('authentication required') as never);

    const result = await verifyGitHubUrlExists('owner/private-repo');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('GitHub authentication required');
  });
});
