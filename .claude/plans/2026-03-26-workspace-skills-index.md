# Workspace Skills Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During sync, discover skills in workspace repositories and embed an `<available_skills>` index in the WORKSPACE-RULES section of AGENTS.md, so AI agents can find and load repo-local skills.

**Architecture:** Extend the existing `generateWorkspaceRules()` pipeline. Add a new `discoverRepoSkills()` function that scans each repository's client skill directories (`.claude/skills/`, `.agents/skills/`, `.codex/skills/`, or custom paths). Parse SKILL.md frontmatter for `name` and `description`. The skill index XML block is appended to the workspace rules content inside the existing `<!-- WORKSPACE-RULES -->` markers.

**Tech Stack:** TypeScript, Zod, gray-matter (already a dependency), bun:test

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/core/repo-skills.ts` | `discoverRepoSkills()` — scan repos, parse SKILL.md frontmatter, return skill entries |
| Modify | `src/models/workspace-config.ts:6-12` | Add `skills` field to `RepositorySchema` |
| Modify | `src/constants.ts:46-62` | Update `generateWorkspaceRules()` to accept and render skill entries |
| Create | `tests/unit/core/repo-skills.test.ts` | Unit tests for skill discovery |
| Modify | `tests/unit/core/workspace-repo.test.ts` | Add test for skills field in workspace.yaml |

---

### Task 1: Add `skills` field to RepositorySchema

**Files:**
- Modify: `src/models/workspace-config.ts:6-12`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/models/workspace-config.test.ts
import { describe, it, expect } from 'bun:test';
import { RepositorySchema } from '../../../src/models/workspace-config.js';

describe('RepositorySchema skills field', () => {
  it('accepts omitted skills (auto-discover)', () => {
    const result = RepositorySchema.safeParse({ path: '../repo' });
    expect(result.success).toBe(true);
  });

  it('accepts skills: true (explicit auto-discover)', () => {
    const result = RepositorySchema.safeParse({ path: '../repo', skills: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills).toBe(true);
  });

  it('accepts skills: false (disabled)', () => {
    const result = RepositorySchema.safeParse({ path: '../repo', skills: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.skills).toBe(false);
  });

  it('accepts skills as array of custom paths', () => {
    const result = RepositorySchema.safeParse({
      path: '../repo',
      skills: ['plugins/agentv-dev/skills', 'plugins/agentic-engineering/skills'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual([
        'plugins/agentv-dev/skills',
        'plugins/agentic-engineering/skills',
      ]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/models/workspace-config.test.ts`
Expected: FAIL — `skills` field rejected by schema

- [ ] **Step 3: Update RepositorySchema**

In `src/models/workspace-config.ts`, change the `RepositorySchema`:

```typescript
export const RepositorySchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  source: z.string().optional(),
  repo: z.string().optional(),
  description: z.string().optional(),
  skills: z.union([z.boolean(), z.array(z.string())]).optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/models/workspace-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/workspace-config.ts tests/unit/models/workspace-config.test.ts
git commit -m "feat(schema): add skills field to RepositorySchema"
```

---

### Task 2: Implement `discoverRepoSkills()`

**Files:**
- Create: `src/core/repo-skills.ts`
- Create: `tests/unit/core/repo-skills.test.ts`

**Design decisions:**
- Default skill directories derived from workspace `clients` config: for each client in `clients`, use `CLIENT_MAPPINGS[client].skillsPath` (e.g., `.claude/skills/`, `.agents/skills/`, `.codex/skills/`). Deduplicate paths (multiple clients may share `.agents/skills/`).
- When `skills` is an array of custom paths, use those instead of client-derived defaults.
- When `skills` is `false`, skip the repo entirely.
- Skip symlinks/junctions when iterating skill directories (use `lstatSync` + `isSymbolicLink()`).
- Reuse existing `parseSkillMetadata()` from `src/validators/skill.ts` for frontmatter parsing.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/core/repo-skills.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverRepoSkills, type RepoSkillEntry } from '../../../src/core/repo-skills.js';

function makeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe('discoverRepoSkills', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-skills-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers skills from default client paths', async () => {
    // Set up .claude/skills/my-skill/SKILL.md
    makeSkill(join(tmpDir, '.claude', 'skills'), 'my-skill', 'A test skill');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('my-skill');
    expect(results[0].description).toBe('A test skill');
    expect(results[0].relativePath).toBe('.claude/skills/my-skill/SKILL.md');
  });

  it('deduplicates skills across clients sharing same path', async () => {
    // Both universal and vscode use .agents/skills/
    makeSkill(join(tmpDir, '.agents', 'skills'), 'shared-skill', 'Shared');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['universal', 'vscode'],
    });

    expect(results).toHaveLength(1);
  });

  it('uses custom skill paths when provided', async () => {
    makeSkill(join(tmpDir, 'plugins', 'my-plugin', 'skills'), 'custom-skill', 'Custom');

    const results = await discoverRepoSkills(tmpDir, {
      skillPaths: ['plugins/my-plugin/skills'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('custom-skill');
    expect(results[0].relativePath).toBe('plugins/my-plugin/skills/custom-skill/SKILL.md');
  });

  it('returns empty array when skills disabled', async () => {
    makeSkill(join(tmpDir, '.claude', 'skills'), 'should-not-find', 'Nope');

    const results = await discoverRepoSkills(tmpDir, {
      disabled: true,
    });

    expect(results).toEqual([]);
  });

  it('skips symlinked skill directories', async () => {
    const realSkillDir = join(tmpDir, 'real-skills', 'real-skill');
    mkdirSync(realSkillDir, { recursive: true });
    writeFileSync(
      join(realSkillDir, 'SKILL.md'),
      '---\nname: real-skill\ndescription: Real\n---\n',
    );

    const claudeSkills = join(tmpDir, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync(realSkillDir, join(claudeSkills, 'linked-skill'));

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toEqual([]);
  });

  it('skips skills with invalid frontmatter', async () => {
    const skillDir = join(tmpDir, '.claude', 'skills', 'bad-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# No frontmatter\n');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude'],
    });

    expect(results).toEqual([]);
  });

  it('discovers skills from multiple client paths', async () => {
    makeSkill(join(tmpDir, '.claude', 'skills'), 'claude-skill', 'Claude skill');
    makeSkill(join(tmpDir, '.agents', 'skills'), 'agents-skill', 'Agents skill');

    const results = await discoverRepoSkills(tmpDir, {
      clients: ['claude', 'universal'],
    });

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['agents-skill', 'claude-skill']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/core/repo-skills.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `discoverRepoSkills()`**

```typescript
// src/core/repo-skills.ts
import { existsSync, lstatSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseSkillMetadata } from '../validators/skill.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import type { ClientType } from '../models/workspace-config.js';

export interface RepoSkillEntry {
  /** Skill name from frontmatter */
  name: string;
  /** Skill description from frontmatter */
  description: string;
  /** Path to SKILL.md relative to the repo root */
  relativePath: string;
}

interface DiscoverOptions {
  /** Client types to derive default skill paths from */
  clients?: (string | ClientType)[];
  /** Custom skill paths (relative to repo root), overrides client-derived paths */
  skillPaths?: string[];
  /** If true, skip discovery entirely */
  disabled?: boolean;
}

/**
 * Discover skills in a repository by scanning skill directories.
 * Parses SKILL.md frontmatter for name and description.
 * Skips symlinks and entries with invalid/missing frontmatter.
 */
export async function discoverRepoSkills(
  repoPath: string,
  options: DiscoverOptions,
): Promise<RepoSkillEntry[]> {
  if (options.disabled) return [];

  // Determine which directories to scan
  const skillDirs = new Set<string>();

  if (options.skillPaths) {
    for (const p of options.skillPaths) {
      skillDirs.add(p);
    }
  } else if (options.clients) {
    for (const client of options.clients) {
      const mapping = CLIENT_MAPPINGS[client as ClientType];
      if (mapping?.skillsPath) {
        skillDirs.add(mapping.skillsPath);
      }
    }
  }

  const results: RepoSkillEntry[] = [];
  const seen = new Set<string>(); // dedupe by relativePath

  for (const skillDir of skillDirs) {
    const absDir = join(repoPath, skillDir);
    if (!existsSync(absDir)) continue;

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip symlinks
      const entryPath = join(absDir, entry.name);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      const skillMdPath = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const relPath = relative(repoPath, skillMdPath);
      if (seen.has(relPath)) continue;

      try {
        const content = await readFile(skillMdPath, 'utf-8');
        const metadata = parseSkillMetadata(content);
        if (!metadata) continue;

        seen.add(relPath);
        results.push({
          name: metadata.name,
          description: metadata.description,
          relativePath: relPath,
        });
      } catch {
        continue;
      }
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/core/repo-skills.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/repo-skills.ts tests/unit/core/repo-skills.test.ts
git commit -m "feat(core): add discoverRepoSkills for workspace skill discovery"
```

---

### Task 3: Embed skill index in workspace rules

**Files:**
- Modify: `src/constants.ts:46-62`
- Create: `tests/unit/constants.test.ts` (or add to existing)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/constants.test.ts
import { describe, it, expect } from 'bun:test';
import { generateWorkspaceRules } from '../../src/constants.js';

describe('generateWorkspaceRules with skills', () => {
  it('includes available_skills block when skills provided', () => {
    const result = generateWorkspaceRules(
      [{ path: '../my-repo', description: 'My repo' }],
      [
        {
          repoPath: '../my-repo',
          name: 'my-skill',
          description: 'Does things',
          location: '../my-repo/.claude/skills/my-skill/SKILL.md',
        },
      ],
    );

    expect(result).toContain('<available_skills>');
    expect(result).toContain('<name>my-skill</name>');
    expect(result).toContain('<description>Does things</description>');
    expect(result).toContain(
      '<location>../my-repo/.claude/skills/my-skill/SKILL.md</location>',
    );
    expect(result).toContain('</available_skills>');
  });

  it('omits available_skills block when no skills found', () => {
    const result = generateWorkspaceRules(
      [{ path: '../my-repo' }],
      [],
    );

    expect(result).not.toContain('<available_skills>');
  });

  it('includes instruction text with skills block', () => {
    const result = generateWorkspaceRules(
      [{ path: '../repo' }],
      [
        {
          repoPath: '../repo',
          name: 's',
          description: 'd',
          location: '../repo/.claude/skills/s/SKILL.md',
        },
      ],
    );

    expect(result).toContain(
      'When a task matches a skill description, fetch the full instructions from its location',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/constants.test.ts`
Expected: FAIL — `generateWorkspaceRules` doesn't accept second argument

- [ ] **Step 3: Update `generateWorkspaceRules()` signature and output**

In `src/constants.ts`:

```typescript
export interface WorkspaceSkillEntry {
  repoPath: string;
  name: string;
  description: string;
  location: string;
}

export function generateWorkspaceRules(
  repositories: Repository[],
  skills: WorkspaceSkillEntry[] = [],
): string {
  const repoList = repositories
    .map((r) => `- ${r.path}${r.description ? ` - ${r.description}` : ''}`)
    .join('\n');

  let skillsBlock = '';
  if (skills.length > 0) {
    const skillEntries = skills
      .map(
        (s) =>
          `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.location}</location>\n</skill>`,
      )
      .join('\n');

    skillsBlock = `

## Workspace Skills
When a task matches a skill description, fetch the full instructions from its location.

<available_skills>
${skillEntries}
</available_skills>`;
  }

  return `
<!-- WORKSPACE-RULES:START -->
## Workspace Repositories
The following repositories are part of this workspace:
${repoList}

## Rule: Use Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use the repository paths listed above, not assumptions
${skillsBlock}
<!-- WORKSPACE-RULES:END -->
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/constants.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `bun test tests/unit/core/workspace-repo.test.ts`
Expected: PASS — existing callers pass no second arg, default `[]` keeps old behavior

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts tests/unit/constants.test.ts
git commit -m "feat(rules): embed available_skills index in workspace rules"
```

---

### Task 4: Wire skill discovery into the sync pipeline

**Files:**
- Modify: `src/core/workspace-repo.ts:168-192` — call `discoverRepoSkills()` and pass results to `generateWorkspaceRules()`
- Modify: `src/constants.ts` — `generateWorkspaceRules()` already updated in Task 3
- Modify: `src/core/transform.ts:28-52` — `ensureWorkspaceRules()` must forward skills

- [ ] **Step 1: Update `ensureWorkspaceRules()` to accept skills**

In `src/core/transform.ts`, update the signature:

```typescript
import type { WorkspaceSkillEntry } from '../constants.js';

export async function ensureWorkspaceRules(
  filePath: string,
  repositories: WorkspaceRepository[],
  skills: WorkspaceSkillEntry[] = [],
): Promise<void> {
  const rulesContent = generateWorkspaceRules(repositories, skills);
  // ... rest unchanged
```

- [ ] **Step 2: Update `updateAgentFiles()` to discover and pass skills**

In `src/core/workspace-repo.ts`:

```typescript
import { discoverRepoSkills } from './repo-skills.js';
import type { WorkspaceSkillEntry } from '../constants.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import type { ClientType } from '../models/workspace-config.js';
import { join, relative, dirname } from 'node:path';

export async function updateAgentFiles(
  workspacePath: string = process.cwd(),
): Promise<void> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  const content = await readFile(configPath, 'utf-8');
  const config = load(content) as WorkspaceConfig;

  if (config.repositories.length === 0) return;

  // Resolve client names from config
  const clientNames: string[] = (config.clients ?? []).map((c) =>
    typeof c === 'string' ? c : c.name,
  );

  // Discover skills from all repositories
  const allSkills: WorkspaceSkillEntry[] = [];
  for (const repo of config.repositories) {
    if (repo.skills === false) continue;

    const repoAbsPath = resolve(workspacePath, repo.path);
    const discoverOpts =
      Array.isArray(repo.skills)
        ? { skillPaths: repo.skills }
        : { clients: clientNames };

    const repoSkills = await discoverRepoSkills(repoAbsPath, discoverOpts);
    for (const skill of repoSkills) {
      allSkills.push({
        repoPath: repo.path,
        name: skill.name,
        description: skill.description,
        location: join(repo.path, skill.relativePath),
      });
    }
  }

  // Collect unique agent files from configured clients
  const agentFiles = new Set<string>();
  for (const client of config.clients ?? []) {
    const clientName = typeof client === 'string' ? client : client.name;
    const mapping = CLIENT_MAPPINGS[clientName as ClientType];
    if (mapping?.agentFile) agentFiles.add(mapping.agentFile);
  }
  agentFiles.add('AGENTS.md');

  for (const agentFile of agentFiles) {
    await ensureWorkspaceRules(
      join(workspacePath, agentFile),
      config.repositories,
      allSkills,
    );
  }
}
```

- [ ] **Step 3: Ensure `copyWorkspaceFiles()` also passes skills**

Search `src/core/transform.ts` for calls to `ensureWorkspaceRules()` inside `copyWorkspaceFiles()`. These also need the skills parameter. This will require passing skills through from the sync pipeline.

In `src/core/sync.ts`, the full sync pipeline calls `copyWorkspaceFiles()` which calls `ensureWorkspaceRules()`. The skill discovery should happen in `syncWorkspace()` before step 5 and be threaded through. Update `copyWorkspaceFiles()` to accept an optional `skills` parameter and forward it to `ensureWorkspaceRules()`.

- [ ] **Step 4: Run all workspace-related tests**

Run: `bun test tests/unit/core/workspace-repo.test.ts tests/unit/core/repo-skills.test.ts tests/unit/constants.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/transform.ts src/core/workspace-repo.ts src/core/sync.ts
git commit -m "feat(sync): wire skill discovery into workspace rules pipeline"
```

---

### Task 5: Integration test — full sync with skills

**Files:**
- Create: `tests/unit/core/repo-skills-sync.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/unit/core/repo-skills-sync.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateAgentFiles } from '../../../src/core/workspace-repo.js';

function makeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe('updateAgentFiles with skills', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-sync-test-'));
    repoDir = join(workspaceDir, 'my-repo');
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('embeds discovered skills in AGENTS.md', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories:\n  - path: ./my-repo\nplugins: []\nclients:\n  - claude\n`,
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<available_skills>');
    expect(agentsContent).toContain('<name>test-skill</name>');
    expect(agentsContent).toContain('./my-repo/.claude/skills/test-skill/SKILL.md');
  });

  it('uses custom skill paths from workspace.yaml', async () => {
    makeSkill(join(repoDir, 'plugins', 'my-plugin', 'skills'), 'custom', 'Custom skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories:\n  - path: ./my-repo\n    skills:\n      - plugins/my-plugin/skills\nplugins: []\nclients:\n  - claude\n`,
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('<name>custom</name>');
    expect(agentsContent).toContain('./my-repo/plugins/my-plugin/skills/custom/SKILL.md');
  });

  it('skips repos with skills: false', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'hidden', 'Should not appear');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories:\n  - path: ./my-repo\n    skills: false\nplugins: []\nclients:\n  - claude\n`,
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('<available_skills>');
  });

  it('no skills block when repos have no skills', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories:\n  - path: ./my-repo\nplugins: []\nclients:\n  - claude\n`,
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('<available_skills>');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS, no regressions

- [ ] **Step 4: Commit**

```bash
git add tests/unit/core/repo-skills-sync.test.ts
git commit -m "test(sync): add integration tests for workspace skill discovery"
```

---

### Task 6: Manual E2E test

- [ ] **Step 1: Build the CLI**

```bash
bun run build
```

- [ ] **Step 2: Set up test workspace in /tmp**

```bash
mkdir -p /tmp/skills-e2e/my-repo/.claude/skills/my-skill
mkdir -p /tmp/skills-e2e/.allagents

cat > /tmp/skills-e2e/my-repo/.claude/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: A test skill for E2E validation
---

# My Skill
Instructions here.
EOF

cat > /tmp/skills-e2e/.allagents/workspace.yaml << 'EOF'
repositories:
  - path: ./my-repo
    description: Test repo
plugins: []
clients:
  - claude
version: 2
EOF
```

- [ ] **Step 3: Run sync and verify output**

```bash
cd /tmp/skills-e2e
/path/to/dist/index.js sync
cat AGENTS.md
```

Expected: AGENTS.md contains `<available_skills>` block with `my-skill` entry and path `./my-repo/.claude/skills/my-skill/SKILL.md`.

- [ ] **Step 4: Test custom paths**

```bash
mkdir -p /tmp/skills-e2e/my-repo/plugins/custom/skills/custom-skill

cat > /tmp/skills-e2e/my-repo/plugins/custom/skills/custom-skill/SKILL.md << 'EOF'
---
name: custom-skill
description: Custom path skill
---

# Custom Skill
EOF

# Update workspace.yaml to use custom paths
cat > /tmp/skills-e2e/.allagents/workspace.yaml << 'EOF'
repositories:
  - path: ./my-repo
    description: Test repo
    skills:
      - plugins/custom/skills
plugins: []
clients:
  - claude
version: 2
EOF

/path/to/dist/index.js sync
cat AGENTS.md
```

Expected: Only `custom-skill` appears (not `my-skill` from `.claude/skills/` since custom paths override defaults).

- [ ] **Step 5: Test skills: false**

```bash
cat > /tmp/skills-e2e/.allagents/workspace.yaml << 'EOF'
repositories:
  - path: ./my-repo
    description: Test repo
    skills: false
plugins: []
clients:
  - claude
version: 2
EOF

/path/to/dist/index.js sync
cat AGENTS.md
```

Expected: No `<available_skills>` block.

- [ ] **Step 6: Clean up**

```bash
rm -rf /tmp/skills-e2e
```

- [ ] **Step 7: Commit (if any fixes were needed)**
