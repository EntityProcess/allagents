import { describe, expect, it } from 'bun:test';
import { CatalogInstallDescriptorSchema } from '../../../src/models/skill-catalog.js';

const descriptor = {
  catalog: 'recommended',
  catalogVersion: 1,
  sourceId: 'hermes-core',
  repo: 'NousResearch/hermes-agent',
  effectiveRef: 'main',
  approvedRoot: 'skills',
  installSource: 'NousResearch/hermes-agent@main/skills',
  installRoot: 'skills',
  sourceKind: 'subtree',
  installPolicy: 'direct-selective',
} as const;

describe('CatalogInstallDescriptorSchema', () => {
  it('round-trips a versioned exact descriptor', () => {
    const parsed = CatalogInstallDescriptorSchema.parse(descriptor);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(descriptor);
  });

  it('rejects unknown versions, catalogs, and repository-only identities', () => {
    expect(
      CatalogInstallDescriptorSchema.safeParse({
        ...descriptor,
        catalogVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      CatalogInstallDescriptorSchema.safeParse({
        ...descriptor,
        catalog: 'unknown',
      }).success,
    ).toBe(false);
    expect(
      CatalogInstallDescriptorSchema.safeParse({
        ...descriptor,
        sourceId: '',
      }).success,
    ).toBe(false);
  });
});
