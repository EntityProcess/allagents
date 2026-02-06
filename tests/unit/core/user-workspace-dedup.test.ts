import { describe, expect, test } from 'bun:test';
import { resolveGitHubIdentity } from '../../../src/core/user-workspace.js';

describe('resolveGitHubIdentity', () => {
  test('resolves GitHub URL to owner/repo', async () => {
    const id = await resolveGitHubIdentity('https://github.com/Owner/Repo');
    expect(id).toBe('owner/repo');
  });

  test('normalizes different URL forms to same identity', async () => {
    const urls = [
      'https://github.com/Owner/Repo',
      'https://github.com/Owner/Repo.git',
      'github.com/Owner/Repo',
      'gh:Owner/Repo',
    ];
    const identities = await Promise.all(urls.map(resolveGitHubIdentity));
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe('owner/repo');
  });

  test('returns null for local paths', async () => {
    const id = await resolveGitHubIdentity('/some/local/path');
    expect(id).toBeNull();
  });
});
