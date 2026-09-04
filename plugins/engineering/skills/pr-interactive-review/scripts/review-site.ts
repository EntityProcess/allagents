import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_REQUIREMENTS_BYTES = 128 * 1024;
const MAX_COMMENT_LENGTH = 12 * 1024;
const MAX_EXCERPT_LINES = 120;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);

type JsonObject = Record<string, unknown>;

export interface ReviewFinding {
  id: string;
  title: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  file: string;
  line: number;
  endLine: number;
  confidence: number | string;
  requiredResponse: string;
  reviewers: string[];
  evidence: string[];
  firstEvidence: string | null;
  sourceLink: string | null;
  scenario: FindingScenario;
  excerpts: {
    before: CodeExcerpt | null;
    after: CodeExcerpt | null;
  };
}

export interface FindingScenario {
  actualHappens: string | null;
  expectedSuggested: string | null;
  actualEvidenceGap: string | null;
  expectedEvidenceGap: string | null;
}

export interface CodeExcerpt {
  startLine: number;
  endLine: number;
  content: string;
}

export interface BusinessPrimer {
  whoConfigures: PrimerField;
  operationalProblem: PrimerField;
  intendedOutcome: PrimerField;
  businessImportance: PrimerField;
  successCriteria: PrimerField;
  scope: PrimerField;
  nonGoals: PrimerField;
  providedRequirements: string | null;
}

export interface PrimerField {
  value: string | null;
  evidenceGap: string | null;
}

export interface StoredReview {
  version: 1;
  repository: string;
  githubRepository: string | null;
  prNumber: number;
  reviewedCommit: string;
  title: string;
  verdict: string;
  intent: string;
  primer: BusinessPrimer;
  findings: ReviewFinding[];
  generatedAt: string;
}

export interface CommentReply {
  id: string;
  author: string;
  role: 'assistant';
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  findingId: string | null;
  author: string;
  role: 'reviewer';
  body: string;
  createdAt: string;
  replies: CommentReply[];
}

interface CommentStore {
  version: 1;
  comments: ReviewComment[];
}

interface ReviewInput {
  status: string;
  verdict: string;
  intent: string;
  scope: { head_sha: string };
  findings: unknown[];
  title?: string;
}

export interface PrepareOptions {
  reviewJsonPath: string;
  pr: string;
  repoPath?: string;
  dataDir?: string;
  scenariosPath?: string;
  specification?: string;
  requirementsPath?: string;
  baseCommit?: string;
  now?: Date;
}

export interface PreparedReview {
  workspace: string;
  review: StoredReview;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
  required = true,
): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (value.includes('\0'))
    throw new Error(`${field} must not contain null characters`);
  const normalized = value.trim();
  if (required && normalized.length === 0)
    throw new Error(`${field} must not be empty`);
  if (normalized.length > maxLength)
    throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function stringArray(value: unknown, field: string, maxEntries = 32): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxEntries)
    throw new Error(
      `${field} must be an array of at most ${maxEntries} strings`,
    );
  return value.map(
    (item, index) => boundedString(item, `${field}[${index}]`, 2000) as string,
  );
}

function safeRelativePath(value: unknown, field: string): string {
  const path = boundedString(value, field, 1000) as string;
  if (
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${field} must be a relative repository path`);
  }
  return path.replace(/\\/g, '/');
}

function findingId(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new Error('finding.# is required');
  const number = Number(String(value).replace(/^#/, ''));
  if (!Number.isInteger(number) || number < 1 || number > 1000000)
    throw new Error('finding.# must be a positive integer');
  return `#${number}`;
}

function lineNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10000000)
    throw new Error(`${field} must be a valid line number`);
  return number;
}

function readReviewInput(value: unknown): ReviewInput {
  if (!isRecord(value))
    throw new Error('Structured review artifact must be an object');
  const status = boundedString(value.status, 'status', 32) as string;
  if (status !== 'complete')
    throw new Error('Structured review artifact must have complete status');
  if (!isRecord(value.scope)) throw new Error('scope is required');
  const headSha = boundedString(
    value.scope.head_sha,
    'scope.head_sha',
    64,
  ) as string;
  if (!/^[0-9a-f]{7,64}$/i.test(headSha))
    throw new Error('scope.head_sha must be a commit SHA');
  if (!Array.isArray(value.findings))
    throw new Error('findings must be an array');
  return {
    status,
    verdict: boundedString(value.verdict, 'verdict', 200) as string,
    intent: boundedString(value.intent, 'intent', 8000) as string,
    scope: { head_sha: headSha.toLowerCase() },
    findings: value.findings,
    ...(typeof value.title === 'string'
      ? { title: boundedString(value.title, 'title', 500) as string }
      : {}),
  };
}

function missingScenario(): FindingScenario {
  return {
    actualHappens: null,
    expectedSuggested: null,
    actualEvidenceGap:
      'Evidence gap: the scenario sidecar does not provide a specific triggering setup/action and observable failure.',
    expectedEvidenceGap:
      'Evidence gap: the scenario sidecar does not provide a specific expected behavior and correction.',
  };
}

function normalizeScenario(value: unknown, field: string): FindingScenario {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const actualHappens = boundedString(
    value.what_actually_happens,
    `${field}.what_actually_happens`,
    8000,
    false,
  );
  const expectedSuggested = boundedString(
    value.expected_suggested,
    `${field}.expected_suggested`,
    8000,
    false,
  );
  const missing = missingScenario();
  return {
    actualHappens,
    expectedSuggested,
    actualEvidenceGap: actualHappens ? null : missing.actualEvidenceGap,
    expectedEvidenceGap: expectedSuggested ? null : missing.expectedEvidenceGap,
  };
}

function normalizeFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) throw new Error('finding must be an object');
  const line = lineNumber(value.line, 'finding.line');
  const endLine =
    value.end_line === undefined
      ? line
      : lineNumber(value.end_line, 'finding.end_line');
  if (endLine < line)
    throw new Error('finding.end_line must not precede finding.line');
  const severity = boundedString(
    value.severity,
    'finding.severity',
    2,
  ) as ReviewFinding['severity'];
  if (!SEVERITIES.has(severity))
    throw new Error('finding.severity must be P0, P1, P2, or P3');
  const owner = boundedString(value.owner, 'finding.owner', 120, false);
  const suggestedFix = boundedString(
    value.suggested_fix,
    'finding.suggested_fix',
    8000,
    false,
  );
  const whyItMatters = boundedString(
    value.why_it_matters,
    'finding.why_it_matters',
    8000,
    false,
  );
  const autofixClass = boundedString(
    value.autofix_class,
    'finding.autofix_class',
    120,
    false,
  );
  const requiredResponse =
    suggestedFix ??
    whyItMatters ??
    owner ??
    autofixClass ??
    'Review the evidence and choose the next action.';
  const confidence = value.confidence;
  if (
    typeof confidence !== 'string' &&
    (typeof confidence !== 'number' || !Number.isFinite(confidence))
  ) {
    throw new Error('finding.confidence must be a string or number');
  }
  return {
    id: findingId(value['#']),
    title: boundedString(value.title, 'finding.title', 1000) as string,
    severity,
    file: safeRelativePath(value.file, 'finding.file'),
    line,
    endLine,
    confidence,
    requiredResponse,
    reviewers: stringArray(value.reviewers, 'finding.reviewers'),
    evidence: stringArray(value.evidence, 'finding.evidence', 64),
    firstEvidence: boundedString(
      value.first_evidence,
      'finding.first_evidence',
      8000,
      false,
    ),
    sourceLink: null,
    excerpts: { before: null, after: null },
    scenario: missingScenario(),
  };
}

export function parsePrTarget(value: string): {
  number: number;
  urlRepository: string | null;
} {
  const input = value.trim();
  if (/^\d+$/.test(input)) {
    const number = Number(input);
    if (Number.isSafeInteger(number) && number > 0)
      return { number, urlRepository: null };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(
      'pr must be a positive number or a https://github.com/owner/repo/pull/number URL',
    );
  }
  const match =
    url.hostname === 'github.com'
      ? /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname)
      : null;
  const number = Number(match?.[3]);
  if (!match?.[1] || !match[2] || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(
      'pr must be a positive number or a https://github.com/owner/repo/pull/number URL',
    );
  }
  return { number, urlRepository: `${match[1]}/${match[2]}` };
}

export function githubRepositoryFromRemote(
  remote: string | null,
): string | null {
  if (!remote) return null;
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

export function buildGitHubLineLink(
  repository: string | null,
  commit: string,
  file: string,
  startLine: number,
  endLine: number,
): string | null {
  if (!repository || !/^[0-9a-f]{7,64}$/i.test(commit)) return null;
  const normalizedPath = safeRelativePath(file, 'finding.file');
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return null;
  const escapedPath = normalizedPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `https://github.com/${repository}/blob/${commit}/${escapedPath}#L${startLine}-L${endLine}`;
}

function parsePrimerField(text: string, labels: string[]): string | null {
  const expression = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:\\s*([^\\n]+)`,
    'i',
  );
  const result = expression.exec(text);
  return result?.[1]?.trim() || null;
}

function primerValue(value: string | null, missing: string): PrimerField {
  return value
    ? { value, evidenceGap: null }
    : { value: null, evidenceGap: missing };
}

export function buildBusinessPrimer(
  specification: string | null,
  intent: string,
): BusinessPrimer {
  const text = specification?.trim() ?? '';
  const operationalGap = `The supplied requirements do not state the operational problem. Review intent: ${intent}`;
  return {
    whoConfigures: primerValue(
      parsePrimerField(text, ['who configures', 'configured by', 'operator']),
      'The supplied requirements do not identify who configures this feature.',
    ),
    operationalProblem: primerValue(
      parsePrimerField(text, ['operational problem', 'problem']),
      operationalGap,
    ),
    intendedOutcome: primerValue(
      parsePrimerField(text, ['intended outcome', 'before/after', 'outcome']),
      'The supplied requirements do not define the intended before-and-after outcome.',
    ),
    businessImportance: primerValue(
      parsePrimerField(text, [
        'why it matters',
        'business importance',
        'business value',
      ]),
      'The supplied requirements do not state why this outcome matters to the business.',
    ),
    successCriteria: primerValue(
      parsePrimerField(text, ['success criteria', 'acceptance criteria']),
      'The supplied requirements do not define measurable success criteria.',
    ),
    scope: primerValue(
      parsePrimerField(text, ['scope', 'in scope']),
      'The supplied requirements do not define the intended scope.',
    ),
    nonGoals: primerValue(
      parsePrimerField(text, ['non-goals', 'non goals', 'out of scope']),
      'The supplied requirements do not define non-goals.',
    ),
    providedRequirements: text || null,
  };
}

function stateRoot(dataDir?: string): string {
  if (dataDir) return resolve(dataDir);
  const root = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(root, 'allagents', 'pr-interactive-review');
}

function repositoryStorageKey(
  remote: string | null,
  githubRepository: string | null,
): string {
  if (githubRepository)
    return `github.com-${githubRepository.replace('/', '-')}`.toLowerCase();
  const digest = createHash('sha256')
    .update(remote ?? 'no-origin-remote')
    .digest('hex')
    .slice(0, 16);
  return `non-github-${digest}`;
}

function workspaceFor(
  dataDir: string,
  repositoryKey: string,
  prNumber: number,
): string {
  if (
    !/^[a-z0-9.-]+$/i.test(repositoryKey) ||
    !Number.isInteger(prNumber) ||
    prNumber < 1
  )
    throw new Error('Invalid workspace identifier');
  return join(dataDir, repositoryKey, `pr-${prNumber}`);
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > maximumBytes)
      throw new Error(`${basename(path)} exceeds ${maximumBytes} bytes`);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

function requirementsFilePath(repoPath: string, value: string): string {
  if (isAbsolute(value))
    throw new Error(
      'requirements must be a repository-relative public-safe reference',
    );
  const resolved = resolve(repoPath, value);
  const fromRepo = relative(repoPath, resolved);
  if (
    fromRepo === '' ||
    fromRepo.startsWith(`..${sep}`) ||
    fromRepo === '..' ||
    isAbsolute(fromRepo) ||
    fromRepo.split(sep).includes('.git')
  ) {
    throw new Error(
      'requirements must stay inside the repository and outside .git',
    );
  }
  return resolved;
}

function runGit(repoPath: string, args: string[]): string | null {
  const result = Bun.spawnSync(['git', '-C', repoPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

function codeExcerpt(
  repoPath: string,
  commit: string,
  file: string,
  line: number,
): CodeExcerpt | null {
  const source = runGit(repoPath, ['show', `${commit}:${file}`]);
  if (source === null) return null;
  const lines = source.split('\n');
  const startLine = Math.max(1, line - 3);
  const endLine = Math.min(lines.length, startLine + MAX_EXCERPT_LINES - 1);
  return {
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join('\n'),
  };
}

function validBaseCommit(value: string | undefined): string | null {
  return value && /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : null;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readScenarioSidecar(
  path: string,
  findingIds: Set<string>,
): Promise<Map<string, FindingScenario>> {
  const value = JSON.parse(
    await readBoundedFile(resolve(path), MAX_REQUIREMENTS_BYTES),
  ) as unknown;
  if (!isRecord(value) || Array.isArray(value))
    throw new Error(
      'Scenario sidecar must be an object keyed by stable finding ID',
    );
  const entries = Object.entries(value);
  if (entries.length > 1000)
    throw new Error('Scenario sidecar exceeds 1000 findings');
  const scenarios = new Map<string, FindingScenario>();
  for (const [id, scenario] of entries) {
    if (!/^#[1-9]\d*$/.test(id))
      throw new Error(
        'Scenario sidecar keys must be stable finding IDs such as #1',
      );
    if (!findingIds.has(id))
      throw new Error(`Scenario sidecar references unknown finding ${id}`);
    scenarios.set(id, normalizeScenario(scenario, `scenario ${id}`));
  }
  return scenarios;
}

export async function prepareReview(
  options: PrepareOptions,
): Promise<PreparedReview> {
  const target = parsePrTarget(options.pr);
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const remote = runGit(repoPath, ['config', '--get', 'remote.origin.url']);
  const githubRepository = githubRepositoryFromRemote(remote);
  if (
    target.urlRepository &&
    githubRepository &&
    target.urlRepository.toLowerCase() !== githubRepository.toLowerCase()
  ) {
    throw new Error(
      'PR URL repository does not match the runtime origin remote',
    );
  }
  const rawArtifact = JSON.parse(
    await readBoundedFile(
      resolve(options.reviewJsonPath),
      MAX_REQUIREMENTS_BYTES,
    ),
  ) as unknown;
  const artifact = readReviewInput(rawArtifact);
  const requirementText = options.requirementsPath
    ? await readBoundedFile(
        requirementsFilePath(repoPath, options.requirementsPath),
        MAX_REQUIREMENTS_BYTES,
      )
    : null;
  const specification = options.specification ?? requirementText;
  if (
    specification &&
    Buffer.byteLength(specification, 'utf8') > MAX_REQUIREMENTS_BYTES
  ) {
    throw new Error(`specification exceeds ${MAX_REQUIREMENTS_BYTES} bytes`);
  }
  const baseCommit = validBaseCommit(options.baseCommit);
  const rawFindings = artifact.findings.map(normalizeFinding);
  const scenarios = options.scenariosPath
    ? await readScenarioSidecar(
        options.scenariosPath,
        new Set(rawFindings.map((finding) => finding.id)),
      )
    : new Map<string, FindingScenario>();
  const findings = rawFindings.map((finding) => ({
    ...finding,
    scenario: scenarios.get(finding.id) ?? finding.scenario,
    sourceLink: buildGitHubLineLink(
      githubRepository,
      artifact.scope.head_sha,
      finding.file,
      finding.line,
      finding.endLine,
    ),
    excerpts: {
      before: baseCommit
        ? codeExcerpt(repoPath, baseCommit, finding.file, finding.line)
        : null,
      after: codeExcerpt(
        repoPath,
        artifact.scope.head_sha,
        finding.file,
        finding.line,
      ),
    },
  }));
  const workspace = workspaceFor(
    stateRoot(options.dataDir),
    repositoryStorageKey(remote, githubRepository),
    target.number,
  );
  const review: StoredReview = {
    version: 1,
    repository: githubRepository ?? repositoryStorageKey(remote, null),
    githubRepository,
    prNumber: target.number,
    reviewedCommit: artifact.scope.head_sha,
    title: artifact.title ?? `Pull request #${target.number}`,
    verdict: artifact.verdict,
    intent: artifact.intent,
    primer: buildBusinessPrimer(specification, artifact.intent),
    findings,
    generatedAt: (options.now ?? new Date()).toISOString(),
  };
  await writeJsonAtomically(join(workspace, 'review.json'), review);
  const commentsPath = join(workspace, 'comments.json');
  try {
    await readFile(commentsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeJsonAtomically(commentsPath, {
      version: 1,
      comments: [],
    } satisfies CommentStore);
  }
  return { workspace, review };
}

export async function loadStoredReview(
  workspace: string,
): Promise<StoredReview> {
  return JSON.parse(
    await readBoundedFile(
      join(resolve(workspace), 'review.json'),
      MAX_REQUIREMENTS_BYTES,
    ),
  ) as StoredReview;
}

async function readCommentStore(workspace: string): Promise<CommentStore> {
  try {
    const data = JSON.parse(
      await readBoundedFile(
        join(workspace, 'comments.json'),
        MAX_REQUIREMENTS_BYTES,
      ),
    ) as unknown;
    if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.comments))
      throw new Error('Invalid comments store');
    return data as unknown as CommentStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, comments: [] };
    throw error;
  }
}

async function withLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        return await operation();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await Bun.sleep(10);
    }
  }
  throw new Error('Comment store is busy; retry the request');
}

function commentBody(value: unknown): string {
  return boundedString(value, 'body', MAX_COMMENT_LENGTH) as string;
}

function commentAuthor(value: unknown): string {
  const author = boundedString(value, 'author', 120, false);
  return author ? author.replace(/[\r\n]/g, ' ') : 'Reviewer';
}

export async function readBoundedRequestBody(
  request: Request,
): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request is already being terminated; preserve the size error.
        }
        throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseJsonRequest(text: string): JsonObject {
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES)
    throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) throw new Error('Request body must be an object');
    return value;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Request body must be an object'
    )
      throw error;
    throw new Error('Request body must be valid JSON');
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function textResponse(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function htmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] as string,
  );
}

export function renderReviewPage(review: StoredReview): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${htmlEscape(review.title)} - Interactive review</title>
<style>
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #172033; background: #f6f8fc; }
* { box-sizing: border-box; } body { margin: 0; } a { color: #164ea6; } button, input, textarea { font: inherit; }
header { background: #13233f; color: #fff; padding: 1.25rem max(1rem, calc((100vw - 1200px) / 2)); } header p { margin: .35rem 0 0; color: #d8e4fa; overflow-wrap: anywhere; }
.shell { width: min(1200px, calc(100% - 2rem)); min-width: 0; margin: 1.25rem auto 3rem; } .panel, article { min-width: 0; background: #fff; border: 1px solid #d9e0eb; border-radius: .75rem; box-shadow: 0 1px 2px #13233f0d; }
.panel { padding: 1.25rem; margin-bottom: 1rem; } h1,h2,h3 { margin-top: 0; overflow-wrap: anywhere; } h2 { font-size: 1.2rem; } h3 { font-size: 1rem; margin-bottom: .35rem; }
.context-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; } .context-item { min-width: 0; border-left: 3px solid #8aa9d6; padding-left: .7rem; } .context-item pre { white-space: pre-wrap; overflow-wrap: anywhere; } .gap { color: #7a2b17; font-style: italic; }
.controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .75rem; align-items: center; } .filters { display: flex; flex-wrap: wrap; gap: .4rem; } button { cursor: pointer; border: 1px solid #9aa9bd; border-radius: .35rem; background: #fff; padding: .4rem .65rem; } button[aria-pressed="true"] { background: #164ea6; color: #fff; border-color: #164ea6; }
input, textarea { width: 100%; min-width: 0; border: 1px solid #9aa9bd; border-radius: .35rem; padding: .55rem; } textarea { min-height: 5rem; resize: vertical; } #findings { display: grid; min-width: 0; gap: 1rem; }
.finding { min-width: 0; padding: 1.2rem; } .finding-top, .finding-top > *, .excerpt-grid, .excerpt-grid > * { min-width: 0; } .finding-top { display: flex; align-items: flex-start; gap: .7rem; justify-content: space-between; } .tag { display: inline-block; border-radius: 999px; padding: .15rem .5rem; font-weight: 700; font-size: .78rem; background: #e8edf5; } .P0 { background: #ffe1df; color: #912018; } .P1 { background: #ffefd6; color: #824300; } .P2 { background: #e7f0ff; color: #164ea6; } .P3 { background: #edf0f4; color: #4c596d; }
.meta { color: #536176; font-size: .9rem; overflow-wrap: anywhere; } pre { max-width: 100%; min-width: 0; overflow-x: auto; white-space: pre; padding: .8rem; background: #101928; color: #e8eef8; border-radius: .35rem; font-size: .82rem; } .excerpt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
.comment { margin-top: .65rem; padding: .7rem; border-left: 3px solid #c5d0e0; background: #f8fafc; } .assistant { border-left-color: #38966a; } .comment p { white-space: pre-wrap; } .reply-form { margin-top: .6rem; }
.hidden { display: none; } .empty { color: #536176; } .small { font-size: .85rem; } .warning { color: #7a2b17; }
@media (max-width: 720px) { .shell { width: calc(100% - 1rem); margin-top: .5rem; } .context-grid, .excerpt-grid, .controls { grid-template-columns: 1fr; } .finding-top { display: block; } .finding-top .tag { margin-top: .5rem; } }
</style>
</head>
<body>
<header><strong>Interactive PR review</strong><p id="review-summary">Loading structured review...</p></header>
<main class="shell">
<section id="business-context" class="panel" aria-labelledby="business-context-title"><h1 id="business-context-title">Business context</h1><p class="small">Context precedes architecture and findings. Missing evidence is explicit.</p><div id="primer" class="context-grid"></div></section>
<section class="panel" aria-labelledby="review-controls-title"><h2 id="review-controls-title">Findings</h2><div class="controls"><input id="search" type="search" placeholder="Search findings, files, or reviewers" aria-label="Search findings"><nav class="filters" aria-label="Severity filters"><button type="button" data-severity="all" aria-pressed="true">All</button><button type="button" data-severity="P0" aria-pressed="false">P0</button><button type="button" data-severity="P1" aria-pressed="false">P1</button><button type="button" data-severity="P2" aria-pressed="false">P2</button><button type="button" data-severity="P3" aria-pressed="false">P3</button></nav></div></section>
<section id="findings" aria-live="polite"></section>
<section class="panel" aria-labelledby="general-comments-title"><h2 id="general-comments-title">General comments</h2><form data-comment-form="general"><label>Comment <textarea name="body" required maxlength="${MAX_COMMENT_LENGTH}"></textarea></label><label class="small">Name (optional) <input name="author" maxlength="120"></label><button type="submit">Save local comment</button></form><div id="general-comments"></div></section>
</main>
<script>
(() => {
  const state = { review: null, comments: [], severity: 'all', search: '' };
  const primerLabels = [['whoConfigures', 'Who configures this?'], ['operationalProblem', 'Operational problem'], ['intendedOutcome', 'Intended before/after outcome'], ['businessImportance', 'Why the business cares'], ['successCriteria', 'Success criteria'], ['scope', 'Scope'], ['nonGoals', 'Non-goals']];
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; };
  const request = async (path, options) => { const response = await fetch(path, options); if (!response.ok) throw new Error(await response.text()); return response.json(); };
  function renderPrimer() {
    const root = document.querySelector('#primer');
    root.replaceChildren();
    for (const [key, label] of primerLabels) {
      const item = el('div', undefined, 'context-item');
      item.append(el('h3', label));
      const field = state.review.primer[key];
      item.append(el('p', field.value || field.evidenceGap, field.value ? '' : 'gap'));
      root.append(item);
    }
    if (state.review.primer.providedRequirements) {
      const requirements = el('div', undefined, 'context-item');
      requirements.append(el('h3', 'Supplied requirements'), el('pre', state.review.primer.providedRequirements));
      root.append(requirements);
    }
  }
  function commentForm(findingId) { const form = el('form'); form.dataset.commentForm = findingId || 'general'; const area = document.createElement('textarea'); area.name = 'body'; area.required = true; area.maxLength = ${MAX_COMMENT_LENGTH}; area.setAttribute('aria-label', findingId ? 'Comment on ' + findingId : 'General comment'); const author = document.createElement('input'); author.name = 'author'; author.maxLength = 120; author.placeholder = 'Name (optional)'; const submit = el('button', 'Save local comment'); submit.type = 'submit'; form.append(el('h3', findingId ? 'Comment on ' + findingId : 'General comment'), area, author, submit); return form; }
  function renderComments(root, findingId) {
    root.replaceChildren();
    const comments = state.comments.filter((comment) => comment.findingId === findingId);
    if (!comments.length) {
      root.append(el('p', 'No local comments yet.', 'empty small'));
      return;
    }
    for (const comment of comments) {
      const card = el('div', undefined, 'comment');
      card.append(el('strong', comment.author + ' - ' + new Date(comment.createdAt).toLocaleString()), el('p', comment.body));
      for (const reply of comment.replies) {
        const replyCard = el('div', undefined, 'comment assistant');
        replyCard.append(el('strong', reply.author + ' (assistant) - ' + new Date(reply.createdAt).toLocaleString()), el('p', reply.body));
        card.append(replyCard);
      }
      root.append(card);
    }
  }
  function renderFindings() {
    const root = document.querySelector('#findings');
    root.replaceChildren();
    const query = state.search.toLowerCase();
    const visible = state.review.findings.filter((finding) => (state.severity === 'all' || finding.severity === state.severity) && [finding.id, finding.title, finding.file, finding.reviewers.join(' '), finding.requiredResponse].join(' ').toLowerCase().includes(query));
    if (!visible.length) {
      root.append(el('p', 'No findings match the current filters.', 'panel empty'));
      return;
    }
    for (const finding of visible) {
      const article = el('article', undefined, 'finding');
      article.dataset.findingSeverity = finding.severity;
      const top = el('div', undefined, 'finding-top');
      const heading = el('div');
      heading.append(el('h2', finding.id + ' ' + finding.title), el('p', finding.file + ':' + finding.line + '-' + finding.endLine, 'meta'));
      const sourceLink = (() => {
        if (typeof finding.sourceLink !== 'string') return null;
        try {
          const url = new URL(finding.sourceLink);
          const [startLine, endLine] = url.hash.slice(2).split('-L').map(Number);
          return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes('/blob/') && url.hash.startsWith('#L') && Number.isInteger(startLine) && Number.isInteger(endLine) && startLine > 0 && endLine >= startLine ? url.toString() : null;
        } catch {
          return null;
        }
      })();
      if (sourceLink) {
        const link = el('a', 'Open exact reviewed lines on GitHub');
        link.href = sourceLink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        heading.append(link);
      }
      top.append(heading, el('span', finding.severity, 'tag ' + finding.severity));
      article.append(top, el('h3', 'What actually happens'));
      const scenario = finding.scenario || { actualHappens: null, expectedSuggested: null, actualEvidenceGap: 'Evidence gap: the scenario sidecar does not provide a specific triggering setup/action and observable failure.', expectedEvidenceGap: 'Evidence gap: the scenario sidecar does not provide a specific expected behavior and correction.' };
      article.append(el('p', scenario.actualHappens || scenario.actualEvidenceGap, scenario.actualHappens ? '' : 'gap'));
      article.append(el('h3', 'Expected / suggested'), el('p', scenario.expectedSuggested || scenario.expectedEvidenceGap, scenario.expectedSuggested ? '' : 'gap'));
      article.append(el('h3', 'Required response'), el('p', finding.requiredResponse), el('p', 'Confidence: ' + finding.confidence + ' | Reviewers: ' + (finding.reviewers.join(', ') || 'not recorded'), 'meta'));
      if (finding.evidence.length || finding.firstEvidence) {
        article.append(el('h3', 'Referenced evidence'));
        const list = el('ul');
        for (const evidence of [...finding.evidence, ...(finding.firstEvidence ? [finding.firstEvidence] : [])]) list.append(el('li', evidence));
        article.append(list);
      }
      const excerpts = el('div', undefined, 'excerpt-grid');
      if (finding.excerpts.before) {
        const before = el('div');
        before.append(el('h3', 'Before excerpt'), el('pre', finding.excerpts.before.content));
        excerpts.append(before);
      }
      if (finding.excerpts.after) {
        const after = el('div');
        after.append(el('h3', 'Reviewed commit excerpt'), el('pre', finding.excerpts.after.content));
        excerpts.append(after);
      }
      if (excerpts.childElementCount) article.append(el('h3', 'Focused code context'), excerpts);
      else article.append(el('p', 'Evidence gap: no exact-commit code excerpt was available locally.', 'gap small'));
      article.append(commentForm(finding.id));
      const comments = el('div');
      comments.dataset.commentsFor = finding.id;
      article.append(comments);
      root.append(article);
      renderComments(comments, finding.id);
    }
  }
  function render() { document.querySelector('#review-summary').textContent = state.review.title + ' | ' + state.review.verdict + ' | reviewed commit ' + state.review.reviewedCommit; renderPrimer(); renderFindings(); renderComments(document.querySelector('#general-comments'), null); }
  async function refreshComments() { state.comments = (await request('/api/comments')).comments; }
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.commentForm) return;
    event.preventDefault();
    const data = new FormData(form);
    try {
      await request('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: data.get('body'), author: data.get('author'), findingId: form.dataset.commentForm === 'general' ? null : form.dataset.commentForm }),
      });
      form.reset();
      await refreshComments();
      render();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save comment');
    }
  });
  document.querySelector('#search').addEventListener('input', (event) => { state.search = event.target.value; renderFindings(); });
  document.querySelectorAll('[data-severity]').forEach((button) => button.addEventListener('click', () => { state.severity = button.dataset.severity; document.querySelectorAll('[data-severity]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); renderFindings(); }));
  Promise.all([request('/api/review'), refreshComments()]).then(([review]) => { state.review = review; render(); }).catch((error) => { document.querySelector('#review-summary').textContent = 'Unable to load review: ' + error.message; });
})();
</script>
</body>
</html>`;
}

function validateWriteRequest(request: Request, url: URL): Response | null {
  const contentType = request.headers.get('content-type');
  if (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    return textResponse('Content-Type must be application/json', 415);
  }
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) {
    return textResponse('Cross-origin comment writes are not allowed', 403);
  }
  return null;
}

export function createReviewServer(
  workspace: string,
  host = '127.0.0.1',
  port = 0,
) {
  const resolvedWorkspace = resolve(workspace);
  let reviewPromise: Promise<StoredReview> | null = null;
  const review = async (): Promise<StoredReview> => {
    reviewPromise ??= loadStoredReview(resolvedWorkspace);
    return reviewPromise;
  };
  return Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === '/')
          return new Response(renderReviewPage(await review()), {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy':
                "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
            },
          });
        if (request.method === 'GET' && url.pathname === '/api/review')
          return json(await review());
        if (request.method === 'GET' && url.pathname === '/api/comments') {
          const comments = (await readCommentStore(resolvedWorkspace)).comments;
          const unanswered = url.searchParams.get('status') === 'unanswered';
          return json({
            comments: unanswered
              ? comments.filter(
                  (comment) =>
                    !comment.replies.some(
                      (reply) => reply.role === 'assistant',
                    ),
                )
              : comments,
          });
        }
        if (request.method === 'POST' && url.pathname === '/api/comments') {
          const writeError = validateWriteRequest(request, url);
          if (writeError) return writeError;
          const contentLength = Number(
            request.headers.get('content-length') ?? '0',
          );
          if (contentLength > MAX_REQUEST_BYTES)
            return textResponse('Request body is too large', 413);
          const body = parseJsonRequest(await readBoundedRequestBody(request));
          const finding =
            body.findingId === null || body.findingId === undefined
              ? null
              : boundedString(body.findingId, 'findingId', 16);
          const storedReview = await review();
          if (
            finding !== null &&
            !storedReview.findings.some((item) => item.id === finding)
          )
            return textResponse('Unknown findingId', 400);
          const comment = await withLock(
            join(resolvedWorkspace, 'comments.json'),
            async () => {
              const store = await readCommentStore(resolvedWorkspace);
              const next: ReviewComment = {
                id: randomUUID(),
                findingId: finding,
                author: commentAuthor(body.author),
                role: 'reviewer',
                body: commentBody(body.body),
                createdAt: new Date().toISOString(),
                replies: [],
              };
              store.comments.push(next);
              await writeJsonAtomically(
                join(resolvedWorkspace, 'comments.json'),
                store,
              );
              return next;
            },
          );
          return json({ comment }, 201);
        }
        const replyMatch = /^\/api\/comments\/([0-9a-f-]{36})\/replies$/.exec(
          url.pathname,
        );
        if (request.method === 'POST' && replyMatch?.[1]) {
          const writeError = validateWriteRequest(request, url);
          if (writeError) return writeError;
          const contentLength = Number(
            request.headers.get('content-length') ?? '0',
          );
          if (contentLength > MAX_REQUEST_BYTES)
            return textResponse('Request body is too large', 413);
          const body = parseJsonRequest(await readBoundedRequestBody(request));
          if (body.role !== 'assistant')
            return textResponse('Replies must declare assistant role', 400);
          const comment = await withLock(
            join(resolvedWorkspace, 'comments.json'),
            async () => {
              const store = await readCommentStore(resolvedWorkspace);
              const parent = store.comments.find(
                (item) => item.id === replyMatch[1],
              );
              if (!parent) throw new Error('Comment not found');
              const reply: CommentReply = {
                id: randomUUID(),
                author: commentAuthor(body.author),
                role: 'assistant',
                body: commentBody(body.body),
                createdAt: new Date().toISOString(),
              };
              parent.replies.push(reply);
              await writeJsonAtomically(
                join(resolvedWorkspace, 'comments.json'),
                store,
              );
              return parent;
            },
          );
          return json({ comment }, 201);
        }
        return textResponse('Not found', 404);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Request failed';
        const status =
          message === 'Comment not found'
            ? 404
            : message.includes('busy')
              ? 503
              : 400;
        return textResponse(message, status);
      }
    },
  });
}

function readArguments(argumentsList: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const item = argumentsList[index];
    if (!item?.startsWith('--'))
      throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const value = argumentsList[index + 1];
    if (value && !value.startsWith('--')) {
      values.set(key, value);
      index += 1;
    } else {
      values.set(key, true);
    }
  }
  return values;
}

function option(
  values: Map<string, string | true>,
  key: string,
  required = false,
): string | undefined {
  const value = values.get(key);
  if (value === true) throw new Error(`--${key} requires a value`);
  if (required && value === undefined) throw new Error(`--${key} is required`);
  return value;
}

function rejectUnknownOptions(
  values: Map<string, string | true>,
  allowed: string[],
): void {
  for (const key of values.keys())
    if (!allowed.includes(key)) throw new Error(`Unknown option: --${key}`);
}

export async function main(
  argumentsList = process.argv.slice(2),
): Promise<void> {
  const [command, ...rest] = argumentsList;
  const values = readArguments(rest);
  if (command === 'prepare') {
    rejectUnknownOptions(values, [
      'review-json',
      'pr',
      'repo',
      'data-dir',
      'scenarios',
      'spec',
      'requirements',
      'base-commit',
    ]);
    const prepared = await prepareReview({
      reviewJsonPath: option(values, 'review-json', true) as string,
      pr: option(values, 'pr', true) as string,
      repoPath: option(values, 'repo'),
      dataDir: option(values, 'data-dir'),
      scenariosPath: option(values, 'scenarios'),
      specification: option(values, 'spec'),
      requirementsPath: option(values, 'requirements'),
      baseCommit: option(values, 'base-commit'),
    });
    process.stdout.write(
      `workspace: ${prepared.workspace}\nreviewed commit: ${prepared.review.reviewedCommit}\n`,
    );
    return;
  }
  if (command === 'serve') {
    rejectUnknownOptions(values, ['workspace', 'host', 'port', 'expose']);
    const workspace = option(values, 'workspace', true) as string;
    const host = option(values, 'host') ?? '127.0.0.1';
    const exposed = values.get('expose') === true;
    if (!LOOPBACK_HOSTS.has(host) && !exposed)
      throw new Error(
        'Refusing non-loopback binding without explicit --expose. Local review comments and findings may be visible on the network.',
      );
    if (!LOOPBACK_HOSTS.has(host))
      process.stderr.write(
        'WARNING: review site is exposed beyond loopback; anyone who can reach this host can read review data and submit local comments.\n',
      );
    const portText = option(values, 'port');
    const port = portText === undefined ? 0 : Number(portText);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('--port must be an integer from 0 through 65535');
    const server = createReviewServer(workspace, host, port);
    process.stdout.write(
      `Interactive review: http://${host}:${server.port}\nworkspace: ${resolve(workspace)}\n`,
    );
    return;
  }
  throw new Error(
    'Usage: review-site.ts prepare --review-json <CE review.json> --scenarios <scenario-sidecar.json> --pr <number-or-url> [--spec <text> | --requirements <repo-relative-file>] [--base-commit <sha>]\n       review-site.ts serve --workspace <path> [--host 127.0.0.1] [--port 0] [--expose]',
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Interactive review failed'}\n`,
    );
    process.exitCode = 1;
  });
}
