import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_REQUEST_BYTES,
  type StoredReview,
  buildBusinessPrimer,
  buildGitHubLineLink,
  createReviewServer,
  prepareReview,
  readBoundedRequestBody,
  renderReviewPage,
} from '../../../plugins/engineering/skills/pr-interactive-review/scripts/review-site.ts';

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'allagents-pr-review-'));
  temporaryPaths.push(path);
  return path;
}

async function fixture(withScenario = true) {
  const root = await temporaryDirectory();
  const repository = join(root, 'repository');
  const state = join(root, 'state');
  await mkdir(repository);
  const init = Bun.spawnSync(['git', '-C', repository, 'init', '--quiet']);
  expect(init.exitCode).toBe(0);
  const remote = Bun.spawnSync([
    'git',
    '-C',
    repository,
    'remote',
    'add',
    'origin',
    'https://github.com/example-org/sample-service.git',
  ]);
  expect(remote.exitCode).toBe(0);
  await writeFile(
    join(repository, 'requirements.md'),
    'Who configures: Operations managers\nOperational problem: Manual approvals delay routine changes\nIntended outcome: Operators complete changes in one workflow\nWhy it matters: Delays postpone service changes\nSuccess criteria: A change completes and records its result\nScope: Change configuration\nNon-goals: Redesigning access roles\n',
  );
  const artifact = join(root, 'review.json');
  await writeFile(
    artifact,
    JSON.stringify({
      status: 'complete',
      verdict: 'Ready with fixes',
      title: 'Example change',
      intent: 'Review a configuration workflow.',
      scope: { head_sha: '0123456789abcdef0123456789abcdef01234567' },
      findings: [
        {
          '#': 1,
          title: 'Escape untrusted label',
          severity: 'P1',
          file: 'src/config.ts',
          line: 18,
          end_line: 20,
          confidence: 90,
          owner: 'downstream-resolver',
          suggested_fix: 'Escape the label before rendering it.',
          first_evidence: 'The value enters the template without encoding.',
          evidence: ['The changed template uses the raw value.'],
          reviewers: ['security', 'correctness'],
        },
      ],
    }),
  );
  const scenarios = join(root, 'interactive-scenarios.json');
  if (withScenario) {
    await writeFile(
      scenarios,
      JSON.stringify({
        '#1': {
          what_actually_happens:
            'When an operator submits a label containing markup, the page renders the markup and the browser executes it.',
          expected_suggested:
            'When an operator submits that label, the page displays the characters as text after encoding the value at the rendering boundary.',
        },
      }),
    );
  }
  const prepared = await prepareReview({
    reviewJsonPath: artifact,
    pr: '123',
    repoPath: repository,
    dataDir: state,
    requirementsPath: 'requirements.md',
    ...(withScenario ? { scenariosPath: scenarios } : {}),
    now: new Date('2026-01-02T03:04:05.000Z'),
  });
  return { ...prepared, artifact, repository, scenarios, state };
}

beforeEach(() => {
  temporaryPaths.length = 0;
});

afterEach(async () => {
  await Promise.all(
    temporaryPaths.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('pr-interactive-review', () => {
  it('renders an evidence-based business primer and labels missing evidence', () => {
    const primer = buildBusinessPrimer(
      'Who configures: Operations managers\nSuccess criteria: A change completes',
      'Review the changed flow.',
    );
    expect(primer.whoConfigures.value).toBe('Operations managers');
    expect(primer.successCriteria.value).toBe('A change completes');
    expect(primer.nonGoals.value).toBeNull();
    expect(primer.nonGoals.evidenceGap).toContain('non-goals');
    expect(primer.operationalProblem.evidenceGap).toContain(
      'Review intent: Review the changed flow.',
    );
  });

  it('pins GitHub links to the reviewed commit and exact line range', () => {
    expect(
      buildGitHubLineLink(
        'example-org/sample-service',
        '0123456789abcdef0123456789abcdef01234567',
        'src/a file.ts',
        18,
        20,
      ),
    ).toBe(
      'https://github.com/example-org/sample-service/blob/0123456789abcdef0123456789abcdef01234567/src/a%20file.ts#L18-L20',
    );
    expect(
      buildGitHubLineLink(
        null,
        '0123456789abcdef0123456789abcdef01234567',
        'src/a.ts',
        1,
        1,
      ),
    ).toBeNull();
    expect(() =>
      buildGitHubLineLink(
        'example-org/sample-service',
        '0123456789abcdef0123456789abcdef01234567',
        '../secrets',
        1,
        1,
      ),
    ).toThrow('relative repository path');
  });

  it('cancels an oversized chunked request body before accepting it', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://127.0.0.1/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
    });
    expect(request.headers.get('content-length')).toBeNull();
    await expect(readBoundedRequestBody(request)).rejects.toThrow(
      `Request body exceeds ${MAX_REQUEST_BYTES} bytes`,
    );
    expect(cancelled).toBe(true);
  });

  it('labels missing concrete scenario evidence instead of inventing a claim', async () => {
    const prepared = await fixture(false);
    const scenario = prepared.review.findings[0]?.scenario;
    expect(scenario?.actualHappens).toBeNull();
    expect(scenario?.expectedSuggested).toBeNull();
    expect(scenario?.actualEvidenceGap).toContain('triggering setup/action');
    expect(scenario?.expectedEvidenceGap).toContain(
      'expected behavior and correction',
    );
  });

  it('merges scenario sidecars by stable finding ID and rejects invalid entries', async () => {
    const prepared = await fixture();
    await writeFile(
      prepared.scenarios,
      JSON.stringify({
        '#99': {
          what_actually_happens: 'A triggering action fails.',
          expected_suggested: 'The action succeeds.',
        },
      }),
    );
    await expect(
      prepareReview({
        reviewJsonPath: prepared.artifact,
        pr: '123',
        repoPath: prepared.repository,
        dataDir: prepared.state,
        scenariosPath: prepared.scenarios,
      }),
    ).rejects.toThrow('unknown finding #99');
    await writeFile(
      prepared.scenarios,
      JSON.stringify({ '#1': { what_actually_happens: 7 } }),
    );
    await expect(
      prepareReview({
        reviewJsonPath: prepared.artifact,
        pr: '123',
        repoPath: prepared.repository,
        dataDir: prepared.state,
        scenariosPath: prepared.scenarios,
      }),
    ).rejects.toThrow('what_actually_happens must be a string');
  });
  it('partitions review workspaces outside the repository and creates atomically readable stores', async () => {
    const prepared = await fixture();
    expect(prepared.workspace).toContain(
      'state/github.com-example-org-sample-service/pr-123',
    );
    expect(prepared.review.primer.scope.value).toBe('Change configuration');
    expect(prepared.review.findings[0]?.sourceLink).toContain(
      '/blob/0123456789abcdef0123456789abcdef01234567/src/config.ts#L18-L20',
    );
    expect(prepared.review.findings[0]?.scenario).toEqual({
      actualHappens:
        'When an operator submits a label containing markup, the page renders the markup and the browser executes it.',
      expectedSuggested:
        'When an operator submits that label, the page displays the characters as text after encoding the value at the rendering boundary.',
      actualEvidenceGap: null,
      expectedEvidenceGap: null,
    });
    expect(
      JSON.parse(
        await readFile(join(prepared.workspace, 'comments.json'), 'utf8'),
      ),
    ).toEqual({ version: 1, comments: [] });
    expect(
      (await readdir(prepared.workspace)).some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  });

  it('escapes untrusted page values and keeps business context before findings', async () => {
    const prepared = await fixture();
    const malicious: StoredReview = {
      ...prepared.review,
      title: '<img src=x onerror=alert(1)>',
    };
    const page = renderReviewPage(malicious);
    expect(page).not.toContain('<img src=x onerror=alert(1)>');
    expect(page.indexOf('id="business-context"')).toBeLessThan(
      page.indexOf('id="findings"'),
    );
    expect(page).not.toContain('Assistant reply');
  });

  it('contains long reviewed lines within finding cards and scrollable code blocks', async () => {
    const prepared = await fixture();
    const longSourceLine = 'x'.repeat(4096);
    const review: StoredReview = {
      ...prepared.review,
      findings: prepared.review.findings.map((finding) => ({
        ...finding,
        excerpts: {
          before: null,
          after: { startLine: 1, endLine: 1, content: longSourceLine },
        },
      })),
    };
    const page = renderReviewPage(review);
    expect(review.findings[0]?.excerpts.after?.content).toHaveLength(4096);
    expect(page).toContain('#findings { display: grid; min-width: 0;');
    expect(page).toContain('.finding { min-width: 0;');
    expect(page).toContain(
      '.finding-top, .finding-top > *, .excerpt-grid, .excerpt-grid > * { min-width: 0; }',
    );
    expect(page).toContain(
      'pre { max-width: 100%; min-width: 0; overflow-x: auto; white-space: pre;',
    );
  });

  it('validates routes, atomically saves comments, and renders assistant replies', async () => {
    const prepared = await fixture();
    const server = createReviewServer(prepared.workspace, '127.0.0.1', 0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const page = await fetch(`${base}/`);
      expect(page.headers.get('content-security-policy')).toContain(
        "default-src 'self'",
      );
      expect(page.status).toBe(200);
      expect((await page.text()).indexOf('Business context')).toBeGreaterThan(
        -1,
      );
      expect(
        (
          await fetch(`${base}/api/comments`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: '{"body":"not JSON content"}',
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await fetch(`${base}/api/comments`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://untrusted.example',
            },
            body: JSON.stringify({ body: 'cross-origin write' }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(`${base}/api/comments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ findingId: '#99', body: 'bad' }),
          })
        ).status,
      ).toBe(400);
      const create = await fetch(`${base}/api/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          findingId: '#1',
          author: 'Reviewer',
          body: '<script>never execute</script>',
        }),
      });
      expect(create.status).toBe(201);
      const created = (await create.json()) as { comment: { id: string } };
      const parallelWrites = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          fetch(`${base}/api/comments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body: `comment ${index}` }),
          }),
        ),
      );
      expect(
        (
          await fetch(`${base}/api/comments/${created.comment.id}/replies`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://untrusted.example',
            },
            body: JSON.stringify({
              role: 'assistant',
              body: 'cross-origin reply',
            }),
          })
        ).status,
      ).toBe(403);
      expect(parallelWrites.every((response) => response.status === 201)).toBe(
        true,
      );
      expect(
        (await fetch(`${base}/api/comments?status=unanswered`)).status,
      ).toBe(200);
      const reply = await fetch(
        `${base}/api/comments/${created.comment.id}/replies`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            role: 'assistant',
            author: 'Assistant',
            body: 'Use the documented escape helper.',
          }),
        },
      );
      expect(reply.status).toBe(201);
      const all = (await (await fetch(`${base}/api/comments`)).json()) as {
        comments: Array<{
          body: string;
          replies: Array<{ role: string; body: string }>;
        }>;
      };
      expect(all.comments).toHaveLength(9);
      expect(all.comments[0]).toEqual(
        expect.objectContaining({
          body: '<script>never execute</script>',
          replies: [
            expect.objectContaining({
              role: 'assistant',
              body: 'Use the documented escape helper.',
            }),
          ],
        }),
      );
      const unanswered = (await (
        await fetch(`${base}/api/comments?status=unanswered`)
      ).json()) as { comments: unknown[] };
      expect(unanswered.comments).toHaveLength(8);
      expect(
        JSON.parse(
          await readFile(join(prepared.workspace, 'comments.json'), 'utf8'),
        ).comments,
      ).toHaveLength(9);
      expect(
        (await readdir(prepared.workspace)).some((name) =>
          name.endsWith('.tmp'),
        ),
      ).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
