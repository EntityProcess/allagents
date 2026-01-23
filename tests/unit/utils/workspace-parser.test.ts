import { describe, it, expect } from 'bun:test';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWorkspaceConfig } from '../../../src/utils/workspace-parser.js';

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'allagents-parser-'));
}

describe('parseWorkspaceConfig', () => {
  it('should parse valid workspace config', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const validConfig = `
repositories:
  - path: ../allagents
    owner: EntityProcess
    repo: allagents
    description: primary project

plugins:
  - ./plugins/example

clients:
  - claude
`;
      writeFileSync(configPath, validConfig);

      const result = await parseWorkspaceConfig(configPath);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]?.path).toBe('../allagents');
      expect(result.plugins).toHaveLength(1);
      expect(result.clients).toContain('claude');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid client type', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories: []
plugins: []
clients:
  - invalid-client
`;
      writeFileSync(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing file', async () => {
    await expect(parseWorkspaceConfig('/nonexistent/workspace.yaml')).rejects.toThrow(
      '.allagents/workspace.yaml not found'
    );
  });

  it('should throw error for empty file', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(configPath, '');

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('.allagents/workspace.yaml is empty');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing required fields', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories:
  - path: ../test
    # missing owner, repo, description
plugins: []
clients: []
`;
      writeFileSync(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
