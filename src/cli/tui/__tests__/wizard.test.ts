import { describe, it, expect } from 'bun:test';
import { buildMenuOptions, type MenuAction } from '../wizard.js';
import type { TuiContext } from '../context.js';

/** Helper to create a TuiContext with sensible defaults. */
function makeContext(overrides: Partial<TuiContext> = {}): TuiContext {
  return {
    hasWorkspace: false,
    workspacePath: null,
    projectPluginCount: 0,
    userPluginCount: 0,
    needsSync: false,
    hasUserConfig: false,
    marketplaceCount: 0,
    ...overrides,
  };
}

/** Extract just the action values from menu options. */
function actionValues(context: TuiContext): MenuAction[] {
  return buildMenuOptions(context).map((o) => o.value);
}

describe('buildMenuOptions', () => {
  describe('State 1: No workspace', () => {
    const context = makeContext({ hasWorkspace: false, needsSync: false });

    it('should have "init" as the first option', () => {
      const values = actionValues(context);
      expect(values[0]).toBe('init');
    });

    it('should include marketplace and install', () => {
      const values = actionValues(context);
      expect(values).toContain('marketplace');
      expect(values).toContain('install');
    });

    it('should NOT include sync, status, manage, manage-skills, or update', () => {
      const values = actionValues(context);
      expect(values).not.toContain('sync');
      expect(values).not.toContain('status');
      expect(values).not.toContain('manage');
      expect(values).not.toContain('manage-skills');
      expect(values).not.toContain('update');
    });

    it('should have "exit" as the last option', () => {
      const values = actionValues(context);
      expect(values[values.length - 1]).toBe('exit');
    });
  });

  describe('State 2: Workspace needs sync', () => {
    const context = makeContext({
      hasWorkspace: true,
      workspacePath: '/tmp/test',
      needsSync: true,
      projectPluginCount: 2,
      userPluginCount: 1,
    });

    it('should have "sync" as the first option', () => {
      const values = actionValues(context);
      expect(values[0]).toBe('sync');
    });

    it('should include status, install, manage, and marketplace', () => {
      const values = actionValues(context);
      expect(values).toContain('status');
      expect(values).toContain('install');
      expect(values).toContain('manage');
      expect(values).toContain('marketplace');
    });

    it('should NOT include init or update', () => {
      const values = actionValues(context);
      expect(values).not.toContain('init');
      expect(values).not.toContain('update');
    });

    it('should have "exit" as the last option', () => {
      const values = actionValues(context);
      expect(values[values.length - 1]).toBe('exit');
    });

    it('should show sync needed hint on sync option', () => {
      const options = buildMenuOptions(context);
      const syncOption = options.find((o) => o.value === 'sync');
      expect(syncOption?.hint).toBe('sync needed');
    });

    it('should include manage-clients', () => {
      const values = actionValues(context);
      expect(values).toContain('manage-clients');
    });

    it('should include manage-skills', () => {
      const values = actionValues(context);
      expect(values).toContain('manage-skills');
    });
  });

  describe('State 3: All synced', () => {
    const context = makeContext({
      hasWorkspace: true,
      workspacePath: '/tmp/test',
      needsSync: false,
      projectPluginCount: 3,
    });

    it('should have "status" as the first option', () => {
      const values = actionValues(context);
      expect(values[0]).toBe('status');
    });

    it('should include install, manage, marketplace, and update', () => {
      const values = actionValues(context);
      expect(values).toContain('install');
      expect(values).toContain('manage');
      expect(values).toContain('marketplace');
      expect(values).toContain('update');
    });

    it('should NOT include init or sync', () => {
      const values = actionValues(context);
      expect(values).not.toContain('init');
      expect(values).not.toContain('sync');
    });

    it('should include manage-clients', () => {
      const values = actionValues(context);
      expect(values).toContain('manage-clients');
    });

    it('should include manage-skills', () => {
      const values = actionValues(context);
      expect(values).toContain('manage-skills');
    });

    it('should have "exit" as the last option', () => {
      const values = actionValues(context);
      expect(values[values.length - 1]).toBe('exit');
    });
  });

  describe('exit option', () => {
    it('should always be present regardless of state', () => {
      const states = [
        makeContext({ hasWorkspace: false }),
        makeContext({ hasWorkspace: true, needsSync: true }),
        makeContext({ hasWorkspace: true, needsSync: false }),
      ];
      for (const ctx of states) {
        const values = actionValues(ctx);
        expect(values).toContain('exit');
      }
    });
  });
});
