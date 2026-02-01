import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Find and read the nearest package.json by walking up from the caller's location.
 * Works regardless of whether the caller is in src/cli/ (dev) or dist/ (built).
 */
export function findPackageJson(callerUrl: string): { version: string; [key: string]: unknown } {
  let dir = dirname(fileURLToPath(callerUrl));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf-8'));
    }
    dir = dirname(dir);
  }
  throw new Error('package.json not found');
}
