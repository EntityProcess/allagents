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

  it('should accept skill with uppercase name (display label)', () => {
    const validSkill = {
      name: 'MySkill',
      description: 'Display name with uppercase',
    };

    const result = SkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it('should accept skill with spaces and mixed case (display label)', () => {
    const validSkill = {
      name: 'Writing Hookify Rules',
      description: 'Display name with spaces',
    };

    const result = SkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
  });

  it('should accept allowed-tools as a single string and normalize to array', () => {
    const validSkill = {
      name: 'browser-skill',
      description: 'A browser automation skill',
      'allowed-tools': 'Bash(agent-browser:*)',
    };

    const result = SkillMetadataSchema.safeParse(validSkill);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['allowed-tools']).toEqual(['Bash(agent-browser:*)']);
    }
  });

  it('should reject skill with name longer than 128 characters', () => {
    const invalidSkill = {
      name: 'a'.repeat(129),
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
