import { describe, it, expect } from 'bun:test';
import {
  WorkspaceConfigSchema,
  ClientTypeSchema,
  RepositorySchema,
} from '../../../src/models/workspace-config.js';

describe('WorkspaceConfigSchema', () => {
  it('should validate a valid workspace config', () => {
    const validConfig = {
      repositories: [
        {
          path: '../allagents',
          source: 'github',
          repo: 'EntityProcess/allagents',
          description: 'primary project',
        },
      ],
      plugins: ['./plugins/example'],
      clients: ['claude'],
    };

    const result = WorkspaceConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('should reject invalid client types', () => {
    const invalidConfig = {
      repositories: [],
      plugins: [],
      clients: ['invalid-client'],
    };

    const result = WorkspaceConfigSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });
});

describe('ClientTypeSchema', () => {
  it('should accept all valid client types', () => {
    const validClients = [
      'claude',
      'copilot',
      'codex',
      'cursor',
      'opencode',
      'gemini',
      'factory',
      'ampcode',
    ];

    validClients.forEach((client) => {
      const result = ClientTypeSchema.safeParse(client);
      expect(result.success).toBe(true);
    });
  });
});

describe('disabledSkills', () => {
  it('accepts valid disabledSkills array', () => {
    const config = {
      repositories: [],
      plugins: ['superpowers@official'],
      clients: ['claude'],
      disabledSkills: ['superpowers:brainstorming', 'my-plugin:frontend-design'],
    };
    const result = WorkspaceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disabledSkills).toEqual(['superpowers:brainstorming', 'my-plugin:frontend-design']);
    }
  });

  it('defaults disabledSkills to undefined when not provided', () => {
    const config = {
      repositories: [],
      plugins: [],
      clients: ['claude'],
    };
    const result = WorkspaceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disabledSkills).toBeUndefined();
    }
  });
});

describe('RepositorySchema', () => {
  it('should accept full repository entry', () => {
    const result = RepositorySchema.safeParse({
      path: '../Glow',
      source: 'github',
      repo: 'WiseTechGlobal/Glow',
      description: 'Main Glow application repository',
    });
    expect(result.success).toBe(true);
  });

  it('should accept path-only entry', () => {
    const result = RepositorySchema.safeParse({
      path: '../Glow',
    });
    expect(result.success).toBe(true);
  });

  it('should reject entry without path', () => {
    const result = RepositorySchema.safeParse({
      source: 'github',
      repo: 'WiseTechGlobal/Glow',
    });
    expect(result.success).toBe(false);
  });
});
