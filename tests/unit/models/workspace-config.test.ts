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

  it('should accept plugin object with optional clients', () => {
    const config = {
      repositories: [],
      plugins: [
        { source: 'code-review@claude-plugins-official', clients: ['claude', 'codex'] },
        './plugins/example',
      ],
      clients: ['claude'],
    };

    const result = WorkspaceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
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

describe('enabledSkills', () => {
  it('parses enabledSkills field', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      enabledSkills: ['superpowers:brainstorming'],
    });
    expect(config.enabledSkills).toEqual(['superpowers:brainstorming']);
  });

  it('enabledSkills defaults to undefined', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['claude'],
    });
    expect(config.enabledSkills).toBeUndefined();
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

  it('accepts skills: true', () => {
    const result = RepositorySchema.safeParse({ path: '../repo', skills: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills).toBe(true);
  });

  it('accepts skills: false', () => {
    const result = RepositorySchema.safeParse({ path: '../repo', skills: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills).toBe(false);
  });

  it('accepts skills as array of custom paths', () => {
    const result = RepositorySchema.safeParse({
      path: '../repo',
      skills: ['plugins/agentv-dev/skills', 'plugins/agentic-engineering/skills'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual([
        'plugins/agentv-dev/skills',
        'plugins/agentic-engineering/skills',
      ]);
    }
  });

  it('accepts omitted skills field', () => {
    const result = RepositorySchema.safeParse({ path: '../repo' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills).toBeUndefined();
  });
});
