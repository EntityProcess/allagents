import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { executeCommand, mergeNativeSyncResults } from '../../../../src/core/native/types.js';
import type { NativeSyncResult } from '../../../../src/core/native/types.js';

describe('native/types', () => {
  describe('executeCommand', () => {
    test.skipIf(process.platform !== 'win32')(
      'preserves npm shim behavior without DEP0190 on Windows',
      async () => {
        const tempDir = mkdtempSync(
          join(tmpdir(), 'allagents-execute-command-'),
        );
        const scriptDir = join(tempDir, 'node_modules', 'test-cli');
        const scriptPath = join(scriptDir, 'print-argv.cjs');
        const shimPath = join(tempDir, 'argv-recorder.cmd');
        const runnerPath = join(tempDir, 'run-execute-command.mjs');
        const args = [
          'value with spaces',
          'literal&operator',
          'literal|pipe',
          'literal;separator',
          'literal^caret',
          'literal%PATH%',
          'literal"quote',
          '',
          'trailing\\',
          'backslash\\"quote',
          'literal\r\nnewline',
        ];

        try {
          mkdirSync(scriptDir, { recursive: true });
          writeFileSync(
            scriptPath,
            [
              '#!/usr/bin/env node',
              "const runtime = typeof Bun === 'undefined' ? 'node' : 'bun';",
              'const args = process.argv.slice(2);',
              'process.stdout.write(JSON.stringify({ runtime, args }));',
            ].join('\n'),
          );
          writeFileSync(
            shimPath,
            '@ECHO off\r\nnode "%~dp0\\node_modules\\test-cli\\print-argv.cjs" %*\r\n',
          );

          const bundle = await Bun.build({
            entrypoints: [
              join(import.meta.dir, '../../../../src/core/native/types.ts'),
            ],
            outdir: tempDir,
            target: 'node',
            format: 'esm',
          });
          expect(bundle.success).toBe(true);
          writeFileSync(
            runnerPath,
            [
              "import { executeCommand } from './types.js';",
              "const args = JSON.parse(process.env.ALLAGENTS_TEST_ARGS ?? '[]');",
              "const result = await executeCommand('argv-recorder', args);",
              'process.stdout.write(JSON.stringify(result));',
            ].join('\n'),
          );

          const runtimes = [
            ['node', '--trace-deprecation'],
            [process.execPath],
          ];
          const env = { ...process.env };
          const pathKey =
            Object.keys(env).find((key) => key.toLowerCase() === 'path') ??
            'PATH';
          env[pathKey] =
            `${tempDir}${delimiter}${env[pathKey] ?? ''}`;

          for (const runtime of runtimes) {
            const proc = Bun.spawnSync([...runtime, runnerPath], {
              cwd: tempDir,
              env: {
                ...env,
                ALLAGENTS_TEST_ARGS: JSON.stringify(args),
              },
              stdout: 'pipe',
              stderr: 'pipe',
            });
            const stdout = new TextDecoder().decode(proc.stdout);
            const stderr = new TextDecoder().decode(proc.stderr);

            expect(proc.exitCode).toBe(0);
            expect(stderr).toBe('');
            expect(JSON.parse(stdout)).toEqual({
              success: true,
              output: JSON.stringify({ runtime: 'node', args }),
            });
          }
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
      15_000,
    );
  });

  describe('mergeNativeSyncResults', () => {
    test('merges two results', () => {
      const a: NativeSyncResult = {
        marketplacesAdded: ['a/repo'],
        pluginsInstalled: [{ plugin: 'p1@repo', client: 'claude' }],
        pluginsFailed: [],
        skipped: [],
      };
      const b: NativeSyncResult = {
        marketplacesAdded: ['b/repo'],
        pluginsInstalled: [{ plugin: 'p2@repo', client: 'copilot' }],
        pluginsFailed: [{ plugin: 'p3@repo', error: 'fail' }],
        skipped: ['local-plugin'],
      };
      const merged = mergeNativeSyncResults([a, b]);
      expect(merged.marketplacesAdded).toEqual(['a/repo', 'b/repo']);
      expect(merged.pluginsInstalled).toEqual([
        { plugin: 'p1@repo', client: 'claude' },
        { plugin: 'p2@repo', client: 'copilot' },
      ]);
      expect(merged.pluginsFailed).toEqual([{ plugin: 'p3@repo', error: 'fail' }]);
      expect(merged.skipped).toEqual(['local-plugin']);
    });

    test('returns empty result for empty array', () => {
      const merged = mergeNativeSyncResults([]);
      expect(merged.marketplacesAdded).toEqual([]);
      expect(merged.pluginsInstalled).toEqual([]);
      expect(merged.pluginsFailed).toEqual([]);
      expect(merged.skipped).toEqual([]);
    });
  });
});
