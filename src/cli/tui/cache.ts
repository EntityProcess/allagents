import type { MarketplaceRegistry, MarketplacePluginsResult } from '../../core/marketplace.js';
import type { TuiContext } from './context.js';

/**
 * Session-scoped cache for the TUI wizard.
 * Holds expensive-to-compute data (registry, plugin lists, context) in memory.
 * Call invalidate() after any write operation (install, remove, sync, etc.).
 */
export class TuiCache {
  private registry: MarketplaceRegistry | undefined;
  private context: TuiContext | undefined;
  private marketplacePlugins: Map<string, MarketplacePluginsResult> = new Map();

  /** Check if registry is cached */
  hasCachedRegistry(): boolean {
    return this.registry !== undefined;
  }

  /** Get cached registry (undefined if not cached) */
  getRegistry(): MarketplaceRegistry | undefined {
    return this.registry;
  }

  /** Store registry in cache */
  setRegistry(registry: MarketplaceRegistry): void {
    this.registry = registry;
  }

  /** Check if context is cached */
  hasCachedContext(): boolean {
    return this.context !== undefined;
  }

  /** Get cached context (undefined if not cached) */
  getContext(): TuiContext | undefined {
    return this.context;
  }

  /** Store context in cache */
  setContext(context: TuiContext): void {
    this.context = context;
  }

  /** Get cached marketplace plugins for a specific marketplace */
  getMarketplacePlugins(name: string): MarketplacePluginsResult | undefined {
    return this.marketplacePlugins.get(name);
  }

  /** Store marketplace plugins in cache */
  setMarketplacePlugins(name: string, result: MarketplacePluginsResult): void {
    this.marketplacePlugins.set(name, result);
  }

  /** Clear all cached data. Call after any write operation. */
  invalidate(): void {
    this.registry = undefined;
    this.context = undefined;
    this.marketplacePlugins.clear();
  }
}
