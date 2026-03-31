import { describe, it, expect } from 'bun:test';
import { shouldClone, shouldPull, buildCloneUrl, expandHome, isValidRepo, processManagedRepos } from '../../../src/core/managed-repos.js';

describe('shouldClone', () => {
  it('returns false for undefined or false', () => {
    expect(shouldClone(undefined)).toBe(false);
    expect(shouldClone(false)).toBe(false);
  });

  it('returns true for true, "clone", or "sync"', () => {
    expect(shouldClone(true)).toBe(true);
    expect(shouldClone('clone')).toBe(true);
    expect(shouldClone('sync')).toBe(true);
  });
});

describe('shouldPull', () => {
  it('returns false for undefined, false, or "clone"', () => {
    expect(shouldPull(undefined)).toBe(false);
    expect(shouldPull(false)).toBe(false);
    expect(shouldPull('clone')).toBe(false);
  });

  it('returns true for true or "sync"', () => {
    expect(shouldPull(true)).toBe(true);
    expect(shouldPull('sync')).toBe(true);
  });
});

describe('isValidRepo', () => {
  it('accepts standard owner/repo format', () => {
    expect(isValidRepo('owner/repo')).toBe(true);
    expect(isValidRepo('my-org/my-repo.js')).toBe(true);
    expect(isValidRepo('org/project/repo')).toBe(true);
  });

  it('rejects dangerous characters', () => {
    expect(isValidRepo('owner/repo --upload-pack="evil"')).toBe(false);
    expect(isValidRepo('owner/repo;rm -rf /')).toBe(false);
    expect(isValidRepo('$(whoami)/repo')).toBe(false);
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

  it('throws on invalid repo identifier', () => {
    expect(() => buildCloneUrl('github', 'owner/repo --inject')).toThrow('Invalid repo identifier');
  });
});

describe('expandHome', () => {
  it('expands ~ prefix', () => {
    const result = expandHome('~/projects/foo');
    expect(result).not.toStartWith('~');
    expect(result).toEndWith('/projects/foo');
  });

  it('leaves absolute and relative paths unchanged', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
    expect(expandHome('../relative/path')).toBe('../relative/path');
  });
});

describe('processManagedRepos', () => {
  it('returns empty when skipManaged is true', async () => {
    const repos = [{ path: '/tmp/x', source: 'github', repo: 'o/r', managed: true as const }];
    const result = await processManagedRepos(repos, '/tmp', { skipManaged: true });
    expect(result).toEqual([]);
  });

  it('returns empty when offline is true', async () => {
    const repos = [{ path: '/tmp/x', source: 'github', repo: 'o/r', managed: true as const }];
    const result = await processManagedRepos(repos, '/tmp', { offline: true });
    expect(result).toEqual([]);
  });

  it('returns empty when dryRun is true', async () => {
    const repos = [{ path: '/tmp/x', source: 'github', repo: 'o/r', managed: true as const }];
    const result = await processManagedRepos(repos, '/tmp', { dryRun: true });
    expect(result).toEqual([]);
  });

  it('returns empty for repos without managed field', async () => {
    const repos = [{ path: '/tmp/x', source: 'github', repo: 'o/r' }];
    const result = await processManagedRepos(repos, '/tmp');
    expect(result).toEqual([]);
  });

  it('reports error when source or repo is missing', async () => {
    const repos = [{ path: '/tmp/x', managed: true as const }];
    const result = await processManagedRepos(repos, '/tmp');
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('skipped');
    expect(result[0].error).toContain('managed requires both source and repo fields');
  });
});
