import { describe, expect, test } from 'bun:test';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

describe('CLIENT_MAPPINGS', () => {
  test('defines project-level paths for all supported clients', () => {
    const expectedClients = [
      'claude', 'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode', 'vscode',
      // Additional clients
      'openclaw', 'windsurf', 'cline', 'continue', 'roo', 'kilo', 'trae', 'augment', 'zencoder', 'junie', 'openhands', 'kiro', 'replit', 'kimi',
    ];
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

  test('vscode uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.vscode.skillsPath).toBe('.agents/skills/');
  });

  test('openclaw uses root-level skills/ path (no dot prefix)', () => {
    expect(CLIENT_MAPPINGS.openclaw.skillsPath).toBe('skills/');
  });

  test('windsurf uses provider-specific .windsurf/skills/ path', () => {
    expect(CLIENT_MAPPINGS.windsurf.skillsPath).toBe('.windsurf/skills/');
  });

  test('cline uses provider-specific .cline/skills/ path', () => {
    expect(CLIENT_MAPPINGS.cline.skillsPath).toBe('.cline/skills/');
  });

  test('continue uses provider-specific .continue/skills/ path', () => {
    expect(CLIENT_MAPPINGS.continue.skillsPath).toBe('.continue/skills/');
  });

  test('roo uses provider-specific .roo/skills/ path', () => {
    expect(CLIENT_MAPPINGS.roo.skillsPath).toBe('.roo/skills/');
  });

  test('kilo uses provider-specific .kilocode/skills/ path', () => {
    expect(CLIENT_MAPPINGS.kilo.skillsPath).toBe('.kilocode/skills/');
  });

  test('replit uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.replit.skillsPath).toBe('.agents/skills/');
  });

  test('kimi uses universal .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.kimi.skillsPath).toBe('.agents/skills/');
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

  test('cursor uses provider-specific ~/.cursor/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.cursor.skillsPath).toBe('.cursor/skills/');
  });

  test('factory uses provider-specific ~/.factory/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.factory.skillsPath).toBe('.factory/skills/');
    expect(USER_CLIENT_MAPPINGS.factory.hooksPath).toBe('.factory/hooks/');
  });

  test('copilot uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.copilot.skillsPath).toBe('.agents/skills/');
  });

  test('codex uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.codex.skillsPath).toBe('.agents/skills/');
  });

  test('opencode uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.opencode.skillsPath).toBe('.agents/skills/');
  });

  test('gemini uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.gemini.skillsPath).toBe('.agents/skills/');
  });

  test('ampcode uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.agents/skills/');
  });

  test('vscode uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.vscode.skillsPath).toBe('.agents/skills/');
  });

  test('openclaw uses root-level skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.openclaw.skillsPath).toBe('skills/');
  });

  test('windsurf uses ~/.codeium/windsurf/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.windsurf.skillsPath).toBe('.codeium/windsurf/skills/');
  });

  test('cline uses ~/.cline/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.cline.skillsPath).toBe('.cline/skills/');
  });

  test('replit uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.replit.skillsPath).toBe('.agents/skills/');
  });

  test('kimi uses universal ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.kimi.skillsPath).toBe('.agents/skills/');
  });

  test('user paths are relative to home directory (no leading /)', () => {
    for (const [, mapping] of Object.entries(USER_CLIENT_MAPPINGS)) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
    }
  });
});
