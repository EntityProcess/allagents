import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { CONFIG_DIR } from '../constants.js';
import {
  normalizeLifecycleScript,
  type LifecycleScript,
} from '../models/workspace-config.js';

export interface LifecycleScriptResult {
  name: string;
  script: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped?: boolean;
}

export interface RunLifecycleScriptsResult {
  results: LifecycleScriptResult[];
  success: boolean;
  error?: string;
}

/**
 * Run a single lifecycle script in the workspace root.
 * The script is executed via sh -c so shell features (pipes, redirects) work.
 */
function runScript(
  script: string,
  workspacePath: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = execFile(
      'sh',
      ['-c', script],
      {
        cwd: workspacePath,
        env: {
          ...process.env,
          ALLAGENTS_WORKSPACE: workspacePath,
          ALLAGENTS_CONFIG_DIR: join(workspacePath, CONFIG_DIR),
        },
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (error as { code?: number }).code ?? 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          durationMs: Date.now() - start,
        });
      },
    );
    // Ensure the promise resolves even if the process is killed
    child.on('error', () => {});
  });
}

/**
 * Run lifecycle scripts for a given phase (e.g., preSync).
 *
 * @param scripts - Raw script entries from workspace config
 * @param workspacePath - Workspace root directory
 * @param options - dryRun mode and timeout
 * @returns Results for each script and overall success
 */
export async function runLifecycleScripts(
  scripts: LifecycleScript[],
  workspacePath: string,
  options: { dryRun?: boolean; timeoutMs?: number } = {},
): Promise<RunLifecycleScriptsResult> {
  const { dryRun = false, timeoutMs = 120_000 } = options;
  const results: LifecycleScriptResult[] = [];

  for (const entry of scripts) {
    const normalized = normalizeLifecycleScript(entry);

    if (dryRun) {
      results.push({
        name: normalized.name,
        script: normalized.script,
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        skipped: true,
      });
      continue;
    }

    const { exitCode, stdout, stderr, durationMs } = await runScript(
      normalized.script,
      workspacePath,
      timeoutMs,
    );
    const success = exitCode === 0;

    results.push({
      name: normalized.name,
      script: normalized.script,
      success,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs,
    });

    // A failing required script stops execution
    if (!success && !normalized.optional) {
      return {
        results,
        success: false,
        error: `Lifecycle script '${normalized.name}' failed (exit code ${exitCode})`,
      };
    }
  }

  return {
    results,
    success: true,
  };
}

/**
 * Format lifecycle script results for CLI output.
 */
export function formatLifecycleResults(
  phase: string,
  result: RunLifecycleScriptsResult,
): string[] {
  if (result.results.length === 0) return [];

  const lines: string[] = [];
  lines.push(`Lifecycle hooks (${phase}):`);

  for (const r of result.results) {
    if (r.skipped) {
      lines.push(`  [dry-run] would run: ${r.name} (${r.script})`);
    } else if (r.success) {
      lines.push(`  ✓ ${r.name} (${formatDuration(r.durationMs)})`);
    } else {
      lines.push(`  ✗ ${r.name} (exit code ${r.exitCode}, ${formatDuration(r.durationMs)})`);
      if (r.stderr) {
        for (const line of r.stderr.split('\n').slice(0, 5)) {
          lines.push(`    ${line}`);
        }
      }
    }
  }

  return lines;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
