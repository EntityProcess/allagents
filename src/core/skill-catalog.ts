import type {
  CatalogInstallDescriptor,
  SkillCatalog,
  SkillCatalogName,
  SkillCatalogSource,
  SkillCatalogWarning,
  SkillCatalogWarningCode,
} from '../models/skill-catalog.js';

const WARNING_TEXT: Record<SkillCatalogWarningCode, string> = {
  'not-security-reviewed':
    'Catalog inclusion is not a security review or safety guarantee.',
  'license-metadata':
    'Repository or per-skill license metadata must be reviewed before use.',
  'license-ambiguous':
    'No single catalog-asserted SPDX license applies to this source.',
  'external-dependencies':
    'Some skills require external services, credentials, binaries, or platform packages.',
  'external-lifecycle':
    'Use the upstream setup and update lifecycle; AllAgents does not run it.',
  'broken-marketplace':
    'The upstream marketplace manifest contains missing or misresolved sources.',
  'large-source':
    'This is a large source; select only the skills you intend to install.',
  'optional-source':
    'This optional source requires explicit selection and confirmation.',
};

function warnings(
  ...codes: Exclude<SkillCatalogWarningCode, 'not-security-reviewed'>[]
): readonly SkillCatalogWarning[] {
  return Object.freeze(
    ['not-security-reviewed' as const, ...codes].map((code) =>
      Object.freeze({ code, message: WARNING_TEXT[code] }),
    ),
  );
}

function source(entry: SkillCatalogSource): SkillCatalogSource {
  return Object.freeze({
    ...entry,
    author: Object.freeze(entry.author),
    warnings: Object.freeze(entry.warnings),
  });
}

const RECOMMENDED_SOURCE_ENTRIES: readonly SkillCatalogSource[] = Object.freeze(
  [
    source({
      sourceId: 'gstack',
      repo: 'garrytan/gstack',
      effectiveRef: 'main',
      approvedRoot: '.',
      installRoot: '.',
      installSource: 'garrytan/gstack@main',
      displayName: 'gstack',
      description:
        'Garry Tan’s full software-engineering workflow distribution.',
      category: 'software-engineering',
      homepage: 'https://github.com/garrytan/gstack',
      author: { name: 'Garry Tan', url: 'https://github.com/garrytan' },
      spdxLicense: 'MIT',
      classification: 'external-lifecycle',
      sourceKind: 'external-lifecycle',
      installPolicy: 'external-installer',
      bulkPolicy: 'forbidden',
      manifestBoundary: 'none',
      warnings: warnings('external-lifecycle', 'external-dependencies'),
    }),
    source({
      sourceId: 'paperclip-companies',
      repo: 'paperclipai/companies',
      effectiveRef: 'main',
      approvedRoot: '.',
      installRoot: '.',
      installSource: 'paperclipai/companies@main',
      installableSubpath: 'skills',
      displayName: 'Paperclip Companies',
      description:
        'Company-building skills and company templates from Paperclip AI.',
      category: 'business-operations',
      homepage: 'https://github.com/paperclipai/companies',
      author: { name: 'Paperclip AI', url: 'https://github.com/paperclipai' },
      spdxLicense: null,
      classification: 'optional',
      sourceKind: 'repository',
      installPolicy: 'direct-selective',
      bulkPolicy: 'explicit-only',
      manifestBoundary: 'none',
      warnings: warnings(
        'optional-source',
        'license-ambiguous',
        'large-source',
      ),
    }),
    source({
      sourceId: 'mattpocock-skills',
      repo: 'mattpocock/skills',
      effectiveRef: 'main',
      approvedRoot: '.',
      installRoot: '.',
      installSource: 'mattpocock/skills@main',
      displayName: 'Matt Pocock Skills',
      description: 'Software-engineering skills curated by Matt Pocock.',
      category: 'software-engineering',
      homepage: 'https://aihero.dev/skills',
      author: { name: 'Matt Pocock', url: 'https://github.com/mattpocock' },
      spdxLicense: 'MIT',
      classification: 'recommended',
      sourceKind: 'marketplace',
      installPolicy: 'marketplace-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'authoritative',
      warnings: warnings(),
    }),
    source({
      sourceId: 'composio-awesome-claude-skills',
      repo: 'ComposioHQ/awesome-claude-skills',
      effectiveRef: 'master',
      approvedRoot: '.',
      installRoot: '.',
      installSource: 'ComposioHQ/awesome-claude-skills@master',
      displayName: 'Composio Awesome Claude Skills',
      description: 'A large collection of integration-oriented Claude skills.',
      category: 'integrations',
      homepage: 'https://github.com/ComposioHQ/awesome-claude-skills',
      author: { name: 'Composio', url: 'https://github.com/ComposioHQ' },
      spdxLicense: null,
      classification: 'optional',
      sourceKind: 'repository',
      installPolicy: 'search-only',
      bulkPolicy: 'forbidden',
      manifestBoundary: 'none',
      warnings: warnings(
        'optional-source',
        'broken-marketplace',
        'external-dependencies',
        'license-ambiguous',
        'large-source',
      ),
    }),
    source({
      sourceId: 'hermes-core',
      repo: 'NousResearch/hermes-agent',
      effectiveRef: 'main',
      approvedRoot: 'skills',
      installRoot: 'skills',
      installSource: 'NousResearch/hermes-agent@main/skills',
      displayName: 'Hermes Core Skills',
      description: 'Core general-purpose skills from Hermes Agent.',
      category: 'general-purpose',
      homepage: 'https://github.com/NousResearch/hermes-agent',
      author: { name: 'Nous Research', url: 'https://github.com/NousResearch' },
      spdxLicense: 'MIT',
      classification: 'recommended',
      sourceKind: 'subtree',
      installPolicy: 'direct-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'none',
      warnings: warnings(),
    }),
    source({
      sourceId: 'hermes-optional',
      repo: 'NousResearch/hermes-agent',
      effectiveRef: 'main',
      approvedRoot: 'optional-skills',
      installRoot: 'optional-skills',
      installSource: 'NousResearch/hermes-agent@main/optional-skills',
      displayName: 'Hermes Optional Skills',
      description:
        'Optional Hermes skills with additional runtime requirements.',
      category: 'integrations',
      homepage: 'https://github.com/NousResearch/hermes-agent',
      author: { name: 'Nous Research', url: 'https://github.com/NousResearch' },
      spdxLicense: 'MIT',
      classification: 'optional',
      sourceKind: 'subtree',
      installPolicy: 'direct-selective',
      bulkPolicy: 'explicit-only',
      manifestBoundary: 'none',
      warnings: warnings('optional-source', 'external-dependencies'),
    }),
    source({
      sourceId: 'anthropic-skills',
      repo: 'anthropics/skills',
      effectiveRef: 'main',
      approvedRoot: 'skills',
      installRoot: '.',
      installSource: 'anthropics/skills@main',
      displayName: 'Anthropic Skills',
      description: 'General-purpose skills maintained by Anthropic.',
      category: 'general-purpose',
      homepage: 'https://github.com/anthropics/skills',
      author: { name: 'Anthropic', url: 'https://github.com/anthropics' },
      spdxLicense: null,
      classification: 'recommended',
      sourceKind: 'marketplace',
      installPolicy: 'marketplace-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'authoritative',
      warnings: warnings('license-metadata'),
    }),
    source({
      sourceId: 'addyosmani-agent-skills',
      repo: 'addyosmani/agent-skills',
      effectiveRef: 'main',
      approvedRoot: 'skills',
      installRoot: 'skills',
      installSource: 'addyosmani/agent-skills@main/skills',
      displayName: 'Addy Osmani Agent Skills',
      description: 'Software-engineering agent skills by Addy Osmani.',
      category: 'software-engineering',
      homepage: 'https://skills.addy.ie',
      author: { name: 'Addy Osmani', url: 'https://github.com/addyosmani' },
      spdxLicense: 'MIT',
      classification: 'recommended',
      sourceKind: 'subtree',
      installPolicy: 'direct-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'none',
      warnings: warnings(),
    }),
    source({
      sourceId: 'obra-superpowers',
      repo: 'obra/superpowers',
      effectiveRef: 'main',
      approvedRoot: 'skills',
      installRoot: 'skills',
      installSource: 'obra/superpowers@main/skills',
      displayName: 'Superpowers',
      description: 'Software-development skills from the Superpowers project.',
      category: 'software-engineering',
      homepage: 'https://github.com/obra/superpowers',
      author: { name: 'obra', url: 'https://github.com/obra' },
      spdxLicense: 'MIT',
      classification: 'recommended',
      sourceKind: 'subtree',
      installPolicy: 'direct-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'none',
      warnings: warnings(),
    }),
    source({
      sourceId: 'context-engineering-skills',
      repo: 'muratcankoylan/Agent-Skills-for-Context-Engineering',
      effectiveRef: 'main',
      approvedRoot: 'skills',
      installRoot: '.',
      installSource: 'muratcankoylan/Agent-Skills-for-Context-Engineering@main',
      displayName: 'Context Engineering Skills',
      description: 'Skills for context engineering and agent systems.',
      category: 'agent-engineering',
      homepage:
        'https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering',
      author: {
        name: 'Murat Can Koylan',
        url: 'https://github.com/muratcankoylan',
      },
      spdxLicense: 'MIT',
      classification: 'recommended',
      sourceKind: 'repository',
      installPolicy: 'direct-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'none',
      warnings: warnings(),
    }),
    source({
      sourceId: 'anthropic-knowledge-work',
      repo: 'anthropics/knowledge-work-plugins',
      effectiveRef: 'main',
      approvedRoot: '.',
      installRoot: '.',
      installSource: 'anthropics/knowledge-work-plugins@main',
      displayName: 'Anthropic Knowledge Work Plugins',
      description: 'Knowledge-work plugins and skills maintained by Anthropic.',
      category: 'knowledge-work',
      homepage: 'https://github.com/anthropics/knowledge-work-plugins',
      author: { name: 'Anthropic', url: 'https://github.com/anthropics' },
      spdxLicense: 'Apache-2.0',
      classification: 'recommended',
      sourceKind: 'marketplace',
      installPolicy: 'marketplace-selective',
      bulkPolicy: 'allowed',
      manifestBoundary: 'authoritative',
      warnings: warnings(),
    }),
  ],
);

export const RECOMMENDED_SKILL_CATALOG: SkillCatalog = Object.freeze({
  schemaVersion: 1,
  name: 'recommended',
  label: 'Recommended',
  sources: RECOMMENDED_SOURCE_ENTRIES,
});

export function getSkillCatalog(name: SkillCatalogName): SkillCatalog {
  if (name !== 'recommended') {
    throw new Error(`Unknown skill catalog "${name}".`);
  }
  return RECOMMENDED_SKILL_CATALOG;
}

export function catalogSourceIdentity(input: {
  catalog: 'recommended';
  sourceId: string;
  effectiveRef: string;
  approvedRoot: '.' | string;
}): string {
  return `${input.catalog}:${input.sourceId}@${input.effectiveRef}#${input.approvedRoot}`;
}

export function catalogInstallDescriptor(
  source: SkillCatalogSource,
): CatalogInstallDescriptor {
  return {
    catalog: 'recommended',
    catalogVersion: 1,
    sourceId: source.sourceId,
    repo: source.repo,
    effectiveRef: source.effectiveRef,
    approvedRoot: source.approvedRoot,
    installSource: source.installSource,
    installRoot: source.installRoot,
    sourceKind: source.sourceKind,
    installPolicy: source.installPolicy,
  };
}

export function normalizeCatalogPath(path: string): string | null {
  if (
    !path ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\')
  ) {
    return null;
  }
  const segments = path.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return segments.join('/');
}

export function isCatalogSkillPath(path: string): boolean {
  const normalized = normalizeCatalogPath(path);
  return normalized !== null && normalized.split('/').at(-1) === 'SKILL.md';
}

export function pathWithinCatalogRoot(
  path: string,
  root: '.' | string,
): boolean {
  const normalized = normalizeCatalogPath(path);
  if (!normalized) return false;
  if (root === '.') return true;
  const normalizedRoot = normalizeCatalogPath(root);
  if (!normalizedRoot) return false;
  const pathSegments = normalized.split('/');
  const rootSegments = normalizedRoot.split('/');
  return rootSegments.every(
    (segment, index) => pathSegments[index] === segment,
  );
}

export function relativeToCatalogRoot(
  path: string,
  root: '.' | string,
): string | null {
  if (!pathWithinCatalogRoot(path, root)) return null;
  if (root === '.') return path;
  return path.split('/').slice(root.split('/').length).join('/');
}

export function matchCatalogSource(
  repo: string,
  path: string,
  catalog: SkillCatalog = RECOMMENDED_SKILL_CATALOG,
): SkillCatalogSource | undefined {
  if (!isCatalogSkillPath(path)) return undefined;
  return catalog.sources
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.repo.toLowerCase() === repo.toLowerCase() &&
        pathWithinCatalogRoot(path, entry.approvedRoot),
    )
    .sort((left, right) => {
      const depth =
        (right.entry.approvedRoot === '.'
          ? 0
          : right.entry.approvedRoot.split('/').length) -
        (left.entry.approvedRoot === '.'
          ? 0
          : left.entry.approvedRoot.split('/').length);
      return depth || left.index - right.index;
    })[0]?.entry;
}

export function warningText(code: SkillCatalogWarningCode): string {
  return WARNING_TEXT[code];
}
