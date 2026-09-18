import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const publishScript = join(import.meta.dir, '..', '..', '..', 'scripts', 'publish.ts');

type PublishScenario = {
  npmTag: 'next' | 'latest';
  version: string;
  publishedVersion?: string;
  distTags: Record<string, string>;
};

async function runPublish(scenario: PublishScenario) {
  const root = await mkdtemp(join(tmpdir(), 'allagents-publish-'));
  const binDir = join(root, 'bin');
  const callsPath = join(root, 'npm-calls.jsonl');
  const fakeNpmPath = join(root, 'fake-npm.ts');

  try {
    await mkdir(binDir);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'allagents', version: scenario.version }),
    );
    await writeFile(
      fakeNpmPath,
      `import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.NPM_CALLS!, JSON.stringify(args) + '\\n');

if (args[0] === 'view' && args[1]?.includes('@')) {
  const publishedVersion = process.env.FAKE_PUBLISHED_VERSION;
  if (!publishedVersion) {
    console.error('E404');
    process.exit(1);
  }
  console.log(JSON.stringify(publishedVersion));
  process.exit(0);
}

if (args[0] === 'view' && args[2] === 'dist-tags') {
  console.log(process.env.FAKE_DIST_TAGS || '{}');
  process.exit(0);
}

if (args[0] === 'publish') process.exit(0);
if (args[0] === 'dist-tag') {
  console.error('dist-tag mutation must not run');
  process.exit(91);
}

console.error('Unexpected npm call: ' + args.join(' '));
process.exit(92);
`,
    );

    if (process.platform === 'win32') {
      await writeFile(
        join(binDir, 'npm.cmd'),
        '@"%BUN_EXECUTABLE%" "%FAKE_NPM_SCRIPT%" %*\r\n',
      );
    } else {
      const launcher = join(binDir, 'npm');
      await writeFile(
        launcher,
        '#!/bin/sh\nexec "$BUN_EXECUTABLE" "$FAKE_NPM_SCRIPT" "$@"\n',
      );
      await chmod(launcher, 0o755);
    }

    const result = Bun.spawnSync(
      [process.execPath, 'run', publishScript, scenario.npmTag],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          BUN_EXECUTABLE: process.execPath,
          FAKE_NPM_SCRIPT: fakeNpmPath,
          NPM_CALLS: callsPath,
          FAKE_PUBLISHED_VERSION: scenario.publishedVersion ?? '',
          FAKE_DIST_TAGS: JSON.stringify(scenario.distTags),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('npm publishing', () => {
  for (const scenario of [
    {
      npmTag: 'next' as const,
      version: '1.14.0-next.1',
      distTags: { next: '1.13.9-next.1', latest: '1.13.9' },
    },
    {
      npmTag: 'latest' as const,
      version: '1.14.0',
      distTags: { next: '1.14.0-next.1', latest: '1.13.9' },
    },
  ]) {
    test(`publishes ${scenario.npmTag} without a redundant dist-tag mutation`, async () => {
      const result = await runPublish(scenario);

      expect(result.exitCode).toBe(0);
      expect(result.calls).toContainEqual(['publish', '--tag', scenario.npmTag]);
      expect(result.calls.some(([command]) => command === 'dist-tag')).toBe(false);
    });
  }

  test('rejects a mismatched tag on retry without mutating npm', async () => {
    const result = await runPublish({
      npmTag: 'next',
      version: '1.14.0-next.1',
      publishedVersion: '1.14.0-next.1',
      distTags: { next: '1.13.9-next.1', latest: '1.13.9' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'allagents@1.14.0-next.1 is already published, but next points to 1.13.9-next.1',
    );
    expect(result.calls.some(([command]) => command === 'dist-tag')).toBe(false);
  });
});
