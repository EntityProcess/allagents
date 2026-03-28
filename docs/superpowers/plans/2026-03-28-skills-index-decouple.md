# Skills Index Decouple Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple repo skills from inline AGENTS.md to separate per-repo index files, preventing double-loading in VS Code and making discovery opt-in.

**Architecture:** Skills are written to `.allagents/skills-index/<repo-name>.md` during sync. AGENTS.md gets a conditional link instead of inline XML. Discovery is opt-in (requires `skills: true` or custom paths on the repository entry).

**Tech Stack:** TypeScript, bun:test, node:fs

---

### File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/core/repo-skills.ts` | Flip default to opt-in; add `writeSkillsIndex()` and `cleanupSkillsIndex()` |
| Modify | `src/constants.ts` | Change `generateWorkspaceRules()` to emit conditional links instead of inline XML |
| Modify | `src/core/workspace-repo.ts` | Call `writeSkillsIndex()` before generating rules; pass grouped skill refs |
| Modify | `src/core/sync.ts` | Same changes as workspace-repo.ts for the full sync pipeline path |
| Modify | `src/models/sync-state.ts` | Add `skillsIndex` field to track generated index files |
| Modify | `tests/unit/core/repo-skills.test.ts` | Update for opt-in default |
| Modify | `tests/unit/core/repo-skills-sync.test.ts` | Update for skills-index files + conditional links |

---

### Task 1: Flip `discoverWorkspaceSkills` to opt-in

**Files:**
- Modify: `src/core/repo-skills.ts:124-130`
- Test: `tests/unit/core/repo-skills.test.ts`

- [ ] **Step 1: Write failing test for opt-in default**

Add to `tests/unit/core/repo-skills.test.ts` a new describe block at the end:

```typescript
import { discoverWorkspaceSkills } from '../../../src/core/repo-skills.js';

describe('discoverWorkspaceSkills opt-in', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-optin-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips repos where skills is undefined (opt-in)', async () => {
    const repoDir = join(tmpDir, 'my-repo');
    makeSkill(join(repoDir, '.claude', 'skills'), 'some-skill', 'A skill');

    const results = await discoverWorkspaceSkills(
      tmpDir,
      [{ path: './my-repo' }],
      ['claude'],
    );

    expect(results).toEqual([]);
  });

  it('discovers skills when skills: true', async () => {
    const repoDir = join(tmpDir, 'my-repo');
    makeSkill(join(repoDir, '.claude', 'skills'), 'some-skill', 'A skill');

    const results = await discoverWorkspaceSkills(
      tmpDir,
      [{ path: './my-repo', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('some-skill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/repo-skills.test.ts`
Expected: "skips repos where skills is undefined" FAILS (currently discovers skills when undefined)

- [ ] **Step 3: Implement opt-in logic**

In `src/core/repo-skills.ts`, change line 125 from:

```typescript
    if (repo.skills === false) continue;
```

to:

```typescript
    if (repo.skills === false || repo.skills === undefined) continue;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/core/repo-skills.test.ts`
Expected: All pass

- [ ] **Step 5: Fix existing tests that rely on opt-out default**

The existing tests in `repo-skills-sync.test.ts` use repos without `skills: true`. Update the workspace.yaml strings in those tests to add `skills: true` to repository entries. For example, in the `updateAgentFiles with skills` describe block, change:

```yaml
repositories:\n  - path: ./my-repo\n
```
to:
```yaml
repositories:\n  - path: ./my-repo\n    skills: true\n
```

Apply this to all test cases in `repo-skills-sync.test.ts` that expect skills to be discovered. Also update the deduplication tests to pass `skills: true` in repository objects:

Change `[{ path: './repo1' }, { path: './repo2' }]` to `[{ path: './repo1', skills: true }, { path: './repo2', skills: true }]`.

- [ ] **Step 6: Run all repo-skills tests**

Run: `bun test tests/unit/core/repo-skills.test.ts tests/unit/core/repo-skills-sync.test.ts`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/core/repo-skills.ts tests/unit/core/repo-skills.test.ts tests/unit/core/repo-skills-sync.test.ts
git commit -m "fix: make repo skill discovery opt-in"
```

---

### Task 2: Add `writeSkillsIndex()` and `cleanupSkillsIndex()`

**Files:**
- Modify: `src/core/repo-skills.ts`
- Test: `tests/unit/core/repo-skills-sync.test.ts`

- [ ] **Step 1: Write failing test for writeSkillsIndex**

Add a new describe block to `tests/unit/core/repo-skills-sync.test.ts`:

```typescript
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { writeSkillsIndex, cleanupSkillsIndex } from '../../../src/core/repo-skills.js';

describe('writeSkillsIndex', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-index-test-'));
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes per-repo skills index files', () => {
    const skillsByRepo = new Map<string, { repoName: string; skills: WorkspaceSkillEntry[] }>();
    skillsByRepo.set('./my-repo', {
      repoName: 'my-repo',
      skills: [
        { repoPath: './my-repo', name: 'test-skill', description: 'A test skill', location: './my-repo/.claude/skills/test-skill/SKILL.md' },
      ],
    });

    const written = writeSkillsIndex(workspaceDir, skillsByRepo);

    expect(written).toEqual(['skills-index/my-repo.md']);
    const content = readFileSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'), 'utf-8');
    expect(content).toContain('<available_skills>');
    expect(content).toContain('<name>test-skill</name>');
    expect(content).toContain('./my-repo/.claude/skills/test-skill/SKILL.md');
  });

  it('returns empty array when no skills', () => {
    const written = writeSkillsIndex(workspaceDir, new Map());
    expect(written).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: FAIL — `writeSkillsIndex` not exported

- [ ] **Step 3: Implement writeSkillsIndex**

Add to `src/core/repo-skills.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface RepoSkillGroup {
  repoName: string;
  skills: WorkspaceSkillEntry[];
}

/**
 * Write per-repo skills index files to .allagents/skills-index/<repo-name>.md
 * Returns list of relative paths (from .allagents/) of written files.
 */
export function writeSkillsIndex(
  workspacePath: string,
  skillsByRepo: Map<string, RepoSkillGroup>,
): string[] {
  if (skillsByRepo.size === 0) return [];

  const indexDir = join(workspacePath, '.allagents', 'skills-index');
  mkdirSync(indexDir, { recursive: true });

  const written: string[] = [];

  for (const [, { repoName, skills }] of skillsByRepo) {
    const skillEntries = skills
      .map(
        (s) =>
          `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.location}</location>\n</skill>`,
      )
      .join('\n');

    const content = `# Skills: ${repoName}\n\n<available_skills>\n${skillEntries}\n</available_skills>\n`;

    const fileName = `${repoName}.md`;
    writeFileSync(join(indexDir, fileName), content, 'utf-8');
    written.push(`skills-index/${fileName}`);
  }

  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: `writeSkillsIndex` tests pass

- [ ] **Step 5: Write failing test for cleanupSkillsIndex**

Add to the same describe block:

```typescript
describe('cleanupSkillsIndex', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-cleanup-test-'));
    mkdirSync(join(workspaceDir, '.allagents', 'skills-index'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('removes stale index files not in current set', () => {
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'old-repo.md'), 'stale');
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'current-repo.md'), 'fresh');

    cleanupSkillsIndex(workspaceDir, ['skills-index/current-repo.md']);

    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'old-repo.md'))).toBe(false);
    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'current-repo.md'))).toBe(true);
  });

  it('removes skills-index directory when empty', () => {
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'old.md'), 'stale');

    cleanupSkillsIndex(workspaceDir, []);

    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index'))).toBe(false);
  });
});
```

- [ ] **Step 6: Implement cleanupSkillsIndex**

Add to `src/core/repo-skills.ts`:

```typescript
import { readdirSync, rmSync } from 'node:fs';

/**
 * Remove skills-index files that are no longer in the current set.
 * Removes the skills-index directory if it becomes empty.
 */
export function cleanupSkillsIndex(
  workspacePath: string,
  currentFiles: string[],
): void {
  const indexDir = join(workspacePath, '.allagents', 'skills-index');
  if (!existsSync(indexDir)) return;

  const currentSet = new Set(currentFiles.map((f) => f.replace('skills-index/', '')));

  let entries: string[];
  try {
    entries = readdirSync(indexDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!currentSet.has(entry)) {
      rmSync(join(indexDir, entry), { force: true });
    }
  }

  // Remove directory if empty
  try {
    const remaining = readdirSync(indexDir);
    if (remaining.length === 0) {
      rmSync(indexDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: All pass

- [ ] **Step 8: Add helper to group skills by repo**

Add to `src/core/repo-skills.ts`:

```typescript
/**
 * Group workspace skills by repo, deriving repo name from repository.name or path basename.
 */
export function groupSkillsByRepo(
  skills: WorkspaceSkillEntry[],
  repositories: Repository[],
): Map<string, RepoSkillGroup> {
  const repoNameMap = new Map<string, string>();
  for (const repo of repositories) {
    repoNameMap.set(repo.path, repo.name ?? basename(repo.path));
  }

  const grouped = new Map<string, RepoSkillGroup>();
  for (const skill of skills) {
    const repoName = repoNameMap.get(skill.repoPath) ?? basename(skill.repoPath);
    const existing = grouped.get(skill.repoPath);
    if (existing) {
      existing.skills.push(skill);
    } else {
      grouped.set(skill.repoPath, { repoName, skills: [skill] });
    }
  }

  return grouped;
}
```

- [ ] **Step 9: Commit**

```bash
git add src/core/repo-skills.ts tests/unit/core/repo-skills-sync.test.ts
git commit -m "feat: add writeSkillsIndex, cleanupSkillsIndex, and groupSkillsByRepo"
```

---

### Task 3: Change `generateWorkspaceRules()` to emit conditional links

**Files:**
- Modify: `src/constants.ts:54-92`
- Test: `tests/unit/core/repo-skills-sync.test.ts`

- [ ] **Step 1: Write failing test for conditional link output**

Add a new describe block to `tests/unit/core/repo-skills-sync.test.ts`:

```typescript
import { generateWorkspaceRules } from '../../../src/constants.js';

describe('generateWorkspaceRules with skills-index links', () => {
  it('emits conditional links instead of inline skills', () => {
    const skillsIndexRefs = [
      { repoName: 'my-repo', indexPath: '.allagents/skills-index/my-repo.md' },
    ];
    const result = generateWorkspaceRules(
      [{ path: './my-repo' }],
      skillsIndexRefs,
    );

    expect(result).toContain('## Repository Skills');
    expect(result).toContain('my-repo');
    expect(result).toContain('.allagents/skills-index/my-repo.md');
    expect(result).not.toContain('<available_skills>');
  });

  it('omits skills section when no index refs', () => {
    const result = generateWorkspaceRules([{ path: './my-repo' }], []);
    expect(result).not.toContain('## Repository Skills');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: FAIL — `generateWorkspaceRules` signature mismatch (still expects `WorkspaceSkillEntry[]`)

- [ ] **Step 3: Update generateWorkspaceRules**

Replace the function and interface in `src/constants.ts`:

```typescript
export interface SkillsIndexRef {
  repoName: string;
  indexPath: string;
}

/**
 * Generate WORKSPACE-RULES content with embedded repository paths and optional skills-index links.
 * Skills are NOT embedded inline — agents are directed to read index files on demand.
 */
export function generateWorkspaceRules(
  repositories: Repository[],
  skillsIndexRefs: SkillsIndexRef[] = [],
): string {
  const repoList = repositories
    .map((r) => `- ${r.path}${r.description ? ` - ${r.description}` : ''}`)
    .join('\n');

  let skillsBlock = '';
  if (skillsIndexRefs.length > 0) {
    const refLines = skillsIndexRefs
      .map((r) => `- ${r.repoName}: ${r.indexPath}`)
      .join('\n');

    skillsBlock = `
## Repository Skills
If the skills from the following repositories are not already available in your context, read the corresponding index file:
${refLines}
`;
  }

  return `
<!-- WORKSPACE-RULES:START -->
## Workspace Repositories
The following repositories are part of this workspace:
${repoList}

## Rule: Use Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use the repository paths listed above, not assumptions
${skillsBlock}<!-- WORKSPACE-RULES:END -->
`;
}
```

Remove the old `WorkspaceSkillEntry` interface from constants.ts (it moves to repo-skills.ts where it's already used).

- [ ] **Step 4: Move WorkspaceSkillEntry to repo-skills.ts**

The `WorkspaceSkillEntry` interface is currently in `src/constants.ts` and imported by `src/core/repo-skills.ts` and `src/core/transform.ts`. Move it to `src/core/repo-skills.ts` and update imports:

In `src/core/repo-skills.ts`, change:
```typescript
import type { WorkspaceSkillEntry } from '../constants.js';
```
to define it locally (it's already used there):
```typescript
export interface WorkspaceSkillEntry {
  repoPath: string;
  name: string;
  description: string;
  location: string;
}
```

Remove the `WorkspaceSkillEntry` interface and its export from `src/constants.ts`.

Update `src/core/transform.ts` import:
```typescript
import { generateWorkspaceRules, type WorkspaceRepository, type SkillsIndexRef } from '../constants.js';
```

Remove `type WorkspaceSkillEntry` from that import.

- [ ] **Step 5: Run tests to verify**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: New tests pass. Some existing `updateAgentFiles` tests will now need updating (Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts src/core/repo-skills.ts src/core/transform.ts tests/unit/core/repo-skills-sync.test.ts
git commit -m "refactor: change generateWorkspaceRules to emit conditional links"
```

---

### Task 4: Update `ensureWorkspaceRules` and `updateAgentFiles` callers

**Files:**
- Modify: `src/core/transform.ts:28-56`
- Modify: `src/core/workspace-repo.ts:177-207`
- Test: `tests/unit/core/repo-skills-sync.test.ts`

- [ ] **Step 1: Update ensureWorkspaceRules signature**

In `src/core/transform.ts`, change the `ensureWorkspaceRules` function signature from:

```typescript
export async function ensureWorkspaceRules(
  filePath: string,
  repositories: WorkspaceRepository[],
  skills: WorkspaceSkillEntry[] = [],
): Promise<void> {
  const rulesContent = generateWorkspaceRules(repositories, skills);
```

to:

```typescript
export async function ensureWorkspaceRules(
  filePath: string,
  repositories: WorkspaceRepository[],
  skillsIndexRefs: SkillsIndexRef[] = [],
): Promise<void> {
  const rulesContent = generateWorkspaceRules(repositories, skillsIndexRefs);
```

Update the import at the top of transform.ts:
```typescript
import { generateWorkspaceRules, type WorkspaceRepository, type SkillsIndexRef } from '../constants.js';
```

- [ ] **Step 2: Update updateAgentFiles to write index files and pass refs**

In `src/core/workspace-repo.ts`, update imports:

```typescript
import { discoverWorkspaceSkills, writeSkillsIndex, cleanupSkillsIndex, groupSkillsByRepo } from './repo-skills.js';
```

Update `updateAgentFiles`:

```typescript
export async function updateAgentFiles(
  workspacePath: string = process.cwd(),
): Promise<void> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  const content = await readFile(configPath, 'utf-8');
  const config = load(content) as WorkspaceConfig;

  if (config.repositories.length === 0) return;

  const clientNames = resolveClientNames(config.clients);

  // Discover skills from all repositories
  const allSkills = await discoverWorkspaceSkills(workspacePath, config.repositories, clientNames);

  // Write per-repo skills-index files
  const grouped = groupSkillsByRepo(allSkills, config.repositories);
  const writtenFiles = writeSkillsIndex(workspacePath, grouped);
  cleanupSkillsIndex(workspacePath, writtenFiles);

  // Build refs for WORKSPACE-RULES conditional links
  const skillsIndexRefs = writtenFiles.map((f) => {
    const repoName = f.replace('skills-index/', '').replace('.md', '');
    return { repoName, indexPath: `.allagents/${f}` };
  });

  // Collect unique agent files from configured clients
  const agentFiles = new Set<string>();
  for (const client of config.clients ?? []) {
    const clientName = typeof client === 'string' ? client : (client as { name: string }).name;
    const mapping = CLIENT_MAPPINGS[clientName as ClientType];
    if (mapping?.agentFile) agentFiles.add(mapping.agentFile);
  }
  agentFiles.add('AGENTS.md');

  for (const agentFile of agentFiles) {
    await ensureWorkspaceRules(join(workspacePath, agentFile), config.repositories, skillsIndexRefs);
  }
}
```

- [ ] **Step 3: Update existing tests for new behavior**

Update the `updateAgentFiles with skills` tests in `tests/unit/core/repo-skills-sync.test.ts`. The tests should now verify:
- Skills-index files are created in `.allagents/skills-index/`
- AGENTS.md contains conditional links, not inline `<available_skills>`

Replace the existing `embeds discovered skills in AGENTS.md` test:

```typescript
  it('writes skills-index file and links from AGENTS.md', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    // Skills-index file should exist
    const indexContent = readFileSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'), 'utf-8');
    expect(indexContent).toContain('<available_skills>');
    expect(indexContent).toContain('<name>test-skill</name>');

    // AGENTS.md should have conditional link, not inline skills
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('## Repository Skills');
    expect(agentsContent).toContain('.allagents/skills-index/my-repo.md');
    expect(agentsContent).not.toContain('<available_skills>');
  });
```

Update the remaining tests similarly — check for index files and conditional links instead of inline `<available_skills>`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/core/repo-skills-sync.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/core/transform.ts src/core/workspace-repo.ts tests/unit/core/repo-skills-sync.test.ts
git commit -m "feat: write skills-index files and conditional links in updateAgentFiles"
```

---

### Task 5: Update sync.ts pipeline

**Files:**
- Modify: `src/core/sync.ts:1917-1929`
- Modify: `src/core/transform.ts` (WorkspaceCopyOptions)

- [ ] **Step 1: Update WorkspaceCopyOptions in transform.ts**

In `src/core/transform.ts`, find the `WorkspaceCopyOptions` interface and change the `skills` field:

```typescript
// Before
skills?: WorkspaceSkillEntry[];

// After
skillsIndexRefs?: SkillsIndexRef[];
```

Update the `copyWorkspaceFiles` function where it calls `ensureWorkspaceRules` (around line 1103) to pass `skillsIndexRefs` instead of `skills`:

```typescript
await ensureWorkspaceRules(targetPath, repositories, options.skillsIndexRefs);
```

- [ ] **Step 2: Update sync.ts**

In `src/core/sync.ts`, update the import:

```typescript
import { discoverWorkspaceSkills, writeSkillsIndex, cleanupSkillsIndex, groupSkillsByRepo } from './repo-skills.js';
```

Replace lines ~1917-1929:

```typescript
    // Step 5c: Discover skills from workspace repositories
    const repoSkills = hasRepositories && !dryRun
      ? await discoverWorkspaceSkills(workspacePath, config.repositories, syncClients as string[])
      : [];

    // Step 5c.1: Write skills-index files and clean up stale ones
    let skillsIndexRefs: SkillsIndexRef[] = [];
    if (repoSkills.length > 0 && !dryRun) {
      const grouped = groupSkillsByRepo(repoSkills, config.repositories);
      const writtenFiles = writeSkillsIndex(workspacePath, grouped);
      cleanupSkillsIndex(workspacePath, writtenFiles);
      skillsIndexRefs = writtenFiles.map((f) => {
        const repoName = f.replace('skills-index/', '').replace('.md', '');
        return { repoName, indexPath: `.allagents/${f}` };
      });
    }

    // Step 5d: Copy workspace files with GitHub cache
    // Pass repositories and skillsIndexRefs so conditional links are embedded in WORKSPACE-RULES
    workspaceFileResults = await copyWorkspaceFiles(
      sourcePath,
      workspacePath,
      filesToCopy,
      { dryRun, githubCache, repositories: config.repositories, skillsIndexRefs },
    );
```

Add the import for `SkillsIndexRef`:
```typescript
import { type SkillsIndexRef } from '../constants.js';
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/core/sync.ts src/core/transform.ts
git commit -m "feat: integrate skills-index into full sync pipeline"
```

---

### Task 6: Add skillsIndex to sync state

**Files:**
- Modify: `src/models/sync-state.ts`
- Modify: `src/core/sync.ts` (where sync state is written)

- [ ] **Step 1: Add field to SyncStateSchema**

In `src/models/sync-state.ts`, add after `vscodeWorkspaceRepos`:

```typescript
  // Skills-index files tracked for cleanup (relative to .allagents/)
  skillsIndex: z.array(z.string()).optional(),
```

- [ ] **Step 2: Update sync.ts to persist skillsIndex in state**

Find where sync state is written in `sync.ts` (search for `SYNC_STATE_FILE` or `sync-state.json` writes). Add the `skillsIndex` field with the list of written files.

The exact location will be where `syncState` object is constructed before writing. Add:

```typescript
skillsIndex: writtenSkillsIndexFiles.length > 0 ? writtenSkillsIndexFiles : undefined,
```

Note: You'll need to hoist `writtenFiles` from Task 5's scope to be accessible at the sync state write point — store it in a variable like `writtenSkillsIndexFiles` declared before the workspace files block.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/models/sync-state.ts src/core/sync.ts
git commit -m "feat: track skills-index files in sync state"
```

---

### Task 7: Clean up and verify

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `bunx biome lint src`
Expected: No errors

- [ ] **Step 4: Commit any remaining fixes**

If any fixes needed from the above checks, commit them.

```bash
git commit -m "fix: address lint and type errors"
```
