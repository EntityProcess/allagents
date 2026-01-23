import { describe, it, expect } from 'bun:test';
import { parsePluginSpec, isPluginSpec } from '../../../src/core/marketplace.js';

describe('parsePluginSpec', () => {
  it('should parse simple marketplace name', () => {
    const result = parsePluginSpec('my-plugin@claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo format', () => {
    const result = parsePluginSpec('my-plugin@anthropics/claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo/subpath format', () => {
    const result = parsePluginSpec('feature-dev@anthropics/claude-plugins-official/plugins');
    expect(result).toEqual({
      plugin: 'feature-dev',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      subpath: 'plugins',
    });
  });

  it('should parse owner/repo with nested subpath', () => {
    const result = parsePluginSpec('addon@owner/repo/src/addons');
    expect(result).toEqual({
      plugin: 'addon',
      marketplaceName: 'repo',
      owner: 'owner',
      repo: 'repo',
      subpath: 'src/addons',
    });
  });

  it('should return null for invalid specs', () => {
    expect(parsePluginSpec('no-at-sign')).toBeNull();
    expect(parsePluginSpec('@missing-plugin')).toBeNull();
    expect(parsePluginSpec('missing-marketplace@')).toBeNull();
    expect(parsePluginSpec('')).toBeNull();
  });

  it('should not confuse URL with owner/repo', () => {
    // URLs with :// should not be treated as owner/repo
    const result = parsePluginSpec('plugin@https://github.com/owner/repo');
    expect(result).toEqual({
      plugin: 'plugin',
      marketplaceName: 'https://github.com/owner/repo',
    });
  });
});

describe('isPluginSpec', () => {
  it('should return true for valid specs', () => {
    expect(isPluginSpec('plugin@marketplace')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo/subpath')).toBe(true);
  });

  it('should return false for invalid specs', () => {
    expect(isPluginSpec('no-at-sign')).toBe(false);
    expect(isPluginSpec('@missing-plugin')).toBe(false);
    expect(isPluginSpec('missing-marketplace@')).toBe(false);
    expect(isPluginSpec('')).toBe(false);
  });
});
