import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanPluginForCopilotDirs } from '../../../src/core/vscode-workspace.js';

describe('scanPluginForCopilotDirs', () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = join(tmpdir(), `allagents-test-plugin-${Date.now()}`);
    mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('detects prompts directory', () => {
    mkdirSync(join(pluginDir, 'prompts'), { recursive: true });
    const result = scanPluginForCopilotDirs(pluginDir);
    expect(result.hasPrompts).toBe(true);
    expect(result.hasInstructions).toBe(false);
  });

  test('detects instructions directory', () => {
    mkdirSync(join(pluginDir, 'instructions'), { recursive: true });
    const result = scanPluginForCopilotDirs(pluginDir);
    expect(result.hasPrompts).toBe(false);
    expect(result.hasInstructions).toBe(true);
  });

  test('detects both', () => {
    mkdirSync(join(pluginDir, 'prompts'), { recursive: true });
    mkdirSync(join(pluginDir, 'instructions'), { recursive: true });
    const result = scanPluginForCopilotDirs(pluginDir);
    expect(result.hasPrompts).toBe(true);
    expect(result.hasInstructions).toBe(true);
  });

  test('returns false when neither exists', () => {
    const result = scanPluginForCopilotDirs(pluginDir);
    expect(result.hasPrompts).toBe(false);
    expect(result.hasInstructions).toBe(false);
  });
});
