import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execa } from 'execa';
import {
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../utils/marketplace-manifest-parser.js';

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

  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
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
      if (!repo) return null;
      return {
        type: 'github',
        location: `${owner}/${repo}`,
        name: repo.replace(/\.git$/, ''),
      };
    }
    return null;
  }

  // Local path (absolute or relative starting with . or /)
  if (source.startsWith('/') || source.startsWith('.')) {
    const absPath = resolve(source);
    const name = basename(absPath) || 'local';
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

  let name = customName || parsed.name;
  const registry = await loadRegistry();

  // For initial duplicate check, use the pre-manifest name
  // (will re-check after manifest is read if name changes)
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

    // Check if directory already exists (from a previous partial registration)
    if (existsSync(marketplacePath)) {
      // Directory exists - just register it without cloning
      // This handles the case where clone succeeded but registry wasn't updated
    } else {
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

  // Read manifest to get canonical name (overrides repo/directory name)
  if (!customName) {
    const manifestResult = await parseMarketplaceManifest(marketplacePath);
    if (manifestResult.success && manifestResult.data.name) {
      const manifestName = manifestResult.data.name;
      if (manifestName !== name) {
        // If the manifest name is already registered, return the existing entry
        const existing = registry.marketplaces[manifestName];
        if (existing) {
          return {
            success: true,
            marketplace: existing,
          };
        }
        name = manifestName;
      }
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
 * Plugin info returned from marketplace discovery
 */
export interface MarketplacePluginInfo {
  name: string;
  path: string;
  description?: string;
  category?: string;
  homepage?: string;
  source?: string;
}

/**
 * Get plugins from a marketplace directory using its manifest.
 * Returns an empty array if no manifest is found.
 */
export async function getMarketplacePluginsFromManifest(
  marketplacePath: string,
): Promise<MarketplacePluginInfo[]> {
  const result = await parseMarketplaceManifest(marketplacePath);
  if (!result.success) {
    return [];
  }

  return result.data.plugins.map((plugin) => {
    const resolvedSource = resolvePluginSourcePath(plugin.source, marketplacePath);
    const info: MarketplacePluginInfo = {
      name: plugin.name,
      path: typeof plugin.source === 'string' ? resolve(marketplacePath, plugin.source) : resolvedSource,
      description: plugin.description,
      source: resolvedSource,
    };
    if (plugin.category) info.category = plugin.category;
    if (plugin.homepage) info.homepage = plugin.homepage;
    return info;
  });
}

/**
 * List plugins available in a marketplace.
 * Prefers .claude-plugin/marketplace.json when available,
 * falls back to scanning the plugins/ directory.
 */
export async function listMarketplacePlugins(
  name: string,
): Promise<MarketplacePluginInfo[]> {
  const marketplace = await getMarketplace(name);
  if (!marketplace) {
    return [];
  }

  // Try manifest first
  const manifestPlugins = await getMarketplacePluginsFromManifest(marketplace.path);
  if (manifestPlugins.length > 0) {
    return manifestPlugins;
  }

  // Fall back to directory scanning
  const pluginsDir = join(marketplace.path, 'plugins');
  if (!existsSync(pluginsDir)) {
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
 * Parse a plugin@marketplace spec into components
 * Supports:
 * - plugin@marketplace-name
 * - plugin@owner/repo
 * - plugin@owner/repo/subpath
 *
 * @param spec - Plugin spec string
 * @returns Parsed components or null if invalid
 */
export function parsePluginSpec(spec: string): {
  plugin: string;
  marketplaceName: string;
  owner?: string;
  repo?: string;
  subpath?: string;
} | null {
  const atIndex = spec.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === spec.length - 1) {
    return null;
  }

  const plugin = spec.slice(0, atIndex);
  const marketplacePart = spec.slice(atIndex + 1);

  if (!plugin || !marketplacePart) {
    return null;
  }

  // Check if it's owner/repo or owner/repo/subpath format
  if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
    const parts = marketplacePart.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const owner = parts[0];
      const repo = parts[1];
      const subpath = parts.length > 2 ? parts.slice(2).join('/') : undefined;

      return {
        plugin,
        marketplaceName: repo, // Marketplace is registered by repo name
        owner,
        repo,
        ...(subpath && { subpath }),
      };
    }
  }

  // Simple marketplace name (e.g., "claude-plugins-official")
  return {
    plugin,
    marketplaceName: marketplacePart,
  };
}

/**
 * Resolve a plugin@marketplace spec to a local path
 * Supports:
 * - plugin@marketplace-name (looks in plugins/ subdir)
 * - plugin@owner/repo (looks in plugins/ subdir)
 * - plugin@owner/repo/subpath (looks in subpath/ subdir)
 *
 * Resolution order:
 * 1. If marketplace has a manifest, look up plugin by name in manifest entries
 * 2. Fall back to directory-based lookup: <marketplace>/<subpath>/<plugin-name>/
 *
 * @param spec - Plugin spec (e.g., "code-review@claude-plugins-official")
 * @param options - Resolution options
 * @returns Local path to plugin directory, or null if not found
 */
export async function resolvePluginSpec(
  spec: string,
  options: { subpath?: string; marketplaceNameOverride?: string } = {},
): Promise<{ path: string; marketplace: string; plugin: string } | null> {
  const parsed = parsePluginSpec(spec);
  if (!parsed) {
    return null;
  }

  // Use override name if provided (e.g., when manifest changed the marketplace name)
  const marketplaceName = options.marketplaceNameOverride ?? parsed.marketplaceName;
  const marketplace = await getMarketplace(marketplaceName);
  if (!marketplace) {
    return null;
  }

  // Try manifest-based resolution first: look up plugin name in manifest entries
  const manifestResult = await parseMarketplaceManifest(marketplace.path);
  if (manifestResult.success) {
    const pluginEntry = manifestResult.data.plugins.find(
      (p) => p.name === parsed.plugin,
    );
    if (pluginEntry) {
      const resolvedSource = typeof pluginEntry.source === 'string'
        ? resolve(marketplace.path, pluginEntry.source)
        : pluginEntry.source.url;
      if (typeof resolvedSource === 'string' && existsSync(resolvedSource)) {
        return {
          path: resolvedSource,
          marketplace: marketplaceName,
          plugin: parsed.plugin,
        };
      }
    }
  }

  // Fall back to directory-based lookup
  const subpath = options.subpath ?? parsed.subpath ?? 'plugins';
  const pluginPath = join(marketplace.path, subpath, parsed.plugin);

  if (!existsSync(pluginPath)) {
    return null;
  }

  return {
    path: pluginPath,
    marketplace: marketplaceName,
    plugin: parsed.plugin,
  };
}

/**
 * Result of resolving a plugin spec with auto-registration
 */
export interface ResolvePluginSpecResult {
  success: boolean;
  path?: string;
  pluginName?: string;
  registeredAs?: string;
  error?: string;
}

/**
 * Resolve a plugin@marketplace spec with auto-registration support
 *
 * Auto-registration rules:
 * 1. Well-known marketplace name → auto-register from known GitHub repo
 * 2. plugin@owner/repo format → auto-register owner/repo as marketplace
 * 3. plugin@owner/repo/subpath → auto-register owner/repo, look in subpath/
 * 4. Unknown short name → error with helpful message
 */
export async function resolvePluginSpecWithAutoRegister(
  spec: string,
): Promise<ResolvePluginSpecResult> {
  // Parse plugin@marketplace using the parser
  const parsed = parsePluginSpec(spec);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid plugin spec format: ${spec}\n  Expected: plugin@marketplace or plugin@owner/repo[/subpath]`,
    };
  }

  const { plugin: pluginName, marketplaceName, owner, repo, subpath } = parsed;

  // Check if marketplace is already registered
  let marketplace = await getMarketplace(marketplaceName);

  // If not registered, try auto-registration
  if (!marketplace) {
    // For owner/repo format, pass the full owner/repo string
    const sourceToRegister = owner && repo ? `${owner}/${repo}` : marketplaceName;
    const autoRegResult = await autoRegisterMarketplace(sourceToRegister);
    if (!autoRegResult.success) {
      return {
        success: false,
        error: autoRegResult.error || 'Unknown error',
      };
    }
    marketplace = await getMarketplace(autoRegResult.name ?? marketplaceName);
  }

  if (!marketplace) {
    return {
      success: false,
      error: `Marketplace '${marketplaceName}' not found`,
    };
  }

  // Determine the expected subpath for error messages
  const expectedSubpath = subpath ?? 'plugins';

  // Now resolve the plugin within the marketplace
  // Pass the actual marketplace name (may differ from spec if manifest overrode it)
  const resolved = await resolvePluginSpec(spec, {
    ...(subpath && { subpath }),
    marketplaceNameOverride: marketplace.name,
  });
  if (!resolved) {
    return {
      success: false,
      error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${marketplace.path}/${expectedSubpath}/${pluginName}/`,
    };
  }

  return {
    success: true,
    path: resolved.path,
    pluginName: resolved.plugin,
    registeredAs: marketplace.name !== marketplaceName ? marketplace.name : undefined,
  };
}

/**
 * Auto-register a marketplace by name
 *
 * Supports:
 * 1. Well-known names (e.g., "claude-plugins-official" → anthropics/claude-plugins-official)
 * 2. owner/repo format (e.g., "obra/superpowers" → github.com/obra/superpowers)
 */
async function autoRegisterMarketplace(
  name: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  const wellKnown = getWellKnownMarketplaces();

  // Check if it's a well-known marketplace name
  if (wellKnown[name]) {
    console.log(`Auto-registering well-known marketplace: ${name}`);
    const result = await addMarketplace(name);
    if (!result.success) {
      return { success: false, error: result.error || 'Unknown error' };
    }
    return { success: true, name };
  }

  // Check if it's an owner/repo format
  if (name.includes('/') && !name.includes('://')) {
    const parts = name.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      console.log(`Auto-registering GitHub marketplace: ${name}`);
      const result = await addMarketplace(name);
      if (!result.success) {
        return { success: false, error: result.error || 'Unknown error' };
      }
      // Use the name from the registered entry (may differ from repo name if manifest has a name)
      const registeredName = result.marketplace?.name ?? parts[1];
      return { success: true, name: registeredName };
    }
  }

  // Unknown marketplace name - provide helpful error
  return {
    success: false,
    error: `Marketplace '${name}' not found.\n  Options:\n  1. Use fully qualified name: plugin@owner/repo\n  2. Register first: allagents plugin marketplace add <source>\n  3. Well-known marketplaces: ${Object.keys(wellKnown).join(', ')}`,
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
