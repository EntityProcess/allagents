import { z } from 'zod';

export const SkillCatalogNameSchema = z.literal('recommended');
export type SkillCatalogName = z.infer<typeof SkillCatalogNameSchema>;

export const SkillCatalogClassificationSchema = z.enum([
  'recommended',
  'optional',
  'external-lifecycle',
]);
export type SkillCatalogClassification = z.infer<
  typeof SkillCatalogClassificationSchema
>;

export const SkillCatalogSourceKindSchema = z.enum([
  'repository',
  'subtree',
  'marketplace',
  'external-lifecycle',
]);
export type SkillCatalogSourceKind = z.infer<
  typeof SkillCatalogSourceKindSchema
>;

export const SkillCatalogInstallPolicySchema = z.enum([
  'direct-selective',
  'marketplace-selective',
  'search-only',
  'external-installer',
]);
export type SkillCatalogInstallPolicy = z.infer<
  typeof SkillCatalogInstallPolicySchema
>;

export type SkillCatalogBulkPolicy = 'allowed' | 'explicit-only' | 'forbidden';

export type SkillCatalogCategory =
  | 'software-engineering'
  | 'business-operations'
  | 'integrations'
  | 'general-purpose'
  | 'agent-engineering'
  | 'documentation'
  | 'knowledge-work';

export interface SkillCatalogAuthor {
  name: string;
  url: string;
}

export type SkillCatalogWarningCode =
  | 'not-security-reviewed'
  | 'license-metadata'
  | 'license-ambiguous'
  | 'external-dependencies'
  | 'external-lifecycle'
  | 'broken-marketplace'
  | 'large-source'
  | 'optional-source';

export interface SkillCatalogWarning {
  code: SkillCatalogWarningCode;
  message: string;
}

export interface SkillCatalogSource {
  sourceId: string;
  repo: `${string}/${string}`;
  effectiveRef: string;
  approvedRoot: '.' | string;
  installRoot: '.' | string;
  installSource: string;
  installableSubpath?: string;
  displayName: string;
  description: string;
  category: SkillCatalogCategory;
  homepage: string;
  author: SkillCatalogAuthor;
  spdxLicense: string | null;
  classification: SkillCatalogClassification;
  sourceKind: SkillCatalogSourceKind;
  installPolicy: SkillCatalogInstallPolicy;
  bulkPolicy: SkillCatalogBulkPolicy;
  manifestBoundary: 'none' | 'authoritative';
  warnings: readonly SkillCatalogWarning[];
}

export interface SkillCatalog {
  schemaVersion: 1;
  name: 'recommended';
  label: 'Recommended';
  sources: readonly SkillCatalogSource[];
}

export const CatalogInstallDescriptorSchema = z.object({
  catalog: SkillCatalogNameSchema,
  catalogVersion: z.literal(1),
  sourceId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  effectiveRef: z.string().min(1),
  approvedRoot: z.string().min(1),
  installSource: z.string().min(1),
  installRoot: z.string().min(1),
  sourceKind: SkillCatalogSourceKindSchema,
  installPolicy: SkillCatalogInstallPolicySchema,
});

export type CatalogInstallDescriptor = z.infer<
  typeof CatalogInstallDescriptorSchema
>;

export interface CatalogDiscoveryProvenance {
  catalogIdentity: string;
  provider: 'github-code-search';
  repo: `${string}/${string}`;
  effectiveRef: string;
  catalogVersion: 1;
  approvedRoot: '.' | string;
  repositoryHeadSha: string;
  skillPath: string;
  blobSha: string;
}
