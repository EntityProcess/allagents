import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GitCloneError } from '../../../src/core/git.js';

// Create a temp dir with workspace files for testing
function createTempRepo(files: Record<string, string>): string {
  const dir = join(tmpdir(), `test-github-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
  return dir;
}

// Mock the git module
const cloneToTempMock = mock(() => Promise.resolve(''));
const cleanupTempDirMock = mock(() => Promise.resolve());
const refExistsMock = mock(() => Promise.resolve(false));

mock.module('../../../src/core/git.js', () => ({
  cloneToTemp: cloneToTempMock,
  cleanupTempDir: cleanupTempDirMock,
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  refExists: refExistsMock,
  GitCloneError,
}));

const { fetchWorkspaceFromGitHub } = await import('../../../src/core/github-fetch.js');

beforeEach(() => {
  cloneToTempMock.mockClear();
  cleanupTempDirMock.mockClear();
  refExistsMock.mockClear();
});

describe('fetchWorkspaceFromGitHub', () => {
  it('should validate GitHub URL format', async () => {
    const result = await fetchWorkspaceFromGitHub('not-a-github-url');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should handle clone auth errors', async () => {
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('should handle clone timeout errors', async () => {
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Clone timed out', 'https://github.com/owner/repo.git', true, false),
    );

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should fetch workspace.yaml from .allagents directory', async () => {
    const yamlContent = 'plugins:\n  - code-review@official';
    const tempDir = createTempRepo({
      '.allagents/workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);
    expect(result.tempDir).toBe(tempDir);

    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should fallback to root workspace.yaml if .allagents not found', async () => {
    const yamlContent = 'plugins:\n  - my-plugin@marketplace';
    const tempDir = createTempRepo({
      'workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle subpath in GitHub URL', async () => {
    const yamlContent = 'clients:\n  - claude';
    const tempDir = createTempRepo({
      'templates/nodejs/.allagents/workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/templates/nodejs',
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse different GitHub URL formats', async () => {
    const urls = [
      'https://github.com/owner/repo',
      'github.com/owner/repo',
      'gh:owner/repo',
      'owner/repo',
    ];

    for (const url of urls) {
      cloneToTempMock.mockClear();
      cleanupTempDirMock.mockClear();

      const yamlContent = 'plugins: []';
      const tempDir = createTempRepo({
        '.allagents/workspace.yaml': yamlContent,
      });

      cloneToTempMock.mockResolvedValueOnce(tempDir);

      const result = await fetchWorkspaceFromGitHub(url);
      expect(result.success).toBe(true);
      expect(result.content).toBe(yamlContent);

      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return error when no workspace.yaml found', async () => {
    const tempDir = createTempRepo({});

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No workspace.yaml found');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
