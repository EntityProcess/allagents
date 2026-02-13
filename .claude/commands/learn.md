---
description: "Extract a learning from the recent conversation and add it to the appropriate instruction file"
---

# Learn

Extract a learning from the recent conversation and persist it.

## Process

1. **Identify the problem** - Look back through the conversation. Find a mistake, oversight, or suboptimal decision you made. What went wrong?

2. **Identify why it was a problem** - What was the consequence? Did it cause a bug, require rework, miss an edge case, or violate a convention?

3. **Identify the fix** - How did the user correct you, or how was it resolved? What was the right approach?

4. **Generalize** - Can this be stated as a general principle rather than a project-specific fact? Avoid learnings that are too narrow (e.g., "file X is at path Y") — prefer ones that capture reusable judgment (e.g., "when syncing config, only track entries you created").

5. **Draft the learning** - Write 1-4 sentences that capture the principle. Present this to the user and briefly explain your reasoning.

6. **Add it** - Append the learning to the `## Learnings` section of `CLAUDE.md` in the project root. If no `## Learnings` section exists, create one at the end of the file.

## Format

Each learning is a bullet point, 1-4 sentences:

```markdown
## Learnings

* When syncing external config files, only track entries you created. Pre-existing user entries must not be tracked, or uninstalling will delete user data.
* CLI output that appears in multiple code paths should use a shared formatter. Adding output to one path but missing others is a common source of inconsistency.
```

## Rules

- One learning per invocation. Keep it focused.
- If no clear mistake happened in the conversation, say so — don't fabricate learnings.
- Always show the draft to the user before writing it to a file.
