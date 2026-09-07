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

export type FindingStatus = 'active' | 'question' | 'withdrawn';

export interface FindingScenario {
  actualHappens: string | null;
  expectedSuggested: string | null;
  actualTriggerEvidence: string | null;
  actualOutcomeEvidence: string | null;
  actualEvidenceGap: string | null;
  expectedEvidenceGap: string | null;
}

export interface FindingClaim {
  title: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  requiredResponse: string;
  scenario: FindingScenario;
}

export interface FindingRevision {
  id: string;
  commentId: string;
  status: FindingStatus;
  rationale: string;
  changes: Partial<FindingClaim>;
  createdAt: string;
}

export interface ReviewFinding extends FindingClaim {
  id: string;
  status: FindingStatus;
  original: FindingClaim;
  revisions: FindingRevision[];
  file: string;
  line: number;
  endLine: number;
  confidence: number | string;
  reviewers: string[];
  evidence: string[];
  firstEvidence: string | null;
  sourceLink: string | null;
  excerpts: {
    before: CodeExcerpt | null;
    after: CodeExcerpt | null;
  };
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
export type PresentationTone = 'neutral' | 'problem' | 'outcome';

export interface PresentationCard {
  label: string;
  title: string;
  body: string;
  tone: PresentationTone;
}

export interface PresentationStep {
  label: string;
  title: string;
  body: string;
}

export interface ReviewPresentation {
  eyebrow: string;
  headline: string;
  summary: string;
  contextCards: PresentationCard[];
  mentalModel: {
    title: string;
    summary: string | null;
    steps: PresentationStep[];
  } | null;
}


export interface StoredReview {
  version: 2;
  repository: string;
  githubRepository: string | null;
  prNumber: number;
  reviewedCommit: string;
  title: string;
  originalVerdict: string;
  verdict: string;
  intent: string;
  primer: BusinessPrimer;
  presentation: ReviewPresentation | null;

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
  presentationPath?: string;

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

function missingScenario(
  actualEvidenceGap = 'Evidence gap: the scenario sidecar does not provide a specific triggering setup/reachability and observable outcome.',
): FindingScenario {
  return {
    actualHappens: null,
    expectedSuggested: null,
    actualTriggerEvidence: null,
    actualOutcomeEvidence: null,
    actualEvidenceGap,
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
  const rawEvidence = value.what_actually_happens_evidence;
  if (rawEvidence !== undefined && !isRecord(rawEvidence))
    throw new Error(`${field}.what_actually_happens_evidence must be an object`);
  const triggerEvidence = rawEvidence
    ? boundedString(
        rawEvidence.triggering_setup,
        `${field}.what_actually_happens_evidence.triggering_setup`,
        8000,
        false,
      )
    : null;
  const outcomeEvidence = rawEvidence
    ? boundedString(
        rawEvidence.observable_outcome,
        `${field}.what_actually_happens_evidence.observable_outcome`,
        8000,
        false,
      )
    : null;
  const hasActualEvidence = Boolean(
    actualHappens && triggerEvidence && outcomeEvidence,
  );
  const missing = missingScenario(
    actualHappens
      ? 'Evidence gap: the asserted scenario lacks both a cited triggering setup/reachability and observable outcome; treat it as an open question, not an active defect.'
      : undefined,
  );
  return {
    actualHappens: hasActualEvidence ? actualHappens : null,
    expectedSuggested,
    actualTriggerEvidence: hasActualEvidence ? triggerEvidence : null,
    actualOutcomeEvidence: hasActualEvidence ? outcomeEvidence : null,
    actualEvidenceGap: hasActualEvidence ? null : missing.actualEvidenceGap,
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
  const title = boundedString(value.title, 'finding.title', 1000) as string;
  const scenario = missingScenario();
  const claim: FindingClaim = { title, severity, requiredResponse, scenario };
  return {
    id: findingId(value['#']),
    ...claim,
    status: 'active',
    original: { ...claim, scenario: { ...scenario } },
    revisions: [],
    file: safeRelativePath(value.file, 'finding.file'),
    line,
    endLine,
    confidence,
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
  maximumBytes = MAX_REQUIREMENTS_BYTES,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes)
    throw new Error(`${basename(path)} exceeds ${maximumBytes} bytes`);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
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
function recordArray(
  value: unknown,
  field: string,
  maximumEntries: number,
): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumEntries)
    throw new Error(
      `${field} must be an array of at most ${maximumEntries} objects`,
    );
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${field}[${index}] must be an object`);
    return item;
  });
}

function normalizePresentation(
  value: unknown,
  field = 'presentation',
): ReviewPresentation | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const contextCards = recordArray(
    value.context_cards ?? value.contextCards,
    `${field}.context_cards`,
    6,
  ).map((card, index): PresentationCard => {
    const tone = (boundedString(
      card.tone,
      `${field}.context_cards[${index}].tone`,
      16,
      false,
    ) ?? 'neutral') as PresentationTone;
    if (!['neutral', 'problem', 'outcome'].includes(tone))
      throw new Error(
        `${field}.context_cards[${index}].tone must be neutral, problem, or outcome`,
      );
    return {
      label: boundedString(
        card.label,
        `${field}.context_cards[${index}].label`,
        120,
      ) as string,
      title: boundedString(
        card.title,
        `${field}.context_cards[${index}].title`,
        300,
      ) as string,
      body: boundedString(
        card.body,
        `${field}.context_cards[${index}].body`,
        3000,
      ) as string,
      tone,
    };
  });
  const rawMentalModel = value.mental_model ?? value.mentalModel;
  let mentalModel: ReviewPresentation['mentalModel'] = null;
  if (rawMentalModel !== undefined && rawMentalModel !== null) {
    if (!isRecord(rawMentalModel))
      throw new Error(`${field}.mental_model must be an object`);
    const steps = recordArray(
      rawMentalModel.steps,
      `${field}.mental_model.steps`,
      6,
    );
    if (!steps.length)
      throw new Error(`${field}.mental_model.steps must not be empty`);
    mentalModel = {
      title: boundedString(
        rawMentalModel.title,
        `${field}.mental_model.title`,
        300,
      ) as string,
      summary: boundedString(
        rawMentalModel.summary,
        `${field}.mental_model.summary`,
        3000,
        false,
      ),
      steps: steps.map((step, index) => ({
        label: boundedString(
          step.label,
          `${field}.mental_model.steps[${index}].label`,
          120,
        ) as string,
        title: boundedString(
          step.title,
          `${field}.mental_model.steps[${index}].title`,
          300,
        ) as string,
        body: boundedString(
          step.body,
          `${field}.mental_model.steps[${index}].body`,
          3000,
        ) as string,
      })),
    };
  }
  return {
    eyebrow: boundedString(value.eyebrow, `${field}.eyebrow`, 200) as string,
    headline: boundedString(value.headline, `${field}.headline`, 500) as string,
    summary: boundedString(value.summary, `${field}.summary`, 3000) as string,
    contextCards,
    mentalModel,
  };
}

async function readPresentationSidecar(
  path: string,
): Promise<ReviewPresentation> {
  const value = JSON.parse(
    await readBoundedFile(resolve(path), MAX_REQUIREMENTS_BYTES),
  ) as unknown;
  const presentation = normalizePresentation(value);
  if (!presentation) throw new Error('presentation must be an object');
  return presentation;
}


function preserveFindingLifecycle(
  fresh: ReviewFinding,
  previous: ReviewFinding | undefined,
): ReviewFinding {
  if (!previous?.revisions.length) return fresh;
  return {
    ...fresh,
    title: previous.title,
    severity: previous.severity,
    requiredResponse: previous.requiredResponse,
    scenario: { ...previous.scenario },
    status: previous.status,
    original: {
      ...previous.original,
      scenario: { ...previous.original.scenario },
    },
    revisions: [...previous.revisions],
  };
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
  const preparedPresentation = options.presentationPath
    ? await readPresentationSidecar(options.presentationPath)
    : undefined;

  const findings = rawFindings.map((finding) => {
    const scenario = scenarios.get(finding.id) ?? finding.scenario;
    return {
      ...finding,
      scenario,
      original: { ...finding.original, scenario: { ...scenario } },
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
    };
  });
  const workspace = workspaceFor(
    stateRoot(options.dataDir),
    repositoryStorageKey(remote, githubRepository),
    target.number,
  );
  const review = await withLock(join(workspace, 'review.json'), async () => {
    let previousReview: StoredReview | null = null;
    try {
      previousReview = await loadStoredReview(workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      previousReview?.reviewedCommit !== artifact.scope.head_sha &&
      previousReview?.findings.some((finding) => finding.revisions.length)
    ) {
      throw new Error(
        'Refusing to replace lifecycle history from a different reviewed commit',
      );
    }
    if (
      previousReview?.findings.some(
        (finding) =>
          finding.revisions.length &&
          !findings.some((candidate) => candidate.id === finding.id),
      )
    ) {
      throw new Error(
        'Refusing to discard lifecycle history for a finding missing from the review artifact',
      );
    }
    const previousFindings = new Map(
      previousReview?.findings.map((finding) => [finding.id, finding]) ?? [],
    );
    const lifecycleFindings = findings.map((finding) =>
      preserveFindingLifecycle(finding, previousFindings.get(finding.id)),
    );
    const next: StoredReview = {
      version: 2,
      repository: githubRepository ?? repositoryStorageKey(remote, null),
      githubRepository,
      prNumber: target.number,
      reviewedCommit: artifact.scope.head_sha,
      title: artifact.title ?? `Pull request #${target.number}`,
      originalVerdict: previousReview?.findings.some(
        (finding) => finding.revisions.length,
      )
        ? previousReview.originalVerdict
        : artifact.verdict,
      verdict: currentVerdict(lifecycleFindings),
      intent: artifact.intent,
      primer: buildBusinessPrimer(specification, artifact.intent),
      presentation:
        preparedPresentation ??
        (previousReview?.reviewedCommit === artifact.scope.head_sha
          ? previousReview.presentation
          : null),
      findings: lifecycleFindings,
      generatedAt: (options.now ?? new Date()).toISOString(),
    };
    await writeJsonAtomically(join(workspace, 'review.json'), next);
    return next;
  });
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

function storedScenario(value: unknown, field: string): FindingScenario {
  if (!isRecord(value)) return missingScenario();
  return normalizeScenario(
    {
      what_actually_happens: value.actualHappens,
      expected_suggested: value.expectedSuggested,
      what_actually_happens_evidence: {
        triggering_setup: value.actualTriggerEvidence,
        observable_outcome: value.actualOutcomeEvidence,
      },
    },
    field,
  );
}

function legacyScenario(value: unknown, field: string): FindingScenario {
  const normalized = storedScenario(value, field);
  if (!isRecord(value)) return normalized;
  const actualHappens = boundedString(
    value.actualHappens,
    `${field}.actualHappens`,
    8000,
    false,
  );
  return actualHappens
    ? {
        ...normalized,
        actualHappens,
        actualEvidenceGap:
          'Legacy scenario retained for audit: it lacks separate reachability and observable-outcome provenance.',
      }
    : normalized;
}
function currentVerdict(findings: ReviewFinding[]): string {
  const active = findings.filter((finding) => finding.status === 'active');
  const questions = findings.filter((finding) => finding.status === 'question');
  if (!active.length)
    return questions.length
      ? `No active findings; ${questions.length} open question${questions.length === 1 ? '' : 's'}`
      : 'No active findings';
  const bySeverity = [...SEVERITIES]
    .filter((severity) => active.some((finding) => finding.severity === severity))
    .map(
      (severity) =>
        `${severity}: ${active.filter((finding) => finding.severity === severity).length}`,
    );
  return `${active.length} active finding${active.length === 1 ? '' : 's'} (${bySeverity.join(', ')})${questions.length ? `; ${questions.length} open question${questions.length === 1 ? '' : 's'}` : ''}`;
}

function migrateStoredReview(value: unknown): StoredReview {
  if (!isRecord(value) || !Array.isArray(value.findings))
    throw new Error('Invalid stored review');

  if (value.version === 2) {
    if (value.presentation !== undefined) {
      normalizePresentation(value.presentation, 'review.presentation');
      return value as unknown as StoredReview;
    }
    return {
      ...(value as unknown as StoredReview),
      presentation: null,
    };
  }
  if (value.version !== 1) throw new Error('Unsupported stored review version');

  const originalVerdict = boundedString(value.verdict, 'review.verdict', 200) as string;
  const findings = value.findings.map((rawFinding, index) => {
    const scenario = storedScenario(rawFinding.scenario, `review.findings[${index}].scenario`);
    const originalScenario = legacyScenario(
      rawFinding.scenario,
      `review.findings[${index}].scenario`,
    );
    const title = boundedString(
      rawFinding.title,
      `review.findings[${index}].title`,
      1000,
    ) as string;
    const severity = boundedString(
      rawFinding.severity,
      `review.findings[${index}].severity`,
      2,
    ) as ReviewFinding['severity'];
    if (!SEVERITIES.has(severity))
      throw new Error(`review.findings[${index}].severity is invalid`);
    const requiredResponse = boundedString(
      rawFinding.requiredResponse,
      `review.findings[${index}].requiredResponse`,
      8000,
    ) as string;
    const claim: FindingClaim = { title, severity, requiredResponse, scenario };
    const original: FindingClaim = {
      ...claim,
      scenario: originalScenario,
    };
    return {
      ...(rawFinding as unknown as Omit<ReviewFinding, keyof FindingClaim | 'status' | 'original' | 'revisions'>),
      ...claim,
      status: 'active' as const,
      original,
      revisions: [],
    };
  });
  return {
    ...(value as unknown as Omit<StoredReview, 'version' | 'originalVerdict' | 'verdict' | 'findings'>),
    version: 2,
    originalVerdict,
    verdict: currentVerdict(findings),
    presentation: normalizePresentation(value.presentation, 'review.presentation'),

    findings,
  };
}

export async function loadStoredReview(
  workspace: string,
): Promise<StoredReview> {
  const path = join(resolve(workspace), 'review.json');
  const raw = JSON.parse(
    await readBoundedFile(path, MAX_REQUIREMENTS_BYTES),
  ) as unknown;
  const review = migrateStoredReview(raw);
  if (raw !== review) await writeJsonAtomically(path, review);
  return review;
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
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
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

function revisedScenario(
  value: unknown,
  current: FindingScenario,
): FindingScenario {
  if (!isRecord(value)) throw new Error('revision.scenario must be an object');
  return normalizeScenario(
    {
      what_actually_happens:
        value.actualHappens === undefined
          ? current.actualHappens
          : value.actualHappens,
      expected_suggested:
        value.expectedSuggested === undefined
          ? current.expectedSuggested
          : value.expectedSuggested,
      what_actually_happens_evidence: {
        triggering_setup:
          value.actualTriggerEvidence === undefined
            ? current.actualTriggerEvidence
            : value.actualTriggerEvidence,
        observable_outcome:
          value.actualOutcomeEvidence === undefined
            ? current.actualOutcomeEvidence
            : value.actualOutcomeEvidence,
      },
    },
    'revision.scenario',
  );
}

function revisionFor(
  body: JsonObject,
  finding: ReviewFinding,
): Omit<FindingRevision, 'id' | 'createdAt'> {
  const status = boundedString(body.status, 'status', 16) as FindingStatus;
  if (!['active', 'question', 'withdrawn'].includes(status))
    throw new Error('status must be active, question, or withdrawn');
  const commentId = boundedString(body.commentId, 'commentId', 36) as string;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(commentId))
    throw new Error('commentId must be a UUID');
  const rationale = boundedString(body.rationale, 'rationale', 8000) as string;
  const changes: Partial<FindingClaim> = {};
  if (body.title !== undefined)
    changes.title = boundedString(body.title, 'title', 1000) as string;
  if (body.severity !== undefined) {
    const severity = boundedString(body.severity, 'severity', 2) as ReviewFinding['severity'];
    if (!SEVERITIES.has(severity))
      throw new Error('severity must be P0, P1, P2, or P3');
    changes.severity = severity;
  }
  if (body.requiredResponse !== undefined)
    changes.requiredResponse = boundedString(
      body.requiredResponse,
      'requiredResponse',
      8000,
    ) as string;
  if (body.scenario !== undefined)
    changes.scenario = revisedScenario(body.scenario, finding.scenario);
  return { commentId, status, rationale, changes };
}

function requestContentLength(request: Request): Response | null {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  return contentLength > MAX_REQUEST_BYTES
    ? textResponse('Request body is too large', 413)
    : null;
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
:root {
  color-scheme: light;
  --ink: #111a2c;
  --muted: #5d6678;
  --paper: #f4f7fb;
  --panel: #ffffff;
  --line: #d7dfeb;
  --blue: #2159d1;
  --blue-dark: #0b3fa5;
  --blue-soft: #eef4ff;
  --red: #b52f36;
  --red-soft: #fff0f1;
  --amber: #8a5b00;
  --amber-soft: #fff7df;
  --green: #177455;
  --green-soft: #eaf8f2;
  --code: #0d1424;
  --code-text: #dbe7ff;
  --shadow: 0 18px 50px rgba(33, 51, 87, .1);
  --radius: 14px;
  font-family: "Segoe UI", Aptos, system-ui, sans-serif;
  color: var(--ink);
  background: var(--paper);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 24px; }
body { margin: 0; min-width: 0; background: var(--paper); font-size: 15px; line-height: 1.58; }
button, input, textarea { font: inherit; }
button, summary, a { -webkit-tap-highlight-color: transparent; }
a { color: var(--blue); }
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 3px solid #8bb6ff; outline-offset: 2px; }
h1, h2, h3, h4, p, li, label, strong, .meta, .gap, .rail-link-label { overflow-wrap: anywhere; word-break: break-word; }
.skip-link { position: fixed; left: 12px; top: -64px; z-index: 100; padding: 10px 14px; border-radius: 8px; background: var(--ink); color: #fff; }
.skip-link:focus { top: 12px; }
.review-shell { display: grid; grid-template-columns: 288px minmax(0, 1fr); min-height: 100vh; }
.review-rail { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 28px 20px; border-right: 1px solid #27334b; background: var(--ink); color: #e8eef9; }
.rail-brand { display: flex; gap: 12px; align-items: center; margin-bottom: 24px; }
.rail-mark { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border: 1px solid #50607c; border-radius: 9px; color: #fff; font: 750 13px/1 "Cascadia Code", Consolas, monospace; letter-spacing: .06em; }
.rail-brand strong, .rail-brand span { display: block; }
.rail-brand strong { color: #fff; font-size: 14px; }
.rail-brand span { color: #9eacc3; font-size: 12px; }
.rail-verdict { padding: 16px; border: 1px solid #34425d; border-radius: 10px; background: #17243b; }
.rail-verdict b { display: block; margin-bottom: 7px; color: #9eacc3; font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
.rail-verdict strong { display: block; color: #fff; font-size: 16px; line-height: 1.3; }
.rail-verdict span { display: block; margin-top: 7px; color: #b9c5d8; font-size: 12px; }
.rail-label { margin: 24px 8px 8px; color: #7f8da6; font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .11em; text-transform: uppercase; }
.rail-nav { display: grid; gap: 4px; }
.rail-nav a { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-width: 0; padding: 8px; border-radius: 7px; color: #c9d3e3; text-decoration: none; font-size: 12px; }
.rail-nav a:hover, .rail-nav a.active { background: #22314c; color: #fff; }
.rail-index { color: #7f8da6; font: 700 10px/1 "Cascadia Code", Consolas, monospace; }
.rail-state { width: 8px; height: 8px; border-radius: 50%; background: #7f8da6; }
.rail-state.active { background: #ff7b82; }
.rail-state.question { background: #f5bd51; }
.rail-state.withdrawn { background: #8190a8; }
.rail-note { margin-top: 22px; padding: 12px; border-top: 1px solid #34425d; color: #9eacc3; font-size: 11px; }
.review-content { min-width: 0; }
.hero { padding: 68px clamp(24px, 6vw, 84px) 42px; border-bottom: 1px solid var(--line); background: radial-gradient(circle at 92% 8%, #dceaff 0, transparent 28%), linear-gradient(145deg, #fff 0%, #f7faff 68%, #eef4ff 100%); }
.eyebrow, .section-kicker { margin: 0 0 12px; color: var(--blue); font: 750 11px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .11em; text-transform: uppercase; }
.hero h1 { max-width: 920px; margin: 0; font: 760 clamp(40px, 6vw, 76px)/.98 "Aptos Display", "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -.045em; }
.hero-lede { max-width: 840px; margin: 24px 0 0; color: #3d4960; font-size: clamp(17px, 2vw, 21px); line-height: 1.55; }
.hero-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; max-width: 840px; margin-top: 32px; overflow: hidden; border: 1px solid var(--line); border-radius: 11px; background: var(--line); }
.metric { min-width: 0; padding: 16px 18px; background: rgba(255,255,255,.9); }
.metric b { display: block; font: 760 25px/1 "Aptos Display", "Segoe UI", sans-serif; }
.metric span { display: block; margin-top: 6px; color: var(--muted); font-size: 11px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.primary-link { display: inline-flex; gap: 7px; align-items: center; padding: 9px 13px; border: 1px solid #b8cdf5; border-radius: 8px; background: #fff; color: var(--blue-dark); font-weight: 700; text-decoration: none; }
.primary-link:hover { border-color: var(--blue); }
.review-main { width: min(1100px, calc(100% - 48px)); margin: 0 auto; padding: 48px 0 72px; }
.review-section { margin-bottom: 44px; }
.section-head { display: flex; gap: 20px; align-items: end; justify-content: space-between; margin-bottom: 18px; }
.section-head h2 { margin: 0; font: 740 clamp(28px, 4vw, 42px)/1.08 "Aptos Display", "Segoe UI", sans-serif; letter-spacing: -.025em; }
.section-summary { max-width: 780px; margin: 0 0 20px; color: #3d4960; font-size: 16px; }
.context-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.context-card { min-width: 0; padding: 20px; border: 1px solid var(--line); border-top: 4px solid #8aa9d6; border-radius: 12px; background: var(--panel); box-shadow: 0 6px 22px rgba(33,51,87,.05); }
.context-card.problem { border-top-color: var(--red); }
.context-card.outcome { border-top-color: var(--green); }
.context-card b { display: block; margin-bottom: 7px; color: var(--blue); font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
.context-card h3 { margin: 0 0 8px; font-size: 18px; line-height: 1.2; }
.context-card p { margin: 0; color: #3d4960; }
.context-extras { display: grid; gap: 10px; margin-top: 14px; }
.model-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.model-step { position: relative; min-width: 0; padding: 18px; border: 1px solid var(--line); border-radius: 11px; background: #fff; }
.model-step b { display: block; margin-bottom: 10px; color: var(--blue); font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
.model-step h3 { margin: 0 0 8px; font-size: 17px; line-height: 1.2; }
.model-step p { margin: 0; color: #465269; font-size: 13px; }

.disclosure { min-width: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.disclosure summary { display: flex; gap: 12px; align-items: center; justify-content: space-between; min-width: 0; padding: 12px 15px; cursor: pointer; color: #26344d; font-weight: 700; list-style: none; }
.disclosure summary::-webkit-details-marker { display: none; }
.disclosure summary::after { content: "+"; flex: 0 0 auto; color: var(--blue); font: 700 18px/1 "Cascadia Code", Consolas, monospace; }
.disclosure[open] summary::after { content: "−"; }
.disclosure[open] summary { border-bottom: 1px solid var(--line); }
.disclosure-body { min-width: 0; padding: 15px; }
.disclosure-body > :first-child { margin-top: 0; }
.disclosure-body > :last-child { margin-bottom: 0; }
.requirements { max-height: 420px; overflow: auto; white-space: pre-wrap; color: #354258; background: #f8fafd; }
.review-controls { position: sticky; top: 12px; z-index: 10; display: grid; gap: 12px; margin-bottom: 20px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.96); box-shadow: 0 10px 30px rgba(33,51,87,.1); backdrop-filter: blur(10px); }
.control-row { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px; align-items: center; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; }
input, textarea { width: 100%; min-width: 0; border: 1px solid #aab6c8; border-radius: 8px; background: #fff; color: var(--ink); }
input { padding: 9px 11px; }
textarea { min-height: 86px; padding: 10px 11px; resize: vertical; }
button { cursor: pointer; border: 1px solid #aab6c8; border-radius: 7px; background: #fff; color: #27344c; padding: 7px 10px; }
button:hover { border-color: var(--blue); }
button[aria-pressed="true"], .comment-form button { border-color: var(--blue); background: var(--blue); color: #fff; }
#findings { display: grid; min-width: 0; gap: 16px; }
.finding-group { display: grid; min-width: 0; gap: 14px; }
.finding-group + .finding-group { margin-top: 24px; }
.group-title { margin: 0; color: #33415a; font: 740 22px/1.2 "Aptos Display", "Segoe UI", sans-serif; }
.finding { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); box-shadow: var(--shadow); }
.finding.active { border-color: #e8c5c8; }
.finding.question { border-color: #ead79f; }
.finding.withdrawn { border-color: #cfd7e3; }
.finding-header { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 14px; align-items: start; padding: 20px 22px 16px; border-bottom: 1px solid var(--line); }
.finding-number { display: grid; place-items: center; width: 42px; height: 42px; border: 1px solid #c9d4e5; border-radius: 9px; background: var(--blue-soft); color: var(--blue-dark); font: 750 12px/1 "Cascadia Code", Consolas, monospace; }
.finding-title { min-width: 0; }
.finding-title h3 { margin: 0 0 5px; font: 730 clamp(19px, 2.5vw, 25px)/1.18 "Aptos Display", "Segoe UI", sans-serif; }
.finding-location { display: inline-flex; color: var(--blue); font-size: 12px; font-weight: 650; text-decoration: none; }
.finding-location:hover { text-decoration: underline; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }
.tag { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 3px 8px; font: 750 10px/1 "Cascadia Code", Consolas, monospace; letter-spacing: .04em; text-transform: uppercase; }
.tag.P0, .tag.P1, .tag.active { background: var(--red-soft); color: var(--red); }
.tag.P2, .tag.question { background: var(--amber-soft); color: var(--amber); }
.tag.P3, .tag.withdrawn { background: #edf0f4; color: #4c596d; }
.finding-body { display: grid; gap: 15px; min-width: 0; padding: 20px 22px 22px; }
.scenario-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.scenario-card { min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; }
.scenario-card.actual { border-color: #efc7ca; background: var(--red-soft); }
.scenario-card.expected { border-color: #b9ddcf; background: var(--green-soft); }
.scenario-card b { display: block; margin-bottom: 7px; font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
.scenario-card.actual b { color: var(--red); }
.scenario-card.expected b { color: var(--green); }
.scenario-card p { margin: 0; color: #344158; }
.provenance { margin: 11px 0 0; padding: 10px 0 0 18px; border-top: 1px solid rgba(181,47,54,.18); color: #5a4850; font-size: 12px; }
.action-card { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 14px; padding: 15px 16px; border-left: 4px solid var(--blue); border-radius: 8px; background: var(--blue-soft); }
.action-card b { color: var(--blue-dark); font: 750 10px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; }
.action-card p { margin: 0; }
.finding-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 12px; }
.evidence-list, .history-list { margin: 0; padding-left: 20px; }
.evidence-list li + li, .history-list li + li { margin-top: 8px; }
.excerpt-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; }
.excerpt-grid > * { min-width: 0; }
.excerpt-grid h4 { margin: 0 0 7px; font-size: 12px; }
pre { max-width: 100%; min-width: 0; margin: 0; overflow-x: auto; white-space: pre; border-radius: 8px; padding: 14px; background: var(--code); color: var(--code-text); font: 12px/1.55 "Cascadia Code", Consolas, monospace; }
.gap { color: #7a2b17; font-style: italic; }
.discussion-disclosure { background: #fbfcfe; }
.comment-form { display: grid; grid-template-columns: minmax(0, 1fr) 180px auto; gap: 8px; align-items: end; }
.comment-form h4 { grid-column: 1 / -1; margin: 0; }
.comment-form label { color: var(--muted); font-size: 12px; }
.comment-form button { min-height: 38px; }
.comment-list { display: grid; gap: 9px; margin-top: 12px; }
.comment { min-width: 0; padding: 12px; border-left: 3px solid #c5d0e0; border-radius: 0 8px 8px 0; background: #f7f9fc; }
.comment.assistant { margin: 10px 0 0 12px; border-left-color: var(--green); background: #f0faf6; }
.comment p { margin: 6px 0 0; white-space: pre-wrap; }
.comment strong { font-size: 12px; }
.discussion-panel { padding: 22px; border: 1px solid var(--line); border-radius: var(--radius); background: #fff; box-shadow: var(--shadow); }
.empty { color: var(--muted); }
.small { font-size: 12px; }
.hidden { display: none !important; }
.toast { position: fixed; right: 20px; bottom: 20px; z-index: 100; max-width: min(360px, calc(100% - 40px)); padding: 11px 14px; border-radius: 8px; background: var(--ink); color: #fff; opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .16s ease, transform .16s ease; }
.toast.show { opacity: 1; transform: translateY(0); }
@media (max-width: 900px) {
  .review-shell { display: block; }
  .review-rail { position: relative; height: auto; padding: 18px; }
  .rail-brand, .rail-verdict { max-width: 620px; }
  .rail-label { margin-top: 14px; }
  .rail-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rail-note { display: none; }
  .hero { padding-top: 42px; }
  .review-controls { position: static; }
}
@media (max-width: 720px) {
  .hero-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .context-grid, .model-grid, .scenario-grid, .excerpt-grid { grid-template-columns: 1fr; }

  .control-row { grid-template-columns: 1fr; }
  .finding-header { grid-template-columns: 42px minmax(0, 1fr); padding: 17px; }
  .tags { grid-column: 2; justify-content: flex-start; }
  .finding-body { padding: 17px; }
  .comment-form { grid-template-columns: 1fr; }
  .comment-form h4 { grid-column: auto; }
  .comment-form button { justify-self: start; }
}
@media (max-width: 520px) {
  .rail-nav { grid-template-columns: 1fr; }
  .hero { padding: 34px 18px 30px; }
  .hero h1 { font-size: 38px; }
  .review-main { width: min(100% - 24px, 1100px); padding-top: 32px; }
  .hero-metrics { grid-template-columns: 1fr 1fr; }
  .metric { padding: 13px; }
  .action-card { grid-template-columns: 1fr; gap: 5px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .toast { transition: none; }
}
</style>
</head>
<body>
<a class="skip-link" href="#findings-section">Skip to findings</a>
<div class="review-shell">
  <aside class="review-rail" aria-label="Review navigation">
    <div class="rail-brand"><div class="rail-mark">PR</div><div><strong id="rail-repository">Interactive review</strong><span id="rail-pr"></span></div></div>
    <div class="rail-verdict"><b>Current verdict</b><strong id="rail-verdict">Loading review…</strong><span id="rail-counts"></span></div>
    <div class="rail-label">Review map</div>
    <nav class="rail-nav" id="review-nav"><a href="#overview"><span class="rail-index">00</span><span class="rail-link-label">Overview</span></a><a href="#business-context"><span class="rail-index">01</span><span class="rail-link-label">Business context</span></a><a class="hidden" id="mental-model-nav" href="#mental-model"><span class="rail-index">02</span><span class="rail-link-label">Mental model</span></a><a href="#findings-section"><span class="rail-index">03</span><span class="rail-link-label">Findings</span></a></nav>

    <div class="rail-label">Findings</div>
    <nav class="rail-nav" id="finding-nav"></nav>
    <div class="rail-label">Discuss</div>
    <nav class="rail-nav"><a href="#discussion"><span class="rail-index">+</span><span class="rail-link-label">General comments</span></a></nav>
    <p class="rail-note">Comments stay on this workstation. Heavy evidence and code remain collapsed until requested.</p>
  </aside>
  <div class="review-content">
    <header class="hero" id="overview">
      <p class="eyebrow" id="review-eyebrow">Structured pull request review</p>
      <h1 id="review-title">Loading review…</h1>
      <p class="hero-lede" id="review-summary"></p>
      <div class="hero-metrics" id="review-metrics" aria-label="Review summary metrics"></div>
      <div class="hero-actions" id="review-actions"></div>
    </header>
    <main class="review-main" id="main">
      <section class="review-section" id="business-context" aria-labelledby="business-context-title">
        <div class="section-head"><div><p class="section-kicker">Business primer</p><h2 id="business-context-title">Understand the change first</h2></div></div>
        <p class="section-summary">The operational context stays ahead of implementation detail. Missing context is explicit but does not dominate the review.</p>
        <div class="context-grid" id="primer"></div>
        <div class="context-extras" id="primer-extras"></div>
      </section>
      <section class="review-section hidden" id="mental-model" aria-labelledby="mental-model-title">
        <div class="section-head"><div><p class="section-kicker">Mental model</p><h2 id="mental-model-title"></h2></div></div>
        <p class="section-summary" id="mental-model-summary"></p>
        <div class="model-grid" id="mental-model-steps"></div>
      </section>

      <section class="review-section" id="findings-section" aria-labelledby="review-controls-title">
        <div class="section-head"><div><p class="section-kicker">Review findings</p><h2 id="review-controls-title">Inspect the failure path</h2></div></div>
        <div class="review-controls">
          <div class="control-row"><input id="search" type="search" placeholder="Search title, file, impact, or reviewer" aria-label="Search findings"><nav class="filters" aria-label="Severity filters"><button type="button" data-severity="all" aria-pressed="true">All severities</button><button type="button" data-severity="P0" aria-pressed="false">P0</button><button type="button" data-severity="P1" aria-pressed="false">P1</button><button type="button" data-severity="P2" aria-pressed="false">P2</button><button type="button" data-severity="P3" aria-pressed="false">P3</button></nav></div>
          <nav class="filters" aria-label="Finding status filters"><button type="button" data-status="all" aria-pressed="true">All statuses</button><button type="button" data-status="active" aria-pressed="false">Active findings</button><button type="button" data-status="question" aria-pressed="false">Open questions</button><button type="button" data-status="withdrawn" aria-pressed="false">Withdrawn</button></nav>
        </div>
        <div id="findings" aria-live="polite"></div>
      </section>
      <section class="review-section" id="discussion" aria-labelledby="general-comments-title">
        <div class="section-head"><div><p class="section-kicker">Discussion</p><h2 id="general-comments-title">General comments</h2></div></div>
        <div class="discussion-panel"><form class="comment-form" data-comment-form="general"><h4>Add a general comment</h4><label>Comment<textarea name="body" required maxlength="${MAX_COMMENT_LENGTH}"></textarea></label><label>Name (optional)<input name="author" maxlength="120"></label><button type="submit">Save comment</button></form><div id="general-comments" class="comment-list"></div></div>
      </section>
    </main>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(() => {
  const state = { review: null, comments: [], severity: 'all', status: 'all', search: '', observer: null };
  const primerLabels = [['whoConfigures', 'Who configures this?', 'Operator', 'neutral'], ['operationalProblem', 'Operational problem', 'Problem', 'problem'], ['intendedOutcome', 'Intended before / after', 'Outcome', 'outcome'], ['businessImportance', 'Why the business cares', 'Business value', 'neutral'], ['successCriteria', 'Success criteria', 'Success', 'outcome'], ['scope', 'Scope', 'In scope', 'neutral'], ['nonGoals', 'Non-goals', 'Boundary', 'neutral']];
  const statusLabels = { active: 'Active findings', question: 'Open questions', withdrawn: 'Withdrawn findings' };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (className) node.className = className; return node; };
  const request = async (path, options) => { const response = await fetch(path, options); if (!response.ok) throw new Error(await response.text()); return response.json(); };
  function toast(message) { const node = document.querySelector('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2400); }
  function disclosure(title, content, className) {
    const details = el('details', undefined, 'disclosure' + (className ? ' ' + className : ''));
    details.append(el('summary', title));
    const body = el('div', undefined, 'disclosure-body');
    if (Array.isArray(content)) body.append(...content); else body.append(content);
    details.append(body);
    return details;
  }
  function renderHero() {
    const review = state.review;
    const counts = review.findings.reduce((total, finding) => { total[finding.status] += 1; return total; }, { active: 0, question: 0, withdrawn: 0 });
    const files = new Set(review.findings.map((finding) => finding.file)).size;
    document.querySelector('#rail-repository').textContent = review.repository;
    document.querySelector('#rail-pr').textContent = 'Pull request #' + review.prNumber;
    document.querySelector('#rail-verdict').textContent = review.verdict;
    document.querySelector('#rail-counts').textContent = counts.active + ' active · ' + counts.question + ' questions · ' + counts.withdrawn + ' withdrawn';
    const presentation = review.presentation;
    document.querySelector('#review-eyebrow').textContent = presentation?.eyebrow || review.repository + ' / PR #' + review.prNumber;
    document.querySelector('#review-title').textContent = presentation?.headline || review.title;
    document.querySelector('#review-summary').textContent = presentation?.summary || review.intent;

    const metrics = document.querySelector('#review-metrics');
    metrics.replaceChildren();
    for (const [value, label] of [[counts.active, 'active findings'], [counts.question, 'open questions'], [counts.withdrawn, 'withdrawn'], [files, 'files with findings']]) {
      const metric = el('div', undefined, 'metric');
      metric.append(el('b', value), el('span', label));
      metrics.append(metric);
    }
    const actions = document.querySelector('#review-actions');
    actions.replaceChildren();
    if (review.githubRepository) {
      const link = el('a', 'Open PR #' + review.prNumber + ' on GitHub ↗', 'primary-link');
      link.href = 'https://github.com/' + review.githubRepository + '/pull/' + review.prNumber;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    }
    actions.append(el('span', 'Reviewed commit ' + review.reviewedCommit.slice(0, 8), 'small meta'));
  }
  function renderPrimer() {
    const root = document.querySelector('#primer');
    const extras = document.querySelector('#primer-extras');
    root.replaceChildren();
    extras.replaceChildren();
    const gaps = [];
    const presentationCards = state.review.presentation?.contextCards || [];
    if (presentationCards.length) {
      for (const item of presentationCards) {
        const card = el('article', undefined, 'context-card ' + item.tone);
        card.append(el('b', item.label), el('h3', item.title), el('p', item.body));
        root.append(card);
      }
      for (const [key, title] of primerLabels) {
        const field = state.review.primer[key];
        if (!field.value) gaps.push(title + ': ' + field.evidenceGap);
      }
    } else {
      let values = 0;
      for (const [key, title, label, tone] of primerLabels) {
        const field = state.review.primer[key];
        if (!field.value) { gaps.push(title + ': ' + field.evidenceGap); continue; }
        values += 1;
        const card = el('article', undefined, 'context-card ' + tone);
        card.append(el('b', label), el('h3', title), el('p', field.value));
        root.append(card);
      }
      if (!values) {
        const card = el('article', undefined, 'context-card');
        card.append(el('b', 'Review intent'), el('h3', 'What this change is trying to do'), el('p', state.review.intent));
        root.append(card);
      }
    }

    if (gaps.length) {
      const list = el('ul', undefined, 'evidence-list');
      for (const gap of gaps) list.append(el('li', gap, 'gap'));
      extras.append(disclosure('Missing business context (' + gaps.length + ')', list));
    }
    if (state.review.primer.providedRequirements) {
      extras.append(disclosure('Supplied requirements', el('pre', state.review.primer.providedRequirements, 'requirements')));
    }
  }
  function renderMentalModel() {
    const section = document.querySelector('#mental-model');
    const nav = document.querySelector('#mental-model-nav');
    const model = state.review.presentation?.mentalModel;
    section.classList.toggle('hidden', !model);
    nav.classList.toggle('hidden', !model);
    if (!model) return;
    document.querySelector('#mental-model-title').textContent = model.title;
    const summary = document.querySelector('#mental-model-summary');
    summary.textContent = model.summary || '';
    summary.classList.toggle('hidden', !model.summary);
    const root = document.querySelector('#mental-model-steps');
    root.replaceChildren();
    for (const step of model.steps) {
      const card = el('article', undefined, 'model-step');
      card.append(el('b', step.label), el('h3', step.title), el('p', step.body));
      root.append(card);
    }
  }

  function commentForm(findingId) {
    const form = el('form', undefined, 'comment-form');
    form.dataset.commentForm = findingId || 'general';
    form.append(el('h4', findingId ? 'Discuss ' + findingId : 'Add a general comment'));
    const bodyLabel = el('label', 'Comment');
    const area = document.createElement('textarea');
    area.name = 'body';
    area.required = true;
    area.maxLength = ${MAX_COMMENT_LENGTH};
    area.setAttribute('aria-label', findingId ? 'Comment on ' + findingId : 'General comment');
    bodyLabel.append(area);
    const authorLabel = el('label', 'Name (optional)');
    const author = document.createElement('input');
    author.name = 'author';
    author.maxLength = 120;
    authorLabel.append(author);
    const submit = el('button', 'Save comment');
    submit.type = 'submit';
    form.append(bodyLabel, authorLabel, submit);
    return form;
  }
  function renderComments(root, findingId) {
    root.replaceChildren();
    const comments = state.comments.filter((comment) => comment.findingId === findingId);
    if (!comments.length) { root.append(el('p', 'No local comments yet.', 'empty small')); return; }
    for (const comment of comments) {
      const card = el('div', undefined, 'comment');
      card.append(el('strong', comment.author + ' · ' + new Date(comment.createdAt).toLocaleString()), el('p', comment.body));
      for (const reply of comment.replies) {
        const replyCard = el('div', undefined, 'comment assistant');
        replyCard.append(el('strong', reply.author + ' · assistant · ' + new Date(reply.createdAt).toLocaleString()), el('p', reply.body));
        card.append(replyCard);
      }
      root.append(card);
    }
  }
  function safeSourceLink(finding) {
    if (typeof finding.sourceLink !== 'string') return null;
    try {
      const url = new URL(finding.sourceLink);
      const lines = url.hash.slice(2).split('-L').map(Number);
      return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.includes('/blob/') && url.hash.startsWith('#L') && Number.isInteger(lines[0]) && Number.isInteger(lines[1]) && lines[0] > 0 && lines[1] >= lines[0] ? url.toString() : null;
    } catch { return null; }
  }
  function renderFinding(finding) {
    const article = el('article', undefined, 'finding ' + finding.status);
    article.id = 'finding-' + finding.id.slice(1);
    article.dataset.findingSeverity = finding.severity;
    article.dataset.findingStatus = finding.status;
    const header = el('header', undefined, 'finding-header');
    const number = el('div', finding.id, 'finding-number');
    const title = el('div', undefined, 'finding-title');
    title.append(el('h3', finding.title));
    const sourceLink = safeSourceLink(finding);
    if (sourceLink) {
      const link = el('a', finding.file + ':' + finding.line + '-' + finding.endLine + ' · Open on GitHub ↗', 'finding-location');
      link.href = sourceLink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      title.append(link);
    } else title.append(el('span', finding.file + ':' + finding.line + '-' + finding.endLine, 'meta'));
    const tags = el('div', undefined, 'tags');
    tags.append(el('span', finding.severity, 'tag ' + finding.severity), el('span', finding.status, 'tag ' + finding.status));
    header.append(number, title, tags);
    const body = el('div', undefined, 'finding-body');
    const scenario = finding.scenario || { actualHappens: null, expectedSuggested: null, actualEvidenceGap: 'Evidence gap: no scenario is available.', expectedEvidenceGap: 'Evidence gap: no expected behavior is available.' };
    const scenarioGrid = el('div', undefined, 'scenario-grid');
    const actual = el('div', undefined, 'scenario-card actual');
    actual.append(el('b', 'What actually happens'), el('p', scenario.actualHappens || scenario.actualEvidenceGap, scenario.actualHappens ? '' : 'gap'));
    if (scenario.actualHappens) {
      const provenance = el('ul', undefined, 'provenance');
      provenance.append(el('li', 'Trigger / reachability: ' + scenario.actualTriggerEvidence), el('li', 'Observable outcome: ' + scenario.actualOutcomeEvidence));
      actual.append(provenance);
    }
    const expected = el('div', undefined, 'scenario-card expected');
    expected.append(el('b', 'Expected / suggested'), el('p', scenario.expectedSuggested || scenario.expectedEvidenceGap, scenario.expectedSuggested ? '' : 'gap'));
    scenarioGrid.append(actual, expected);
    body.append(scenarioGrid);
    const action = el('div', undefined, 'action-card');
    action.append(el('b', 'Required response'), el('p', finding.requiredResponse));
    body.append(action);
    const meta = el('div', undefined, 'finding-meta');
    meta.append(el('span', 'Confidence ' + finding.confidence), el('span', 'Reviewers ' + (finding.reviewers.join(', ') || 'not recorded')));
    body.append(meta);
    const evidenceValues = [...new Set([...finding.evidence, ...(finding.firstEvidence ? [finding.firstEvidence] : [])])];
    if (evidenceValues.length) {
      const list = el('ul', undefined, 'evidence-list');
      for (const evidence of evidenceValues) list.append(el('li', evidence));
      body.append(disclosure('Referenced evidence (' + evidenceValues.length + ')', list));
    }
    if (finding.revisions.length) {
      const history = el('ul', undefined, 'history-list');
      for (const revision of finding.revisions) history.append(el('li', new Date(revision.createdAt).toLocaleString() + ': ' + revision.status + ' — ' + revision.rationale));
      history.append(el('li', 'Original claim: ' + finding.original.title + ' | ' + finding.original.severity));
      body.append(disclosure('Lifecycle history', history));
    }
    const excerpts = el('div', undefined, 'excerpt-grid');
    if (finding.excerpts.before) { const before = el('div'); before.append(el('h4', 'Before excerpt'), el('pre', finding.excerpts.before.content)); excerpts.append(before); }
    if (finding.excerpts.after) { const after = el('div'); after.append(el('h4', 'Reviewed commit excerpt'), el('pre', finding.excerpts.after.content)); excerpts.append(after); }
    if (excerpts.childElementCount) body.append(disclosure('Focused code context', excerpts));
    else body.append(el('p', 'Evidence gap: no exact-commit code excerpt was available locally.', 'gap small'));
    const discussion = el('div');
    const comments = el('div', undefined, 'comment-list');
    comments.dataset.commentsFor = finding.id;
    discussion.append(commentForm(finding.id), comments);
    const commentCount = state.comments.filter((comment) => comment.findingId === finding.id).length;
    const discussionDisclosure = disclosure('Discussion' + (commentCount ? ' (' + commentCount + ')' : ''), discussion, 'discussion-disclosure');
    if (commentCount) discussionDisclosure.open = true;
    body.append(discussionDisclosure);
    article.append(header, body);
    renderComments(comments, finding.id);
    return article;
  }
  function visibleFindings() {
    const query = state.search.toLowerCase();
    return state.review.findings.filter((finding) => (state.severity === 'all' || finding.severity === state.severity) && (state.status === 'all' || finding.status === state.status) && [finding.id, finding.title, finding.file, finding.status, finding.reviewers.join(' '), finding.requiredResponse, finding.scenario.actualHappens || '', finding.scenario.expectedSuggested || '', ...finding.revisions.map((revision) => revision.rationale)].join(' ').toLowerCase().includes(query));
  }
  function renderFindingNav(findings) {
    const nav = document.querySelector('#finding-nav');
    nav.replaceChildren();
    for (const finding of findings) {
      const link = document.createElement('a');
      link.href = '#finding-' + finding.id.slice(1);
      link.append(el('span', finding.id, 'rail-index'), el('span', finding.title, 'rail-link-label'), el('span', undefined, 'rail-state ' + finding.status));
      nav.append(link);
    }
  }
  function observeSections() {
    if (state.observer) state.observer.disconnect();
    state.observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      document.querySelectorAll('.rail-nav a').forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + visible.target.id));
    }, { rootMargin: '-15% 0px -70% 0px', threshold: [0, .2, .5] });
    document.querySelectorAll('#overview, #business-context, #findings-section, #discussion, article.finding').forEach((node) => state.observer.observe(node));
  }
  function renderFindings() {
    const root = document.querySelector('#findings');
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    root.replaceChildren();
    const visible = visibleFindings();
    renderFindingNav(visible);
    if (!visible.length) { root.append(el('p', 'No findings match the current filters.', 'discussion-panel empty')); return; }
    for (const status of ['active', 'question', 'withdrawn']) {
      const group = visible.filter((finding) => finding.status === status);
      if (!group.length) continue;
      const section = el('section', undefined, 'finding-group');
      section.append(el('h3', statusLabels[status] + ' (' + group.length + ')', 'group-title'));
      for (const finding of group) section.append(renderFinding(finding));
      root.append(section);
    }
    observeSections();
  }
  function render() {
    renderHero();
    renderPrimer();
    renderMentalModel();
    renderFindings();
    renderComments(document.querySelector('#general-comments'), null);
  }
  async function refreshComments() { state.comments = (await request('/api/comments')).comments; }
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.commentForm) return;
    event.preventDefault();
    const data = new FormData(form);
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await request('/api/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: data.get('body'), author: data.get('author'), findingId: form.dataset.commentForm === 'general' ? null : form.dataset.commentForm }) });
      form.reset();
      await refreshComments();
      render();
      toast('Comment saved locally');
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not save comment'); }
    finally { button.disabled = false; }
  });
  document.querySelector('#search').addEventListener('input', (event) => { state.search = event.target.value; renderFindings(); });
  document.querySelectorAll('[data-severity]').forEach((button) => button.addEventListener('click', () => { state.severity = button.dataset.severity; document.querySelectorAll('[data-severity]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); renderFindings(); }));
  document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => { state.status = button.dataset.status; document.querySelectorAll('[data-status]').forEach((item) => item.setAttribute('aria-pressed', String(item === button))); renderFindings(); }));
  Promise.all([request('/api/review'), refreshComments()]).then(([reviewData]) => { state.review = reviewData; render(); }).catch((error) => { document.querySelector('#review-title').textContent = 'Unable to load review'; document.querySelector('#review-summary').textContent = error.message; });
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
    return textResponse('Cross-origin writes are not allowed', 403);
  }
  return null;
}

export function createReviewServer(
  workspace: string,
  host = '127.0.0.1',
  port = 0,
) {
  const resolvedWorkspace = resolve(workspace);
  const review = (): Promise<StoredReview> => loadStoredReview(resolvedWorkspace);
  return Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        const pathname = decodeURIComponent(url.pathname);
        if (request.method === 'GET' && pathname === '/')
          return new Response(renderReviewPage(await review()), {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy':
                "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'",
            },
          });
        if (request.method === 'GET' && pathname === '/api/review')
          return json(await review());
        if (request.method === 'GET' && pathname === '/api/comments') {
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
        if (request.method === 'POST' && pathname === '/api/comments') {
          const writeError = validateWriteRequest(request, url);
          if (writeError) return writeError;
          const lengthError = requestContentLength(request);
          if (lengthError) return lengthError;
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
          pathname,
        );
        if (request.method === 'POST' && replyMatch?.[1]) {
          const writeError = validateWriteRequest(request, url);
          if (writeError) return writeError;
          const lengthError = requestContentLength(request);
          if (lengthError) return lengthError;
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
        const revisionMatch = /^\/api\/findings\/(#[1-9]\d*)\/revisions$/.exec(
          pathname,
        );
        if (request.method === 'POST' && revisionMatch?.[1]) {
          const writeError = validateWriteRequest(request, url);
          if (writeError) return writeError;
          const lengthError = requestContentLength(request);
          if (lengthError) return lengthError;
          const body = parseJsonRequest(await readBoundedRequestBody(request));
          const result = await withLock(
            join(resolvedWorkspace, 'review.json'),
            async () => {
              const current = await loadStoredReview(resolvedWorkspace);
              const target = current.findings.find(
                (item) => item.id === revisionMatch[1],
              );
              if (!target) throw new Error('Finding not found');
              const revision = revisionFor(body, target);
              const comment = (
                await readCommentStore(resolvedWorkspace)
              ).comments.find((item) => item.id === revision.commentId);
              if (!comment || comment.findingId !== target.id)
                throw new Error(
                  'commentId must identify a comment on this finding',
                );
              const applied: FindingRevision = {
                ...revision,
                id: randomUUID(),
                createdAt: new Date().toISOString(),
              };
              Object.assign(target, applied.changes);
              target.status = applied.status;
              target.revisions.push(applied);
              current.verdict = currentVerdict(current.findings);
              await writeJsonAtomically(
                join(resolvedWorkspace, 'review.json'),
                current,
              );
              return { finding: target, verdict: current.verdict };
            },
          );
          return json(result, 201);
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
      'presentation',

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
      presentationPath: option(values, 'presentation'),

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
        'WARNING: review site is exposed beyond loopback; anyone who can reach this host can read review data and submit local comments or lifecycle revisions.\n',
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
    'Usage: review-site.ts prepare --review-json <structured-review.json> --scenarios <scenario-sidecar.json> --pr <number-or-url> [--presentation <presentation-sidecar.json>] [--spec <text> | --requirements <repo-relative-file>] [--base-commit <sha>]\n       review-site.ts serve --workspace <path> [--host 127.0.0.1] [--port 0] [--expose]',
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
