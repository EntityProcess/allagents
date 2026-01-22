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
          owner: 'EntityProcess',
          repo: 'allagents',
          description: 'primary project',
        },
      ],
      plugins: ['.claude/allagents'],
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

describe('RepositorySchema', () => {
  it('should validate a valid repository', () => {
    const validRepo = {
      path: '../my-repo',
      owner: 'username',
      repo: 'repo-name',
      description: 'A repository',
    };

    const result = RepositorySchema.safeParse(validRepo);
    expect(result.success).toBe(true);
  });

  it('should reject repository missing required fields', () => {
    const invalidRepo = {
      path: '../my-repo',
      owner: 'username',
      // missing repo and description
    };

    const result = RepositorySchema.safeParse(invalidRepo);
    expect(result.success).toBe(false);
  });
});
