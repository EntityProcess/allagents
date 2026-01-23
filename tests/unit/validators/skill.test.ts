import { describe, it, expect } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { validateSkill, parseSkillMetadata } from '../../../src/validators/skill.js';

function createTestDir(): string {
  return `/tmp/allagents-skill-${randomUUID()}`;
}

describe('validateSkill', () => {
  it('should validate valid skill with required fields', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'my-skill');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: my-skill
description: A test skill
---

# My Skill

Instructions here.
`
      );

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(true);
      expect(result.metadata?.name).toBe('my-skill');
      expect(result.metadata?.description).toBe('A test skill');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should validate skill with optional fields', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'advanced-skill');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: advanced-skill
description: An advanced skill
allowed-tools:
  - Read
  - Write
model: claude-3-5-sonnet
---

# Advanced Skill
`
      );

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(true);
      expect(result.metadata?.['allowed-tools']).toEqual(['Read', 'Write']);
      expect(result.metadata?.model).toBe('claude-3-5-sonnet');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should reject skill without SKILL.md', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'no-skill-md');
      await mkdir(skillDir, { recursive: true });

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('SKILL.md not found');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should reject skill without frontmatter', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'no-frontmatter');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `# Just a markdown file

No frontmatter here.
`
      );

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must have YAML frontmatter');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should reject skill with invalid name format', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'invalid-name');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: Invalid_Name
description: Invalid name format
---
`
      );

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('lowercase');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('should reject skill without description', async () => {
    const testDir = createTestDir();
    await mkdir(testDir, { recursive: true });
    try {
      const skillDir = join(testDir, 'no-description');
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: valid-name
---
`
      );

      const result = await validateSkill(skillDir);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('description');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('parseSkillMetadata', () => {
  it('should parse valid skill content', () => {
    const content = `---
name: test-skill
description: Test description
---

# Content
`;
    const result = parseSkillMetadata(content);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('test-skill');
  });

  it('should return null for invalid content', () => {
    const content = `---
name: Invalid_Name
---
`;
    const result = parseSkillMetadata(content);
    expect(result).toBeNull();
  });

  it('should return null for content without frontmatter', () => {
    const content = `# Just markdown`;
    const result = parseSkillMetadata(content);
    expect(result).toBeNull();
  });
});
