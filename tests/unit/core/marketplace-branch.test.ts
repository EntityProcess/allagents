import { describe, it, expect } from 'bun:test';
import { parseLocation, parseMarketplaceSource } from '../../../src/core/marketplace.js';

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

describe('parseMarketplaceSource branch extraction', () => {
  it('should extract branch from GitHub URL with /tree/', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/feat/v2');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/feat/v2',
      name: 'repo',
      branch: 'feat/v2',
    });
  });

  it('should extract simple branch from GitHub URL', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo/tree/main');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/main',
      name: 'repo',
      branch: 'main',
    });
  });

  it('should handle GitHub URL without branch (unchanged)', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });

  it('should handle GitHub URL with .git suffix and branch', () => {
    const result = parseMarketplaceSource('https://github.com/owner/repo.git/tree/dev');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo/dev',
      name: 'repo',
      branch: 'dev',
    });
  });

  it('should not extract branch from owner/repo shorthand', () => {
    const result = parseMarketplaceSource('owner/repo');
    expect(result).toEqual({
      type: 'github',
      location: 'owner/repo',
      name: 'repo',
    });
  });
});

describe('parseMarketplaceSource Windows local paths', () => {
  it('should parse Windows absolute path with forward slashes', () => {
    const result = parseMarketplaceSource('D:/GitHub/WiseTechGlobal/WTG.AI.Prompts');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('WTG.AI.Prompts');
  });

  it('should parse Windows absolute path with backslashes', () => {
    const result = parseMarketplaceSource('C:\\Users\\test\\my-marketplace');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('my-marketplace');
  });

  it('should parse lowercase Windows drive letter', () => {
    const result = parseMarketplaceSource('c:/projects/plugins');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('local');
    expect(result!.name).toBe('plugins');
  });
});
