import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { cloneTo, gitHubUrl, GitCloneError, pull } from './git.js';
import {
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../utils/marketplace-manifest-parser.js';
import { fetchPlugin } from './plugin.js';
import type { FetchResult } from './plugin.js';
import { parseGitHubUrl, getPluginCachePath } from '../utils/plugin-path.js';
import { getHomeDir } from '../constants.js';

/**
 * Parse a marketplace location string into owner, repo, and optional branch.
 * Location format: "owner/repo" or "owner/repo/branch" (branch can contain slashes).
 */
export function parseLocation(location: string): { owner: string; repo: string; branch?: string } {
  const [owner = '', repo = '', ...rest] = location.split('/');
  const branch = rest.length > 0 ? rest.join('/') : undefined;
  return { owner, repo, ...(branch !== undefined && { branch }) };
}

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
  /** User-level plugins that were removed during marketplace removal cascade */
  removedUserPlugins?: string[];
}

/**
 * Get the allagents config directory
 */
export function getAllagentsDir(): string {
  return resolve(getHomeDir(), '.allagents');
}

/**
 * Get the marketplaces directory
 */
export function getMarketplacesDir(): string {
  return join(getAllagentsDir(), 'plugins', 'marketplaces');
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
 * Get the normalized source location key for a marketplace (owner/repo without branch)
 */
function getSourceLocationKey(source: MarketplaceSource): string {
  if (source.type === 'github') {
    const { owner, repo } = parseLocation(source.location);
    return `${owner}/${repo}`;
  }
  return source.location;
}

/**
 * Find a marketplace by source location in the registry
 */
function findBySourceLocation(
  registry: MarketplaceRegistry,
  sourceLocation: string,
): MarketplaceEntry | null {
  for (const entry of Object.values(registry.marketplaces)) {
    if (getSourceLocationKey(entry.source) === sourceLocation) {
      return entry;
    }
  }
  return null;
}

/**
 * Parse a marketplace source string
 * Supports:
 * - GitHub URL: https://github.com/owner/repo
 * - GitHub shorthand: owner/repo
 * - Local path: /absolute/path or ./relative/path
 */
export function parseMarketplaceSource(source: string): {
  type: MarketplaceSourceType;
  location: string;
  name: string;
  branch?: string;
} | null {
  // GitHub URL
  if (source.startsWith('https://github.com/')) {
    const match = source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/);
    if (match) {
      const [, owner, repo, branch] = match;
      if (!repo) return null;
      const location = branch ? `${owner}/${repo}/${branch}` : `${owner}/${repo}`;
      return {
        type: 'github',
        location,
        name: repo,
        ...(branch && { branch }),
      };
    }
    return null;
  }

  // GitHub shorthand: owner/repo (exactly one slash, no backslashes, no protocol)
  const parts = source.split('/');
  if (parts.length === 2 && parts[0] && parts[1] && !source.includes('\\') && !source.includes('://')) {
    return {
      type: 'github',
      location: source,
      name: parts[1],
    };
  }

  // Everything else is a local path
  const absPath = resolve(source);
  const name = basename(absPath) || 'local';
  return {
    type: 'local',
    location: absPath,
    name,
  };
}

/**
 * Add a marketplace to the registry
 * Idempotent: returns success if marketplace is already registered by source location
 *
 * @param source - Marketplace source (URL, path, or name)
 * @param customName - Optional custom name for the marketplace
 */
export async function addMarketplace(
  source: string,
  customName?: string,
  branch?: string,
): Promise<MarketplaceResult> {
  const parsed = parseMarketplaceSource(source);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid marketplace source: ${source}\n  Use: GitHub URL, owner/repo, or local path`,
    };
  }

  // Resolve branch: explicit --branch flag wins over URL-parsed branch
  const effectiveBranch = branch || parsed.branch;

  // Naming rules for non-default branches
  if (effectiveBranch) {
    if (!customName) {
      return {
        success: false,
        error: `--name is required when registering a non-default branch.\n  Example: allagents plugin marketplace add ${source} --name <custom-name>`,
      };
    }
    if (customName === parsed.name) {
      return {
        success: false,
        error: `Name '${customName}' is reserved for the default branch of ${parsed.location}.\n  Choose a different --name for branch '${effectiveBranch}'.`,
      };
    }
  }

  let name = customName || parsed.name;
  const registry = await loadRegistry();

  // Check if already registered by name
  if (registry.marketplaces[name]) {
    return {
      success: false,
      error: `Marketplace '${name}' already exists. Use 'update' to refresh it.`,
    };
  }

  // Check if already registered by source location (idempotent)
  const sourceLocation = parsed.type === 'github'
    ? `${parseLocation(parsed.location).owner}/${parseLocation(parsed.location).repo}`
    : parsed.location;
  const existingBySource = findBySourceLocation(registry, sourceLocation);
  if (existingBySource) {
    return { success: true, marketplace: existingBySource };
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
      // Ensure parent directory exists
      const parentDir = getMarketplacesDir();
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }

      // Extract owner/repo for GitHub operations (strip branch from location if present)
      const { owner, repo } = parseLocation(parsed.location);
      const repoUrl = gitHubUrl(owner, repo);

      // Clone repository (with branch if specified)
      try {
        await cloneTo(repoUrl, marketplacePath, effectiveBranch);
      } catch (error) {
        if (error instanceof GitCloneError) {
          if (error.isAuthError) {
            return {
              success: false,
              error: `Authentication failed for ${owner}/${repo}.\n  Check your SSH keys or git credentials.`,
            };
          }
        }
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
          return {
            success: false,
            error: `Repository not found: ${owner}/${repo}`,
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

  // Build location: for GitHub, use owner/repo for default branch, owner/repo/branch for non-default
  let entryLocation: string;
  if (parsed.type === 'github') {
    const { owner, repo } = parseLocation(parsed.location);
    entryLocation = effectiveBranch
      ? `${owner}/${repo}/${effectiveBranch}`
      : `${owner}/${repo}`;
  } else {
    entryLocation = parsed.location;
  }

  // Create entry
  const entry: MarketplaceEntry = {
    name,
    source: {
      type: parsed.type,
      location: entryLocation,
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
 * Remove a marketplace from the registry and delete its files
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

  // Delete the cached directory (only for cloned GitHub marketplaces, not local paths)
  if (entry.source.type !== 'local' && existsSync(entry.path)) {
    await rm(entry.path, { recursive: true, force: true });
  }

  // Cascade: remove user-level plugins referencing this marketplace
  const { removeUserPluginsForMarketplace } = await import('./user-workspace.js');
  const removedUserPlugins = await removeUserPluginsForMarketplace(name);

  return {
    success: true,
    marketplace: entry,
    removedUserPlugins,
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
 * Find a marketplace by name, falling back to source location lookup.
 * Single registry load for both checks.
 */
export async function findMarketplace(
  name: string,
  sourceLocation?: string,
): Promise<MarketplaceEntry | null> {
  const registry = await loadRegistry();
  if (registry.marketplaces[name]) {
    return registry.marketplaces[name];
  }
  if (sourceLocation) {
    return findBySourceLocation(registry, sourceLocation);
  }
  return null;
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
      // Check if location includes a branch
      const { branch: storedBranch } = parseLocation(marketplace.source.location);
      const git = simpleGit(marketplace.path);

      let targetBranch: string;
      if (storedBranch) {
        // Branch-pinned marketplace: use stored branch directly
        targetBranch = storedBranch;
      } else {
        // Default branch marketplace: detect default branch
        targetBranch = 'main';
        try {
          const ref = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short']);
          const trimmed = ref.trim();
          targetBranch = trimmed.startsWith('origin/')
            ? trimmed.slice('origin/'.length)
            : trimmed;
        } catch {
          try {
            const showOutput = await git.raw(['remote', 'show', 'origin']);
            const match = showOutput.match(/HEAD branch:\s*(\S+)/);
            if (match?.[1]) {
              targetBranch = match[1];
            }
          } catch {
            // Network unavailable; fall back to 'main'
          }
        }
      }

      await git.checkout(targetBranch);
      await pull(marketplace.path);

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
 * Result of listing marketplace plugins, including any warnings
 * from lenient manifest parsing.
 */
export interface MarketplacePluginsResult {
  plugins: MarketplacePluginInfo[];
  warnings: string[];
}

/**
 * Get plugins from a marketplace directory using its manifest.
 * Returns an empty array if no manifest is found.
 * Includes warnings from lenient parsing when applicable.
 */
export async function getMarketplacePluginsFromManifest(
  marketplacePath: string,
): Promise<MarketplacePluginsResult> {
  const result = await parseMarketplaceManifest(marketplacePath);
  if (!result.success) {
    return { plugins: [], warnings: [] };
  }

  const plugins = result.data.plugins.map((plugin) => {
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

  return { plugins, warnings: result.warnings };
}

/**
 * List plugins available in a marketplace.
 * Prefers .claude-plugin/marketplace.json when available,
 * falls back to scanning the plugins/ directory.
 */
export async function listMarketplacePlugins(
  name: string,
): Promise<MarketplacePluginsResult> {
  const marketplace = await getMarketplace(name);
  if (!marketplace) {
    return { plugins: [], warnings: [] };
  }

  // Try manifest first
  const manifestResult = await getMarketplacePluginsFromManifest(marketplace.path);
  if (manifestResult.plugins.length > 0) {
    return manifestResult;
  }

  // Fall back to directory scanning
  const pluginsDir = join(marketplace.path, 'plugins');
  if (!existsSync(pluginsDir)) {
    return { plugins: [], warnings: manifestResult.warnings };
  }

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const plugins = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: join(pluginsDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plugins, warnings: manifestResult.warnings };
  } catch {
    return { plugins: [], warnings: manifestResult.warnings };
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
  options: {
    subpath?: string;
    marketplaceNameOverride?: string;
    marketplacePathOverride?: string;
    offline?: boolean;
    fetchFn?: (url: string) => Promise<FetchResult>;
  } = {},
): Promise<{ path: string; marketplace: string; plugin: string } | null> {
  const parsed = parsePluginSpec(spec);
  if (!parsed) {
    return null;
  }

  // Use override name if provided (e.g., when manifest changed the marketplace name)
  const marketplaceName = options.marketplaceNameOverride ?? parsed.marketplaceName;

  // Determine marketplace path: use override or look up from registry
  let marketplacePath: string | null = options.marketplacePathOverride ?? null;
  if (!marketplacePath) {
    const marketplace = await getMarketplace(marketplaceName);
    if (!marketplace) {
      return null;
    }
    marketplacePath = marketplace.path;
  }

  // Try manifest-based resolution first: look up plugin name in manifest entries
  const manifestResult = await parseMarketplaceManifest(marketplacePath);
  if (manifestResult.success) {
    const pluginEntry = manifestResult.data.plugins.find(
      (p) => p.name === parsed.plugin,
    );
    if (pluginEntry) {
      if (typeof pluginEntry.source === 'string') {
        // Local path source - resolve relative to marketplace
        const resolvedPath = resolve(marketplacePath, pluginEntry.source);
        if (existsSync(resolvedPath)) {
          return {
            path: resolvedPath,
            marketplace: marketplaceName,
            plugin: parsed.plugin,
          };
        }
      } else {
        if (options.offline) {
          // Offline mode: check if plugin is already cached, don't fetch
          const parsedUrl = parseGitHubUrl(pluginEntry.source.url);
          if (parsedUrl) {
            const cachePath = getPluginCachePath(parsedUrl.owner, parsedUrl.repo);
            if (existsSync(cachePath)) {
              return {
                path: cachePath,
                marketplace: marketplaceName,
                plugin: parsed.plugin,
              };
            }
          }
          return null;
        }
        // URL source - fetch/clone the plugin
        const fetchFn = options.fetchFn ?? fetchPlugin;
        const fetchResult = await fetchFn(pluginEntry.source.url);
        if (fetchResult.success && fetchResult.cachePath) {
          return {
            path: fetchResult.cachePath,
            marketplace: marketplaceName,
            plugin: parsed.plugin,
          };
        }
      }
    }
  }

  // Fall back to directory-based lookup
  const subpath = options.subpath ?? parsed.subpath ?? 'plugins';
  const pluginPath = join(marketplacePath, subpath, parsed.plugin);

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
 * Refresh a GitHub marketplace by removing it from registry, deleting the
 * cached directory, and re-adding it (fresh clone).
 * Unlike removeMarketplace, this does NOT cascade-remove user plugins.
 */
async function refreshMarketplace(
  marketplace: MarketplaceEntry,
): Promise<MarketplaceResult> {
  if (marketplace.source.type !== 'github') {
    return { success: true, marketplace };
  }

  const { owner, repo, branch } = parseLocation(marketplace.source.location);

  // Remove from registry without cascade
  const registry = await loadRegistry();
  delete registry.marketplaces[marketplace.name];
  await saveRegistry(registry);

  // Delete the cached directory
  if (existsSync(marketplace.path)) {
    await rm(marketplace.path, { recursive: true, force: true });
  }

  // Re-add with original source (will clone fresh)
  return addMarketplace(`${owner}/${repo}`, marketplace.name, branch);
}

/**
 * Resolve a plugin@marketplace spec with auto-registration support
 *
 * Auto-registration rules:
 * 1. plugin@owner/repo format → auto-register owner/repo as marketplace
 * 2. plugin@owner/repo/subpath → auto-register owner/repo, look in subpath/
 * 3. Unknown short name → error with helpful message
 */
export async function resolvePluginSpecWithAutoRegister(
  spec: string,
  options: { offline?: boolean } = {},
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

  // Check if marketplace is already registered (by name, then by source location)
  const sourceLocation = owner && repo ? `${owner}/${repo}` : undefined;
  let marketplace = await findMarketplace(marketplaceName, sourceLocation);
  let didAutoRegister = false;

  // If not registered, try auto-registration
  if (!marketplace) {
    const sourceToRegister = owner && repo ? `${owner}/${repo}` : marketplaceName;
    const autoRegResult = await autoRegisterMarketplace(sourceToRegister);
    if (!autoRegResult.success) {
      return {
        success: false,
        error: autoRegResult.error || 'Unknown error',
      };
    }
    marketplace = await getMarketplace(autoRegResult.name ?? marketplaceName);
    didAutoRegister = true;
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
  const resolveOpts = {
    ...(subpath && { subpath }),
    marketplaceNameOverride: marketplace.name,
    ...(options.offline != null && { offline: options.offline }),
  };

  let resolved = await resolvePluginSpec(spec, resolveOpts);

  // If not found and online, refresh the marketplace (re-clone) and retry
  if (!resolved && !options.offline && marketplace.source.type === 'github') {
    console.log(
      `Plugin not found in cached marketplace, refreshing '${marketplace.name}'...`,
    );
    const refreshResult = await refreshMarketplace(marketplace);
    if (refreshResult.success && refreshResult.marketplace) {
      marketplace = refreshResult.marketplace;
      resolved = await resolvePluginSpec(spec, {
        ...(subpath && { subpath }),
        marketplaceNameOverride: marketplace.name,
      });
    }
  }

  if (!resolved) {
    return {
      success: false,
      error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${join(marketplace.path, expectedSubpath, pluginName)}`,
    };
  }

  // Return registeredAs when we auto-registered OR when the canonical name differs
  const shouldReturnRegisteredAs =
    didAutoRegister || marketplace.name !== marketplaceName;

  return {
    success: true,
    path: resolved.path,
    pluginName: resolved.plugin,
    ...(shouldReturnRegisteredAs && { registeredAs: marketplace.name }),
  };
}

/**
 * Auto-register a marketplace by source.
 * Only supports owner/repo format for GitHub marketplaces.
 */
async function autoRegisterMarketplace(
  source: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  // Check if it's an owner/repo format
  if (source.includes('/') && !source.includes('://')) {
    const parts = source.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      console.log(`Auto-registering GitHub marketplace: ${source}`);
      const result = await addMarketplace(source);
      if (!result.success) {
        return { success: false, error: result.error || 'Unknown error' };
      }
      return { success: true, name: result.marketplace?.name ?? parts[1] };
    }
  }

  // Unknown marketplace name - provide helpful error
  return {
    success: false,
    error: `Marketplace '${source}' not found.\n  Use fully qualified format: plugin@owner/repo`,
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
 * Extract unique marketplace sources from a list of plugin specs.
 * Used to pre-register marketplaces before parallel plugin validation.
 */
export function extractUniqueMarketplaceSources(plugins: string[]): string[] {
  const sources = new Set<string>();

  for (const plugin of plugins) {
    if (!isPluginSpec(plugin)) continue;

    const parsed = parsePluginSpec(plugin);
    if (!parsed) continue;

    // For owner/repo format, use the full owner/repo as source
    if (parsed.owner && parsed.repo) {
      sources.add(`${parsed.owner}/${parsed.repo}`);
    }
  }

  return Array.from(sources);
}

/**
 * Ensure all marketplaces for the given plugins are registered.
 * Called before parallel plugin validation to avoid race conditions.
 *
 * @param plugins - List of plugin sources (may include plugin@marketplace specs)
 * @returns Results of marketplace registration attempts
 */
export async function ensureMarketplacesRegistered(
  plugins: string[],
): Promise<Array<{ source: string; success: boolean; name?: string; error?: string }>> {
  const sources = extractUniqueMarketplaceSources(plugins);
  const results: Array<{ source: string; success: boolean; name?: string; error?: string }> = [];

  for (const source of sources) {
    // Check if already registered
    const parts = source.split('/');
    const sourceLocation = source;
    const existing = await findMarketplace(parts[1] ?? '', sourceLocation);

    if (existing) {
      results.push({ source, success: true, name: existing.name });
      continue;
    }

    // Register the marketplace
    const result = await autoRegisterMarketplace(source);
    results.push({ source, ...result });
  }

  return results;
}

/**
 * Get the short git commit hash for a marketplace directory.
 * Returns null if the marketplace is not a git repo or has no commits.
 */
export async function getMarketplaceVersion(marketplacePath: string): Promise<string | null> {
  if (!existsSync(marketplacePath)) {
    return null;
  }

  try {
    const git = simpleGit(marketplacePath);
    const log = await git.log({ maxCount: 1, format: { hash: '%h' } });
    return log.latest?.hash || null;
  } catch {
    return null;
  }
}
