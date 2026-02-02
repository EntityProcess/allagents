import * as p from '@clack/prompts';
import { addPlugin, removePlugin } from '../../../core/workspace-modify.js';
import { addUserPlugin, removeUserPlugin } from '../../../core/user-workspace.js';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import {
  listMarketplaces,
  listMarketplacePlugins,
  addMarketplace,
} from '../../../core/marketplace.js';
import { getWorkspaceStatus } from '../../../core/status.js';
import type { TuiContext } from '../context.js';

/**
 * Plugin installation flow.
 * Lists marketplace plugins, lets user pick one, installs it, and auto-syncs.
 */
export async function runInstallPlugin(context: TuiContext): Promise<void> {
  try {
    // Get available marketplaces
    let marketplaces = await listMarketplaces();

    // If no marketplaces, prompt to add one
    if (marketplaces.length === 0) {
      p.note(
        'No marketplaces registered. Add one to browse plugins.',
        'Marketplace',
      );

      const source = await p.text({
        message: 'Marketplace source (GitHub URL, owner/repo, or name)',
        placeholder: 'e.g., anthropics/claude-plugins-official',
      });

      if (p.isCancel(source)) {
        p.cancel('Cancelled');
        return;
      }

      const s = p.spinner();
      s.start('Adding marketplace...');
      const result = await addMarketplace(source);
      s.stop(result.success ? 'Marketplace added' : 'Failed to add marketplace');

      if (!result.success) {
        p.note(result.error ?? 'Unknown error', 'Error');
        return;
      }

      // Refresh list
      marketplaces = await listMarketplaces();
    }

    // Collect plugins from all marketplaces
    const allPlugins: Array<{ label: string; value: string }> = [];
    for (const marketplace of marketplaces) {
      const result = await listMarketplacePlugins(marketplace.name);
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
      p.cancel('Cancelled');
      return;
    }

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
        p.cancel('Cancelled');
        return;
      }

      scope = scopeChoice;
    }

    const s = p.spinner();
    s.start('Installing plugin...');

    if (scope === 'project' && context.workspacePath) {
      const result = await addPlugin(selected, context.workspacePath);
      if (!result.success) {
        s.stop('Installation failed');
        p.note(result.error ?? 'Unknown error', 'Error');
        return;
      }
      s.stop('Plugin added');

      // Auto-sync
      const syncS = p.spinner();
      syncS.start('Syncing...');
      await syncWorkspace(context.workspacePath);
      syncS.stop('Sync complete');
    } else {
      const result = await addUserPlugin(selected);
      if (!result.success) {
        s.stop('Installation failed');
        p.note(result.error ?? 'Unknown error', 'Error');
        return;
      }
      s.stop('Plugin added');

      // Auto-sync
      const syncS = p.spinner();
      syncS.start('Syncing...');
      await syncUserWorkspace();
      syncS.stop('Sync complete');
    }

    p.note(`Installed: ${selected}`, 'Success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Plugin management (uninstall) flow.
 * Lists installed plugins, lets user pick which to remove, and auto-syncs.
 */
export async function runManagePlugins(context: TuiContext): Promise<void> {
  try {
    const status = await getWorkspaceStatus();

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
      p.cancel('Cancelled');
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
        p.cancel('Cancelled');
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

    p.note(results.join('\n'), 'Removed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
