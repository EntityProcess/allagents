import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

async function createPlugin(baseDir: string, name: string, skillName: string): Promise<string> {
  const pluginDir = join(baseDir, name);
  const skillDir = join(pluginDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: test\n---\n`);
  return pluginDir;
}

describe('syncWorkspace — install mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-install-mode-'));
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('file-only clients work as before with string shorthand', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - claude\n  - copilot\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('native-only client skips file copy for that client', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - name: claude\n    install: native\n  - copilot\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Claude native: local plugin can't install natively -> falls back to file
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    // Copilot file: files copied
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('plugin-level install:file overrides client native', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - source: ./test-plugin\n    install: file\nclients:\n  - name: claude\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Plugin forces file mode even for native client
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
  });

  it('non-marketplace plugin with native client falls back to file copy', async () => {
    await createPlugin(testDir, 'local-plugin', 'local-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./local-plugin\nclients:\n  - name: claude\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Non-marketplace can't install natively, falls back to file
    expect(existsSync(join(testDir, '.claude', 'skills', 'local-skill'))).toBe(true);
  });

  it('copilot native in project scope falls back to file copy', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - name: copilot\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Copilot native with local plugin can't install natively -> falls back to file
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('colon shorthand claude:native skips file copy for marketplace plugin', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - copilot\n  - claude:native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Local plugin falls back to file copy even for native clients
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });
});
