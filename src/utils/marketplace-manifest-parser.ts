import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MarketplaceManifestSchema,
  type MarketplaceManifest,
  type PluginSourceRef,
} from '../models/marketplace-manifest.js';

const MANIFEST_PATH = '.claude-plugin/marketplace.json';

export type ParseResult =
  | { success: true; data: MarketplaceManifest }
  | { success: false; error: string };

/**
 * Parse and validate a marketplace.json from a marketplace directory.
 * Looks for .claude-plugin/marketplace.json within the given path.
 */
export async function parseMarketplaceManifest(
  marketplacePath: string,
): Promise<ParseResult> {
  const manifestPath = join(marketplacePath, MANIFEST_PATH);

  if (!existsSync(manifestPath)) {
    return {
      success: false,
      error: `Marketplace manifest not found: ${manifestPath}`,
    };
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: `Failed to read marketplace manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error: `Failed to parse marketplace.json as JSON: invalid syntax`,
    };
  }

  const result = MarketplaceManifestSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    return {
      success: false,
      error: `Marketplace manifest validation failed:\n${issues}`,
    };
  }

  return { success: true, data: result.data };
}

/**
 * Resolve a plugin source reference to a usable path.
 *
 * - String sources (relative paths like "./plugins/foo") are resolved
 *   relative to the marketplace directory.
 * - URL source objects return the URL string directly.
 */
export function resolvePluginSourcePath(
  source: PluginSourceRef,
  marketplacePath: string,
): string {
  if (typeof source === 'object') {
    return source.url;
  }
  return resolve(marketplacePath, source);
}
