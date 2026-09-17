import { describe, expect, it } from 'bun:test';
import {
  canonicalizeGitSource,
  gitSourceKey,
  normalizeGitRef,
} from '../../../src/utils/git-source.js';

describe('canonicalizeGitSource', () => {
  it('collapses known-equivalent GitHub transports and trailing .git', () => {
    const sources = [
      'https://github.com/Acme/Tools.git',
      'git@github.com:Acme/Tools.git',
      'ssh://git@github.com/Acme/Tools.git',
      'github.com/Acme/Tools',
      'gh:Acme/Tools',
      'Acme/Tools',
    ];

    expect(new Set(sources.map(canonicalizeGitSource))).toEqual(
      new Set(['https://github.com/acme/tools']),
    );
  });

  it('does not collapse shorthand paths beyond owner and repository', () => {
    const shorthand = 'Acme/Tools/extra';
    const prefixed = 'gh:Acme/Tools/extra';

    expect(canonicalizeGitSource(shorthand)).toBe(shorthand);
    expect(canonicalizeGitSource(prefixed)).toBe(prefixed);
    expect(gitSourceKey(shorthand)).not.toBe(gitSourceKey(prefixed));
  });

  it('retains transport, user, host, port, and path identity for generic remotes', () => {
    const sources = [
      'https://git.example.com/team/repo.git',
      'ssh://git@git.example.com/team/repo.git',
      'ssh://deploy@git.example.com/team/repo.git',
      'ssh://git@git.example.com:2222/team/repo.git',
      'ssh://git@mirror.example.com/team/repo.git',
      'ssh://git@git.example.com/other/repo.git',
    ];

    expect(new Set(sources.map(canonicalizeGitSource)).size).toBe(sources.length);
  });
});

describe('Git source identity', () => {
  it('normalizes equivalent ref spellings into one key', () => {
    expect(normalizeGitRef(' refs/heads/main ')).toBe('main');
    expect(normalizeGitRef('origin/main')).toBe('main');
    expect(normalizeGitRef(undefined)).toBeUndefined();
    expect(
      gitSourceKey('git@github.com:Acme/Tools.git', 'refs/heads/main'),
    ).toBe(gitSourceKey('https://github.com/acme/tools', 'origin/main'));
  });

  it('keeps distinct sources and refs distinct', () => {
    const keys = [
      gitSourceKey('https://github.com/acme/tools', 'main'),
      gitSourceKey('https://github.com/acme/other', 'main'),
      gitSourceKey('https://github.com/other/tools', 'main'),
      gitSourceKey('https://git.example.com/acme/tools', 'main'),
      gitSourceKey('https://github.com/acme/tools', 'next'),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
