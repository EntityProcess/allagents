import { z } from 'zod';

/**
 * Skill name validation: lowercase, alphanumeric + hyphens, max 64 chars
 */
const skillNameRegex = /^[a-z0-9-]{1,64}$/;

/**
 * Skill metadata schema (SKILL.md YAML frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z
    .string()
    .regex(
      skillNameRegex,
      'Skill name must be lowercase, alphanumeric + hyphens, max 64 chars',
    ),
  description: z.string().min(1, 'Description is required'),
  'allowed-tools': z.array(z.string()).optional(),
  model: z.string().optional(),
});

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
