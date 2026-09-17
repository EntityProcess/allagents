#!/usr/bin/env bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const HELP = `Usage: bun run bench:update -- --baseline <built-cli> --candidate <built-cli> [options]

Required:
  --baseline <path>          Already-built baseline dist/index.js entrypoint
  --candidate <path>         Already-built candidate dist/index.js entrypoint

Options:
  --baseline-commit <id>     Explicit baseline commit provenance
  --candidate-commit <id>    Explicit candidate commit provenance
  --samples <count>          Timed samples per scenario/profile (default: 100)
  --warmups <count>          Warmup samples per scenario/profile (default: 5)
  --profiles <list>          Comma-separated injected Git command latency in ms
                             (default: 0,50,200)
  --scenarios <list>         plugin,skill (default: plugin,skill)
  --no-compare               Emit evidence without enforcing runtime thresholds
  -h, --help                 Show this help

Latency is injected before local Git remote commands. It is a controlled command-cost
profile, not a claim of network fidelity. Exact candidate no-op operation counts,
normalized public output, and normalized filesystem state are gated. Runtime ratios
for the 0 ms, 50 ms, and 200 ms profiles are report-only evidence.
`;

type ScenarioName = 'plugin' | 'skill';

interface Options {
  baseline: string;
  candidate: string;
  baselineCommit?: string;
  candidateCommit?: string;
  samples: number;
  warmups: number;
  profiles: number[];
  scenarios: ScenarioName[];
  compare: boolean;
}

interface GitCounts {
  [operation: string]: number;
}

interface Sample {
  durationMs: number;
  exitCode: number;
  gitOperations: GitCounts;
  stdoutSha256: string;
  stateSha256: string;
}

interface FixtureContext {
  root: string;
  template: string;
  wrapperDir: string;
}

interface IterationContext {
  root: string;
  cwd: string;
  home: string;
  cache: string;
  trace: string;
  args: string[];
}

const decoder = new TextDecoder();
const remoteOperations = ['ls-remote', 'clone', 'pull', 'fetch'];
const observedOperations = [
  'ls-remote',
  'clone',
  'pull',
  'fetch',
  'checkout',
  'reset',
  'rev-parse',
  'remote',
  'status',
  'symbolic-ref',
];
const YAML_CONFIG =
  'repositories: []\nplugins:\n  - source: uat/benchmark-update\n    skills:\n      - keep\n      - gone\nclients:\n  - claude\nversion: 2\n';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function positiveInteger(value: string | undefined, option: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    fail(`${option} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const values = new Map<string, string>();
  let compare = true;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--no-compare') {
      compare = false;
      continue;
    }
    if (!argument?.startsWith('--')) fail(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${argument}`);
    values.set(argument, value);
    index++;
  }
  const baseline = values.get('--baseline');
  const candidate = values.get('--candidate');
  if (!baseline || !candidate) fail('Both --baseline and --candidate are required. Use --help for usage.');
  const profiles = (values.get('--profiles') ?? '0,50,200').split(',').map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) fail('--profiles must contain non-negative integer milliseconds');
    return parsed;
  });
  const scenarios = (values.get('--scenarios') ?? 'plugin,skill').split(',').map((value) => {
    if (value !== 'plugin' && value !== 'skill') fail(`Unknown scenario: ${value}`);
    return value;
  }) as ScenarioName[];
  return {
    baseline: validateCli(baseline, '--baseline'),
    candidate: validateCli(candidate, '--candidate'),
    ...(values.get('--baseline-commit') && { baselineCommit: values.get('--baseline-commit') }),
    ...(values.get('--candidate-commit') && { candidateCommit: values.get('--candidate-commit') }),
    samples: positiveInteger(values.get('--samples') ?? '100', '--samples'),
    warmups: positiveInteger(values.get('--warmups') ?? '5', '--warmups', true),
    profiles: [...new Set(profiles)],
    scenarios: [...new Set(scenarios)],
    compare,
  };
}

function validateCli(path: string, option: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${option} is not an existing file: ${absolute}`);
  }
  return absolute;
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    fail(`git ${args.join(' ')} failed: ${decoder.decode(result.stderr).trim()}`);
  }
  return decoder.decode(result.stdout).trim();
}

function setupFixture(): FixtureContext {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'allagents-update-bench-'));
  const work = join(root, 'upstream');
  const remote = join(root, 'benchmark-update.git');
  const template = join(root, 'cache-template');
  mkdirSync(work, { recursive: true });
  runGit(work, ['init']);
  runGit(work, ['checkout', '-b', 'main']);
  runGit(work, ['config', '--local', 'user.name', 'AllAgents Benchmark']);
  runGit(work, ['config', '--local', 'user.email', 'benchmark@example.test']);
  mkdirSync(join(work, '.claude-plugin'), { recursive: true });
  mkdirSync(join(work, 'plugins', 'demo', 'skills', 'demo'), { recursive: true });
  mkdirSync(join(work, 'skills', 'keep'), { recursive: true });
  mkdirSync(join(work, 'skills', 'gone'), { recursive: true });
  writeFileSync(
    join(work, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({
      name: 'bench-market',
      plugins: [{ name: 'demo', source: './plugins/demo' }],
    }, null, 2)}\n`,
  );
  writeFileSync(join(work, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: benchmark\n---\n# demo\n');
  writeFileSync(join(work, 'skills', 'keep', 'SKILL.md'), '---\nname: keep\ndescription: benchmark\n---\n# keep\n');
  writeFileSync(join(work, 'skills', 'gone', 'SKILL.md'), '---\nname: gone\ndescription: benchmark\n---\n# gone\n');
  runGit(work, ['add', '.']);
  runGit(work, ['commit', '-m', 'benchmark fixture']);
  runGit(root, ['init', '--bare', remote]);
  runGit(work, ['remote', 'add', 'origin', remote]);
  runGit(work, ['push', '-u', 'origin', 'main']);
  runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  runGit(root, ['clone', '--branch', 'main', remote, template]);
  runGit(template, ['remote', 'set-url', 'origin', 'https://github.com/uat/benchmark-update.git']);

  const wrapperDir = join(root, 'bin');
  mkdirSync(wrapperDir, { recursive: true });
  const wrapper = join(wrapperDir, 'git');
  const realGit = Bun.which('git') ?? '/usr/bin/git';
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase " $* " in\n  *" remote get-url "*) exec "${realGit}" "$@" ;;\n  *" ls-remote "*|*" clone "*|*" pull "*|*" fetch "*)\n    if [ "${'$'}{ALLAGENTS_BENCH_LATENCY_SECONDS:-0}" != "0" ]; then sleep "${'$'}ALLAGENTS_BENCH_LATENCY_SECONDS"; fi\n    ;;\nesac\nexec "${realGit}" -c "url.file://${remote}.insteadOf=https://github.com/uat/benchmark-update.git" "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return { root, template, wrapperDir };
}


function prepareIteration(
  fixture: FixtureContext,
  scenario: ScenarioName,
  serial: number,
): IterationContext {
  const root = join(fixture.root, 'iterations', `${scenario}-${serial}`);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  const cache = join(
    home,
    '.allagents',
    'plugins',
    'marketplaces',
    scenario === 'plugin' ? 'bench-market' : 'uat-benchmark-update',
  );
  mkdirSync(join(cwd, '.allagents'), { recursive: true });
  mkdirSync(dirname(cache), { recursive: true });
  cpSync(fixture.template, cache, { recursive: true });
  const trace = join(root, 'git-trace.jsonl');

  if (scenario === 'plugin') {
    mkdirSync(join(home, '.allagents'), { recursive: true });
    const entry = {
      name: 'bench-market',
      source: { type: 'github', location: 'uat/benchmark-update' },
      path: cache,
      lastUpdated: '2000-01-01T00:00:00.000Z',
    };
    writeFileSync(
      join(home, '.allagents', 'marketplaces.json'),
      `${JSON.stringify({
        version: 1,
        marketplaces: {
          'bench-market': entry,
          'bench-market-consumer-2': { ...entry },
        },
      }, null, 2)}\n`,
    );
    return {
      root,
      cwd,
      home,
      cache,
      trace,
      args: ['--json', 'plugin', 'marketplace', 'update'],
    };
  }

  writeFileSync(join(cwd, '.allagents', 'workspace.yaml'), YAML_CONFIG);
  mkdirSync(join(home, '.allagents'), { recursive: true });
  writeFileSync(join(home, '.allagents', 'workspace.yaml'), YAML_CONFIG);
  return {
    root,
    cwd,
    home,
    cache,
    trace,
    args: ['--json', 'skill', 'update', '--scope', 'all', '--yes'],
  };
}

function gitCounts(trace: string): GitCounts {
  const counts: GitCounts = Object.fromEntries(observedOperations.map((operation) => [operation, 0]));
  if (!existsSync(trace)) return counts;
  for (const line of readFileSync(trace, 'utf8').split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as { event?: string; argv?: string[] };
    if (event.event !== 'start' && event.event !== 'child_start') continue;
    for (const operation of observedOperations) {
      if (event.argv?.some((argument) => argument === operation)) {
        counts[operation] = (counts[operation] ?? 0) + 1;
      }
    }
  }
  return counts;
}

function normalizeIterationValue(value: unknown, root: string): string {
  return JSON.stringify(value).replaceAll(root, '<ITERATION_ROOT>');
}

function captureState(
  scenario: ScenarioName,
  iteration: IterationContext,
): unknown {
  const head = runGit(iteration.cache, ['rev-parse', 'HEAD']);
  if (scenario === 'plugin') {
    const registry = JSON.parse(
      readFileSync(
        join(iteration.home, '.allagents', 'marketplaces.json'),
        'utf8',
      ),
    ) as {
      marketplaces: Record<
        string,
        {
          name: string;
          source: unknown;
          path: string;
          lastUpdated?: string;
        }
      >;
    };
    const entries = Object.fromEntries(
      Object.entries(registry.marketplaces).map(([key, entry]) => [
        key,
        {
          name: entry.name,
          source: entry.source,
          path: entry.path.replaceAll(iteration.root, '<ITERATION_ROOT>'),
          lastUpdatedAdvanced:
            typeof entry.lastUpdated === 'string' &&
            entry.lastUpdated !== '2000-01-01T00:00:00.000Z',
        },
      ]),
    );
    return { head, entries };
  }
  return {
    head,
    projectConfig: readFileSync(
      join(iteration.cwd, '.allagents', 'workspace.yaml'),
      'utf8',
    ),
    userConfig: readFileSync(
      join(iteration.home, '.allagents', 'workspace.yaml'),
      'utf8',
    ),
  };
}

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(value);
  return hasher.digest('hex');
}

function runSample(
  cli: string,
  fixture: FixtureContext,
  scenario: ScenarioName,
  profileMs: number,
  serial: number,
): Sample {
  const iteration = prepareIteration(fixture, scenario, serial);
  const start = performance.now();
  const result = Bun.spawnSync([cli, ...iteration.args], {
    cwd: iteration.cwd,
    env: {
      ...process.env,
      ALLAGENTS_TEST_HOME: iteration.home,
      HOME: iteration.home,
      USERPROFILE: iteration.home,
      XDG_CONFIG_HOME: join(iteration.home, '.config'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_TRACE2_EVENT: iteration.trace,
      NO_COLOR: '1',
      PATH: `${fixture.wrapperDir}:${process.env.PATH ?? ''}`,
      ALLAGENTS_BENCH_LATENCY_SECONDS: profileMs === 0 ? '0' : (profileMs / 1000).toFixed(3),
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const durationMs = performance.now() - start;
  const stdout = decoder.decode(result.stdout);
  const stderr = decoder.decode(result.stderr);
  let payload: { success?: boolean };
  try {
    payload = JSON.parse(stdout) as { success?: boolean };
    if (result.exitCode !== 0 || payload.success !== true) {
      fail(
        `${basename(cli)} ${scenario} failed (${result.exitCode}): ${stdout}${stderr}`,
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(
        `${basename(cli)} ${scenario} emitted invalid JSON: ${stdout}${stderr}`,
      );
    }
    throw error;
  }
  const sample = {
    durationMs,
    exitCode: result.exitCode,
    gitOperations: gitCounts(iteration.trace),
    stdoutSha256: hash(normalizeIterationValue(payload, iteration.root)),
    stateSha256: hash(
      normalizeIterationValue(captureState(scenario, iteration), iteration.root),
    ),
  };
  rmSync(iteration.root, { recursive: true, force: true });
  return sample;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] as number;
}

function summarize(samples: Sample[]) {
  const durations = samples.map((sample) => sample.durationMs);
  const operationSignatures = samples.map((sample) =>
    JSON.stringify(sample.gitOperations),
  );
  return {
    count: samples.length,
    minMs: Math.min(...durations),
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(...durations),
    operationCountsDeterministic:
      new Set(operationSignatures).size === 1,
    operationCountSignatures: [...new Set(operationSignatures)].map(
      (signature) => JSON.parse(signature),
    ),
    outputSignatures: [...new Set(samples.map((sample) => sample.stdoutSha256))],
    stateSignatures: [...new Set(samples.map((sample) => sample.stateSha256))],
  };
}

function exactCandidateWork(samples: Sample[]): boolean {
  return samples.every(
    (sample) =>
      sample.gitOperations['ls-remote'] === 1 &&
      sample.gitOperations.clone === 0 &&
      sample.gitOperations.pull === 0 &&
      sample.gitOperations.fetch === 0 &&
      sample.gitOperations.checkout === 0 &&
      sample.gitOperations.reset === 0,
  );
}

function inferCommit(cli: string): string | null {
  let directory = dirname(cli);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      const result = Bun.spawnSync(['git', '-C', directory, 'rev-parse', 'HEAD'], {
        stderr: 'pipe',
        stdout: 'pipe',
      });
      if (result.exitCode === 0) return decoder.decode(result.stdout).trim();
      return null;
    }
    directory = dirname(directory);
  }
  return null;
}

function commandVersion(command: string, args: string[]): string {
  const result = Bun.spawnSync([command, ...args], { stderr: 'pipe', stdout: 'pipe' });
  return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
  console.log(HELP);
  process.exit(0);
}

const fixture = setupFixture();
let serial = 0;
let gateFailed = false;
try {
  const results = [];
  for (const scenario of options.scenarios) {
    for (const profileMs of options.profiles) {
      const baselineWarmups: Sample[] = [];
      const candidateWarmups: Sample[] = [];
      for (let index = 0; index < options.warmups; index++) {
        const order =
          index % 2 === 0
            ? [
                [options.baseline, baselineWarmups],
                [options.candidate, candidateWarmups],
              ] as const
            : [
                [options.candidate, candidateWarmups],
                [options.baseline, baselineWarmups],
              ] as const;
        for (const [cli, samples] of order) {
          samples.push(runSample(cli, fixture, scenario, profileMs, serial++));
        }
      }
      const baselineSamples: Sample[] = [];
      const candidateSamples: Sample[] = [];
      for (let index = 0; index < options.samples; index++) {
        const order =
          index % 2 === 0
            ? [
                [options.baseline, baselineSamples],
                [options.candidate, candidateSamples],
              ] as const
            : [
                [options.candidate, candidateSamples],
                [options.baseline, baselineSamples],
              ] as const;
        for (const [cli, samples] of order) {
          samples.push(runSample(cli, fixture, scenario, profileMs, serial++));
        }
      }
      const baselineSummary = summarize(baselineSamples);
      const candidateSummary = summarize(candidateSamples);
      const evaluated = options.compare;
      const medianRatio = candidateSummary.medianMs / baselineSummary.medianMs;
      const p95Ratio = candidateSummary.p95Ms / baselineSummary.p95Ms;
      const exactWork = exactCandidateWork(candidateSamples);
      const outputCompatible =
        baselineSummary.outputSignatures.length === 1 &&
        candidateSummary.outputSignatures.length === 1 &&
        baselineSummary.outputSignatures[0] ===
          candidateSummary.outputSignatures[0];
      const stateCompatible =
        baselineSummary.stateSignatures.length === 1 &&
        candidateSummary.stateSignatures.length === 1 &&
        baselineSummary.stateSignatures[0] ===
          candidateSummary.stateSignatures[0];
      const passed =
        !evaluated ||
        (candidateSummary.operationCountsDeterministic &&
          exactWork &&
          outputCompatible &&
          stateCompatible);
      if (!passed) gateFailed = true;
      results.push({
        scenario,
        profileMs,
        profileInterpretation: 'Delay injected before each local Git remote command; not network-fidelity simulation.',
        sourceGraph: scenario === 'plugin'
          ? { physicalSources: 1, physicalCheckouts: 1, consumers: 2, consumerKind: 'marketplace registry registrations', scopes: ['user'] }
          : { physicalSources: 1, physicalCheckouts: 1, consumers: 2, consumerKind: 'skill installations', scopes: ['project', 'user'] },
        baseline: { summary: baselineSummary, warmups: baselineWarmups, samples: baselineSamples },
        candidate: { summary: candidateSummary, warmups: candidateWarmups, samples: candidateSamples },
        verification: {
          evaluated,
          policy:
            'candidate performs one ls-remote and no clone/pull/fetch/checkout/reset; normalized public output and filesystem state match baseline',
          exactCandidateWork: exactWork,
          outputCompatible,
          stateCompatible,
          passed: evaluated ? passed : null,
        },
        comparison: {
          evaluated: false,
          policy: 'report-only',
          ...(options.compare ? {} : { disabledReason: '--no-compare' }),
          medianRatio,
          p95Ratio,
          passed: null,
        },
      });
    }
  }

  const output = {
    schemaVersion: 1,
    benchmark: 'update-noop',
    generatedAt: new Date().toISOString(),
    provenance: {
      baseline: { cli: options.baseline, commit: options.baselineCommit ?? inferCommit(options.baseline) },
      candidate: { cli: options.candidate, commit: options.candidateCommit ?? inferCommit(options.candidate) },
      buildMode: 'prebuilt executable JavaScript entrypoints supplied by caller',
    },
    environment: {
      bun: Bun.version,
      git: commandVersion('git', ['--version']),
      os: { platform: platform(), release: release(), arch: process.arch },
      cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCount: cpus().length },
      homeRedacted: true,
    },
    method: {
      warmups: options.warmups,
      timedSamples: options.samples,
      profilesMs: options.profiles,
      freshCliProcessPerSample: true,
      fixtureRearmedOutsideTimedInterval: true,
      sampleOrder: 'paired AB/BA, alternating the first CLI per pair',
      percentileAlgorithm: 'nearest-rank on ascending samples; index=max(0, ceil(p*n)-1)',
      failurePolicy: 'fail fast on non-zero exit or invalid/unsuccessful JSON; no retries',
      outlierPolicy: 'no samples excluded',
      latencyInjection: { operations: remoteOperations, fidelity: 'controlled local command delay, not network emulation' },
      gatePolicy:
        'exact Git work plus normalized output/state compatibility; all runtime ratios are report-only',
      manualDispatchOnly: true,
      comparisonEnabled: options.compare,
    },
    results,
    passed: options.compare ? !gateFailed : null,
  };
  console.log(JSON.stringify(output, null, 2));
} finally {
  rmSync(fixture.root, { recursive: true, force: true });
}
if (gateFailed) process.exit(1);
