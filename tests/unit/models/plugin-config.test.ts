import { describe, it, expect } from 'bun:test';
import { PluginManifestSchema } from '../../../src/models/plugin-config.js';

describe('PluginManifestSchema', () => {
  it('parses manifest with exclude field', () => {
    const result = PluginManifestSchema.safeParse({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
      exclude: ['.github/instructions/skills.instructions.md'],
    });

    expect(result.success).toBe(true);
    expect(result.data!.exclude).toEqual(['.github/instructions/skills.instructions.md']);
  });

  it('defaults exclude to undefined when not provided', () => {
    const result = PluginManifestSchema.safeParse({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'A test plugin',
    });

    expect(result.success).toBe(true);
    expect(result.data!.exclude).toBeUndefined();
  });
});
