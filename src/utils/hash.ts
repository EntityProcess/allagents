import { createHash } from 'node:crypto';

/**
 * Generate a deterministic 6-character short ID from a string
 *
 * This is used for local path disambiguation when multiple plugins have
 * skills with the same folder name AND the same plugin name. The short ID
 * provides a stable identifier derived from the full path.
 *
 * @param input - The string to hash (typically a file path)
 * @returns A 6-character hexadecimal string
 */
export function getShortId(input: string): string {
  return createHash('sha256').update(input).digest('hex').substring(0, 6);
}
