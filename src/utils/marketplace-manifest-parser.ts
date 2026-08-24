import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type MarketplaceFileArtifacts,
  type MarketplaceManifest,
  MarketplaceManifestLenientSchema,
  MarketplaceManifestSchema,
  type MarketplacePluginEntry,
  MarketplacePluginEntrySchema,
  type PluginSourceRef,
  PluginSourceRefSchema,
  getMarketplaceFileArtifacts,
} from '../models/marketplace-manifest.js';

const MANIFEST_PATHS = [
  '.github/plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
] as const;

export type ParseResult =
  | { success: true; data: MarketplaceManifest; warnings: string[] }
  | { success: false; error: string };

/**
 * Parse and validate a marketplace.json from a marketplace directory.
 * Prefers GitHub Copilot's marketplace location and falls back to Claude's.
 *
 * Uses a two-tier approach:
 * 1. Try strict validation first — if it passes, return with no warnings
 * 2. If strict fails, try lenient parsing — validate each plugin entry
 *    individually, collecting warnings for invalid fields/entries
 */
export async function parseMarketplaceManifest(
  marketplacePath: string,
): Promise<ParseResult> {
  const manifestPath = MANIFEST_PATHS.map((path) =>
    join(marketplacePath, path),
  ).find((path) => existsSync(path));

  if (!manifestPath) {
    return {
      success: false,
      error: `Marketplace manifest not found (checked ${MANIFEST_PATHS.join(', ')})`,
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
 * Parse only strictly valid, repository-local entries from a catalog
 * marketplace. Object sources describe independent remote distributions and
 * are deliberately excluded: catalog installation must not widen to them.
 */
export async function parseCatalogLocalMarketplaceManifest(
  marketplacePath: string,
): Promise<ParseResult> {
  const manifestPath = MANIFEST_PATHS.map((path) =>
    join(marketplacePath, path),
  ).find((path) => existsSync(path));
  if (!manifestPath) {
    return {
      success: false,
      error: `Marketplace manifest not found (checked ${MANIFEST_PATHS.join(', ')})`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(await readFile(manifestPath, 'utf-8'));
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof SyntaxError
          ? 'Failed to parse marketplace.json as JSON: invalid syntax'
          : `Failed to read marketplace manifest: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const manifest = MarketplaceManifestLenientSchema.safeParse(json);
  if (!manifest.success) {
    return {
      success: false,
      error: 'Marketplace manifest must contain a "plugins" array',
    };
  }

  const plugins: MarketplacePluginEntry[] = [];
  for (let index = 0; index < manifest.data.plugins.length; index++) {
    const rawPlugin = manifest.data.plugins[index];
    if (
      typeof rawPlugin === 'object' &&
      rawPlugin !== null &&
      'source' in rawPlugin &&
      typeof rawPlugin.source !== 'string'
    ) {
      continue;
    }
    const plugin = MarketplacePluginEntrySchema.safeParse(rawPlugin);
    if (!plugin.success || typeof plugin.data.source !== 'string') {
      return {
        success: false,
        error: `Local marketplace plugin at index ${index} is invalid.`,
      };
    }
    plugins.push(plugin.data);
  }

  const rawManifest = json as Record<string, unknown>;
  return {
    success: true,
    data: {
      name:
        typeof manifest.data.name === 'string' ? manifest.data.name : 'unknown',
      description:
        typeof rawManifest.description === 'string'
          ? rawManifest.description
          : '',
      plugins,
    },
    warnings: [],
  };
}

/**
 * Read a plugin repository's own marketplace manifest and return the file
 * artifact boundary for the entry whose source is the repository root.
 *
 * A preferred name disambiguates repositories that expose multiple root
 * entries. When there is only one root entry, it is safe to use for direct
 * repository sources whose directory name differs from the plugin name.
 */
export async function getEmbeddedMarketplaceFileArtifacts(
  pluginPath: string,
  preferredName?: string,
): Promise<MarketplaceFileArtifacts | undefined> {
  const manifestResult = await parseMarketplaceManifest(pluginPath);
  if (!manifestResult.success) return undefined;

  const pluginRoot = resolve(pluginPath);
  const rootEntries = manifestResult.data.plugins.filter(
    (entry) =>
      typeof entry.source === 'string' &&
      resolve(pluginPath, entry.source) === pluginRoot,
  );
  const entry =
    rootEntries.find((candidate) => candidate.name === preferredName) ??
    (rootEntries.length === 1 ? rootEntries[0] : undefined);

  return entry ? getMarketplaceFileArtifacts(entry) : undefined;
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
    description:
      typeof obj.description === 'string' ? (obj.description as string) : '',
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
    description = (obj.metadata as Record<string, unknown>)
      .description as string;
    warnings.push(
      `plugins[${index}] ("${name}"): "description" found in metadata instead of top level`,
    );
  } else {
    warnings.push(`plugins[${index}] ("${name}"): missing "description" field`);
  }

  // Try to extract and normalize source via the schema (handles string, url, github→url transform)
  let source: PluginSourceRef = '';
  const sourceResult = PluginSourceRefSchema.safeParse(obj.source);
  if (sourceResult.success) {
    source = sourceResult.data;
  } else {
    warnings.push(
      `plugins[${index}] ("${name}"): missing or invalid "source" field`,
    );
  }

  return {
    name,
    description,
    source,
    ...(typeof obj.version === 'string' && { version: obj.version }),
    ...(typeof obj.category === 'string' && { category: obj.category }),
    ...(typeof obj.homepage === 'string' && { homepage: obj.homepage }),
    ...(isComponentPath(obj.skills) && { skills: obj.skills }),
    ...(isComponentPath(obj.commands) && { commands: obj.commands }),
    ...(isComponentPath(obj.agents) && { agents: obj.agents }),
    ...((typeof obj.hooks === 'string' || isRecord(obj.hooks)) && {
      hooks: obj.hooks,
    }),
    ...((typeof obj.mcpServers === 'string' || isRecord(obj.mcpServers)) && {
      mcpServers: obj.mcpServers,
    }),
    ...(typeof obj.strict === 'boolean' && { strict: obj.strict }),
  };
}

function isComponentPath(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
