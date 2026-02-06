import { describe, expect, test } from 'bun:test';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

describe('CLIENT_MAPPINGS', () => {
  test('defines project-level paths for all supported clients', () => {
    const expectedClients = ['claude', 'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode', 'vscode'];
    for (const client of expectedClients) {
      expect(CLIENT_MAPPINGS).toHaveProperty(client);
    }
  });

  test('claude uses provider-specific .claude/skills/ path', () => {
    expect(CLIENT_MAPPINGS.claude.skillsPath).toBe('.claude/skills/');
    expect(CLIENT_MAPPINGS.claude.commandsPath).toBe('.claude/commands/');
    expect(CLIENT_MAPPINGS.claude.hooksPath).toBe('.claude/hooks/');
    expect(CLIENT_MAPPINGS.claude.agentsPath).toBe('.claude/agents/');
  });

  test('cursor uses provider-specific .cursor/skills/ path', () => {
    expect(CLIENT_MAPPINGS.cursor.skillsPath).toBe('.cursor/skills/');
  });

  test('factory uses provider-specific .factory/skills/ path', () => {
    expect(CLIENT_MAPPINGS.factory.skillsPath).toBe('.factory/skills/');
    expect(CLIENT_MAPPINGS.factory.hooksPath).toBe('.factory/hooks/');
  });

  test('copilot uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.copilot.skillsPath).toBe('.agents/skills/');
  });

  test('codex uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.codex.skillsPath).toBe('.agents/skills/');
  });

  test('opencode uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.opencode.skillsPath).toBe('.agents/skills/');
  });

  test('gemini uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.gemini.skillsPath).toBe('.agents/skills/');
  });

  test('ampcode uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.agents/skills/');
  });

  test('vscode has empty skillsPath (not applicable)', () => {
    expect(CLIENT_MAPPINGS.vscode.skillsPath).toBe('');
  });

  test('project paths are relative (no leading /)', () => {
    for (const [, mapping] of Object.entries(CLIENT_MAPPINGS)) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
    }
  });
});

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
