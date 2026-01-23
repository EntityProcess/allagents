import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { validateSkill, parseSkillMetadata } from '../../../src/validators/skill.js';

const TEST_DIR = '/tmp/allagents-test-skill-validator';

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('validateSkill', () => {
  it('should validate valid skill with required fields', async () => {
    const skillDir = join(TEST_DIR, 'my-skill');
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
  });

  it('should validate skill with optional fields', async () => {
    const skillDir = join(TEST_DIR, 'advanced-skill');
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
  });

  it('should reject skill without SKILL.md', async () => {
    const skillDir = join(TEST_DIR, 'no-skill-md');
    await mkdir(skillDir, { recursive: true });

    const result = await validateSkill(skillDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('SKILL.md not found');
  });

  it('should reject skill without frontmatter', async () => {
    const skillDir = join(TEST_DIR, 'no-frontmatter');
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
  });

  it('should reject skill with invalid name format', async () => {
    const skillDir = join(TEST_DIR, 'invalid-name');
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
  });

  it('should reject skill without description', async () => {
    const skillDir = join(TEST_DIR, 'no-description');
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
