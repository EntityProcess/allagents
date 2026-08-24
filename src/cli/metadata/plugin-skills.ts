import type { AgentCommandMeta } from '../help.js';

export const skillsListMeta: AgentCommandMeta = {
  command: 'skill list',
  description: 'List all skills from installed plugins',
  whenToUse: 'To see available skills and their enabled/disabled status',
  examples: [
    'allagents skill list',
    'allagents skill list --scope user',
    'allagents --json=name,plugin skill list',
  ],
  expectedOutput: 'Lists skills grouped by plugin with enabled/disabled status',
  options: [
    {
      flag: '--scope',
      short: '-s',
      type: 'string',
      description: 'Scope: "project" (default) or "user"',
    },
  ],
  outputSchema: {
    skills: [{ name: 'string', plugin: 'string', disabled: 'boolean' }],
  },
  jsonFields: ['name', 'plugin', 'disabled'] as const,
};

export const skillsRemoveMeta: AgentCommandMeta = {
  command: 'skill remove',
  description: 'Disable a skill (exclude from sync)',
  whenToUse: 'To prevent a specific skill from being synced to your workspace',
  examples: [
    'allagents skill remove brainstorming',
    'allagents skill remove brainstorming --plugin superpowers',
    'allagents skill remove brainstorming --scope user',
  ],
  expectedOutput: 'Confirms skill was disabled and runs sync',
  positionals: [
    {
      name: 'skill',
      type: 'string',
      required: true,
      description: 'Skill name to disable',
    },
  ],
  options: [
    {
      flag: '--scope',
      short: '-s',
      type: 'string',
      description: 'Scope: "project" (default) or "user"',
    },
    {
      flag: '--plugin',
      short: '-p',
      type: 'string',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    },
  ],
  outputSchema: {
    skill: 'string',
    plugin: 'string',
    syncResult: { copied: 'number', failed: 'number' },
  },
};

export const skillsUpdateMeta: AgentCommandMeta = {
  command: 'skill update',
  description:
    'Update installed skills and safely reconcile skills deleted upstream',
  whenToUse:
    'To refresh project or user skills while preserving local copies unless an interactive deletion is explicitly confirmed',
  examples: [
    'allagents skill update',
    'allagents skill update code-review glow-api',
    'allagents skill update --scope user',
    'allagents skill update --scope all',
    'allagents skill update --yes',
    'allagents --json skill update --scope project',
  ],
  expectedOutput:
    'Reports updated, removed, retained, skipped, failed, or cancelled refresh units',
  positionals: [
    {
      name: 'skills',
      type: 'string',
      required: false,
      description:
        'Optional installed skill names or qualified subpaths to update',
    },
  ],
  options: [
    {
      flag: '--scope',
      short: '-s',
      type: 'string',
      description: 'Scope: project, user, or all',
    },
    {
      flag: '--yes',
      short: '-y',
      type: 'boolean',
      description:
        'Run without prompts (deleted-upstream skills are retained, not removed)',
    },
  ],
  outputSchema: {
    scopes: ['string'],
    results: [
      {
        id: 'string',
        source: 'string',
        status: 'string',
        error: 'string?',
      },
    ],
    syncedScopes: ['string'],
    skippedLocalSources: ['string'],
    summary: {
      updated: 'number',
      removed: 'number',
      retained: 'number',
      skipped: 'number',
      failed: 'number',
      cancelled: 'number',
    },
  },
  jsonFields: ['id', 'source', 'status', 'error'] as const,
};

export const skillsSearchMeta: AgentCommandMeta = {
  command: 'skill search',
  description:
    'Discover SKILL.md files interactively with Recommended first and deduplicated global GitHub results second. JSON and redirected no-catalog output remain global-only. Use --catalog recommended for a strict catalog boundary that never falls back. Installable TTY results can be selectively installed with exact catalog descriptors.',
  whenToUse:
    'To discover public GitHub skills with catalog context, or to enforce a versioned catalog boundary whose classification, policy, warnings, source metadata, and provenance are explicit. Recommended is a discovery label, not a security or license assertion.',
  examples: [
    'allagents skill search terraform',
    'allagents skill pr-search',
    'allagents skill "pr search"',
    'allagents skill search terraform --owner hashicorp',
    'allagents skill search testing --catalog recommended',
    'allagents --json skill search testing --catalog recommended',
    'allagents skill search docs --page 2 --limit 10',
    'allagents --json skill search docs --limit 5',
  ],
  expectedOutput:
    'Interactive Recommended and All GitHub sections, or strict single-scope machine results, with exact install source, selector, policy, warnings, metadata, and provenance. Search-only and external-lifecycle entries remain visible but cannot be selected.',
  positionals: [
    {
      name: 'query',
      type: 'string',
      required: true,
      description: 'Search query (≥2 characters).',
    },
  ],
  options: [
    {
      flag: '--owner',
      type: 'string',
      description: 'Scope to a single GitHub owner (org or user).',
    },
    {
      flag: '--catalog',
      type: 'string',
      description:
        'Restrict to the built-in Recommended catalog. Mutually exclusive with --owner; strict default-branch/ref/root boundary; never falls back to global search.',
    },
    {
      flag: '--page',
      type: 'string',
      description: 'Result page (1-indexed, default 1).',
    },
    {
      flag: '--limit',
      type: 'string',
      description: 'Results per page (1–100, default 15).',
    },
  ],
  outputSchema: {
    query: 'string',
    items: [
      {
        name: 'string',
        namespace: 'string',
        repo: 'string',
        path: 'string',
        description: 'string',
        sha: 'string',
        stars: 'number',
        installSource: 'string',
        installSelector: 'string',
        installation: {
          policy:
            'repository-install | direct-selective | marketplace-selective | search-only | external-installer',
          reasonCodes: ['string'],
        },
        catalog: {
          name: 'recommended?',
          label: 'Recommended?',
          version: '1?',
          identity: 'string?',
          sourceId: 'string?',
          classification: 'recommended | optional | external-lifecycle?',
          sourceKind:
            'repository | subtree | marketplace | external-lifecycle?',
          category: 'string?',
          homepage: 'string?',
          author: { name: 'string', url: 'string' },
          spdxLicense: 'string | null',
          warnings: [{ code: 'string', message: 'string' }],
          discovery: {
            catalogIdentity: 'string',
            provider: 'github-code-search',
            repo: 'string',
            effectiveRef: 'string',
            catalogVersion: 1,
            approvedRoot: 'string',
            repositoryHeadSha: 'string',
            skillPath: 'string',
            blobSha: 'string',
          },
          installDescriptor: 'CatalogInstallDescriptor',
        },
      },
    ],
    total: 'number',
    truncated: 'boolean',
  },
};

export const skillsAddMeta: AgentCommandMeta = {
  command: 'skill add',
  description:
    'Add a skill from a plugin, or re-enable a previously disabled skill',
  whenToUse:
    'To add a skill from a GitHub repo or marketplace plugin, or to re-enable a skill that was previously disabled',
  examples: [
    'allagents skill add ReScienceLab/opc-skills',
    'allagents skill add reddit --from ReScienceLab/opc-skills',
    'allagents skill add NousResearch/hermes-agent --skill llm-wiki',
    'allagents skill add NousResearch/hermes-agent --skill llm-wiki,dogfood',
    'allagents skill add NousResearch/hermes-agent --list',
    'allagents skill add NousResearch/hermes-agent --all',
    'allagents skill add https://github.com/owner/repo/tree/main/skills/my-skill',
    'allagents skill add brainstorming',
    'allagents skill add brainstorming --plugin superpowers',
    'allagents skill add --list --from rstackjs/agent-skills',
    'allagents skill add --all --from rstackjs/agent-skills',
  ],
  expectedOutput: 'Confirms skill was enabled and runs sync',
  positionals: [
    {
      name: 'skill-or-source',
      type: 'string',
      required: false,
      description:
        'A skill name (re-enable an installed skill, or pair with --from to install from a source); ' +
        'a plugin source without subpath (owner/repo, gh:owner/repo, or https://github.com/owner/repo — ' +
        'installs all skills from that repo without needing any flags); ' +
        'or a deep GitHub URL with a subpath pointing to a specific skill file.',
    },
  ],
  options: [
    {
      flag: '--scope',
      short: '-s',
      type: 'string',
      description: 'Scope: "project" (default) or "user"',
    },
    {
      flag: '--plugin',
      short: '-p',
      type: 'string',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    },
    {
      flag: '--from',
      short: '-f',
      type: 'string',
      description:
        'Plugin source (GitHub URL, owner/repo, or plugin@marketplace) to install the skill from. Omit when the positional is already a source.',
    },
    {
      flag: '--skill',
      type: 'string',
      description:
        'Comma-separated skill names to install when the positional is a plugin source (e.g., `skill add owner/repo --skill foo,bar`).',
    },
    {
      flag: '--list',
      short: '-l',
      type: 'boolean',
      description: 'List skills available at the source without installing',
    },
    {
      flag: '--all',
      type: 'boolean',
      description: 'Install every skill from the source',
    },
  ],
  outputSchema: {
    skill: 'string',
    plugin: 'string',
    syncResult: { copied: 'number', failed: 'number' },
  },
};
