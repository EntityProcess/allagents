import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSyncStatePath,
  loadSyncState,
  saveSyncState,
  getPreviouslySyncedFiles,
  getPreviouslySyncedMcpServers,
} from '../../../src/core/sync-state.js';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../../../src/constants.js';

describe('sync-state', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-state-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getSyncStatePath', () => {
    it('should return correct path', () => {
      const result = getSyncStatePath(testDir);
      expect(result).toBe(join(testDir, CONFIG_DIR, SYNC_STATE_FILE));
    });
  });

  describe('loadSyncState', () => {
    it('should return null when file does not exist', async () => {
      const result = await loadSyncState(testDir);
      expect(result).toBeNull();
    });

    it('should return null on corrupted JSON', async () => {
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(join(testDir, CONFIG_DIR, SYNC_STATE_FILE), 'not json');

      const result = await loadSyncState(testDir);
      expect(result).toBeNull();
    });

    it('should return null on invalid schema', async () => {
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      await writeFile(
        join(testDir, CONFIG_DIR, SYNC_STATE_FILE),
        JSON.stringify({ version: 999, invalid: true }),
      );

      const result = await loadSyncState(testDir);
      expect(result).toBeNull();
    });

    it('should load valid state file', async () => {
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      const state = {
        version: 1,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {
          claude: ['.claude/commands/test.md'],
        },
      };
      await writeFile(
        join(testDir, CONFIG_DIR, SYNC_STATE_FILE),
        JSON.stringify(state),
      );

      const result = await loadSyncState(testDir);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.files.claude).toEqual(['.claude/commands/test.md']);
    });
  });

  describe('saveSyncState', () => {
    it('should create state file with correct structure', async () => {
      await saveSyncState(testDir, {
        claude: ['.claude/commands/cmd1.md', '.claude/commands/cmd2.md'],
      });

      const statePath = join(testDir, CONFIG_DIR, SYNC_STATE_FILE);
      expect(existsSync(statePath)).toBe(true);

      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      expect(state.version).toBe(1);
      expect(state.lastSync).toBeDefined();
      expect(state.files.claude).toEqual([
        '.claude/commands/cmd1.md',
        '.claude/commands/cmd2.md',
      ]);
    });

    it('should create config directory if it does not exist', async () => {
      expect(existsSync(join(testDir, CONFIG_DIR))).toBe(false);

      await saveSyncState(testDir, { claude: [] });

      expect(existsSync(join(testDir, CONFIG_DIR))).toBe(true);
    });
  });

  describe('getPreviouslySyncedFiles', () => {
    it('should return empty array when state is null', () => {
      const result = getPreviouslySyncedFiles(null, 'claude');
      expect(result).toEqual([]);
    });

    it('should return empty array when client has no files', () => {
      const state = {
        version: 1 as const,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {},
      };

      const result = getPreviouslySyncedFiles(state, 'claude');
      expect(result).toEqual([]);
    });

    it('should return files for specific client', () => {
      const state = {
        version: 1 as const,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {
          claude: ['.claude/commands/cmd1.md', '.claude/commands/cmd2.md'],
          copilot: ['.github/skills/my-skill/'],
        },
      };

      expect(getPreviouslySyncedFiles(state, 'claude')).toEqual([
        '.claude/commands/cmd1.md',
        '.claude/commands/cmd2.md',
      ]);
      expect(getPreviouslySyncedFiles(state, 'copilot')).toEqual([
        '.github/skills/my-skill/',
      ]);
    });
  });

  describe('getPreviouslySyncedMcpServers', () => {
    it('should return empty array when state is null', () => {
      const result = getPreviouslySyncedMcpServers(null, 'vscode');
      expect(result).toEqual([]);
    });

    it('should return empty array when mcpServers is not defined', () => {
      const state = {
        version: 1 as const,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {},
      };

      const result = getPreviouslySyncedMcpServers(state, 'vscode');
      expect(result).toEqual([]);
    });

    it('should return empty array when scope has no servers', () => {
      const state = {
        version: 1 as const,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {},
        mcpServers: {},
      };

      const result = getPreviouslySyncedMcpServers(state, 'vscode');
      expect(result).toEqual([]);
    });

    it('should return servers for specific scope', () => {
      const state = {
        version: 1 as const,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {},
        mcpServers: {
          vscode: ['server1', 'server2'],
        },
      };

      const result = getPreviouslySyncedMcpServers(state, 'vscode');
      expect(result).toEqual(['server1', 'server2']);
    });
  });

  describe('saveSyncState with mcpServers', () => {
    it('should save state with mcpServers using SyncStateData format', async () => {
      await saveSyncState(testDir, {
        files: {
          claude: ['.claude/commands/cmd1.md'],
        },
        mcpServers: {
          vscode: ['server1', 'server2'],
        },
      });

      const statePath = join(testDir, CONFIG_DIR, SYNC_STATE_FILE);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      expect(state.version).toBe(1);
      expect(state.files.claude).toEqual(['.claude/commands/cmd1.md']);
      expect(state.mcpServers.vscode).toEqual(['server1', 'server2']);
    });

    it('should not include mcpServers key when undefined', async () => {
      await saveSyncState(testDir, {
        files: {
          claude: ['.claude/commands/cmd1.md'],
        },
      });

      const statePath = join(testDir, CONFIG_DIR, SYNC_STATE_FILE);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      expect(state.mcpServers).toBeUndefined();
    });

    it('should save empty mcpServers array when all servers removed', async () => {
      await saveSyncState(testDir, {
        files: {
          claude: ['.claude/commands/cmd1.md'],
        },
        mcpServers: {
          vscode: [], // Empty array - all servers were removed
        },
      });

      const statePath = join(testDir, CONFIG_DIR, SYNC_STATE_FILE);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      // Should save empty array, not omit the key
      expect(state.mcpServers).toBeDefined();
      expect(state.mcpServers.vscode).toEqual([]);
    });

    it('should load state with mcpServers correctly', async () => {
      await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
      const state = {
        version: 1,
        lastSync: '2024-01-01T00:00:00.000Z',
        files: {
          claude: ['.claude/commands/test.md'],
        },
        mcpServers: {
          vscode: ['server1'],
        },
      };
      await writeFile(
        join(testDir, CONFIG_DIR, SYNC_STATE_FILE),
        JSON.stringify(state),
      );

      const result = await loadSyncState(testDir);
      expect(result).not.toBeNull();
      expect(result!.mcpServers).toEqual({ vscode: ['server1'] });
    });
  });
});
