# Client Native Shorthand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `client:mode` colon-separated string shorthand to `ClientEntrySchema` so `claude:native` in workspace.yaml is equivalent to `{ name: claude, install: native }`.

**Architecture:** Replace the `ClientEntrySchema` union's bare `ClientTypeSchema` branch with a single `z.string().transform()` that handles both bare strings (`"claude"`) and colon shorthand (`"claude:native"`). Refactor `parseClientEntries()` to delegate single-entry validation to the schema.

**Tech Stack:** TypeScript, Zod, bun:test

**Spec:** `docs/superpowers/specs/2026-03-20-client-native-shorthand-design.md`

**Issue:** #276

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/models/workspace-config.ts` | Modify (lines 103-114) | Schema change: new string transform branch |
| `src/cli/commands/workspace.ts` | Modify (lines 27-55) | Refactor `parseClientEntries()` to use schema |
| `tests/unit/models/client-entry-schema.test.ts` | Create | Schema unit tests |
| `tests/unit/cli/parse-client-entries.test.ts` | Modify | Update tests for refactored `parseClientEntries()` |
| `examples/workspaces/native-install/.allagents/workspace.yaml` | Modify | Use shorthand syntax |

---

### Task 1: Schema unit tests for existing behavior

**Files:**
- Create: `tests/unit/models/client-entry-schema.test.ts`

Capture current behavior before changing the schema so we can verify nothing breaks.

- [ ] **Step 1: Write tests for current `ClientEntrySchema` behavior**

```typescript
import { describe, it, expect } from 'bun:test';
import { ClientEntrySchema, WorkspaceConfigSchema, normalizeClientEntry } from '../../../src/models/workspace-config.js';

describe('ClientEntrySchema', () => {
  describe('existing behavior', () => {
    it('parses bare client string', () => {
      expect(ClientEntrySchema.parse('claude')).toBe('claude');
    });

    it('parses object form with install mode', () => {
      expect(ClientEntrySchema.parse({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('defaults install to file in object form', () => {
      expect(ClientEntrySchema.parse({ name: 'claude' })).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects invalid client name string', () => {
      expect(() => ClientEntrySchema.parse('fakeclient')).toThrow();
    });

    it('rejects invalid client name in object', () => {
      expect(() => ClientEntrySchema.parse({ name: 'fakeclient', install: 'file' })).toThrow();
    });
  });

  describe('normalizeClientEntry', () => {
    it('normalizes bare string to object', () => {
      expect(normalizeClientEntry('claude')).toEqual({ name: 'claude', install: 'file' });
    });

    it('normalizes object entry', () => {
      expect(normalizeClientEntry({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test tests/unit/models/client-entry-schema.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/unit/models/client-entry-schema.test.ts
git commit -m "test: add baseline schema tests for ClientEntrySchema"
```

---

### Task 2: Update `ClientEntrySchema` with string transform

**Files:**
- Modify: `src/models/workspace-config.ts:103-114`

- [ ] **Step 1: Write failing tests for colon shorthand**

Add to `tests/unit/models/client-entry-schema.test.ts`:

```typescript
  describe('colon shorthand', () => {
    it('parses claude:native to object', () => {
      expect(ClientEntrySchema.parse('claude:native')).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('parses claude:file to object', () => {
      expect(ClientEntrySchema.parse('claude:file')).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects empty client name', () => {
      expect(() => ClientEntrySchema.parse(':native')).toThrow();
    });

    it('rejects empty install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:')).toThrow();
    });

    it('rejects extra colons', () => {
      expect(() => ClientEntrySchema.parse('claude:native:extra')).toThrow();
    });

    it('rejects invalid install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:bogus')).toThrow();
    });

    it('rejects invalid client with valid mode', () => {
      expect(() => ClientEntrySchema.parse('fakeclient:native')).toThrow();
    });

    it('rejects uppercase (case-sensitive)', () => {
      expect(() => ClientEntrySchema.parse('CLAUDE:NATIVE')).toThrow();
    });
  });

  describe('full WorkspaceConfigSchema with mixed client formats', () => {
    it('parses config with bare, shorthand, and object clients', () => {
      const config = WorkspaceConfigSchema.parse({
        repositories: [],
        plugins: [],
        clients: [
          'copilot',
          'claude:native',
          { name: 'cursor', install: 'file' },
        ],
      });
      expect(config.clients).toEqual([
        'copilot',
        { name: 'claude', install: 'native' },
        { name: 'cursor', install: 'file' },
      ]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/models/client-entry-schema.test.ts`
Expected: Colon shorthand tests FAIL (schema doesn't support it yet)

- [ ] **Step 3: Implement the schema change**

In `src/models/workspace-config.ts`, replace lines 103-114 with:

```typescript
/**
 * Client entry — string shorthand, colon shorthand, or object with install mode.
 *
 * "claude"        → bare client, install defaults to "file"
 * "claude:native" → colon shorthand, parsed to { name: "claude", install: "native" }
 * { name, install } → explicit object form
 */
export const ClientEntrySchema = z.union([
  z
    .string()
    .transform((s, ctx) => {
      const colonIdx = s.indexOf(':');
      if (colonIdx === -1) {
        // Bare string — validate as client type
        const result = ClientTypeSchema.safeParse(s);
        if (!result.success) {
          result.error.issues.forEach((issue) => ctx.addIssue(issue));
          return z.NEVER;
        }
        return result.data;
      }
      // Colon shorthand — split on first colon
      const name = s.slice(0, colonIdx);
      const mode = s.slice(colonIdx + 1);
      const nameResult = ClientTypeSchema.safeParse(name);
      if (!nameResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid client type: '${name}'`,
        });
        return z.NEVER;
      }
      const modeResult = InstallModeSchema.safeParse(mode);
      if (!modeResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid install mode: '${mode}'. Valid modes: ${InstallModeSchema.options.join(', ')}`,
        });
        return z.NEVER;
      }
      return { name: nameResult.data, install: modeResult.data };
    }),
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);
export type ClientEntry = z.infer<typeof ClientEntrySchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/models/client-entry-schema.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run existing tests to check for regressions**

Run: `bun test tests/unit/core/sync-install-mode.test.ts tests/unit/cli/parse-client-entries.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/models/workspace-config.ts tests/unit/models/client-entry-schema.test.ts
git commit -m "feat: add client:mode colon shorthand to ClientEntrySchema"
```

---

### Task 3: Refactor `parseClientEntries()` to use schema

**Files:**
- Modify: `src/cli/commands/workspace.ts:27-55`
- Modify: `tests/unit/cli/parse-client-entries.test.ts`

- [ ] **Step 1: Refactor `parseClientEntries()`**

First, add `ClientEntrySchema` to the import on line 14 of `src/cli/commands/workspace.ts`:

```typescript
import { ClientTypeSchema, InstallModeSchema, ClientEntrySchema, type ClientEntry, type ClientType, type InstallMode } from '../../models/workspace-config.js';
```

Then replace lines 27-55 with:

```typescript
export function parseClientEntries(input: string): ClientEntry[] {
  const entries: ClientEntry[] = [];

  for (const part of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    const result = ClientEntrySchema.safeParse(part);
    if (!result.success) {
      // Provide user-friendly error messages
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `Invalid client(s): ${part}\n  Valid clients: ${ClientTypeSchema.options.join(', ')}`,
        );
      }
      const name = part.slice(0, colonIdx);
      const mode = part.slice(colonIdx + 1);
      if (!ClientTypeSchema.options.includes(name as any)) {
        throw new Error(
          `Invalid client(s): ${name}\n  Valid clients: ${ClientTypeSchema.options.join(', ')}`,
        );
      }
      throw new Error(
        `Invalid install mode '${mode}' for client '${name}'. Valid modes: ${InstallModeSchema.options.join(', ')}`,
      );
    }
    entries.push(result.data);
  }

  return entries;
}
```

Note: We keep the manual error messages to preserve the existing CLI error format. The schema does the parsing; we handle error formatting.

- [ ] **Step 2: Run existing `parseClientEntries` tests**

Run: `bun test tests/unit/cli/parse-client-entries.test.ts`
Expected: All tests PASS (same behavior, same error messages)

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/workspace.ts
git commit -m "refactor: parseClientEntries delegates to ClientEntrySchema"
```

---

### Task 4: Update example and docs

**Files:**
- Modify: `examples/workspaces/native-install/.allagents/workspace.yaml`

- [ ] **Step 1: Update the example workspace.yaml**

Replace lines 21-24 of `examples/workspaces/native-install/.allagents/workspace.yaml`:

```yaml
clients:
  - copilot
  - claude:native
```

- [ ] **Step 2: Update the comment header to mention shorthand**

Replace lines 1-14:

```yaml
# Example: Native plugin installation with install mode
#
# This workspace demonstrates using `client:mode` shorthand on client entries
# to install plugins via the client's native CLI instead of copying files.
#
# How it works:
# - `claude:native` uses `claude plugin marketplace add` and
#   `claude plugin install` to install marketplace plugins natively.
# - Non-marketplace plugins (local paths, GitHub URLs) automatically fall
#   back to file-based copy even for native clients.
# - Copilot uses standard file-based sync (the default).
#
# Usage:
#   allagents workspace sync
```

- [ ] **Step 3: Commit**

```bash
git add examples/workspaces/native-install/.allagents/workspace.yaml
git commit -m "docs: update native-install example to use client:mode shorthand"
```

---

### Task 5: Full integration test with shorthand in workspace.yaml

**Files:**
- Modify: `tests/unit/core/sync-install-mode.test.ts`

- [ ] **Step 1: Write integration test using colon shorthand in YAML config**

Add to `tests/unit/core/sync-install-mode.test.ts`:

```typescript
  it('colon shorthand claude:native skips file copy for marketplace plugin', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - copilot\n  - claude:native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Local plugin falls back to file copy even for native clients
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/unit/core/sync-install-mode.test.ts`
Expected: All tests PASS (the shorthand is parsed by the schema before reaching sync)

- [ ] **Step 3: Run full test suite one final time**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/unit/core/sync-install-mode.test.ts
git commit -m "test: add integration test for client:mode shorthand in workspace.yaml"
```
