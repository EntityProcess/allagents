import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { fetchWorkspaceFromGitHub } from '../../../src/core/github-fetch.js';

// Mock execa
const execaMock = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
mock.module('execa', () => ({
  execa: execaMock,
}));

beforeEach(() => {
  execaMock.mockClear();
});

describe('fetchWorkspaceFromGitHub', () => {
  it('should validate GitHub URL format', async () => {
    const result = await fetchWorkspaceFromGitHub('not-a-github-url');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should check for gh CLI availability', async () => {
    execaMock.mockRejectedValueOnce(new Error('gh not found'));

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('gh CLI not installed');
  });

  it('should handle repository not found', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' }) // gh --version
      .mockRejectedValueOnce(new Error('404 not found')); // gh repo view

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Repository not found');
  });

  it('should handle authentication errors', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' }) // gh --version
      .mockRejectedValueOnce(new Error('authentication required')); // gh repo view

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('authentication required');
  });

  it('should fetch workspace.yaml from .allagents directory', async () => {
    const yamlContent = 'plugins:\n  - code-review@official';
    const base64Content = Buffer.from(yamlContent).toString('base64');

    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' }) // gh --version
      .mockResolvedValueOnce({ stdout: '{"name":"repo"}' }) // gh repo view
      .mockResolvedValueOnce({ stdout: base64Content }); // gh api contents

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);
  });

  it('should fallback to root workspace.yaml if .allagents not found', async () => {
    const yamlContent = 'plugins:\n  - my-plugin@marketplace';
    const base64Content = Buffer.from(yamlContent).toString('base64');

    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' }) // gh --version
      .mockResolvedValueOnce({ stdout: '{"name":"repo"}' }) // gh repo view
      .mockRejectedValueOnce(new Error('404')) // .allagents/workspace.yaml not found
      .mockResolvedValueOnce({ stdout: base64Content }); // root workspace.yaml

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);
  });

  it('should handle subpath in GitHub URL', async () => {
    const yamlContent = 'clients:\n  - claude';
    const base64Content = Buffer.from(yamlContent).toString('base64');

    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' })
      .mockResolvedValueOnce({ stdout: '{"name":"repo"}' })
      .mockResolvedValueOnce({ stdout: base64Content });

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/templates/nodejs'
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);
  });

  it('should parse different GitHub URL formats', async () => {
    const urls = [
      'https://github.com/owner/repo',
      'github.com/owner/repo',
      'gh:owner/repo',
      'owner/repo',
    ];

    for (const url of urls) {
      execaMock.mockClear();
      const yamlContent = 'plugins: []';
      const base64Content = Buffer.from(yamlContent).toString('base64');

      execaMock
        .mockResolvedValueOnce({ stdout: 'gh version' })
        .mockResolvedValueOnce({ stdout: '{"name":"repo"}' })
        .mockResolvedValueOnce({ stdout: base64Content });

      const result = await fetchWorkspaceFromGitHub(url);
      expect(result.success).toBe(true);
      expect(result.content).toBe(yamlContent);
    }
  });

  it('should return error when no workspace.yaml found', async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: 'gh version' })
      .mockResolvedValueOnce({ stdout: '{"name":"repo"}' })
      .mockRejectedValueOnce(new Error('404')) // .allagents/workspace.yaml
      .mockRejectedValueOnce(new Error('404')); // workspace.yaml

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No workspace.yaml found');
  });
});
