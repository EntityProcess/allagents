import { describe, expect, test } from 'bun:test';
import { getNativeClient } from '../../../../src/core/native/registry.js';
import { ClaudeNativeClient } from '../../../../src/core/native/claude.js';
import { CopilotNativeClient } from '../../../../src/core/native/copilot.js';

describe('native/registry', () => {
  test('returns ClaudeNativeClient for claude', () => {
    expect(getNativeClient('claude')).toBeInstanceOf(ClaudeNativeClient);
  });

  test('returns CopilotNativeClient for copilot', () => {
    expect(getNativeClient('copilot')).toBeInstanceOf(CopilotNativeClient);
  });

  test('returns null for unsupported client', () => {
    expect(getNativeClient('cursor')).toBeNull();
  });

  test('returns null for universal', () => {
    expect(getNativeClient('universal')).toBeNull();
  });
});
