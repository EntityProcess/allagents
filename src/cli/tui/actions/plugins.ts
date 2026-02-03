import * as p from '@clack/prompts';
import { addPlugin, removePlugin } from '../../../core/workspace-modify.js';
import { addUserPlugin, removeUserPlugin } from '../../../core/user-workspace.js';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import {
  listMarketplaces,
  listMarketplacePlugins,
  addMarketplace,
  removeMarketplace,
  updateMarketplace,
  type MarketplaceEntry,
  type MarketplacePluginsResult,
} from '../../../core/marketplace.js';
import { getWorkspaceStatus } from '../../../core/status.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';

/**
 * Get marketplace list, using cache when available.
 */
async function getCachedMarketplaces(
  cache?: TuiCache,
): Promise<MarketplaceEntry[]> {
  const cached = cache?.getMarketplaces();
  if (cached) return cached;

  const result = await listMarketplaces();
  cache?.setMarketplaces(result);
  return result;
}

/**
 * Get marketplace plugins, using cache when available.
 */
async function getCachedMarketplacePlugins(
  name: string,
  cache?: TuiCache,
): Promise<MarketplacePluginsResult> {
  const cached = cache?.getMarketplacePlugins(name);
  if (cached) return cached;

  const result = await listMarketplacePlugins(name);
  cache?.setMarketplacePlugins(name, result);
  return result;
}

/**
 * Shared helper: determine scope, install a plugin, sync, and show success.
 * Returns true if installed successfully, false if cancelled or failed.
 */
async function installSelectedPlugin(
  pluginRef: string,
  context: TuiContext,
  cache?: TuiCache,
): Promise<boolean> {
  // Determine scope
  let scope: 'project' | 'user' = 'user';
  if (context.hasWorkspace) {
    const scopeChoice = await p.select({
      message: 'Install scope',
      options: [
        { label: 'Project (this workspace)', value: 'project' as const },
        { label: 'User (global)', value: 'user' as const },
      ],
    });

    if (p.isCancel(scopeChoice)) {
      return false;
    }

    scope = scopeChoice;
  }

  const s = p.spinner();
  s.start('Installing plugin...');

  if (scope === 'project' && context.workspacePath) {
    const result = await addPlugin(pluginRef, context.workspacePath);
    if (!result.success) {
      s.stop('Installation failed');
      p.note(result.error ?? 'Unknown error', 'Error');
      return false;
    }
    s.stop('Plugin added');

    const syncS = p.spinner();
    syncS.start('Syncing...');
    await syncWorkspace(context.workspacePath);
    syncS.stop('Sync complete');
  } else {
    const result = await addUserPlugin(pluginRef);
    if (!result.success) {
      s.stop('Installation failed');
      p.note(result.error ?? 'Unknown error', 'Error');
      return false;
    }
    s.stop('Plugin added');

    const syncS = p.spinner();
    syncS.start('Syncing...');
    await syncUserWorkspace();
    syncS.stop('Sync complete');
  }

  cache?.invalidate();
  p.note(`Installed: ${pluginRef}`, 'Success');
  return true;
}

/**
 * Plugin installation flow.
 * Lists marketplace plugins, lets user pick one, installs it, and auto-syncs.
 */
export async function runInstallPlugin(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    // Get available marketplaces
    const marketplaces = await getCachedMarketplaces(cache);

    if (marketplaces.length === 0) {
      p.note(
        'No marketplaces registered.\nUse "Manage marketplaces" to add one first.',
        'Marketplace',
      );
      return;
    }

    // Collect plugins from all marketplaces
    const allPlugins: Array<{ label: string; value: string }> = [];
    for (const marketplace of marketplaces) {
      const result = await getCachedMarketplacePlugins(marketplace.name, cache);
      for (const plugin of result.plugins) {
        const label = plugin.description
          ? `${plugin.name} - ${plugin.description}`
          : plugin.name;
        allPlugins.push({
          label: `${label} (${marketplace.name})`,
          value: `${plugin.name}@${marketplace.name}`,
        });
      }
    }

    if (allPlugins.length === 0) {
      p.note('No plugins found in any marketplace.', 'Plugins');
      return;
    }

    const selected = await p.select({
      message: 'Select a plugin to install',
      options: allPlugins,
    });

    if (p.isCancel(selected)) {
      return;
    }

    await installSelectedPlugin(selected, context, cache);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Plugin management (uninstall) flow.
 * Lists installed plugins, lets user pick which to remove, and auto-syncs.
 */
export async function runManagePlugins(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    const status = await getWorkspaceStatus(context.workspacePath ?? undefined);

    if (!status.success || status.plugins.length === 0) {
      p.note('No plugins installed in this workspace.', 'Plugins');
      return;
    }

    const options = status.plugins.map((plugin) => ({
      label: `${plugin.available ? '\u2713' : '\u2717'} ${plugin.source} (${plugin.type})`,
      value: plugin.source,
    }));

    const selected = await p.multiselect({
      message: 'Select plugins to remove',
      options,
      required: false,
    });

    if (p.isCancel(selected)) {
      return;
    }

    if (selected.length === 0) {
      p.note('No plugins selected.', 'Plugins');
      return;
    }

    // Determine scope
    let scope: 'project' | 'user' = context.hasWorkspace ? 'project' : 'user';
    if (context.hasWorkspace) {
      const scopeChoice = await p.select({
        message: 'Remove from which scope?',
        options: [
          { label: 'Project (this workspace)', value: 'project' as const },
          { label: 'User (global)', value: 'user' as const },
        ],
      });

      if (p.isCancel(scopeChoice)) {
        return;
      }

      scope = scopeChoice;
    }

    const s = p.spinner();
    s.start('Removing plugins...');

    const results: string[] = [];
    for (const plugin of selected) {
      if (scope === 'project' && context.workspacePath) {
        const result = await removePlugin(plugin, context.workspacePath);
        results.push(`${result.success ? '\u2713' : '\u2717'} ${plugin}`);
      } else {
        const result = await removeUserPlugin(plugin);
        results.push(`${result.success ? '\u2713' : '\u2717'} ${plugin}`);
      }
    }

    s.stop('Plugins removed');

    // Auto-sync
    const syncS = p.spinner();
    syncS.start('Syncing...');
    if (scope === 'project' && context.workspacePath) {
      await syncWorkspace(context.workspacePath);
    } else {
      await syncUserWorkspace();
    }
    syncS.stop('Sync complete');
    cache?.invalidate();

    p.note(results.join('\n'), 'Removed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Browse and manage registered marketplaces.
 * Lists marketplaces, allows adding new ones, and drilling into marketplace details.
 */
export async function runBrowseMarketplaces(
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  try {
    while (true) {
      const marketplaces = await getCachedMarketplaces(cache);

      const options: Array<{ label: string; value: string }> = [
        { label: '+ Add marketplace', value: '__add__' },
        ...marketplaces.map((m) => ({
          label: `${m.name} (${m.source.type}: ${m.source.location})`,
          value: m.name,
        })),
        { label: 'Back', value: '__back__' },
      ];

      const selected = await p.select({
        message: 'Marketplaces',
        options,
      });

      if (p.isCancel(selected) || selected === '__back__') {
        return;
      }

      if (selected === '__add__') {
        const source = await p.text({
          message: 'Marketplace source (GitHub URL, owner/repo, or name)',
          placeholder: 'e.g., anthropics/claude-plugins-official',
        });

        if (p.isCancel(source)) {
          continue;
        }

        const s = p.spinner();
        s.start('Adding marketplace...');
        const result = await addMarketplace(source);
        s.stop(
          result.success ? 'Marketplace added' : 'Failed to add marketplace',
        );

        if (!result.success) {
          p.note(result.error ?? 'Unknown error', 'Error');
        } else {
          cache?.invalidate();
        }

        continue;
      }

      // User selected a marketplace — show detail screen
      await runMarketplaceDetail(selected, context, cache);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Marketplace detail screen.
 * Shows actions for a specific marketplace: browse plugins, update, remove.
 */
async function runMarketplaceDetail(
  marketplaceName: string,
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  while (true) {
    const action = await p.select({
      message: `Marketplace: ${marketplaceName}`,
      options: [
        { label: 'Browse plugins', value: 'browse' as const },
        { label: 'Update marketplace', value: 'update' as const },
        { label: 'Remove marketplace', value: 'remove' as const },
        { label: 'Back', value: 'back' as const },
      ],
    });

    if (p.isCancel(action) || action === 'back') {
      return;
    }

    if (action === 'browse') {
      try {
        const result = await getCachedMarketplacePlugins(marketplaceName, cache);

        if (result.plugins.length === 0) {
          p.note('No plugins found in this marketplace.', 'Plugins');
          continue;
        }

        const pluginOptions: Array<{ label: string; value: string }> =
          result.plugins.map((plugin) => {
            const label = plugin.description
              ? `${plugin.name} - ${plugin.description}`
              : plugin.name;
            return { label, value: plugin.name };
          });
        pluginOptions.push({ label: 'Back', value: '__back__' });

        const selectedPlugin = await p.select({
          message: 'Select a plugin to install',
          options: pluginOptions,
        });

        if (p.isCancel(selectedPlugin) || selectedPlugin === '__back__') {
          continue;
        }

        const pluginRef = `${selectedPlugin}@${marketplaceName}`;
        await installSelectedPlugin(pluginRef, context, cache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      }

      continue;
    }

    if (action === 'update') {
      try {
        const s = p.spinner();
        s.start('Updating marketplace...');
        const results = await updateMarketplace(marketplaceName);
        const summary = results
          .map(
            (r) =>
              `${r.success ? '\u2713' : '\u2717'} ${r.name}${r.error ? ` - ${r.error}` : ''}`,
          )
          .join('\n');
        s.stop('Update complete');
        cache?.invalidate();
        p.note(summary || 'Marketplace updated.', 'Update');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      }

      continue;
    }

    if (action === 'remove') {
      const confirmed = await p.confirm({
        message: `Remove marketplace "${marketplaceName}"?`,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        continue;
      }

      try {
        const s = p.spinner();
        s.start('Removing marketplace...');
        const result = await removeMarketplace(marketplaceName);
        s.stop(
          result.success
            ? 'Marketplace removed'
            : 'Failed to remove marketplace',
        );

        if (!result.success) {
          p.note(result.error ?? 'Unknown error', 'Error');
          continue;
        }

        cache?.invalidate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      }

      // Exit detail loop so marketplace list refreshes
      return;
    }
  }
}
