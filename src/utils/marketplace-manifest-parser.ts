import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MarketplaceManifestSchema,
  MarketplaceManifestLenientSchema,
  MarketplacePluginEntrySchema,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type PluginSourceRef,
} from '../models/marketplace-manifest.js';

const MANIFEST_PATH = '.claude-plugin/marketplace.json';

export type ParseResult =
  | { success: true; data: MarketplaceManifest; warnings: string[] }
  | { success: false; error: string };

/**
 * Parse and validate a marketplace.json from a marketplace directory.
 * Looks for .claude-plugin/marketplace.json within the given path.
 *
 * Uses a two-tier approach:
 * 1. Try strict validation first — if it passes, return with no warnings
 * 2. If strict fails, try lenient parsing — validate each plugin entry
 *    individually, collecting warnings for invalid fields/entries
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
      error: 'Failed to parse marketplace.json as JSON: invalid syntax',
    };
  }

  // Tier 1: strict validation
  const strictResult = MarketplaceManifestSchema.safeParse(json);
  if (strictResult.success) {
    return { success: true, data: strictResult.data, warnings: [] };
  }

  // Tier 2: lenient parsing
  return parseLeniently(json);
}

/**
 * Attempt lenient parsing of a marketplace manifest.
 * Requires at minimum a `plugins` array in the JSON.
 * Validates each plugin entry individually, collecting warnings.
 */
function parseLeniently(json: unknown): ParseResult {
  const lenientResult = MarketplaceManifestLenientSchema.safeParse(json);
  if (!lenientResult.success) {
    return {
      success: false,
      error: 'Marketplace manifest must contain a "plugins" array',
    };
  }

  const raw = lenientResult.data;
  const warnings: string[] = [];

  const obj = json as Record<string, unknown>;

  // Validate each plugin entry individually
  const validPlugins: MarketplacePluginEntry[] = [];

  for (let i = 0; i < raw.plugins.length; i++) {
    const entry = raw.plugins[i];
    const entryResult = MarketplacePluginEntrySchema.safeParse(entry);

    if (entryResult.success) {
      validPlugins.push(entryResult.data);
      continue;
    }

    // Best-effort extraction
    const extracted = extractPluginEntry(entry, i, warnings);
    if (extracted) {
      validPlugins.push(extracted);
    }
  }

  // Build a manifest-like object with the valid plugins
  const data: MarketplaceManifest = {
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    description: typeof obj.description === 'string' ? obj.description as string : '',
    plugins: validPlugins,
  };

  return { success: true, data, warnings };
}

/**
 * Best-effort extraction of a plugin entry from raw data.
 * Returns null only if the entry is completely unusable (not an object).
 */
function extractPluginEntry(
  entry: unknown,
  index: number,
  warnings: string[],
): MarketplacePluginEntry | null {
  if (!entry || typeof entry !== 'object') {
    warnings.push(`plugins[${index}]: not an object, skipped`);
    return null;
  }

  const obj = entry as Record<string, unknown>;

  const name = typeof obj.name === 'string' && obj.name ? obj.name : undefined;
  if (!name) {
    warnings.push(`plugins[${index}]: missing "name" field, skipped`);
    return null;
  }

  // Try to extract description from common locations
  let description = '';
  if (typeof obj.description === 'string' && obj.description) {
    description = obj.description;
  } else if (
    obj.metadata &&
    typeof obj.metadata === 'object' &&
    typeof (obj.metadata as Record<string, unknown>).description === 'string'
  ) {
    description = (obj.metadata as Record<string, unknown>).description as string;
    warnings.push(`plugins[${index}] ("${name}"): "description" found in metadata instead of top level`);
  } else {
    warnings.push(`plugins[${index}] ("${name}"): missing "description" field`);
  }

  // Try to extract source
  let source: PluginSourceRef = '';
  if (typeof obj.source === 'string') {
    source = obj.source;
  } else if (
    obj.source &&
    typeof obj.source === 'object' &&
    (obj.source as Record<string, unknown>).source === 'url' &&
    typeof (obj.source as Record<string, unknown>).url === 'string'
  ) {
    source = obj.source as { source: 'url'; url: string };
  } else {
    warnings.push(`plugins[${index}] ("${name}"): missing or invalid "source" field`);
  }

  return {
    name,
    description,
    source,
    ...(typeof obj.version === 'string' && { version: obj.version }),
    ...(typeof obj.category === 'string' && { category: obj.category }),
    ...(typeof obj.homepage === 'string' && { homepage: obj.homepage }),
  };
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
