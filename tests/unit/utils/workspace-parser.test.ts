import { describe, it, expect } from 'bun:test';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { parseWorkspaceConfig } from '../../../src/utils/workspace-parser.js';

function createTestDir(): string {
  return `/tmp/allagents-parser-${randomUUID()}`;
}

describe('parseWorkspaceConfig', () => {
  it('should parse valid workspace config', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const validConfig = `
repositories:
  - path: ../allagents
    owner: EntityProcess
    repo: allagents
    description: primary project

plugins:
  - .claude/allagents

clients:
  - claude
`;
      await writeFile(configPath, validConfig);

      const result = await parseWorkspaceConfig(configPath);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]?.path).toBe('../allagents');
      expect(result.plugins).toHaveLength(1);
      expect(result.clients).toContain('claude');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid client type', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories: []
plugins: []
clients:
  - invalid-client
`;
      await writeFile(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing file', async () => {
    await expect(parseWorkspaceConfig('/nonexistent/workspace.yaml')).rejects.toThrow(
      'workspace.yaml not found'
    );
  });

  it('should throw error for empty file', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const configPath = join(testDir, 'workspace.yaml');
      await writeFile(configPath, '');

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('workspace.yaml is empty');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing required fields', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories:
  - path: ../test
    # missing owner, repo, description
plugins: []
clients: []
`;
      await writeFile(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
