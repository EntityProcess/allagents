import { describe, it, expect } from 'bun:test';
import { shouldClone, shouldPull, buildCloneUrl, expandHome } from '../../../src/core/managed-repos.js';

describe('shouldClone', () => {
  it('returns false for undefined', () => {
    expect(shouldClone(undefined)).toBe(false);
  });

  it('returns false for false', () => {
    expect(shouldClone(false)).toBe(false);
  });

  it('returns true for true', () => {
    expect(shouldClone(true)).toBe(true);
  });

  it('returns true for "clone"', () => {
    expect(shouldClone('clone')).toBe(true);
  });

  it('returns true for "sync"', () => {
    expect(shouldClone('sync')).toBe(true);
  });
});

describe('shouldPull', () => {
  it('returns false for undefined', () => {
    expect(shouldPull(undefined)).toBe(false);
  });

  it('returns false for false', () => {
    expect(shouldPull(false)).toBe(false);
  });

  it('returns false for "clone"', () => {
    expect(shouldPull('clone')).toBe(false);
  });

  it('returns true for true', () => {
    expect(shouldPull(true)).toBe(true);
  });

  it('returns true for "sync"', () => {
    expect(shouldPull('sync')).toBe(true);
  });
});

describe('buildCloneUrl', () => {
  it('builds GitHub HTTPS URL', () => {
    expect(buildCloneUrl('github', 'owner/repo')).toBe('https://github.com/owner/repo.git');
  });

  it('builds GitLab HTTPS URL', () => {
    expect(buildCloneUrl('gitlab', 'owner/repo')).toBe('https://gitlab.com/owner/repo.git');
  });

  it('builds Bitbucket HTTPS URL', () => {
    expect(buildCloneUrl('bitbucket', 'owner/repo')).toBe('https://bitbucket.org/owner/repo.git');
  });

  it('builds Azure DevOps URL from org/project/repo', () => {
    expect(buildCloneUrl('azure-devops', 'myorg/myproject/myrepo')).toBe(
      'https://dev.azure.com/myorg/myproject/_git/myrepo',
    );
  });

  it('falls back to generic URL for unknown source', () => {
    expect(buildCloneUrl('gitea.example.com', 'owner/repo')).toBe(
      'https://gitea.example.com/owner/repo.git',
    );
  });
});

describe('expandHome', () => {
  it('expands ~ prefix', () => {
    const result = expandHome('~/projects/foo');
    expect(result).not.toStartWith('~');
    expect(result).toEndWith('/projects/foo');
  });

  it('expands bare ~', () => {
    const result = expandHome('~');
    expect(result).not.toBe('~');
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('../relative/path')).toBe('../relative/path');
  });
});
