import { z } from 'zod';

/**
 * Skill metadata schema (SKILL.md YAML frontmatter)
 */
export const SkillMetadataSchema = z.object({
  name: z
    .string()
    .min(1, 'Skill name is required')
    .max(128, 'Skill name too long'),
  description: z.string().min(1, 'Description is required'),
  'allowed-tools': z.array(z.string()).optional(),
  model: z.string().optional(),
});

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
