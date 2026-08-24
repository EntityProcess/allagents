const ISOLATED_TEST_FILE_ENV = 'ALLAGENTS_ISOLATED_TEST_FILE';

export function isIsolatedTestRun(file: string): boolean {
  return process.env[ISOLATED_TEST_FILE_ENV] === file;
}

export function runTestFileIsolated(file: string): void {
  const result = Bun.spawnSync([process.execPath, 'test', file], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [ISOLATED_TEST_FILE_ENV]: file,
    } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode === 0) return;

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  throw new Error(
    [
      `Isolated test process failed for ${file} (exit ${result.exitCode}).`,
      stdout,
      stderr,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
