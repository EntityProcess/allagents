import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

/**
 * Source types for marketplaces
 */
export type MarketplaceSourceType = 'github' | 'local';

/**
 * Source configuration for a marketplace
 */
export interface MarketplaceSource {
  type: MarketplaceSourceType;
  /** GitHub: "owner/repo", Local: absolute path */
  location: string;
}

/**
 * Marketplace entry in registry
 */
export interface MarketplaceEntry {
  name: string;
  source: MarketplaceSource;
  /** Local path where marketplace is stored (for GitHub) or linked (for local) */
  path: string;
  lastUpdated?: string;
}

/**
 * Marketplace registry structure
 */
export interface MarketplaceRegistry {
  version: 1;
  marketplaces: Record<string, MarketplaceEntry>;
}

/**
 * Result of marketplace operations
 */
export interface MarketplaceResult {
  success: boolean;
  marketplace?: MarketplaceEntry;
  error?: string;
}

/**
 * Well-known marketplace mappings (name → GitHub repo)
 */
const WELL_KNOWN_MARKETPLACES: Record<string, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
};

/**
 * Get the allagents config directory
 */
export function getAllagentsDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '~';
  return resolve(homeDir, '.allagents');
}

/**
 * Get the marketplaces directory
 */
export function getMarketplacesDir(): string {
  return join(getAllagentsDir(), 'marketplaces');
}

/**
 * Get the registry file path
 */
export function getRegistryPath(): string {
  return join(getAllagentsDir(), 'marketplaces.json');
}

/**
 * Load marketplace registry from disk
 */
export async function loadRegistry(): Promise<MarketplaceRegistry> {
  const registryPath = getRegistryPath();

  if (!existsSync(registryPath)) {
    return { version: 1, marketplaces: {} };
  }

  try {
    const content = await readFile(registryPath, 'utf-8');
    return JSON.parse(content) as MarketplaceRegistry;
  } catch {
    return { version: 1, marketplaces: {} };
  }
}

/**
 * Save marketplace registry to disk
 */
export async function saveRegistry(registry: MarketplaceRegistry): Promise<void> {
  const registryPath = getRegistryPath();
  const dir = getAllagentsDir();

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Parse a marketplace source string
 * Supports:
 * - GitHub URL: https://github.com/owner/repo
 * - GitHub shorthand: owner/repo
 * - Local path: /absolute/path or ./relative/path
 * - Well-known name: claude-plugins-official
 */
export function parseMarketplaceSource(source: string): {
  type: MarketplaceSourceType;
  location: string;
  name: string;
} | null {
  // Well-known marketplace names
  if (WELL_KNOWN_MARKETPLACES[source]) {
    return {
      type: 'github',
      location: WELL_KNOWN_MARKETPLACES[source],
      name: source,
    };
  }

  // GitHub URL
  if (source.startsWith('https://github.com/')) {
    const match = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      const [, owner, repo] = match;
      return {
        type: 'github',
        location: `${owner}/${repo}`,
        name: repo!.replace(/\.git$/, ''),
      };
    }
    return null;
  }

  // Local path (absolute or relative starting with . or /)
  if (source.startsWith('/') || source.startsWith('.')) {
    const absPath = resolve(source);
    const name = absPath.split('/').pop() || 'local';
    return {
      type: 'local',
      location: absPath,
      name,
    };
  }

  // GitHub shorthand: owner/repo (exactly one slash, no dots at start)
  if (source.includes('/') && !source.includes('://')) {
    const parts = source.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return {
        type: 'github',
        location: source,
        name: parts[1],
      };
    }
  }

  return null;
}

/**
 * Add a marketplace to the registry
 * @param source - Marketplace source (URL, path, or name)
 * @param customName - Optional custom name for the marketplace
 */
export async function addMarketplace(
  source: string,
  customName?: string,
): Promise<MarketplaceResult> {
  const parsed = parseMarketplaceSource(source);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid marketplace source: ${source}\n  Use: GitHub URL, owner/repo, local path, or well-known name`,
    };
  }

  const name = customName || parsed.name;
  const registry = await loadRegistry();

  // Check if already exists
  if (registry.marketplaces[name]) {
    return {
      success: false,
      error: `Marketplace '${name}' already exists. Use 'update' to refresh it.`,
    };
  }

  let marketplacePath: string;

  if (parsed.type === 'github') {
    // Clone GitHub repository
    marketplacePath = join(getMarketplacesDir(), name);

    // Check if gh CLI is available
    try {
      await execa('gh', ['--version']);
    } catch {
      return {
        success: false,
        error: 'gh CLI not installed\n  Install: https://cli.github.com',
      };
    }

    // Ensure parent directory exists
    const parentDir = getMarketplacesDir();
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }

    // Clone repository
    try {
      await execa('gh', ['repo', 'clone', parsed.location, marketplacePath]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
        return {
          success: false,
          error: `Repository not found: ${parsed.location}`,
        };
      }
      return {
        success: false,
        error: `Failed to clone marketplace: ${msg}`,
      };
    }
  } else {
    // Local directory - just verify it exists
    marketplacePath = parsed.location;
    if (!existsSync(marketplacePath)) {
      return {
        success: false,
        error: `Local directory not found: ${marketplacePath}`,
      };
    }
  }

  // Create entry
  const entry: MarketplaceEntry = {
    name,
    source: {
      type: parsed.type,
      location: parsed.location,
    },
    path: marketplacePath,
    lastUpdated: new Date().toISOString(),
  };

  // Save to registry
  registry.marketplaces[name] = entry;
  await saveRegistry(registry);

  return {
    success: true,
    marketplace: entry,
  };
}

/**
 * Remove a marketplace from the registry
 * Note: Does not delete cloned files
 */
export async function removeMarketplace(name: string): Promise<MarketplaceResult> {
  const registry = await loadRegistry();

  if (!registry.marketplaces[name]) {
    return {
      success: false,
      error: `Marketplace '${name}' not found in registry`,
    };
  }

  const entry = registry.marketplaces[name];
  delete registry.marketplaces[name];
  await saveRegistry(registry);

  return {
    success: true,
    marketplace: entry,
  };
}

/**
 * List all registered marketplaces
 */
export async function listMarketplaces(): Promise<MarketplaceEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.marketplaces).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Get a marketplace by name
 */
export async function getMarketplace(name: string): Promise<MarketplaceEntry | null> {
  const registry = await loadRegistry();
  return registry.marketplaces[name] || null;
}

/**
 * Update marketplace(s) by pulling latest changes
 * @param name - Optional marketplace name (updates all if not specified)
 */
export async function updateMarketplace(
  name?: string,
): Promise<Array<{ name: string; success: boolean; error?: string }>> {
  const registry = await loadRegistry();
  const results: Array<{ name: string; success: boolean; error?: string }> = [];

  const toUpdate = name
    ? registry.marketplaces[name]
      ? [registry.marketplaces[name]]
      : []
    : Object.values(registry.marketplaces);

  if (name && toUpdate.length === 0) {
    return [{ name, success: false, error: `Marketplace '${name}' not found` }];
  }

  for (const marketplace of toUpdate) {
    if (marketplace.source.type === 'local') {
      // Local marketplaces don't need updating
      results.push({
        name: marketplace.name,
        success: true,
      });
      continue;
    }

    // GitHub marketplace - git pull
    if (!existsSync(marketplace.path)) {
      results.push({
        name: marketplace.name,
        success: false,
        error: `Marketplace directory not found: ${marketplace.path}`,
      });
      continue;
    }

    try {
      await execa('git', ['pull'], { cwd: marketplace.path });

      // Update lastUpdated in registry
      marketplace.lastUpdated = new Date().toISOString();
      registry.marketplaces[marketplace.name] = marketplace;

      results.push({
        name: marketplace.name,
        success: true,
      });
    } catch (error) {
      results.push({
        name: marketplace.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Save updated timestamps
  await saveRegistry(registry);

  return results;
}

/**
 * Get the path to a marketplace
 */
export async function getMarketplacePath(name: string): Promise<string | null> {
  const marketplace = await getMarketplace(name);
  return marketplace?.path || null;
}

/**
 * List plugins available in a marketplace
 */
export async function listMarketplacePlugins(
  name: string,
): Promise<Array<{ name: string; path: string }>> {
  const marketplace = await getMarketplace(name);
  if (!marketplace) {
    return [];
  }

  const pluginsDir = join(marketplace.path, 'plugins');
  if (!existsSync(pluginsDir)) {
    // Marketplace might not have plugins subdirectory (it IS the plugin)
    return [];
  }

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: join(pluginsDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Resolve a plugin@marketplace spec to a local path
 * @param spec - Plugin spec (e.g., "code-review@claude-plugins-official")
 * @returns Local path to plugin directory, or null if not found
 */
export async function resolvePluginSpec(
  spec: string,
): Promise<{ path: string; marketplace: string; plugin: string } | null> {
  // Parse plugin@marketplace format
  const atIndex = spec.lastIndexOf('@');
  if (atIndex === -1) {
    return null;
  }

  const pluginName = spec.slice(0, atIndex);
  const marketplaceName = spec.slice(atIndex + 1);

  if (!pluginName || !marketplaceName) {
    return null;
  }

  const marketplace = await getMarketplace(marketplaceName);
  if (!marketplace) {
    return null;
  }

  // Plugin path is: <marketplace>/plugins/<plugin-name>/
  const pluginPath = join(marketplace.path, 'plugins', pluginName);

  if (!existsSync(pluginPath)) {
    return null;
  }

  return {
    path: pluginPath,
    marketplace: marketplaceName,
    plugin: pluginName,
  };
}

/**
 * Check if a spec is in plugin@marketplace format
 */
export function isPluginSpec(spec: string): boolean {
  const atIndex = spec.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === spec.length - 1) {
    return false;
  }
  return true;
}

/**
 * Get well-known marketplace names
 */
export function getWellKnownMarketplaces(): Record<string, string> {
  return { ...WELL_KNOWN_MARKETPLACES };
}
