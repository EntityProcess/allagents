---
name: pr-interactive-review
description: Turn a structured GitHub pull request review into a local interactive site for business context, findings, and reviewer comments. Use when a reviewer needs to triage a PR interactively without posting to GitHub.
---

# Interactive Pull Request Review

Use an existing review skill when one is available, and prefer its structured JSON output. This skill consumes structured findings and presents them locally; it does not select reviewer personas, assign severity, discover review scope, validate findings, or deduplicate findings.

## Safety boundaries

- Accept a GitHub PR number or `https://github.com/<owner>/<repo>/pull/<number>` URL.
- Prefer the installed review skill's structured or agent output when it supports one. Do not parse markdown output.
- Store generated review data and comments outside the repository. The default workspace is `$XDG_STATE_HOME/allagents/pr-interactive-review/` (or `~/.local/state/allagents/pr-interactive-review/`).
- Never put tokens, cookies, GitHub authentication, comments, or generated review data in the repository.
- The server binds to `127.0.0.1` by default. Non-loopback binding requires the explicit `--expose` option and emits a warning because findings and comments become network-visible.
- Comments are local only. Do not post them to GitHub. This skill does not implement GitHub posting.

## Obtain a structured review

From the repository that owns the PR, use an existing review skill when one is available. Ask it for structured JSON and pass the PR target directly. If no review skill is installed, use the host's available code-review capability and produce the same structured review artifact without inventing findings.

The review artifact must contain `status`, `verdict`, `intent`, `scope.head_sha`, and the validated `findings` array. Require `status: complete`; stop on `failed`, `degraded`, or `skipped`. Save the artifact outside the repository as `review.json` and consume that JSON directly. Do not scrape, transform, or infer findings from a human markdown report.

### Concrete finding scenarios

After the review completes, actively enrich every finding without modifying `review.json`. For each stable `#`, inspect only its structured `evidence` and `first_evidence` plus the exact cited path at the reviewed commit. Write a separate JSON sidecar beside the review artifact (or in the external review workspace) as `interactive-scenarios.json`, keyed by the stable finding IDs:

```json
{
  "#1": {
    "what_actually_happens": "When an operator saves a label containing markup, the page renders it and the browser executes it.",
    "expected_suggested": "When that label is saved, the page displays the characters as text after encoding at the rendering boundary."
  }
}
```

`what_actually_happens` must state a triggering setup/action and observable failure. `expected_suggested` must state the expected resulting behavior and correction. This sidecar is presentation context only: it must not change review scope, personas, severity, validation, deduplication, or required response. If direct evidence cannot support either statement, omit that field; the site labels the gap instead of inventing a scenario. `prepare` rejects malformed sidecars and IDs that are not review findings.

Specifications may be private when the user authorizes access. Use the appropriate host tool to read or extract an authorized local file, document, or URL. Derive only concise labeled primer fields from that material, then pass the derived text with `--spec`; never put the original source content in this public repository.

```text
Who configures: Release managers
Operational problem: Manual approval queues delay configuration changes
Intended outcome: Operators can complete the change without a queue handoff
Why it matters: Delays postpone customer-visible changes
Success criteria: A configured change completes and records its result
Scope: Configuration flow and audit record
Non-goals: Redesigning permission roles
```

`--requirements` remains a direct file-read option only for a repository-relative path. The helper rejects paths outside the repository and `.git`; use host extraction plus `--spec` for any external specification reference.

## Create a reusable workspace

Resolve this skill directory, then prepare the site from the structured `review.json`.

```bash
SKILL_DIR="<directory containing this SKILL.md>"
bun "$SKILL_DIR/scripts/review-site.ts" prepare \
  --review-json "<artifact_path>/review.json" \
  --scenarios "<artifact_path>/interactive-scenarios.json" \
  --pr 123 \
  --spec "Who configures: Release managers
Operational problem: Manual approval queues delay configuration changes
Intended outcome: Operators complete changes without a queue handoff
Why it matters: Delays postpone customer-visible changes
Success criteria: A configured change completes and records its result
Scope: Configuration flow and audit record
Non-goals: Redesigning permission roles"
```

For a repository-relative requirements reference, use:

```bash
bun "$SKILL_DIR/scripts/review-site.ts" prepare \
  --review-json "<artifact_path>/review.json" \
  --scenarios "<artifact_path>/interactive-scenarios.json" \
  --pr https://github.com/example-org/sample-service/pull/123 \
  --requirements docs/requirements.md
```

`prepare` prints the per-repository, per-PR workspace path. It validates the review artifact, scenario sidecar, PR identifier, finding file paths, sizes, and requirements reference. It generates GitHub source links only when the runtime `origin` remote is GitHub. Links pin the reviewed commit and exact cited line range. Non-GitHub remotes receive no external link.

For focused code context, `prepare` reads only the cited relative paths at the reviewed commit. Pass `--base-commit <sha>` only when the review already supplied a verified exact base SHA; the helper does not rediscover PR scope. When no base or reviewed object is locally readable, the site labels that gap instead of substituting current-worktree content.

## Host the site

```bash
bun "$SKILL_DIR/scripts/review-site.ts" serve --workspace "<printed workspace>"
```

Open the printed loopback URL. The page places **Business context** before findings, includes severity navigation and search, exact reviewed-commit links, required response, reviewers, confidence, structured evidence, available focused excerpts, and comments.

LAN or public exposure is opt-in and must be deliberate:

```bash
bun "$SKILL_DIR/scripts/review-site.ts" serve \
  --workspace "<printed workspace>" \
  --host 0.0.0.0 \
  --expose
```

The warning is part of the command contract. Do not expose a review site that contains material the intended network audience may not read.

## Comment handoff loop

Reviewers can save general comments or comments attached to a finding. The browser sends only validated, bounded JSON to the local server. Comments are atomically written to `comments.json` in the external workspace; comment bodies are not logged.

To respond as the assistant, first inspect only unanswered local comments:

```bash
curl -sS "http://127.0.0.1:<port>/api/comments?status=unanswered"
```

Use the returned comment `id`, formulate an evidence-based response from the review artifact and reviewed code, then save it locally:

```bash
curl -sS -X POST "http://127.0.0.1:<port>/api/comments/<comment-id>/replies" \
  -H 'content-type: application/json' \
  --data '{"role":"assistant","author":"Assistant","body":"Verified response with the required next action."}'
```

The page renders replies with an Assistant label. Refresh unanswered comments until the queue is empty. Never treat this local operation as authority to post a GitHub comment; GitHub posting requires a separate explicit, user-confirmed feature.

## Completion
1. Confirm the review artifact was consumed as JSON, not markdown.
2. Browser-check the local site: business context comes first; every finding shows `What actually happens` and `Expected / suggested` (or an explicit evidence gap); severity filters and search work; the responsive layout works; a local comment and assistant reply render; a GitHub remote produces a reviewed-commit line link.
3. State the workspace path and loopback URL. Do not include comment text, credentials, or source contents in the report.
