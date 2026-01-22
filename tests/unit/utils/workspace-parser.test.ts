import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { parseWorkspaceConfig } from '../../../src/utils/workspace-parser.js';

const TEST_DIR = '/tmp/allagents-test-workspace-parser';
const TEST_CONFIG = join(TEST_DIR, 'workspace.yaml');

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('parseWorkspaceConfig', () => {
  it('should parse valid workspace config', async () => {
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
    await writeFile(TEST_CONFIG, validConfig);

    const result = await parseWorkspaceConfig(TEST_CONFIG);

    expect(result.repositories).toHaveLength(1);
    expect(result.repositories[0]?.path).toBe('../allagents');
    expect(result.plugins).toHaveLength(1);
    expect(result.clients).toContain('claude');
  });

  it('should reject invalid client type', async () => {
    const invalidConfig = `
repositories: []
plugins: []
clients:
  - invalid-client
`;
    await writeFile(TEST_CONFIG, invalidConfig);

    await expect(parseWorkspaceConfig(TEST_CONFIG)).rejects.toThrow('validation failed');
  });

  it('should throw error for missing file', async () => {
    await expect(parseWorkspaceConfig('/nonexistent/workspace.yaml')).rejects.toThrow(
      'workspace.yaml not found'
    );
  });

  it('should throw error for empty file', async () => {
    await writeFile(TEST_CONFIG, '');

    await expect(parseWorkspaceConfig(TEST_CONFIG)).rejects.toThrow('workspace.yaml is empty');
  });

  it('should throw error for missing required fields', async () => {
    const invalidConfig = `
repositories:
  - path: ../test
    # missing owner, repo, description
plugins: []
clients: []
`;
    await writeFile(TEST_CONFIG, invalidConfig);

    await expect(parseWorkspaceConfig(TEST_CONFIG)).rejects.toThrow('validation failed');
  });
});
