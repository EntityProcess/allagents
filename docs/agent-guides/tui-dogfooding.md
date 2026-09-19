# TUI Dogfooding

Use this guide for any change to interactive CLI navigation, prompts, labels, status messages, or failure recovery.

## Goal

Prove that the built TUI is understandable to a first-time user, not only that its underlying mutation succeeds.

## Setup

1. Build the CLI.
2. Create isolated temporary project and HOME directories.
3. Seed the smallest realistic configuration that exposes every changed state.
4. Launch the built CLI with `agent-tui`.
5. Capture each changed decision screen before interacting with it.

Never dogfood against a real user workspace when an isolated fixture can exercise the behavior.

## Confusion pass

For every changed screen, state:

- the object the user is currently managing;
- the single decision the screen asks them to make;
- where Back and Ctrl+C will land;
- whether the selected scope or destination remains visible and intact.

Apply one screen, one decision:

- A resource list contains resources plus Add and Back.
- A resource detail contains actions for that resource plus Back.
- Scope or destination changes happen by returning to the chooser.
- Maintenance mechanics stay automatic. Show a retry only when automatic recovery fails.

If a menu mixes resource selection, navigation, and maintenance operations, simplify it before continuing.

## Language pass

Use the established public term for each operation in labels, progress messages, results, errors, and documentation. Internal implementation terms do not belong in user-facing copy. For example, use **Update** rather than sync or reconcile.

Read the complete screen, not only the changed label. Adjacent hints, summaries, and success or error messages must use the same vocabulary.

## Interaction pass

Exercise every changed path that applies:

1. Enter the flow from the main menu.
2. Move forward through each chooser and detail screen.
3. Use Back from every changed level.
4. Use Ctrl+C from every changed level.
5. Complete a successful mutation and verify both the next screen and filesystem result.
6. Trigger a realistic failure and verify the error leaves a clear recovery path.
7. Exercise retry, repeated retry failure, explicit cancellation, and eventual success when retry behavior changed.

A transition passes only when it lands on the screen a user would predict without losing or silently changing scope.

## Durable coverage

Keep regression tests for navigation state, scope preservation, cancellation, mutation boundaries, and failure recovery. Test exact copy only when the wording is a deliberate product contract; use the manual confusion pass for general prose quality.

## Completion evidence

Record in the PR description:

- the exact built command;
- temporary workspace and HOME setup;
- selections and transitions exercised;
- screenshots or the text of each observed decision screen;
- resulting configuration or filesystem state;
- failure and retry behavior checked;
- cleanup performed.

Dogfooding is complete only when the full changed journey passes the confusion, language, interaction, and filesystem checks.
