import { describe, expect, it, test } from 'bun:test';
import {
  CLIENT_MAPPINGS,
  USER_CLIENT_MAPPINGS,
  resolveClientMappings,
} from '../../../src/models/client-mapping.js';

describe('CLIENT_MAPPINGS', () => {
  test('defines project-level paths for all supported clients', () => {
    const expectedClients = [
      'claude', 'copilot', 'codex', 'cursor', 'opencode', 'gemini', 'factory', 'ampcode', 'vscode',
      'openclaw', 'windsurf', 'cline', 'continue', 'roo', 'kilo', 'trae', 'augment', 'zencoder', 'junie', 'openhands', 'kiro', 'replit', 'kimi',
      'universal',
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

  test('copilot uses provider-specific .github/skills/ path', () => {
    expect(CLIENT_MAPPINGS.copilot.skillsPath).toBe('.github/skills/');
  });

  test('codex uses provider-specific .codex/skills/ path', () => {
    expect(CLIENT_MAPPINGS.codex.skillsPath).toBe('.codex/skills/');
  });

  test('opencode uses provider-specific .opencode/skills/ path', () => {
    expect(CLIENT_MAPPINGS.opencode.skillsPath).toBe('.opencode/skills/');
  });

  test('gemini uses provider-specific .gemini/skills/ path', () => {
    expect(CLIENT_MAPPINGS.gemini.skillsPath).toBe('.gemini/skills/');
  });

  test('ampcode uses provider-specific .ampcode/skills/ path', () => {
    expect(CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.ampcode/skills/');
  });

  test('vscode defaults to .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.vscode.skillsPath).toBe('.agents/skills/');
    expect(CLIENT_MAPPINGS.vscode.githubPath).toBeUndefined();
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

  test('replit uses provider-specific .replit/skills/ path', () => {
    expect(CLIENT_MAPPINGS.replit.skillsPath).toBe('.replit/skills/');
  });

  test('kimi uses provider-specific .kimi/skills/ path', () => {
    expect(CLIENT_MAPPINGS.kimi.skillsPath).toBe('.kimi/skills/');
  });

  test('universal uses .agents/skills/ path', () => {
    expect(CLIENT_MAPPINGS.universal.skillsPath).toBe('.agents/skills/');
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

  test('copilot uses provider-specific ~/.copilot/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.copilot.skillsPath).toBe('.copilot/skills/');
  });

  test('codex uses provider-specific ~/.codex/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.codex.skillsPath).toBe('.codex/skills/');
  });

  test('opencode uses provider-specific ~/.opencode/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.opencode.skillsPath).toBe('.opencode/skills/');
  });

  test('gemini uses provider-specific ~/.gemini/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.gemini.skillsPath).toBe('.gemini/skills/');
  });

  test('ampcode uses provider-specific ~/.ampcode/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.ampcode.skillsPath).toBe('.ampcode/skills/');
  });

  test('vscode defaults to .agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.vscode.skillsPath).toBe('.agents/skills/');
    expect(USER_CLIENT_MAPPINGS.vscode.githubPath).toBeUndefined();
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

  test('replit uses provider-specific ~/.replit/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.replit.skillsPath).toBe('.replit/skills/');
  });

  test('kimi uses provider-specific ~/.kimi/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.kimi.skillsPath).toBe('.kimi/skills/');
  });

  test('universal uses ~/.agents/skills/ path', () => {
    expect(USER_CLIENT_MAPPINGS.universal.skillsPath).toBe('.agents/skills/');
  });

  test('user paths are relative to home directory (no leading /)', () => {
    for (const [, mapping] of Object.entries(USER_CLIENT_MAPPINGS)) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
    }
  });
});

describe('resolveClientMappings', () => {
  describe('project-level (CLIENT_MAPPINGS)', () => {
    it('should default vscode to .agents/skills/ when no copilot', () => {
      const resolved = resolveClientMappings(['vscode'], CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.agents/skills/');
      expect(resolved.vscode.githubPath).toBeUndefined();
    });

    it('should resolve vscode to .github/skills/ when copilot is present', () => {
      const resolved = resolveClientMappings(['copilot', 'vscode'], CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.github/skills/');
      expect(resolved.vscode.githubPath).toBe('.github/');
    });

    it('should resolve vscode to .github/skills/ when both copilot and universal are present', () => {
      const resolved = resolveClientMappings(['universal', 'copilot', 'vscode'], CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.github/skills/');
      expect(resolved.vscode.githubPath).toBe('.github/');
    });

    it('should resolve vscode to .agents/skills/ when universal is present but not copilot', () => {
      const resolved = resolveClientMappings(['universal', 'vscode'], CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.agents/skills/');
      expect(resolved.vscode.githubPath).toBeUndefined();
    });

    it('should not modify non-vscode client mappings', () => {
      const resolved = resolveClientMappings(['copilot', 'vscode', 'claude'], CLIENT_MAPPINGS);
      expect(resolved.copilot).toEqual(CLIENT_MAPPINGS.copilot);
      expect(resolved.claude).toEqual(CLIENT_MAPPINGS.claude);
    });

    it('should return baseMappings unchanged when vscode is not in clients', () => {
      const resolved = resolveClientMappings(['copilot', 'claude'], CLIENT_MAPPINGS);
      expect(resolved).toBe(CLIENT_MAPPINGS); // same reference
    });
  });

  describe('user-level (USER_CLIENT_MAPPINGS)', () => {
    it('should default vscode to .agents/skills/ when no copilot', () => {
      const resolved = resolveClientMappings(['vscode'], USER_CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.agents/skills/');
    });

    it('should resolve vscode to .copilot/skills/ when copilot is present', () => {
      const resolved = resolveClientMappings(['copilot', 'vscode'], USER_CLIENT_MAPPINGS);
      expect(resolved.vscode.skillsPath).toBe('.copilot/skills/');
      expect(resolved.vscode.githubPath).toBe('.copilot/');
    });
  });
});
