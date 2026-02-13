import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUserPlugin,
  removeUserPlugin,
  getUserWorkspaceConfig,
  ensureUserWorkspace,
  getUserWorkspaceConfigPath,
} from '../../../src/core/user-workspace.js';

describe('user-workspace', () => {
  let tempHome: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('getUserWorkspaceConfigPath', () => {
    test('returns path under ~/.allagents', () => {
      const configPath = getUserWorkspaceConfigPath();
      expect(configPath).toContain('.allagents');
      expect(configPath).toEndWith('workspace.yaml');
    });
  });

  describe('ensureUserWorkspace', () => {
    test('creates ~/.allagents/workspace.yaml if missing', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toEqual([]);
      // User-scope should NOT include claude (only project-scope does)
      expect(config!.clients).not.toContain('claude');
      expect(config!.clients).toContain('copilot');
    });

    test('does not overwrite existing config', async () => {
      await ensureUserWorkspace();
      // Create a real temp plugin directory so path validation passes
      const pluginDir = join(tempHome, 'fake-plugin-dir');
      await mkdir(pluginDir, { recursive: true });

      // Use a local path plugin (no @, so won't trigger marketplace resolution)
      await addUserPlugin(pluginDir);
      await ensureUserWorkspace(); // call again
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('creates default config with user-scope clients (excludes claude)', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      // User-scope excludes claude (only project-scope includes it)
      expect(config!.clients).not.toContain('claude');
      expect(config!.clients).toContain('copilot');
      expect(config!.clients).toContain('codex');
      expect(config!.clients).toContain('cursor');
      expect(config!.clients).toContain('opencode');
      expect(config!.clients).toContain('gemini');
      expect(config!.clients).toContain('factory');
      expect(config!.clients).toContain('ampcode');
      expect(config!.clients).toContain('vscode');
    });
  });

  describe('getUserWorkspaceConfig', () => {
    test('returns null when config does not exist', async () => {
      const config = await getUserWorkspaceConfig();
      expect(config).toBeNull();
    });

    test('reads existing config', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toBeInstanceOf(Array);
      expect(config!.clients).toBeInstanceOf(Array);
    });
  });

  describe('addUserPlugin', () => {
    test('adds local path plugin to user workspace.yaml', async () => {
      // Create a real temp plugin directory so path validation passes
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('rejects duplicate plugin', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      await addUserPlugin(pluginDir);
      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    test('creates config if it does not exist yet', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      // Config doesn't exist yet
      expect(await getUserWorkspaceConfig()).toBeNull();

      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(true);

      // Config was auto-created
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('rejects non-existent local path', async () => {
      const nonExistentPath = join(tempHome, 'nonexistent-plugin');
      const result = await addUserPlugin(nonExistentPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Plugin not found at');
      expect(result.error).toContain(nonExistentPath);
    });
  });

  describe('removeUserPlugin', () => {
    test('removes plugin from user workspace.yaml', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      await addUserPlugin(pluginDir);
      const result = await removeUserPlugin(pluginDir);
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).not.toContain(pluginDir);
    });

    test('returns error for non-existent plugin', async () => {
      await ensureUserWorkspace();
      const result = await removeUserPlugin('/nonexistent/plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('creates config if it does not exist yet', async () => {
      const result = await removeUserPlugin('/nonexistent/plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      // Config was auto-created as a side effect
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
    });

    test('removes plugin using partial match (e.g., "code-review" matches "code-review@marketplace")', async () => {
      await ensureUserWorkspace();

      // Manually add a plugin with marketplace suffix
      const configPath = getUserWorkspaceConfigPath();
      const content = await readFile(configPath, 'utf-8');
      const { load: yamlLoad } = await import('js-yaml');
      const config = yamlLoad(content) as any;
      config.plugins.push('code-review@marketplace');

      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      // Now remove using partial match
      const result = await removeUserPlugin('code-review');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.plugins).not.toContain('code-review@marketplace');
    });

    test('cleans up disabled skills when removing plugin spec', async () => {
      await ensureUserWorkspace();

      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad } = await import('js-yaml');
      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');

      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('cargowise@wtg-ai-prompts');
      config.disabledSkills = ['cargowise:cw-document-macro', 'other:skill'];
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const result = await removeUserPlugin('cargowise@wtg-ai-prompts');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.plugins).not.toContain('cargowise@wtg-ai-prompts');
      expect(updatedConfig!.disabledSkills ?? []).not.toContain('cargowise:cw-document-macro');
      expect(updatedConfig!.disabledSkills).toContain('other:skill');
    });

    test('clears disabledSkills entirely when all belong to removed plugin', async () => {
      await ensureUserWorkspace();

      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad } = await import('js-yaml');
      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');

      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('cargowise@wtg-ai-prompts');
      config.disabledSkills = ['cargowise:cw-document-macro', 'cargowise:cw-coding'];
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const result = await removeUserPlugin('cargowise@wtg-ai-prompts');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.disabledSkills).toBeUndefined();
    });
  });
});
