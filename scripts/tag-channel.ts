#!/usr/bin/env bun
/**
 * Manage npm dist-tags for the allagents package.
 *
 * Usage:
 *   bun scripts/tag-channel.ts <next|latest> [version]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

type DistTag = 'next' | 'latest';

const VALID_TAGS: DistTag[] = ['next', 'latest'];

function parseArgs(argv: readonly string[]): { tag: DistTag; version?: string } {
  const tag = argv[2];
  const version = argv[3];

  if (!tag) {
    throw new Error('Missing dist-tag. Usage: bun scripts/tag-channel.ts <next|latest> [version]');
  }

  if (!VALID_TAGS.includes(tag as DistTag)) {
    throw new Error(`Invalid dist-tag: ${tag}. Valid options: ${VALID_TAGS.join(', ')}`);
  }

  return { tag: tag as DistTag, version };
}

async function main() {
  const { tag, version: requestedVersion } = parseArgs(process.argv);

  const pkgPath = resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string };
  const targetVersion = requestedVersion ?? pkg.version;
  const spec = `${pkg.name}@${targetVersion}`;

  console.log(`🏷️  Tagging npm dist-tag '${tag}' -> ${targetVersion}\n`);
  console.log(`• ${spec}`);
  await $`npm dist-tag add ${spec} ${tag}`.quiet();

  console.log('\n✅ Updated npm dist-tag.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ ${message}`);
  process.exit(1);
});
