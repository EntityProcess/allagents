import { posix } from 'node:path';
import {
  MarketplaceManifestLenientSchema,
  MarketplacePluginEntrySchema,
} from '../models/marketplace-manifest.js';
import type {
  SkillCatalog,
  SkillCatalogSource,
  SkillCatalogWarningCode,
} from '../models/skill-catalog.js';
import { parseExactGitHubInstallSource } from '../utils/plugin-path.js';
import {
  catalogSourceIdentity,
  isCatalogSkillPath,
  normalizeCatalogPath,
  pathWithinCatalogRoot,
} from './skill-catalog.js';

export interface CatalogValidationIssue {
  sourceId?: string;
  code: string;
  message: string;
}

const SPDX_EXPRESSION =
  /^[A-Za-z0-9][A-Za-z0-9.+-]*(?:\s+(?:AND|OR)\s+[A-Za-z0-9][A-Za-z0-9.+-]*)*$/;
const REQUIRED_NON_INSTALL_WARNING: Record<
  'search-only' | 'external-installer',
  SkillCatalogWarningCode
> = {
  'search-only': 'broken-marketplace',
  'external-installer': 'external-lifecycle',
};

export function validateSkillCatalog(
  catalog: SkillCatalog,
): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  const sourceIds = new Set<string>();
  const identities = new Set<string>();

  if (catalog.schemaVersion !== 1 || catalog.name !== 'recommended') {
    issues.push({
      code: 'invalid-catalog-header',
      message: 'Catalog must use schema version 1 and name recommended.',
    });
  }
  if (catalog.label !== 'Recommended') {
    issues.push({
      code: 'invalid-catalog-label',
      message: 'Catalog label must be Recommended.',
    });
  }

  for (const source of catalog.sources) {
    validateSource(source, issues);
    const identity = catalogSourceIdentity({
      catalog: catalog.name,
      sourceId: source.sourceId,
      effectiveRef: source.effectiveRef,
      approvedRoot: source.approvedRoot,
    });
    if (sourceIds.has(source.sourceId)) {
      issues.push({
        sourceId: source.sourceId,
        code: 'duplicate-source-id',
        message: `Duplicate source ID: ${source.sourceId}`,
      });
    }
    if (identities.has(identity)) {
      issues.push({
        sourceId: source.sourceId,
        code: 'duplicate-identity',
        message: `Duplicate catalog identity: ${identity}`,
      });
    }
    sourceIds.add(source.sourceId);
    identities.add(identity);
  }
  return issues;
}

function validateSource(
  source: SkillCatalogSource,
  issues: CatalogValidationIssue[],
): void {
  const issue = (code: string, message: string): void => {
    issues.push({ sourceId: source.sourceId, code, message });
  };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.sourceId)) {
    issue('invalid-source-id', 'Source ID must be stable kebab-case.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)) {
    issue('invalid-repository', `Invalid repository: ${source.repo}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(source.effectiveRef)) {
    issue(
      'invalid-effective-ref',
      'Effective ref must be a default branch name.',
    );
  }
  for (const [field, value] of [
    ['approvedRoot', source.approvedRoot],
    ['installRoot', source.installRoot],
    ['installableSubpath', source.installableSubpath],
  ] as const) {
    if (
      value !== undefined &&
      value !== '.' &&
      normalizeCatalogPath(value) === null
    ) {
      issue(
        'invalid-path',
        `${field} is not a normalized POSIX-relative path.`,
      );
    }
  }
  if (
    source.installableSubpath &&
    !pathWithinCatalogRoot(source.installableSubpath, source.approvedRoot)
  ) {
    issue(
      'installable-subpath-outside-boundary',
      'Installable subpath must remain inside the approved root.',
    );
  }

  const parsed = parseExactGitHubInstallSource(source.installSource);
  if (
    !parsed ||
    parsed.repo.toLowerCase() !== source.repo.toLowerCase() ||
    parsed.ref !== source.effectiveRef ||
    parsed.root !== source.installRoot
  ) {
    issue(
      'install-source-mismatch',
      'Install source must encode the same repository, effective ref, and install root.',
    );
  }
  if (!source.displayName || !source.description || !source.homepage) {
    issue(
      'missing-metadata',
      'Display name, description, and homepage are required.',
    );
  }
  if (!source.author.name || !source.author.url) {
    issue('missing-author', 'Author name and URL are required.');
  }
  for (const url of [source.homepage, source.author.url]) {
    try {
      new URL(url);
    } catch {
      issue('invalid-url', `Invalid metadata URL: ${url}`);
    }
  }
  if (
    source.spdxLicense !== null &&
    !SPDX_EXPRESSION.test(source.spdxLicense)
  ) {
    issue('invalid-spdx', `Invalid SPDX expression: ${source.spdxLicense}`);
  }

  const warningCodes = new Set(source.warnings.map((warning) => warning.code));
  if (!warningCodes.has('not-security-reviewed')) {
    issue(
      'missing-common-warning',
      'Every source must include the not-security-reviewed warning.',
    );
  }
  if (
    source.classification === 'optional' &&
    !warningCodes.has('optional-source')
  ) {
    issue(
      'missing-optional-warning',
      'Optional sources require an explicit warning.',
    );
  }
  if (
    source.classification === 'optional' &&
    !['explicit-only', 'forbidden'].includes(source.bulkPolicy)
  ) {
    issue(
      'invalid-optional-bulk-policy',
      'Optional sources cannot allow implicit bulk installation.',
    );
  }
  if (
    ['search-only', 'external-installer'].includes(source.installPolicy) &&
    source.bulkPolicy !== 'forbidden'
  ) {
    issue(
      'invalid-non-installable-bulk-policy',
      'Search-only and external-installer sources must forbid bulk installation.',
    );
  }
  if (
    source.installPolicy === 'search-only' ||
    source.installPolicy === 'external-installer'
  ) {
    const requiredWarning = REQUIRED_NON_INSTALL_WARNING[source.installPolicy];
    if (!warningCodes.has(requiredWarning)) {
      issue(
        'missing-policy-warning',
        `${source.installPolicy} requires warning ${requiredWarning}.`,
      );
    }
  }
  if (
    (source.sourceKind === 'marketplace') !==
    (source.manifestBoundary === 'authoritative')
  ) {
    issue(
      'invalid-manifest-boundary',
      'Only marketplace sources use an authoritative manifest boundary.',
    );
  }
  if (
    source.sourceKind === 'marketplace' &&
    source.installPolicy !== 'marketplace-selective'
  ) {
    issue(
      'invalid-marketplace-policy',
      'Marketplace sources must use marketplace-selective installation.',
    );
  }
}

export interface CatalogRepositoryHealth {
  fullName: string;
  defaultBranch: string;
  headSha: string;
}

export interface CatalogTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  mode?: string;
}

export interface CatalogHealthDependencies {
  getRepository(repo: string): Promise<CatalogRepositoryHealth>;
  getTree(repo: string, ref: string): Promise<readonly CatalogTreeEntry[]>;
  getTextFile(repo: string, ref: string, path: string): Promise<string | null>;
}

export interface CatalogSourceHealth {
  sourceId: string;
  identity: string;
  status: 'healthy' | 'drifted' | 'unreachable';
  reasonCodes: readonly string[];
  repositoryHeadSha?: string;
}

export interface CatalogHealthReport {
  catalog: 'recommended';
  catalogVersion: 1;
  checkedAt: string;
  sources: readonly CatalogSourceHealth[];
}

export async function checkSkillCatalogHealth(
  catalog: SkillCatalog,
  deps: CatalogHealthDependencies,
): Promise<CatalogHealthReport> {
  const repositoryRequests = new Map<
    string,
    Promise<{
      repository: CatalogRepositoryHealth;
      tree: readonly CatalogTreeEntry[];
    }>
  >();
  const inspectRepository = (
    source: SkillCatalogSource,
  ): Promise<{
    repository: CatalogRepositoryHealth;
    tree: readonly CatalogTreeEntry[];
  }> => {
    const key = `${source.repo.toLowerCase()}@${source.effectiveRef}`;
    const existing = repositoryRequests.get(key);
    if (existing) return existing;
    const request = Promise.all([
      deps.getRepository(source.repo),
      deps.getTree(source.repo, source.effectiveRef),
    ]).then(([repository, tree]) => ({ repository, tree }));
    repositoryRequests.set(key, request);
    return request;
  };

  const sources = await Promise.all(
    catalog.sources.map(async (source): Promise<CatalogSourceHealth> => {
      const identity = catalogSourceIdentity({
        catalog: catalog.name,
        sourceId: source.sourceId,
        effectiveRef: source.effectiveRef,
        approvedRoot: source.approvedRoot,
      });
      try {
        const { repository, tree } = await inspectRepository(source);
        const reasons = await inspectSourceHealth(
          source,
          repository,
          tree,
          deps,
        );
        return {
          sourceId: source.sourceId,
          identity,
          status: reasons.length === 0 ? 'healthy' : 'drifted',
          reasonCodes: reasons,
          repositoryHeadSha: repository.headSha,
        };
      } catch {
        return {
          sourceId: source.sourceId,
          identity,
          status: 'unreachable',
          reasonCodes: ['repository-unreachable'],
        };
      }
    }),
  );

  return {
    catalog: catalog.name,
    catalogVersion: catalog.schemaVersion,
    checkedAt: new Date().toISOString(),
    sources,
  };
}

async function inspectSourceHealth(
  source: SkillCatalogSource,
  repository: CatalogRepositoryHealth,
  tree: readonly CatalogTreeEntry[],
  deps: CatalogHealthDependencies,
): Promise<string[]> {
  const reasons: string[] = [];
  if (repository.fullName.toLowerCase() !== source.repo.toLowerCase()) {
    reasons.push('repository-renamed');
  }
  if (repository.defaultBranch !== source.effectiveRef) {
    reasons.push('default-ref-drift');
  }
  const paths = new Map(tree.map((entry) => [entry.path, entry]));
  for (const root of [
    source.approvedRoot,
    source.installRoot,
    source.installableSubpath,
  ]) {
    if (root && root !== '.' && !paths.has(root)) reasons.push('root-missing');
  }
  const skillPaths = tree
    .filter((entry) => entry.type === 'blob' && isCatalogSkillPath(entry.path))
    .map((entry) => entry.path)
    .filter((path) => pathWithinCatalogRoot(path, source.approvedRoot));
  if (skillPaths.length === 0) reasons.push('skills-missing');

  if (source.manifestBoundary === 'authoritative') {
    const manifestReasons = await inspectAuthoritativeManifest(
      source,
      paths,
      deps,
    );
    reasons.push(...manifestReasons);
  }
  return [...new Set(reasons)];
}

async function inspectAuthoritativeManifest(
  source: SkillCatalogSource,
  paths: ReadonlyMap<string, CatalogTreeEntry>,
  deps: CatalogHealthDependencies,
): Promise<string[]> {
  const rootPrefix = source.installRoot === '.' ? '' : `${source.installRoot}/`;
  const candidates = [
    `${rootPrefix}.github/plugin/marketplace.json`,
    `${rootPrefix}.claude-plugin/marketplace.json`,
  ];
  const manifestPath = candidates.find((candidate) => paths.has(candidate));
  if (!manifestPath) return ['manifest-missing'];
  const content = await deps.getTextFile(
    source.repo,
    source.effectiveRef,
    manifestPath,
  );
  if (content === null) return ['manifest-unreadable'];

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return ['manifest-invalid-json'];
  }
  const parsed = MarketplaceManifestLenientSchema.safeParse(parsedJson);
  if (!parsed.success) return ['manifest-invalid'];

  const reasons: string[] = [];
  for (const rawPlugin of parsed.data.plugins) {
    if (
      typeof rawPlugin !== 'object' ||
      rawPlugin === null ||
      !('source' in rawPlugin)
    ) {
      reasons.push('manifest-invalid');
      continue;
    }
    // Remote plugin distributions have their own lifecycle. Only local entries
    // are installable through this catalog source and constrained to its root.
    if (typeof rawPlugin.source !== 'string') continue;
    const parsedPlugin = MarketplacePluginEntrySchema.safeParse(rawPlugin);
    if (!parsedPlugin.success) {
      reasons.push('manifest-invalid');
      continue;
    }
    const plugin = parsedPlugin.data;
    if (typeof plugin.source !== 'string') continue;
    const pluginRoot = resolveTreePath(source.installRoot, plugin.source);
    if (
      !pluginRoot ||
      (pluginRoot === '.'
        ? source.installRoot !== '.'
        : !pathWithinCatalogRoot(pluginRoot, source.installRoot))
    ) {
      reasons.push('manifest-source-escape');
      continue;
    }
    if (
      pluginRoot !== '.' &&
      (!paths.has(pluginRoot) || treePathContainsSymlink(pluginRoot, paths))
    ) {
      reasons.push('manifest-source-missing');
      continue;
    }
    const declaredSkills = Array.isArray(plugin.skills)
      ? plugin.skills
      : plugin.skills
        ? [plugin.skills]
        : [];
    for (const skillPath of declaredSkills) {
      const resolved = resolveTreePath(pluginRoot, skillPath);
      if (
        !resolved ||
        !pathWithinCatalogRoot(resolved, source.approvedRoot) ||
        (!paths.has(resolved) && !paths.has(`${resolved}/SKILL.md`)) ||
        treePathContainsSymlink(resolved, paths)
      ) {
        reasons.push('manifest-skill-invalid');
      }
    }
  }
  return reasons;
}

function treePathContainsSymlink(
  path: string,
  entries: ReadonlyMap<string, CatalogTreeEntry>,
): boolean {
  let current = '';
  for (const segment of path.split('/')) {
    current = current ? `${current}/${segment}` : segment;
    if (entries.get(current)?.mode === '120000') return true;
  }
  return false;
}

function resolveTreePath(root: '.' | string, relative: string): string | null {
  if (!relative || relative.startsWith('/') || relative.includes('\\'))
    return null;
  const base = root === '.' ? '' : root;
  const normalized = posix
    .normalize(posix.join(base, relative))
    .replace(/\/$/, '');
  if ((normalized === '.' || normalized === '') && root === '.') return '.';
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalizeCatalogPath(normalized) === null
  ) {
    return null;
  }
  return normalized;
}
