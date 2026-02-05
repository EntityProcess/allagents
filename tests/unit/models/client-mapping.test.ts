import { describe, expect, test } from 'bun:test';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

describe('USER_CLIENT_MAPPINGS', () => {
  test('defines user-level paths for all clients in CLIENT_MAPPINGS', () => {
    for (const client of Object.keys(CLIENT_MAPPINGS)) {
      expect(USER_CLIENT_MAPPINGS).toHaveProperty(client);
    }
  });

  test('claude uses ~/.claude/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.claude.skillsPath).toBe('.claude/skills/');
    expect(USER_CLIENT_MAPPINGS.claude.commandsPath).toBe('.claude/commands/');
    expect(USER_CLIENT_MAPPINGS.claude.hooksPath).toBe('.claude/hooks/');
    expect(USER_CLIENT_MAPPINGS.claude.agentsPath).toBe('.claude/agents/');
  });

  test('copilot uses ~/.copilot/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.copilot.skillsPath).toBe('.copilot/skills/');
  });

  test('codex uses ~/.codex/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.codex.skillsPath).toBe('.codex/skills/');
  });

  test('opencode uses .config/opencode/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.opencode.skillsPath).toBe('.config/opencode/skills/');
  });

  test('ampcode uses .config/amp/ paths', () => {
    expect(USER_CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.config/amp/skills/');
  });

  test('user paths are relative to home directory (no leading /)', () => {
    for (const [, mapping] of Object.entries(USER_CLIENT_MAPPINGS)) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
    }
  });
});
