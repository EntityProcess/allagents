import { describe, it, expect } from 'bun:test';
import { extractPluginNames, findPluginEntryByName } from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('extractPluginNames', () => {
  it('extracts repo name from full GitHub URL', () => {
    const names = extractPluginNames('https://github.com/anthropics/skills');
    expect(names).toContain('skills');
  });

  it('includes owner-repo format for GitHub URLs', () => {
    const names = extractPluginNames('https://github.com/anthropics/skills');
    expect(names).toContain('anthropics-skills');
  });

  it('handles GitHub shorthand (owner/repo)', () => {
    const names = extractPluginNames('anthropics/skills');
    expect(names).toContain('skills');
    expect(names).toContain('anthropics-skills');
  });

  it('handles plugin@marketplace spec', () => {
    const names = extractPluginNames('document-skills@anthropic-agent-skills');
    expect(names).toContain('document-skills');
    expect(names).toContain('anthropic-agent-skills');
  });

  it('handles local path', () => {
    const names = extractPluginNames('/home/user/plugins/my-plugin');
    expect(names).toEqual(['my-plugin']);
  });
});

describe('findPluginEntryByName with GitHub URL entries', () => {
  it('matches cache-derived name (owner-repo) against URL entry', () => {
    const config: WorkspaceConfig = {
      plugins: ['https://github.com/anthropics/skills'],
      repositories: [],
      clients: ['copilot'],
      version: 2,
    };
    // The cache directory name is 'anthropics-skills', which is what
    // getAllSkillsFromPlugins uses as pluginName
    const index = findPluginEntryByName(config, 'anthropics-skills');
    expect(index).toBe(0);
  });

  it('matches repo name against URL entry', () => {
    const config: WorkspaceConfig = {
      plugins: ['https://github.com/anthropics/skills'],
      repositories: [],
      clients: ['copilot'],
      version: 2,
    };
    const index = findPluginEntryByName(config, 'skills');
    expect(index).toBe(0);
  });

  it('matches cache-derived name against shorthand entry', () => {
    const config: WorkspaceConfig = {
      plugins: ['anthropics/skills'],
      repositories: [],
      clients: ['copilot'],
      version: 2,
    };
    const index = findPluginEntryByName(config, 'anthropics-skills');
    expect(index).toBe(0);
  });

  it('matches against object-form entry with source URL', () => {
    const config: WorkspaceConfig = {
      plugins: [{ source: 'https://github.com/anthropics/skills', skills: ['pdf'] }],
      repositories: [],
      clients: ['copilot'],
      version: 2,
    };
    const index = findPluginEntryByName(config, 'anthropics-skills');
    expect(index).toBe(0);
  });

  it('returns -1 when no match', () => {
    const config: WorkspaceConfig = {
      plugins: ['https://github.com/other/repo'],
      repositories: [],
      clients: ['copilot'],
      version: 2,
    };
    const index = findPluginEntryByName(config, 'anthropics-skills');
    expect(index).toBe(-1);
  });
});
