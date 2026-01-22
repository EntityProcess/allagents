import { describe, it, expect } from 'bun:test';
import { SkillMetadataSchema } from '../../../src/models/skill-metadata.js';

describe('SkillMetadataSchema', () => {
  it('should validate valid skill metadata', () => {
    const validSkill = {
      name: 'my-skill',
      description: 'A useful skill',
    };

    const result = SkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it('should validate skill with optional fields', () => {
    const validSkill = {
      name: 'advanced-skill',
      description: 'An advanced skill',
      'allowed-tools': ['Read', 'Write', 'Bash'],
      model: 'claude-3-5-sonnet-20241022',
    };

    const result = SkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it('should reject skill with uppercase name', () => {
    const invalidSkill = {
      name: 'MySkill',
      description: 'Invalid name',
    };

    const result = SkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });

  it('should reject skill with invalid characters in name', () => {
    const invalidSkill = {
      name: 'my_skill',
      description: 'Invalid name with underscore',
    };

    const result = SkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });

  it('should reject skill with name longer than 64 characters', () => {
    const invalidSkill = {
      name: 'a'.repeat(65),
      description: 'Name too long',
    };

    const result = SkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });

  it('should reject skill with empty description', () => {
    const invalidSkill = {
      name: 'valid-name',
      description: '',
    };

    const result = SkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });

  it('should reject skill missing name', () => {
    const invalidSkill = {
      description: 'Missing name',
    };

    const result = SkillMetadataSchema.safeParse(invalidSkill);
    expect(result.success).toBe(false);
  });
});
