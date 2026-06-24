import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runLifecycleScripts,
  formatLifecycleResults,
} from '../../../src/core/lifecycle-scripts.js';
import {
  LifecycleScriptSchema,
  normalizeLifecycleScript,
} from '../../../src/models/workspace-config.js';

describe('lifecycle-scripts', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-lifecycle-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // Schema and normalization
  // ---------------------------------------------------------------
  describe('schema parsing', () => {
    it('should parse string shorthand', () => {
      const result = LifecycleScriptSchema.safeParse('scripts/setup.sh');
      expect(result.success).toBe(true);
      expect(result.data).toBe('scripts/setup.sh');
    });

    it('should parse object form with all fields', () => {
      const result = LifecycleScriptSchema.safeParse({
        script: 'scripts/setup.sh',
        name: 'Setup',
        optional: true,
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        script: 'scripts/setup.sh',
        name: 'Setup',
        optional: true,
      });
    });

    it('should parse object form with only script', () => {
      const result = LifecycleScriptSchema.safeParse({
        script: 'scripts/setup.sh',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ script: 'scripts/setup.sh' });
    });

    it('should reject non-string non-object values', () => {
      const result = LifecycleScriptSchema.safeParse(42);
      expect(result.success).toBe(false);
    });
  });

  describe('normalizeLifecycleScript', () => {
    it('should normalize string shorthand', () => {
      const result = normalizeLifecycleScript('scripts/setup.sh');
      expect(result).toEqual({
        script: 'scripts/setup.sh',
        name: 'scripts/setup.sh',
        optional: false,
      });
    });

    it('should normalize object form with defaults', () => {
      const result = normalizeLifecycleScript({ script: 'scripts/setup.sh' });
      expect(result).toEqual({
        script: 'scripts/setup.sh',
        name: 'scripts/setup.sh',
        optional: false,
      });
    });

    it('should normalize object form with explicit fields', () => {
      const result = normalizeLifecycleScript({
        script: 'scripts/setup.sh',
        name: 'Install agent-tui',
        optional: true,
      });
      expect(result).toEqual({
        script: 'scripts/setup.sh',
        name: 'Install agent-tui',
        optional: true,
      });
    });
  });

  // ---------------------------------------------------------------
  // Script execution
  // ---------------------------------------------------------------
  describe('runLifecycleScripts', () => {
    it('should run a single script successfully', async () => {
      await writeFile(join(testDir, 'marker.txt'), 'not yet');
      const result = await runLifecycleScripts(
        ['echo "hello" > marker.txt'],
        testDir,
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].exitCode).toBe(0);
      expect(result.results[0].name).toBe('echo "hello" > marker.txt');
    });

    it('should run multiple scripts in order', async () => {
      const result = await runLifecycleScripts(
        [
          'echo "first" > order.txt',
          'echo "second" >> order.txt',
        ],
        testDir,
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(true);

      const content = await Bun.file(join(testDir, 'order.txt')).text();
      expect(content).toBe('first\nsecond\n');
    });

    it('should stop on required script failure', async () => {
      const result = await runLifecycleScripts(
        [
          { script: 'exit 1', name: 'failing-script' },
          { script: 'echo "should not run" > skipped.txt', name: 'second' },
        ],
        testDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('failing-script');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].exitCode).toBe(1);
      expect(existsSync(join(testDir, 'skipped.txt'))).toBe(false);
    });

    it('should continue past optional script failure', async () => {
      await writeFile(join(testDir, 'marker.txt'), 'not yet');
      const result = await runLifecycleScripts(
        [
          { script: 'exit 1', name: 'optional-step', optional: true },
          { script: 'echo "ran" > marker.txt', name: 'required-step' },
        ],
        testDir,
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].name).toBe('optional-step');
      expect(result.results[1].success).toBe(true);
      expect(result.results[1].name).toBe('required-step');
    });

    it('should provide ALLAGENTS_WORKSPACE and ALLAGENTS_CONFIG_DIR env vars', async () => {
      const result = await runLifecycleScripts(
        ['echo "$ALLAGENTS_WORKSPACE" > ws.txt && echo "$ALLAGENTS_CONFIG_DIR" > cfg.txt'],
        testDir,
      );

      expect(result.success).toBe(true);
      const ws = (await Bun.file(join(testDir, 'ws.txt')).text()).trim();
      const cfg = (await Bun.file(join(testDir, 'cfg.txt')).text()).trim();
      expect(ws).toBe(testDir);
      expect(cfg).toBe(join(testDir, '.allagents'));
    });

    it('should capture stderr on failure', async () => {
      const result = await runLifecycleScripts(
        ['echo "error output" >&2 && exit 1'],
        testDir,
      );

      expect(result.success).toBe(false);
      expect(result.results[0].stderr).toContain('error output');
    });

    it('should handle empty script list', async () => {
      const result = await runLifecycleScripts([], testDir);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
    });

    it('should timeout long-running scripts', async () => {
      const result = await runLifecycleScripts(
        ['sleep 60'],
        testDir,
        { timeoutMs: 500 },
      );

      expect(result.success).toBe(false);
      expect(result.results[0].exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // Dry-run
  // ---------------------------------------------------------------
  describe('dry-run', () => {
    it('should not execute scripts in dry-run mode', async () => {
      const result = await runLifecycleScripts(
        ['echo "should not execute" > dryrun-marker.txt'],
        testDir,
        { dryRun: true },
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].skipped).toBe(true);
      expect(existsSync(join(testDir, 'dryrun-marker.txt'))).toBe(false);
    });

    it('should show all scripts in dry-run even if later ones would fail', async () => {
      const result = await runLifecycleScripts(
        [
          { script: 'echo ok', name: 'step-1' },
          { script: 'exit 1', name: 'step-2' },
          { script: 'echo ok', name: 'step-3' },
        ],
        testDir,
        { dryRun: true },
      );

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(3);
      for (const r of result.results) {
        expect(r.skipped).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------
  // Format output
  // ---------------------------------------------------------------
  describe('formatLifecycleResults', () => {
    it('should return empty for no results', () => {
      const lines = formatLifecycleResults('preSync', {
        results: [],
        success: true,
      });
      expect(lines).toHaveLength(0);
    });

    it('should format successful scripts', () => {
      const lines = formatLifecycleResults('preSync', {
        results: [
          {
            name: 'install-deps',
            script: 'npm install',
            success: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 150,
          },
        ],
        success: true,
      });
      expect(lines[0]).toContain('preSync');
      expect(lines[1]).toContain('install-deps');
      expect(lines[1]).toContain('150ms');
    });

    it('should format failed scripts with stderr', () => {
      const lines = formatLifecycleResults('preSync', {
        results: [
          {
            name: 'bad-script',
            script: 'exit 1',
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: 'something went wrong',
            durationMs: 50,
          },
        ],
        success: false,
        error: 'bad-script failed',
      });
      expect(lines[1]).toContain('bad-script');
      expect(lines[1]).toContain('exit code 1');
      expect(lines[2]).toContain('something went wrong');
    });

    it('should format dry-run skipped scripts', () => {
      const lines = formatLifecycleResults('preSync', {
        results: [
          {
            name: 'setup',
            script: './setup.sh',
            success: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 0,
            skipped: true,
          },
        ],
        success: true,
      });
      expect(lines[1]).toContain('dry-run');
      expect(lines[1]).toContain('setup');
    });
  });
});
