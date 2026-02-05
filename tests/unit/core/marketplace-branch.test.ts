import { describe, it, expect } from 'bun:test';
import { parseLocation } from '../../../src/core/marketplace.js';

describe('parseLocation', () => {
  it('should parse owner/repo without branch', () => {
    expect(parseLocation('owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('should parse owner/repo with simple branch', () => {
    expect(parseLocation('owner/repo/my-branch')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'my-branch',
    });
  });

  it('should parse owner/repo with nested branch', () => {
    expect(parseLocation('WiseTechGlobal/CargoWise.Shared/feat/v2')).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'CargoWise.Shared',
      branch: 'feat/v2',
    });
  });
});
