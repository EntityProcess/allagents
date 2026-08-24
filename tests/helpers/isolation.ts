import { resolve } from 'node:path';

const ISOLATED_TEST_FILE_ENV = 'ALLAGENTS_ISOLATED_TEST_FILE';
const ISOLATED_TEST_TIMEOUT_MS = 60_000;
const ISOLATED_TEST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function isIsolatedTestRun(file: string): boolean {
  const isolatedFile = process.env[ISOLATED_TEST_FILE_ENV];
  return isolatedFile !== undefined && resolve(isolatedFile) === resolve(file);
}

export function runTestFileIsolated(file: string): void {
  const resolvedFile = resolve(file);
  const result = Bun.spawnSync([process.execPath, 'test', resolvedFile], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [ISOLATED_TEST_FILE_ENV]: resolvedFile,
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: ISOLATED_TEST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: ISOLATED_TEST_MAX_BUFFER_BYTES,
  });

  if (result.success) return;

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  const status = result.exitedDueToTimeout
    ? `timed out after ${ISOLATED_TEST_TIMEOUT_MS}ms`
    : result.exitedDueToMaxBuffer
      ? `exceeded ${ISOLATED_TEST_MAX_BUFFER_BYTES} bytes of output`
      : result.signalCode
        ? `signal ${result.signalCode}`
        : `exit ${result.exitCode}`;
  throw new Error(
    [
      `Isolated test process failed for ${resolvedFile} (${status}).`,
      stdout,
      stderr,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
