# Fix Marketplace TUI Screen - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure the TUI "Browse marketplace" screen to show installed marketplaces first (not plugins), then let users drill into a marketplace to manage plugins or delete the marketplace, and provide a way to add new marketplaces.

**Architecture:** Replace the current `runInstallPlugin` flow (which immediately lists all plugins from all marketplaces) with a two-level navigation: Level 1 shows registered marketplaces with an "Add marketplace" option; Level 2 shows actions for a selected marketplace (browse plugins, update, remove). The existing `runInstallPlugin` function is renamed/refactored and a new `runBrowseMarketplaces` function becomes the entry point for the `marketplace` menu action. The `install` menu action continues to use the existing direct plugin install flow.

**Tech Stack:** TypeScript, @clack/prompts (TUI library), bun test (`bun:test` imports, run via `bun test`)

---

### Task 1: Add `runBrowseMarketplaces` function - marketplace list screen

**Files:**
- Modify: `src/cli/tui/actions/plugins.ts` (add new function)

**Step 1: Write the failing test**

Create test file `src/cli/tui/__tests__/marketplace-actions.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
// We'll test the exported function signatures and behavior
// Since @clack/prompts is interactive, we test the helper logic
```

> Note: The TUI actions are highly interactive (prompts, spinners). The existing codebase has no tests for `runInstallPlugin` or `runManagePlugins` - only for `buildMenuOptions`. We'll follow the same pattern and test the pure logic parts.

**Step 2: Implement `runBrowseMarketplaces`**

Add a new exported function `runBrowseMarketplaces` in `src/cli/tui/actions/plugins.ts` that:

1. Calls `listMarketplaces()` to get registered marketplaces
2. Builds a selection list with:
   - Each marketplace as an option: `{label: "marketplace-name (source-type: location)", value: marketplace.name}`
   - An "Add new marketplace" option at the top: `{label: "+ Add marketplace", value: "__add__"}`
3. If user selects "Add marketplace":
   - Prompts for source (same flow as current empty-marketplace prompt in `runInstallPlugin`)
   - Calls `addMarketplace(source)` with spinner
   - Loops back to marketplace list
4. If user selects a marketplace:
   - Calls `runMarketplaceDetail(marketplace, context)` (Task 2)

**Imports to add:**
```typescript
import {
  listMarketplaces,
  listMarketplacePlugins,
  addMarketplace,
  removeMarketplace,
  updateMarketplace,
} from '../../../core/marketplace.js';
```

**Step 3: Commit**

```bash
git add src/cli/tui/actions/plugins.ts
git commit -m "feat(tui): add marketplace list screen with add option"
```

---

### Task 2: Add `runMarketplaceDetail` function - marketplace detail screen

**Files:**
- Modify: `src/cli/tui/actions/plugins.ts`

**Step 1: Implement `runMarketplaceDetail`**

Add a new function (not exported, internal helper) that shows actions for a selected marketplace:

```typescript
async function runMarketplaceDetail(
  marketplaceName: string,
  context: TuiContext,
): Promise<void>
```

Actions presented via `p.select()`:
- "Browse plugins" → calls the existing plugin-install flow scoped to this marketplace
- "Update marketplace" → calls `updateMarketplace(name)` with spinner
- "Remove marketplace" → confirms with `p.confirm()`, then calls `removeMarketplace(name)`
- "Back" → returns to marketplace list

**Browse plugins sub-flow:**
1. Call `listMarketplacePlugins(marketplaceName)`
2. If no plugins, show note and return
3. Present plugin selection via `p.select()`
4. Determine scope (project/user)
5. Install plugin and auto-sync (reuse existing install logic)

**Step 2: Commit**

```bash
git add src/cli/tui/actions/plugins.ts
git commit -m "feat(tui): add marketplace detail screen with browse/update/remove"
```

---

### Task 3: Wire up `runBrowseMarketplaces` in the wizard

**Files:**
- Modify: `src/cli/tui/wizard.ts`
- Modify: `src/cli/tui/actions/plugins.ts` (update exports)

**Step 1: Update imports in wizard.ts**

```typescript
import { runInstallPlugin, runManagePlugins, runBrowseMarketplaces } from './actions/plugins.js';
```

**Step 2: Update the switch statement**

Change the `marketplace` case from:
```typescript
case 'marketplace':
  // Browse marketplace is the same flow as install — user picks from marketplace plugins
  await runInstallPlugin(context);
  break;
```

To:
```typescript
case 'marketplace':
  await runBrowseMarketplaces(context);
  break;
```

**Step 3: Run existing tests to verify no regressions**

Run: `bun test src/cli/tui/__tests__/wizard.test.ts`
Expected: Tests still pass (they only test `buildMenuOptions`, not the action dispatch)

**Step 4: Commit**

```bash
git add src/cli/tui/wizard.ts src/cli/tui/actions/plugins.ts
git commit -m "feat(tui): wire marketplace screen to wizard"
```

---

### Task 4: Update menu labels for clarity

**Files:**
- Modify: `src/cli/tui/wizard.ts`

**Step 1: Differentiate "Browse marketplace" from "Install plugin"**

The issue mentions the confusion between these two options. Update `buildMenuOptions`:

- Rename "Browse marketplace" → "Manage marketplaces" (since it now shows marketplace list with add/remove/browse)
- Keep "Install plugin" as-is (direct plugin install flow)

In all three menu states, change the marketplace label:
```typescript
{ label: 'Manage marketplaces', value: 'marketplace' }
```

**Step 2: Update wizard tests**

The existing wizard tests check for action values (not labels), so they should still pass. But verify.

Run: `bun test src/cli/tui/__tests__/wizard.test.ts`

**Step 3: Commit**

```bash
git add src/cli/tui/wizard.ts
git commit -m "fix(tui): rename Browse marketplace to Manage marketplaces"
```

---

### Task 5: Update `runInstallPlugin` to handle empty marketplaces gracefully

**Files:**
- Modify: `src/cli/tui/actions/plugins.ts`

**Step 1: Simplify the empty-marketplace flow in `runInstallPlugin`**

Since marketplace management is now handled by `runBrowseMarketplaces`, the `runInstallPlugin` function no longer needs the "add marketplace" prompt when no marketplaces exist. Instead:

- If no marketplaces registered, show a note directing the user to "Manage marketplaces" first
- Return early

```typescript
if (marketplaces.length === 0) {
  p.note(
    'No marketplaces registered.\nUse "Manage marketplaces" to add one first.',
    'Marketplace',
  );
  return;
}
```

**Step 2: Commit**

```bash
git add src/cli/tui/actions/plugins.ts
git commit -m "fix(tui): simplify install plugin when no marketplaces exist"
```

---

### Task 6: End-to-end review and polish

**Files:**
- All modified files

**Step 1: Review the complete flow**

Walk through each user scenario:
1. User selects "Manage marketplaces" → sees list of installed marketplaces + "Add" option
2. User adds a new marketplace → prompted for source, marketplace added, list refreshes
3. User clicks into a marketplace → sees Browse plugins / Update / Remove / Back
4. User browses plugins → sees plugin list, selects one, installs it
5. User removes a marketplace → confirmation prompt, marketplace removed, returns to list
6. User selects "Install plugin" → sees all plugins from all marketplaces (existing flow)

**Step 2: Verify the marketplace detail screen shows useful info**

Each marketplace option in the list should show:
- Name
- Source type and location (e.g., "github: owner/repo" or "local: /path")
- Last updated date if available

**Step 3: Commit any polish**

```bash
git add -A
git commit -m "fix(tui): polish marketplace screen labels and display"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/cli/tui/actions/plugins.ts` | Add `runBrowseMarketplaces`, `runMarketplaceDetail`; simplify `runInstallPlugin` empty-marketplace flow |
| `src/cli/tui/wizard.ts` | Wire `marketplace` action to `runBrowseMarketplaces`; rename label to "Manage marketplaces" |

## Key Design Decisions

1. **Two-level navigation**: Marketplace list → Marketplace detail (browse/update/remove). This matches the Claude marketplace UX shown in the issue screenshots.
2. **Separate "Install plugin" and "Manage marketplaces"**: Install plugin keeps the current flat list of all plugins. Manage marketplaces is the new hierarchical view.
3. **Reuse existing core functions**: `addMarketplace`, `removeMarketplace`, `updateMarketplace`, `listMarketplacePlugins` already exist in `src/core/marketplace.ts`. No core changes needed.
4. **Loop pattern**: Both the marketplace list and detail screens loop back after actions (like the existing wizard loop), only exiting on "Back" or cancel.
